// Joint origin / axis math in URDF parent frames (rpy = fixed ZYX).

import * as THREE from "three";
import type { Joint, Pose, Robot, Vec3 } from "../types/urdf";
import { isMovable } from "../types/urdf";

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

export function poseToMatrix(p: Pose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...p.xyz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(p.rpy[0], p.rpy[1], p.rpy[2], "ZYX")),
    new THREE.Vector3(1, 1, 1),
  );
}

export function matrixToPose(m: THREE.Matrix4): Pose {
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(pos, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
  return { xyz: [r6(pos.x), r6(pos.y), r6(pos.z)], rpy: [r6(e.x), r6(e.y), r6(e.z)] };
}

export function normalizeAxis(axis: Vec3): THREE.Vector3 {
  const a = new THREE.Vector3(...axis);
  if (a.lengthSq() < 1e-12) a.set(0, 0, 1);
  return a.normalize();
}

/** Motion transform at joint value `q` in the joint frame. */
export function motionMatrix(joint: Joint, q: number): THREE.Matrix4 {
  const axis = normalizeAxis(joint.axis);
  if (joint.joint_type === "prismatic") return new THREE.Matrix4().makeTranslation(axis.x * q, axis.y * q, axis.z * q);
  return new THREE.Matrix4().makeRotationAxis(axis, q);
}

/** Fold current joint value into origin so the posed child becomes the new zero pose. */
export function foldJointValue(joint: Joint, q: number): Pose {
  if (Math.abs(q) < 1e-12) return { xyz: [...joint.origin.xyz] as Vec3, rpy: [...joint.origin.rpy] as Vec3 };
  return matrixToPose(poseToMatrix(joint.origin).multiply(motionMatrix(joint, q)));
}

export function shiftJointCalibration(joint: Joint, dq: number) {
  if (joint.limit) {
    joint.limit.lower -= dq;
    joint.limit.upper -= dq;
  }
  if (joint.safety_controller) {
    joint.safety_controller.soft_lower_limit -= dq;
    joint.safety_controller.soft_upper_limit -= dq;
  }
  if (joint.calibration) {
    if (joint.calibration.rising != null) joint.calibration.rising -= dq;
    if (joint.calibration.falling != null) joint.calibration.falling -= dq;
  }
}

/** Axis direction of `joint` expressed in the parent link frame. */
export function axisInParent(joint: Joint): THREE.Vector3 {
  const R = new THREE.Matrix4().extractRotation(poseToMatrix(joint.origin));
  return normalizeAxis(joint.axis).applyMatrix4(R);
}

/** Joint-frame unit axis (X=0, Y=1, Z=2) in the parent link frame. */
export function jointFrameAxisInParent(joint: Joint, axisIndex: 0 | 1 | 2): THREE.Vector3 {
  const R = new THREE.Matrix4().extractRotation(poseToMatrix(joint.origin));
  const v = new THREE.Vector3(axisIndex === 0 ? 1 : 0, axisIndex === 1 ? 1 : 0, axisIndex === 2 ? 1 : 0);
  return v.applyMatrix4(R).normalize();
}

/**
 * Reorient joint so motion axis is +Z of the joint frame and points along
 * `targetDirParent` (parent link frame). Compensates the child link so world
 * appearance at q=0 is unchanged.
 */
export function remapJointAxis(robot: Robot, joint: Joint, targetDirParent: THREE.Vector3) {
  const t = targetDirParent.clone();
  if (t.lengthSq() < 1e-12) return;
  t.normalize();

  const T = poseToMatrix(joint.origin);
  const pos = new THREE.Vector3();
  const RoldQ = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  T.decompose(pos, RoldQ, scl);

  const RnewQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
  joint.origin = matrixToPose(new THREE.Matrix4().compose(pos, RnewQ, new THREE.Vector3(1, 1, 1)));
  joint.axis = [0, 0, 1];

  const RoldM = new THREE.Matrix4().makeRotationFromQuaternion(RoldQ);
  const RnewM = new THREE.Matrix4().makeRotationFromQuaternion(RnewQ);
  const comp = RnewM.clone().invert().multiply(RoldM);
  compensateLinkFrame(robot, joint.child, comp);
}

/** Left-multiply a link's local content by `comp` (keeps world poses when the link frame changed). */
export function compensateLinkFrame(robot: Robot, linkName: string, comp: THREE.Matrix4) {
  const link = robot.links.find((l) => l.name === linkName);
  if (!link) return;
  const apply = (p: Pose): Pose => matrixToPose(comp.clone().multiply(poseToMatrix(p)));
  for (const v of link.visuals) v.origin = apply(v.origin);
  for (const c of link.collisions) c.origin = apply(c.origin);
  if (link.inertial) link.inertial.origin = apply(link.inertial.origin);
  for (const j of robot.joints) {
    if (j.parent === linkName) j.origin = apply(j.origin);
  }
}

/** Translate joint origin in the parent frame (keeps orientation). */
export function translateOrigin(pose: Pose, deltaParent: THREE.Vector3): Pose {
  return {
    xyz: [r6(pose.xyz[0] + deltaParent.x), r6(pose.xyz[1] + deltaParent.y), r6(pose.xyz[2] + deltaParent.z)],
    rpy: [...pose.rpy] as Vec3,
  };
}

/** Rotate joint origin about its position so a parent-frame direction maps onto another. */
export function rotateOriginAlign(pose: Pose, fromParent: THREE.Vector3, toParent: THREE.Vector3): Pose {
  const a = fromParent.clone();
  const b = toParent.clone();
  if (a.lengthSq() < 1e-12 || b.lengthSq() < 1e-12) return pose;
  a.normalize();
  b.normalize();
  if (a.dot(b) > 1 - 1e-10) return pose;
  const Rdelta = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(a, b));
  const T = poseToMatrix(pose);
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  T.decompose(pos, q, s);
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const Rnew = Rdelta.multiply(R);
  return matrixToPose(new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromRotationMatrix(Rnew), new THREE.Vector3(1, 1, 1)));
}

export function canSetJointZero(joint: Joint) {
  return isMovable(joint);
}

export function canRemapJointAxis(joint: Joint) {
  return joint.joint_type !== "fixed" && joint.joint_type !== "floating";
}
