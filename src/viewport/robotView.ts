// Builds the three.js scene graph for a robot:
//   link frame -> joint origin (fixed transform) -> joint motion -> child link frame
// URDF is Z-up; the whole scene uses Z-up so no conversion is needed.

import * as THREE from "three";
import { getMesh } from "../mesh/registry";
import { isMovable, rootLinks, type Geometry, type Joint, type Material, type Pose, type Robot } from "../types/urdf";

export interface GeomRef {
  link: string;
  role: "visual" | "collision";
  index: number;
  meshPath: string | null;
  /** Group carrying the <origin> transform. */
  origin: THREE.Group;
  /** The rendered mesh (scaled for mesh geometry). */
  mesh: THREE.Mesh;
}

export interface BuildOptions {
  meshPaths: Record<string, string | null>;
  showVisual: boolean;
  showCollision: boolean;
  showFrames: boolean;
  showAxes: boolean;
  wireframe: boolean;
}

const DEFAULT_COLOR = new THREE.Color(0.72, 0.74, 0.77);
const COLLISION_COLOR = new THREE.Color(0.2, 0.75, 1.0);

export function applyPose(o: THREE.Object3D, p: Pose) {
  o.position.set(p.xyz[0], p.xyz[1], p.xyz[2]);
  // URDF rpy: fixed-axis roll/pitch/yaw = Rz(yaw) * Ry(pitch) * Rx(roll).
  o.quaternion.setFromEuler(new THREE.Euler(p.rpy[0], p.rpy[1], p.rpy[2], "ZYX"));
}

export function poseFromObject(o: THREE.Object3D): Pose {
  const e = new THREE.Euler().setFromQuaternion(o.quaternion, "ZYX");
  const r = (v: number) => Math.round(v * 1e6) / 1e6 || 0;
  return {
    xyz: [r(o.position.x), r(o.position.y), r(o.position.z)],
    rpy: [r(e.x), r(e.y), r(e.z)],
  };
}

export function primitiveGeometry(g: Geometry): THREE.BufferGeometry | null {
  switch (g.type) {
    case "box":
      return new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2]);
    case "cylinder": {
      const c = new THREE.CylinderGeometry(g.radius, g.radius, g.length, 32);
      c.rotateX(Math.PI / 2); // three cylinders are Y-aligned, URDF's are Z-aligned
      return c;
    }
    case "sphere":
      return new THREE.SphereGeometry(g.radius, 32, 16);
    default:
      return null;
  }
}

function materialColor(robot: Robot, m: Material | null): THREE.Color {
  if (m?.color) return new THREE.Color(m.color[0], m.color[1], m.color[2]);
  if (m?.name) {
    const named = robot.materials.find((x) => x.name === m.name);
    if (named?.color) return new THREE.Color(named.color[0], named.color[1], named.color[2]);
  }
  return DEFAULT_COLOR.clone();
}

export class RobotView {
  readonly root = new THREE.Group();
  links = new Map<string, THREE.Group>();
  jointOrigins = new Map<string, THREE.Group>();
  jointMotions = new Map<string, THREE.Group>();
  geoms: GeomRef[] = [];
  private helpers: THREE.Object3D[] = [];
  private axisArrows = new Map<string, THREE.ArrowHelper>();
  private ownedGeometries: THREE.BufferGeometry[] = [];
  helperSize = 0.1;

  constructor() {
    this.root.name = "robot";
  }

  dispose() {
    this.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    this.ownedGeometries.forEach((g) => g.dispose());
    this.ownedGeometries = [];
    this.root.clear();
    this.links.clear();
    this.jointOrigins.clear();
    this.jointMotions.clear();
    this.axisArrows.clear();
    this.geoms = [];
    this.helpers = [];
  }

  build(robot: Robot, opts: BuildOptions) {
    this.dispose();
    for (const l of robot.links) {
      const g = new THREE.Group();
      g.name = `link:${l.name}`;
      g.userData.link = l.name;
      this.links.set(l.name, g);
    }
    const byParent = new Map<string, Joint[]>();
    for (const j of robot.joints) {
      if (!this.links.has(j.parent) || !this.links.has(j.child)) continue;
      const list = byParent.get(j.parent) ?? [];
      list.push(j);
      byParent.set(j.parent, list);
    }
    const attached = new Set<string>();
    const attach = (linkName: string, parent: THREE.Object3D) => {
      if (attached.has(linkName)) return;
      attached.add(linkName);
      parent.add(this.links.get(linkName)!);
      for (const j of byParent.get(linkName) ?? []) {
        const origin = new THREE.Group();
        origin.name = `joint:${j.name}`;
        origin.userData.joint = j.name;
        applyPose(origin, j.origin);
        const motion = new THREE.Group();
        motion.name = `motion:${j.name}`;
        origin.add(motion);
        this.links.get(linkName)!.add(origin);
        this.jointOrigins.set(j.name, origin);
        this.jointMotions.set(j.name, motion);
        attach(j.child, motion);
      }
    };
    for (const r of rootLinks(robot)) attach(r, this.root);
    // Links in loops / with broken references still get displayed.
    for (const name of this.links.keys()) attach(name, this.root);

    for (const l of robot.links) {
      const frame = this.links.get(l.name)!;
      l.visuals.forEach((v, i) => {
        const color = materialColor(robot, v.material);
        const mat = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.1,
          roughness: 0.65,
          wireframe: opts.wireframe,
          transparent: v.material?.color ? v.material.color[3] < 1 : false,
          opacity: v.material?.color?.[3] ?? 1,
        });
        mat.userData.baseColor = color.clone();
        this.addGeom(frame, l.name, "visual", i, v.origin, v.geometry, mat, opts, opts.showVisual);
      });
      l.collisions.forEach((c, i) => {
        const mat = new THREE.MeshBasicMaterial({
          color: COLLISION_COLOR,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          wireframe: opts.wireframe,
        });
        mat.userData.baseColor = COLLISION_COLOR.clone();
        this.addGeom(frame, l.name, "collision", i, c.origin, c.geometry, mat, opts, opts.showCollision);
      });
    }

    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    const size = box.isEmpty() ? 0.5 : box.getSize(new THREE.Vector3()).length();
    this.helperSize = Math.max(0.02, size * 0.06);
    this.buildHelpers(robot, opts);
  }

  private addGeom(
    frame: THREE.Group,
    link: string,
    role: "visual" | "collision",
    index: number,
    pose: Pose,
    g: Geometry,
    mat: THREE.Material,
    opts: BuildOptions,
    visible: boolean,
  ) {
    const origin = new THREE.Group();
    applyPose(origin, pose);
    origin.visible = visible;
    let geometry: THREE.BufferGeometry | null = null;
    let meshPath: string | null = null;
    if (g.type === "mesh") {
      meshPath = opts.meshPaths[g.filename] ?? null;
      geometry = getMesh(meshPath)?.geometry ?? null;
    } else {
      geometry = primitiveGeometry(g);
      if (geometry) this.ownedGeometries.push(geometry);
    }
    if (!geometry) {
      // Placeholder for meshes that are missing or still loading.
      geometry = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      this.ownedGeometries.push(geometry);
      (mat as THREE.MeshStandardMaterial).wireframe = true;
    }
    const mesh = new THREE.Mesh(geometry, mat);
    if (g.type === "mesh" && g.scale) mesh.scale.set(g.scale[0], g.scale[1], g.scale[2]);
    mesh.userData = { link, role, index, meshPath };
    mesh.renderOrder = role === "collision" ? 2 : 0;
    origin.add(mesh);
    frame.add(origin);
    this.geoms.push({ link, role, index, meshPath, origin, mesh });
  }

  private buildHelpers(robot: Robot, opts: BuildOptions) {
    const s = this.helperSize;
    if (opts.showFrames) {
      for (const [, frame] of this.links) {
        const a = new THREE.AxesHelper(s);
        (a.material as THREE.Material).depthTest = false;
        a.renderOrder = 10;
        frame.add(a);
        this.helpers.push(a);
      }
    }
    if (opts.showAxes) {
      for (const j of robot.joints) {
        if (!isMovable(j)) continue;
        const origin = this.jointOrigins.get(j.name);
        if (!origin) continue;
        const axis = new THREE.Vector3(...j.axis);
        if (axis.lengthSq() < 1e-12) continue;
        const arrow = new THREE.ArrowHelper(axis.normalize(), new THREE.Vector3(), s * 1.6, 0xffc23a, s * 0.4, s * 0.25);
        arrow.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (m) m.depthTest = false;
          o.renderOrder = 11;
        });
        origin.add(arrow);
        this.axisArrows.set(j.name, arrow);
        this.helpers.push(arrow);
      }
    }
  }

  setJointValues(robot: Robot, values: Record<string, number>) {
    for (const j of robot.joints) {
      const motion = this.jointMotions.get(j.name);
      if (!motion) continue;
      const v = values[j.name] ?? 0;
      const axis = new THREE.Vector3(...j.axis);
      if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
      axis.normalize();
      motion.position.set(0, 0, 0);
      motion.quaternion.identity();
      if (j.joint_type === "revolute" || j.joint_type === "continuous") motion.quaternion.setFromAxisAngle(axis, v);
      else if (j.joint_type === "prismatic") motion.position.copy(axis.multiplyScalar(v));
    }
    this.root.updateMatrixWorld(true);
  }

  /** Tints the selected link's geometry and the selected joint's axis. */
  setHighlight(link: string | null, joint: string | null) {
    for (const g of this.geoms) {
      const mat = g.mesh.material as THREE.MeshStandardMaterial;
      const base = mat.userData.baseColor as THREE.Color;
      const on = g.link === link;
      if (mat.emissive) mat.emissive.setRGB(on ? 0.35 : 0, on ? 0.18 : 0, 0);
      else mat.color.copy(on ? base.clone().lerp(new THREE.Color(1, 0.6, 0.1), 0.5) : base);
    }
    for (const [name, arrow] of this.axisArrows) {
      arrow.setColor(name === joint ? 0xff4d2e : 0xffc23a);
      arrow.scale.setScalar(name === joint ? 1.5 : 1);
    }
  }

  findGeom(link: string, role: "visual" | "collision", index: number) {
    return this.geoms.find((g) => g.link === link && g.role === role && g.index === index);
  }

  /** Object the transform gizmo should move for a link/joint selection. */
  gizmoTarget(robot: Robot, sel: { kind: "link" | "joint"; name: string } | null): { joint: string; object: THREE.Group } | null {
    if (!sel) return null;
    const jointName = sel.kind === "joint" ? sel.name : robot.joints.find((j) => j.child === sel.name)?.name;
    if (!jointName) return null;
    const object = this.jointOrigins.get(jointName);
    return object ? { joint: jointName, object } : null;
  }
}
