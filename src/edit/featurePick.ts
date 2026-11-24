// Object-mode geometric feature picking for feature-align mode.

import * as THREE from "three";
import { getMesh, type MeshEntry } from "../mesh/registry";
import type { FeatureConstraint, FeatureKind, FeaturePick } from "../state/store";
import type { FitResult } from "../wasm";
import type { GeomRef } from "../viewport/robotView";

type MeshEditor = MeshEntry["editor"];
type WorldFeature = Omit<FeaturePick, "link">;

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

function pickFromPrimitiveCylinder(geom: GeomRef): WorldFeature | null {
  const m = meshWorldMatrix(geom);
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
  geom: GeomRef,
  ctx: FeaturePickContext,
): WorldFeature | null {
  const mvp = mvpForMesh(ctx.camera, meshWorldMatrix(geom));
  const { width, height, x, y } = ctx;
  let faces = Array.from(editor.inCircle("face", mvp, width, height, x, y, 28));
  if (!faces.length) faces = Array.from(editor.inCircle("face", mvp, width, height, x, y, 56));
  const wholeMesh = faces.length === 0;
  try {
    const results = editor.fitPrimitives({
      shape: "cylinder",
      mode: "least_squares",
      axis: "auto",
      aligned: false,
      per_island: wholeMesh,
      all: wholeMesh,
      ...(wholeMesh ? {} : { face_ids: faces }),
      scale: geom.mesh.scale.toArray(),
    }) as FitResult[];
    const cylinder = results.find((r) => r.geometry.type === "cylinder");
    return cylinder ? fitResultToPick(cylinder, geom.origin.matrixWorld) : null;
  } catch {
    return null;
  }
}

function fitResultToPick(r: FitResult, originMatrix: THREE.Matrix4): WorldFeature {
  // Fitting already applied URDF scale. Only place the fit in the geometry frame.
  const center = transformPoint(originMatrix, r.center);
  const q = new THREE.Quaternion(...r.rotation);
  const axisLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const axis = transformDir(originMatrix, axisLocal.toArray());
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
): WorldFeature | null {
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
): WorldFeature | null {
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

  const feature = pickOnGeometry(ctx, geom, hits[0].point);
  const linkFrame = geom.origin.parent;
  if (!feature || !linkFrame) return null;
  linkFrame.updateWorldMatrix(true, false);
  const inverse = linkFrame.matrixWorld.clone().invert();
  return {
    ...feature,
    link: geom.link,
    origin: transformPoint(inverse, feature.origin).toArray(),
    direction: new THREE.Vector3(...feature.direction).transformDirection(inverse).toArray(),
  };
}

function pickOnGeometry(ctx: FeaturePickContext, geom: GeomRef, hitPoint: THREE.Vector3): WorldFeature | null {
  if (geom.geometryType !== "mesh") {
    if (ctx.kind === "circle" && geom.geometryType === "cylinder") return pickFromPrimitiveCylinder(geom);
    if (ctx.kind === "point") {
      return { kind: "point", origin: toTuple(hitPoint), direction: [0, 0, 0], label: `${geom.link} 表面点` };
    }
    return null;
  }

  const entry = getMesh(geom.meshPath);
  if (!entry) return null;
  if (ctx.kind === "circle") return fitCircleOnMesh(entry.editor, geom, ctx);
  const matrix = meshWorldMatrix(geom);
  const pick = ctx.kind === "point" ? pickPoint : pickLine;
  return pick(entry.editor, ctx.camera, matrix, ctx.width, ctx.height, ctx.x, ctx.y);
}
