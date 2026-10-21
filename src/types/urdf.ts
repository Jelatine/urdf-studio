// Mirrors the serde model in crates/urdf-core/src/lib.rs.

export type Vec3 = [number, number, number];

export interface Pose {
  xyz: Vec3;
  rpy: Vec3;
}

export interface Material {
  name: string;
  color: [number, number, number, number] | null;
  texture: string | null;
}

export interface Inertia {
  ixx: number;
  ixy: number;
  ixz: number;
  iyy: number;
  iyz: number;
  izz: number;
}

export interface Inertial {
  origin: Pose;
  mass: number;
  inertia: Inertia;
}

export type Geometry =
  | { type: "box"; size: Vec3 }
  | { type: "cylinder"; radius: number; length: number }
  | { type: "sphere"; radius: number }
  | { type: "mesh"; filename: string; scale: Vec3 | null };

export interface Visual {
  name: string | null;
  origin: Pose;
  geometry: Geometry;
  material: Material | null;
}

export interface Collision {
  name: string | null;
  origin: Pose;
  geometry: Geometry;
}

export interface Link {
  name: string;
  inertial: Inertial | null;
  visuals: Visual[];
  collisions: Collision[];
  extras: string[];
}

export type JointType = "revolute" | "continuous" | "prismatic" | "fixed" | "floating" | "planar";

export interface Limit {
  lower: number;
  upper: number;
  effort: number;
  velocity: number;
}

export interface Joint {
  name: string;
  joint_type: JointType;
  origin: Pose;
  parent: string;
  child: string;
  axis: Vec3;
  limit: Limit | null;
  dynamics: { damping: number; friction: number } | null;
  mimic: { joint: string; multiplier: number; offset: number } | null;
  safety_controller: {
    soft_lower_limit: number;
    soft_upper_limit: number;
    k_position: number;
    k_velocity: number;
  } | null;
  calibration: { rising: number | null; falling: number | null } | null;
  extras: string[];
}

export interface Robot {
  name: string;
  materials: Material[];
  links: Link[];
  joints: Joint[];
  extras: string[];
}

export interface Issue {
  level: "error" | "warning";
  message: string;
  target: string | null;
}

export const zeroPose = (): Pose => ({ xyz: [0, 0, 0], rpy: [0, 0, 0] });

export const isMovable = (j: Joint) => j.joint_type === "revolute" || j.joint_type === "continuous" || j.joint_type === "prismatic";

/** Joint range used by sliders and the simulator. */
export function jointRange(j: Joint): [number, number] {
  if (j.joint_type === "continuous") return [-Math.PI, Math.PI];
  if (j.limit && j.limit.upper > j.limit.lower) return [j.limit.lower, j.limit.upper];
  return j.joint_type === "prismatic" ? [-0.5, 0.5] : [-Math.PI, Math.PI];
}

export function newLink(name: string): Link {
  return { name, inertial: null, visuals: [], collisions: [], extras: [] };
}

export function newJoint(name: string, parent: string, child: string): Joint {
  return {
    name,
    joint_type: "fixed",
    origin: zeroPose(),
    parent,
    child,
    axis: [0, 0, 1],
    limit: null,
    dynamics: null,
    mimic: null,
    safety_controller: null,
    calibration: null,
    extras: [],
  };
}

/** Child links of each link, following joints. */
export function childrenMap(robot: Robot): Map<string, Joint[]> {
  const m = new Map<string, Joint[]>();
  for (const j of robot.joints) {
    const list = m.get(j.parent) ?? [];
    list.push(j);
    m.set(j.parent, list);
  }
  return m;
}

export function rootLinks(robot: Robot): string[] {
  const children = new Set(robot.joints.map((j) => j.child));
  return robot.links.map((l) => l.name).filter((n) => !children.has(n));
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}_${i}`;
    if (!set.has(n)) return n;
  }
}
