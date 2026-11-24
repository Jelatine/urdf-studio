// Object-mode geometric feature picking for feature-align mode.

import * as THREE from "three";
import { getMesh, type MeshEntry } from "../mesh/registry";
import type { FeatureConstraint, FeatureKind, FeaturePick } from "../state/store";
import type { FitResult } from "../wasm";
import type { GeomRef } from "../viewport/robotView";

type MeshEditor = MeshEntry["editor"];

function toTuple(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

function meshWorldMatrix(geom: GeomRef): THREE.Matrix4 {
  geom.mesh.updateWorldMatrix(true, false);
  return geom.mesh.matrixWorld.clone();
}

function mvpForMesh(camera: THREE.Camera, meshMatrixWorld: THREE.Matrix4): Float64Array {
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(meshMatrixWorld);
  return Float64Array.from(m.elements);
}

function transformPoint(m: THREE.Matrix4, p: ArrayLike<number>): THREE.Vector3 {
  return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m);
}

function transformDir(m: THREE.Matrix4, d: ArrayLike<number>): THREE.Vector3 {
  return new THREE.Vector3(d[0], d[1], d[2]).applyMatrix3(new THREE.Matrix3().getNormalMatrix(m)).normalize();
}

/** Desired feature kind for the next pick given constraint + progress. */
export function nextFeatureKind(constraint: FeatureConstraint, pickIndex: number): FeatureKind {
  if (constraint === "concentric") return "circle";
  if (constraint === "collinear") return pickIndex === 0 ? "point" : "line";
  return "line";
}

function pickFromPrimitiveCylinder(geom: GeomRef): FeaturePick | null {
  const robotGeom = geom; // visual origin carries cylinder frame (Z = axis)
  const m = meshWorldMatrix(robotGeom);
  // URDF cylinder mesh is Z-aligned after primitiveGeometry rotateX fix — local Y in three
  // CylinderGeometry was rotated X by π/2 so URDF Z → three local Z. Axis is local Z.
  const center = transformPoint(m, [0, 0, 0]);
  const axis = transformDir(m, [0, 0, 1]);
  return {
    kind: "circle",
    origin: toTuple(center),
    direction: toTuple(axis),
    label: `${geom.link}/${geom.role} 圆柱`,
  };
}

function fitCircleOnMesh(
  editor: MeshEditor,
  camera: THREE.Camera,
  meshMatrix: THREE.Matrix4,
  w: number,
  h: number,
  x: number,
  y: number,
  scale: [number, number, number],
): FeaturePick | null {
  const mvp = mvpForMesh(camera, meshMatrix);
  const faceIds = Array.from(editor.faceIds());
  // Prefer faces under cursor; fall back to a screen circle.
  let faces = Array.from(editor.inCircle("face", mvp, w, h, x, y, 28));
  if (!faces.length) faces = Array.from(editor.inCircle("face", mvp, w, h, x, y, 56));
  if (!faces.length && faceIds.length) {
    // Last resort: whole mesh cylinder fit.
    try {
      const results = editor.fitPrimitives({
        shape: "cylinder",
        mode: "least_squares",
        axis: "auto",
        aligned: false,
        per_island: true,
        all: true,
        scale,
      }) as FitResult[];
      const cyl = results.find((r) => r.geometry.type === "cylinder");
      if (!cyl) return null;
      return fitResultToPick(cyl, meshMatrix, scale);
    } catch {
      return null;
    }
  }
  if (!faces.length) return null;

  const prev = editor.faceSelection();
  const prevIds = editor.faceIds();
  try {
    editor.selectRaw("face", Uint32Array.from(faces), "set");
    const results = editor.fitPrimitives({
      shape: "cylinder",
      mode: "least_squares",
      axis: "auto",
      aligned: false,
      per_island: false,
      all: false,
      scale,
    }) as FitResult[];
    const cyl = results.find((r) => r.geometry.type === "cylinder") ?? results[0];
    if (!cyl || cyl.geometry.type !== "cylinder") return null;
    return fitResultToPick(cyl, meshMatrix, scale);
  } catch {
    return null;
  } finally {
    // Restore previous face selection without undo.
    const selected: number[] = [];
    for (let i = 0; i < prev.length; i++) if (prev[i]) selected.push(prevIds[i]);
    editor.selectRaw("face", Uint32Array.from(selected), "set");
  }
}

function fitResultToPick(r: FitResult, meshMatrix: THREE.Matrix4, _scale: [number, number, number]): FeaturePick {
  // Fit center/rotation are in editor (file) coordinates; mesh.matrixWorld maps them to world
  // (including URDF mesh scale on the three.js mesh).
  const center = transformPoint(meshMatrix, r.center);
  const q = new THREE.Quaternion(...r.rotation);
  const axisLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const axis = transformDir(meshMatrix, [axisLocal.x, axisLocal.y, axisLocal.z]);
  return {
    kind: "circle",
    origin: toTuple(center),
    direction: toTuple(axis),
    label: `圆 r=${r.geometry.type === "cylinder" ? r.geometry.radius.toFixed(3) : "?"}`,
  };
}

function pickLine(
  editor: MeshEditor,
  camera: THREE.Camera,
  meshMatrix: THREE.Matrix4,
  w: number,
  h: number,
  x: number,
  y: number,
): FeaturePick | null {
  const mvp = mvpForMesh(camera, meshMatrix);
  const pairs = editor.pickEdges(mvp, w, h, x, y, 14, 16);
  if (!pairs.length) return null;
  const e = pairs[0];
  const [a, b] = editor.edgeVerts(e);
  const pa = editor.vertPosition(a);
  const pb = editor.vertPosition(b);
  const wa = transformPoint(meshMatrix, pa);
  const wb = transformPoint(meshMatrix, pb);
  const dir = wb.clone().sub(wa);
  if (dir.lengthSq() < 1e-16) return null;
  dir.normalize();
  const mid = wa.clone().add(wb).multiplyScalar(0.5);
  return {
    kind: "line",
    origin: toTuple(mid),
    direction: toTuple(dir),
    label: `边 #${e}`,
  };
}

function pickPoint(
  editor: MeshEditor,
  camera: THREE.Camera,
  meshMatrix: THREE.Matrix4,
  w: number,
  h: number,
  x: number,
  y: number,
): FeaturePick | null {
  const mvp = mvpForMesh(camera, meshMatrix);
  const verts = editor.pickVerts(mvp, w, h, x, y, 16, 16);
  if (verts.length) {
    const p = transformPoint(meshMatrix, editor.vertPosition(verts[0]));
    return { kind: "point", origin: toTuple(p), direction: [0, 0, 0], label: `顶点 #${verts[0]}` };
  }
  // Fall back to edge midpoint.
  const line = pickLine(editor, camera, meshMatrix, w, h, x, y);
  if (!line) return null;
  return { kind: "point", origin: line.origin, direction: [0, 0, 0], label: `边中点` };
}

export interface FeaturePickContext {
  camera: THREE.Camera;
  width: number;
  height: number;
  x: number;
  y: number;
  geoms: GeomRef[];
  raycaster: THREE.Raycaster;
  ndc: THREE.Vector2;
  kind: FeatureKind;
}

/** Pick a feature under the cursor from visible robot geometries. */
export function pickFeatureAt(ctx: FeaturePickContext): FeaturePick | null {
  const meshes = ctx.geoms.filter((g) => g.origin.visible).map((g) => g.mesh);
  ctx.raycaster.setFromCamera(ctx.ndc, ctx.camera);
  const hits = ctx.raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const mesh = hits[0].object as THREE.Mesh;
  const geom = ctx.geoms.find((g) => g.mesh === mesh);
  if (!geom) return null;

  // URDF primitive cylinder → exact center/axis.
  if (ctx.kind === "circle") {
    const entry = geom.meshPath ? getMesh(geom.meshPath) : null;
    if (!entry) {
      // Likely a primitive; cylinder axis is local Z of the mesh after build.
      return pickFromPrimitiveCylinder(geom);
    }
    const scale: [number, number, number] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    return fitCircleOnMesh(entry.editor, ctx.camera, meshWorldMatrix(geom), ctx.width, ctx.height, ctx.x, ctx.y, scale);
  }

  if (!geom.meshPath) {
    // Primitive edges aren't in a MeshEditor — synthesize axes from the box/cylinder/sphere frame.
    const m = meshWorldMatrix(geom);
    if (ctx.kind === "point") {
      const p = hits[0].point.clone();
      return { kind: "point", origin: toTuple(p), direction: [0, 0, 0], label: `${geom.link} 表面点` };
    }
    // Use closest local axis projected as a line through hit point.
    const localAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const hitLocal = hits[0].point.clone().applyMatrix4(m.clone().invert());
    let best = localAxes[0];
    let bestDot = -1;
    const view = ctx.camera.getWorldDirection(new THREE.Vector3());
    for (const a of localAxes) {
      const aw = transformDir(m, [a.x, a.y, a.z]);
      const score = 1 - Math.abs(aw.dot(view));
      if (score > bestDot) {
        bestDot = score;
        best = a;
      }
    }
    void hitLocal;
    const dir = transformDir(m, [best.x, best.y, best.z]);
    return {
      kind: "line",
      origin: toTuple(hits[0].point),
      direction: toTuple(dir),
      label: `${geom.link} 局部轴`,
    };
  }

  const entry = getMesh(geom.meshPath);
  if (!entry) return null;
  const M = meshWorldMatrix(geom);
  if (ctx.kind === "point") return pickPoint(entry.editor, ctx.camera, M, ctx.width, ctx.height, ctx.x, ctx.y);
  return pickLine(entry.editor, ctx.camera, M, ctx.width, ctx.height, ctx.x, ctx.y);
}
