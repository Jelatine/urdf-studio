// Closed-form feature constraints that rewrite a joint origin / axis.

import * as THREE from "three";
import { axisInParent, poseToMatrix, rotateOriginAlign, translateOrigin } from "../math/jointPose";
import type { FeatureAlignState, FeaturePick } from "../state/store";
import { store } from "../state/store";
import type { Joint, Pose, Robot } from "../types/urdf";
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

/** Map a world-space direction into the joint's parent link frame. */
function worldDirToParent(joint: Joint, d: THREE.Vector3): THREE.Vector3 {
  return d.clone().transformDirection(parentWorldMatrix(joint).invert()).normalize();
}

/** Map a world-space displacement into the joint's parent link frame. */
function worldDeltaToParent(joint: Joint, deltaW: THREE.Vector3): THREE.Vector3 {
  return deltaW.clone().transformDirection(parentWorldMatrix(joint).invert());
}

function v3(a: [number, number, number]) {
  return new THREE.Vector3(...a);
}

/** Joint origin world matrix (parent * origin), ignoring joint motion. */
function jointOriginWorld(joint: Joint): THREE.Matrix4 {
  return parentWorldMatrix(joint).multiply(poseToMatrix(joint.origin));
}

export type FeatureConstraintResult =
  | { ok: false }
  | { ok: true; kind: "axisAlign" }
  | { ok: true; kind: "origin"; joint: string };

/**
 * Apply the constraint described by `fa` onto the live robot.
 * For origin constraints, `afterOrigin` runs in the same undo step after the
 * geometric edit (used to fold the current joint value into URDF).
 */
export function applyFeatureConstraint(
  fa: FeatureAlignState,
  remapAxis: (name: string, direction: THREE.Vector3) => boolean,
  afterOrigin: (robot: Robot, joint: Joint) => void,
): FeatureConstraintResult {
  const st = store.getState();
  const robot = st.robot;
  if (!robot) return { ok: false };
  const joint = robot.joints.find((j) => j.name === fa.joint);
  if (!joint) {
    st.setStatus(`找不到关节 ${fa.joint}`, "error");
    return { ok: false };
  }

  const picks = fa.picks.map(featureInWorld);
  if (picks.some((pick) => pick === null)) {
    st.setStatus("找不到所选特征的 link", "error");
    return { ok: false };
  }
  try {
    switch (fa.constraint) {
      case "axisAlign":
        return applyAxisAlign(joint, picks[0]!, remapAxis);
      case "parallel":
        return applyParallel(joint, picks[0]!, picks[1]!, afterOrigin);
      case "collinear":
        return applyCollinear(joint, picks[0]!, picks[1]!, afterOrigin);
      case "concentric":
        return applyConcentric(joint, picks[0]!, picks[1]!, afterOrigin);
      default:
        return { ok: false };
    }
  } catch (e) {
    st.setStatus(e instanceof Error ? e.message : String(e), "error");
    return { ok: false };
  }
}

function commitOrigin(
  jointName: string,
  nextOrigin: Pose,
  afterOrigin: (robot: Robot, joint: Joint) => void,
): FeatureConstraintResult {
  store.getState().editRobot(
    (r) => {
      const j = r.joints.find((x) => x.name === jointName);
      if (!j) return;
      j.origin = nextOrigin;
      afterOrigin(r, j);
    },
    { snapJoints: true },
  );
  return { ok: true, kind: "origin", joint: jointName };
}

function applyAxisAlign(
  joint: Joint,
  line: FeaturePick,
  remapAxis: (name: string, direction: THREE.Vector3) => boolean,
): FeatureConstraintResult {
  if (line.kind !== "line" && line.kind !== "circle") {
    store.getState().setStatus("轴对齐需要一条直线或圆轴", "error");
    return { ok: false };
  }
  const dirParent = worldDirToParent(joint, v3(line.direction));
  if (dirParent.lengthSq() < 1e-12) {
    store.getState().setStatus("直线方向无效", "error");
    return { ok: false };
  }
  // Prefer direction closer to current axis (avoid 180° flips).
  const cur = axisInParent(joint);
  if (cur.dot(dirParent) < 0) dirParent.negate();
  return remapAxis(joint.name, dirParent) ? { ok: true, kind: "axisAlign" } : { ok: false };
}

function applyParallel(
  joint: Joint,
  moving: FeaturePick,
  reference: FeaturePick,
  afterOrigin: (robot: Robot, joint: Joint) => void,
): FeatureConstraintResult {
  const dMove = v3(moving.direction);
  const dRef = v3(reference.direction);
  if (dMove.lengthSq() < 1e-12 || dRef.lengthSq() < 1e-12) {
    store.getState().setStatus("线平行需要两条有效直线", "error");
    return { ok: false };
  }
  dMove.normalize();
  dRef.normalize();
  // Rotate joint origin so the moving direction (from current FK) becomes parallel
  // to the reference. Child content is not compensated — it must move in world.
  const dMoveP = worldDirToParent(joint, dMove);
  const dRefP = worldDirToParent(joint, dRef);
  if (dMoveP.dot(dRefP) < 0) dRefP.negate();
  return commitOrigin(joint.name, rotateOriginAlign(joint.origin, dMoveP, dRefP), afterOrigin);
}

function applyCollinear(
  joint: Joint,
  point: FeaturePick,
  line: FeaturePick,
  afterOrigin: (robot: Robot, joint: Joint) => void,
): FeatureConstraintResult {
  const pW = v3(point.origin);
  const l0 = v3(line.origin);
  const ld = v3(line.direction);
  if (ld.lengthSq() < 1e-12) {
    store.getState().setStatus("点共线需要有效参考直线", "error");
    return { ok: false };
  }
  ld.normalize();
  const projected = l0.clone().addScaledVector(ld, pW.clone().sub(l0).dot(ld));
  const deltaParent = worldDeltaToParent(joint, projected.sub(pW));
  return commitOrigin(joint.name, translateOrigin(joint.origin, deltaParent), afterOrigin);
}

function applyConcentric(
  joint: Joint,
  moving: FeaturePick,
  reference: FeaturePick,
  afterOrigin: (robot: Robot, joint: Joint) => void,
): FeatureConstraintResult {
  const deltaParent = worldDeltaToParent(joint, v3(reference.origin).sub(v3(moving.origin)));
  return commitOrigin(joint.name, translateOrigin(joint.origin, deltaParent), afterOrigin);
}

/** Resolve a link-local pick against the current robot pose. */
export function featureInWorld(pick: FeaturePick): FeaturePick | null {
  const link = getEngine()?.robotView.links.get(pick.link);
  if (!link) return null;
  link.updateWorldMatrix(true, false);
  const origin = v3(pick.origin).applyMatrix4(link.matrixWorld);
  const direction = v3(pick.direction).transformDirection(link.matrixWorld);
  return { ...pick, origin: origin.toArray(), direction: direction.toArray() };
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
