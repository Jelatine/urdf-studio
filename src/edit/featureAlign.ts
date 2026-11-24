// Closed-form feature constraints that rewrite a joint origin / axis.

import * as THREE from "three";
import { axisInParent, poseToMatrix, remapJointAxis, rotateOriginAlign, translateOrigin } from "../math/jointPose";
import type { FeatureAlignState, FeaturePick } from "../state/store";
import { store } from "../state/store";
import type { Joint, Robot } from "../types/urdf";
import { getEngine } from "../viewport/engine";

function parentWorldMatrix(joint: Joint): THREE.Matrix4 {
  const eng = getEngine();
  const link = eng?.robotView.links.get(joint.parent);
  if (link) {
    link.updateWorldMatrix(true, false);
    return link.matrixWorld.clone();
  }
  return new THREE.Matrix4();
}

function worldDirToParent(joint: Joint, d: THREE.Vector3): THREE.Vector3 {
  const n = new THREE.Matrix3().getNormalMatrix(parentWorldMatrix(joint).invert());
  return d.clone().applyMatrix3(n).normalize();
}

function v3(a: [number, number, number]) {
  return new THREE.Vector3(...a);
}

/** Joint origin world matrix (parent * origin), ignoring joint motion. */
function jointOriginWorld(joint: Joint): THREE.Matrix4 {
  return parentWorldMatrix(joint).multiply(poseToMatrix(joint.origin));
}

/**
 * Apply the constraint described by `fa` onto the live robot.
 * Returns false when inputs are invalid.
 */
export function applyFeatureConstraint(fa: FeatureAlignState): boolean {
  const st = store.getState();
  const robot = st.robot;
  if (!robot) return false;
  const joint = robot.joints.find((j) => j.name === fa.joint);
  if (!joint) {
    st.setStatus(`找不到关节 ${fa.joint}`, "error");
    return false;
  }

  const picks = fa.picks;
  try {
    switch (fa.constraint) {
      case "axisAlign":
        return applyAxisAlign(robot, joint, picks[0]);
      case "parallel":
        return applyParallel(robot, joint, picks[0], picks[1]);
      case "collinear":
        return applyCollinear(robot, joint, picks[0], picks[1]);
      case "concentric":
        return applyConcentric(robot, joint, picks[0], picks[1]);
      default:
        return false;
    }
  } catch (e) {
    st.setStatus(e instanceof Error ? e.message : String(e), "error");
    return false;
  }
}

function commit(fn: (r: Robot) => void) {
  store.getState().editRobot(fn, { snapJoints: true });
}

function applyAxisAlign(_robot: Robot, joint: Joint, line: FeaturePick): boolean {
  if (line.kind !== "line" && line.kind !== "circle") {
    store.getState().setStatus("轴对齐需要一条直线或圆轴", "error");
    return false;
  }
  const dirParent = worldDirToParent(joint, v3(line.direction));
  if (dirParent.lengthSq() < 1e-12) {
    store.getState().setStatus("直线方向无效", "error");
    return false;
  }
  // Prefer direction closer to current axis (avoid 180° flips).
  const cur = axisInParent(joint);
  if (cur.dot(dirParent) < 0) dirParent.negate();
  commit((r) => {
    const j = r.joints.find((x) => x.name === joint.name);
    if (!j) return;
    remapJointAxis(r, j, dirParent);
  });
  return true;
}

function applyParallel(_robot: Robot, joint: Joint, moving: FeaturePick, reference: FeaturePick): boolean {
  const dMove = v3(moving.direction);
  const dRef = v3(reference.direction);
  if (dMove.lengthSq() < 1e-12 || dRef.lengthSq() < 1e-12) {
    store.getState().setStatus("线平行需要两条有效直线", "error");
    return false;
  }
  dMove.normalize();
  dRef.normalize();
  // Rotate joint origin so the moving direction (rigidly attached in world at
  // pick time via current FK) becomes parallel to reference. We approximate by
  // rotating the joint frame's orientation in the parent by the same delta.
  const dMoveP = worldDirToParent(joint, dMove);
  const dRefP = worldDirToParent(joint, dRef);
  if (dMoveP.dot(dRefP) < 0) dRefP.negate();
  // Do not compensate the child: the moving feature must rotate in world.
  commit((r) => {
    const j = r.joints.find((x) => x.name === joint.name);
    if (!j) return;
    j.origin = rotateOriginAlign(j.origin, dMoveP, dRefP);
  });
  return true;
}

function applyCollinear(_robot: Robot, joint: Joint, point: FeaturePick, line: FeaturePick): boolean {
  const pW = v3(point.origin);
  const l0 = v3(line.origin);
  const ld = v3(line.direction);
  if (ld.lengthSq() < 1e-12) {
    store.getState().setStatus("点共线需要有效参考直线", "error");
    return false;
  }
  ld.normalize();
  const projected = l0.clone().addScaledVector(ld, pW.clone().sub(l0).dot(ld));
  const deltaW = projected.sub(pW);
  const Rp = new THREE.Matrix3().getNormalMatrix(parentWorldMatrix(joint).invert());
  const deltaParent = deltaW.clone().applyMatrix3(Rp);
  commit((r) => {
    const j = r.joints.find((x) => x.name === joint.name);
    if (!j) return;
    j.origin = translateOrigin(j.origin, deltaParent);
  });
  return true;
}

function applyConcentric(_robot: Robot, joint: Joint, moving: FeaturePick, reference: FeaturePick): boolean {
  const a = v3(moving.origin);
  const b = v3(reference.origin);
  const deltaW = b.clone().sub(a);
  const Rp = new THREE.Matrix3().getNormalMatrix(parentWorldMatrix(joint).invert());
  const deltaParent = deltaW.clone().applyMatrix3(Rp);
  commit((r) => {
    const j = r.joints.find((x) => x.name === joint.name);
    if (!j) return;
    j.origin = translateOrigin(j.origin, deltaParent);
  });
  return true;
}

/** Project a world point onto the closest point of a feature for preview. */
export function featureEndpoints(pick: FeaturePick, length = 0.08): { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 } {
  const o = v3(pick.origin);
  const d = v3(pick.direction);
  if (d.lengthSq() < 1e-12) return { a: o.clone(), b: o.clone(), c: o.clone() };
  d.normalize();
  return {
    a: o.clone().addScaledVector(d, -length),
    b: o.clone().addScaledVector(d, length),
    c: o.clone(),
  };
}

export function jointOriginWorldPos(jointName: string): THREE.Vector3 | null {
  const robot = store.getState().robot;
  const joint = robot?.joints.find((j) => j.name === jointName);
  if (!joint) return null;
  const m = jointOriginWorld(joint);
  return new THREE.Vector3().setFromMatrixPosition(m);
}
