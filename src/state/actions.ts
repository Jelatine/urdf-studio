import * as THREE from "three";
import { backend, type OpenedProject, type SaveMode } from "../io/project";
import { addMesh, allMeshes, clearMeshes, getMesh, isModified, loadMesh, markSaved, meshFiles, modifiedFiles, type MeshFormat } from "../mesh/registry";
import {
  childrenMap,
  isMovable,
  jointRange,
  newJoint,
  newLink,
  uniqueName,
  type Geometry,
  type Issue,
  type Joint,
  type Pose,
  type Robot,
} from "../types/urdf";
import { MeshEditor, parseUrdf, resolveMesh, siblingReference, validateUrdf, writeUrdf, type FitOptions, type FitResult } from "../wasm";
import { redoStep, undoGroup, undoStep, type HistoryStep } from "./history";
import {
  axisInParent,
  canRemapJointAxis,
  canSetJointZero,
  foldJointValue,
  jointFrameAxisInParent,
  remapJointAxis as remapAxisMath,
  shiftJointCalibration,
} from "../math/jointPose";
import { applyFeatureConstraint } from "../edit/featureAlign";
import { getEngine } from "../viewport/engine";
import {
  store,
  type ConfirmRequest,
  type EditTarget,
  type FeatureAlignState,
  type FeatureConstraint,
  type FeaturePick,
  type FitTarget,
  type ProjectInfo,
} from "./store";

/** World-space unit direction expressed in a link's local frame (via live FK). */
function worldDirInParent(parentLink: string, worldDir: THREE.Vector3): THREE.Vector3 {
  const parent = getEngine()?.robotView.links.get(parentLink);
  if (!parent) return worldDir.clone().normalize();
  parent.updateWorldMatrix(true, false);
  const n = new THREE.Matrix3().getNormalMatrix(parent.matrixWorld.clone().invert());
  return worldDir.clone().applyMatrix3(n).normalize();
}

const s = () => store.getState();

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function meshFilenames(robot: Robot): string[] {
  const out = new Set<string>();
  for (const l of robot.links) {
    for (const g of [...l.visuals.map((v) => v.geometry), ...l.collisions.map((c) => c.geometry)]) {
      if (g.type === "mesh") out.add(g.filename);
    }
  }
  return [...out];
}

/** Resolves and loads meshes referenced by the robot that are not loaded yet. */
export async function syncMeshes() {
  const { robot, project } = s();
  if (!robot || !project) return;
  const paths = { ...s().meshPaths };
  const info = { ...s().meshInfo };
  const toLoad: string[] = [];
  for (const f of meshFilenames(robot)) {
    if (!(f in paths)) paths[f] = resolveMesh(project.urdfPath, f, project.files) ?? null;
    const p = paths[f];
    if (!p) continue;
    if (!info[p]) {
      info[p] = getMesh(p) ? { status: "ready" } : { status: "loading" };
      if (!getMesh(p)) toLoad.push(p);
    }
  }
  store.setState({ meshPaths: paths, meshInfo: info });
  await Promise.all(
    toLoad.map(async (p) => {
      try {
        const e = await loadMesh(p);
        store.setState((st) => ({
          meshInfo: { ...st.meshInfo, [p]: { status: "ready", format: e.format } },
          meshVersion: st.meshVersion + 1,
        }));
      } catch (e) {
        store.setState((st) => ({ meshInfo: { ...st.meshInfo, [p]: { status: "error", error: errMsg(e) } } }));
      }
    }),
  );
  const missing = meshFilenames(robot).filter((f) => !paths[f]);
  if (missing.length) s().setStatus(`有 ${missing.length} 个网格文件未找到: ${missing.slice(0, 3).join(", ")}`, "error");
}

export function initialJointValues(robot: Robot, prev: Record<string, number> = {}) {
  const v: Record<string, number> = {};
  for (const j of robot.joints) {
    if (!isMovable(j)) continue;
    const [lo, hi] = jointRange(j);
    const cur = prev[j.name] ?? (lo <= 0 && hi >= 0 ? 0 : lo);
    v[j.name] = Math.min(hi, Math.max(lo, cur));
  }
  return v;
}

/** Applies mimic joints on top of the independent joint values. */
export function effectiveJointValues(robot: Robot, values: Record<string, number>): Record<string, number> {
  const out = { ...values };
  const byName = new Map(robot.joints.map((j) => [j.name, j]));
  for (let pass = 0; pass < 4; pass++) {
    for (const j of robot.joints) {
      if (!j.mimic || !byName.has(j.mimic.joint)) continue;
      out[j.name] = (out[j.mimic.joint] ?? 0) * j.mimic.multiplier + j.mimic.offset;
    }
  }
  return out;
}

export function validate() {
  const { robot } = s();
  if (!robot) return;
  try {
    store.setState({ issues: validateUrdf(robot) as Issue[] });
  } catch (e) {
    store.setState({ issues: [{ level: "error", message: errMsg(e), target: null }] });
  }
}

function loadRobot(text: string, project: ProjectInfo) {
  const robot = parseUrdf(text) as Robot;
  clearMeshes();
  store.setState({
    project,
    robot,
    robotDirty: false,
    robotUndo: [],
    robotRedo: [],
    robotUndoSeq: [],
    robotRedoSeq: [],
    jointSnapUndo: [],
    jointSnapRedo: [],
    meshPaths: {},
    meshInfo: {},
    meshVersion: s().meshVersion + 1,
    selection: robot.links.length ? { kind: "link", name: robot.links[0].name } : null,
    mode: "object",
    editTarget: null,
    meshStats: null,
    lastOp: null,
    featureAlign: null,
    jointValues: initialJointValues(robot),
    keyframes: [],
    playing: false,
  });
  validate();
  s().setStatus(`已加载 ${robot.name}: ${robot.links.length} 个 link, ${robot.joints.length} 个 joint`, "ok");
  void syncMeshes();
}

/** Shows the in-app confirmation dialog and resolves with the chosen button id (null = cancelled). */
export function ask(req: Omit<ConfirmRequest, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    s().confirm?.resolve(null);
    store.setState({
      confirm: {
        ...req,
        resolve: (id) => {
          store.setState({ confirm: null });
          resolve(id);
        },
      },
    });
  });
}

/** Asks what to do with unsaved changes; resolves true when it's OK to continue. */
export async function confirmDiscard(): Promise<boolean> {
  if (!hasUnsavedChanges()) return true;
  const name = s().robot?.name ?? "当前项目";
  const choice = await ask({
    title: "未保存的修改",
    message: `“${name}” 有未保存的修改。继续之前要保存吗？`,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "discard", label: "不保存", kind: "danger" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    defaultId: "save",
  });
  if (choice === "save") return saveProject("inplace");
  return choice === "discard";
}

/** Project paths of the meshes the robot references. */
function referencedMeshPaths(): Set<string> {
  const { robot, meshPaths } = s();
  const out = new Set<string>();
  for (const f of robot ? meshFilenames(robot) : []) {
    const p = meshPaths[f];
    if (p) out.add(p);
  }
  return out;
}

export function hasUnsavedChanges() {
  const used = referencedMeshPaths();
  return s().robotDirty || allMeshes().some((m) => used.has(m.path) && isModified(m));
}

export async function openProject(opened?: OpenedProject | null) {
  if (!(await confirmDiscard())) return;
  try {
    store.setState({ busy: "正在打开…" });
    const p = opened ?? (await backend.open());
    if (!p) return;
    loadRobot(p.urdfText, { kind: p.kind, origin: p.origin, urdfPath: p.urdfPath, candidates: p.candidates, files: p.files });
  } catch (e) {
    s().setStatus(`打开失败: ${errMsg(e)}`, "error");
  } finally {
    store.setState({ busy: null });
  }
}

export async function openFolderBrowser() {
  if (!backend.openFolder) return;
  const p = await backend.openFolder();
  if (p) await openProject(p);
}

export async function switchUrdf(path: string) {
  const { project } = s();
  if (!project || !(await confirmDiscard())) return;
  try {
    const text = await backend.selectUrdf(path);
    loadRobot(text, { ...project, urdfPath: path });
  } catch (e) {
    s().setStatus(`切换失败: ${errMsg(e)}`, "error");
  }
}

export async function newProject() {
  if (!(await confirmDiscard())) return;
  const urdf = `<?xml version="1.0"?>\n<robot name="new_robot">\n  <link name="base_link">\n    <visual>\n      <geometry><box size="0.2 0.2 0.1"/></geometry>\n    </visual>\n  </link>\n</robot>\n`;
  const p = await backend.newProject(urdf);
  loadRobot(p.urdfText, { kind: p.kind, origin: p.origin, urdfPath: p.urdfPath, candidates: p.candidates, files: p.files });
}

/** Resolves true when the project was saved. */
export async function saveProject(mode: SaveMode): Promise<boolean> {
  const { robot, project } = s();
  if (!robot || !project) return false;
  try {
    store.setState({ busy: "正在保存…" });
    const urdfText = writeUrdf(robot);
    const used = referencedMeshPaths();
    // Meshes no longer referenced (e.g. an undone separate) are not written.
    const byMesh = [...modifiedFiles()].filter(([p]) => used.has(p));
    const modified = new Map(byMesh.flatMap(([, files]) => [...files]));
    // Companion files (OBJ material libraries) travel with their meshes.
    const include = new Set([...used].flatMap((p) => {
      const e = getMesh(p);
      return e ? meshFiles(e) : [p];
    }));
    for (const p of modified.keys()) include.add(p);
    const saved = await backend.save({ urdfText, modified, include: [...include], remove: [], mode });
    if (!saved) return false;
    markSaved(byMesh.map(([p]) => p));
    const files = new Set(project.files);
    for (const p of modified.keys()) files.add(p);
    store.setState({ robotDirty: false, project: { ...project, files: [...files] }, meshVersion: s().meshVersion + 1 });
    s().setStatus(`已保存到 ${saved}`, "ok");
    return true;
  } catch (e) {
    s().setStatus(`保存失败: ${errMsg(e)}`, "error");
    return false;
  } finally {
    store.setState({ busy: null });
  }
}

// ------------------------------------------------------------ robot editing

export function editRobot(fn: (r: Robot) => void, mergeOrOpts: boolean | { merge?: boolean; snapJoints?: boolean } = false) {
  const opts = typeof mergeOrOpts === "boolean" ? { merge: mergeOrOpts } : mergeOrOpts;
  s().editRobot(fn, opts);
  validate();
}

// ------------------------------------------------------------ undo / redo

/** Undo in any mode: the most recent robot or mesh step (see history.ts). */
export function undo() {
  finishHistoryStep(undoStep(s().mode === "object"), "撤销", "没有可撤销的操作");
}

export function redo() {
  finishHistoryStep(redoStep(s().mode === "object"), "重做", "没有可重做的操作");
}

function editTargetValid(t: EditTarget): boolean {
  const l = s().robot?.links.find((x) => x.name === t.link);
  const g = (t.role === "visual" ? l?.visuals[t.index] : l?.collisions[t.index])?.geometry;
  return g?.type === "mesh" && s().meshPaths[g.filename] === t.meshPath;
}

function finishHistoryStep(step: HistoryStep | null, verb: string, none: string) {
  if (!step) {
    s().setStatus(none);
    return;
  }
  if (step.robot) {
    validate();
    store.setState({ jointValues: initialJointValues(s().robot!, s().jointValues) });
  }
  store.setState((st) => ({ lastOp: null, meshVersion: st.meshVersion + 1 }));
  const t = s().editTarget;
  if (s().mode === "edit" && t) {
    // Undoing e.g. "convert to mesh" removes the mesh being edited.
    if (!editTargetValid(t)) exitEditMode();
    else store.setState({ meshStats: getMesh(t.meshPath)?.editor.stats() ?? null });
  }
  s().setStatus(`${verb}: ${[...new Set(step.labels)].join(" + ")}`);
}

export function renameLink(oldName: string, name: string) {
  if (!name || name === oldName) return;
  const { robot } = s();
  if (robot?.links.some((l) => l.name === name)) {
    s().setStatus(`link 名称 "${name}" 已存在`, "error");
    return;
  }
  editRobot((r) => {
    for (const l of r.links) if (l.name === oldName) l.name = name;
    for (const j of r.joints) {
      if (j.parent === oldName) j.parent = name;
      if (j.child === oldName) j.child = name;
    }
  });
  store.setState({ selection: { kind: "link", name } });
}

export function renameJoint(oldName: string, name: string) {
  if (!name || name === oldName) return;
  if (s().robot?.joints.some((j) => j.name === name)) {
    s().setStatus(`joint 名称 "${name}" 已存在`, "error");
    return;
  }
  editRobot((r) => {
    for (const j of r.joints) {
      if (j.name === oldName) j.name = name;
      if (j.mimic?.joint === oldName) j.mimic.joint = name;
    }
  });
  const jv = { ...s().jointValues };
  if (oldName in jv) {
    jv[name] = jv[oldName];
    delete jv[oldName];
  }
  store.setState({ selection: { kind: "joint", name }, jointValues: jv });
}

/** Adds a child link connected by a new joint to `parent`. */
export function addChildLink(parent?: string) {
  const { robot, selection } = s();
  if (!robot) return;
  const parentName =
    parent ??
    (selection?.kind === "link"
      ? selection.name
      : selection?.kind === "joint"
        ? robot.joints.find((j) => j.name === selection.name)?.child
        : robot.links[0]?.name);
  const linkName = uniqueName("link", robot.links.map((l) => l.name));
  const jointName = uniqueName("joint", robot.joints.map((j) => j.name));
  editRobot((r) => {
    const l = newLink(linkName);
    l.visuals.push({ name: null, origin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] }, geometry: { type: "cylinder", radius: 0.03, length: 0.1 }, material: null });
    r.links.push(l);
    if (parentName) {
      const j = newJoint(jointName, parentName, linkName);
      j.joint_type = "revolute";
      j.origin.xyz = [0, 0, 0.1];
      j.limit = { lower: -Math.PI / 2, upper: Math.PI / 2, effort: 10, velocity: 1 };
      r.joints.push(j);
    }
  });
  store.setState({ selection: { kind: "link", name: linkName }, jointValues: initialJointValues(s().robot!, s().jointValues) });
}

function subtree(robot: Robot, link: string): { links: Set<string>; joints: Set<string> } {
  const kids = childrenMap(robot);
  const links = new Set<string>();
  const joints = new Set<string>();
  const stack = [link];
  while (stack.length) {
    const l = stack.pop()!;
    if (links.has(l)) continue;
    links.add(l);
    for (const j of kids.get(l) ?? []) {
      joints.add(j.name);
      stack.push(j.child);
    }
  }
  for (const j of robot.joints) if (links.has(j.child)) joints.add(j.name);
  return { links, joints };
}

/** Deletes the selected link (or the joint's child link) with its subtree. */
export function deleteSelection() {
  const { robot, selection } = s();
  if (!robot || !selection) return;
  const link = selection.kind === "link" ? selection.name : robot.joints.find((j) => j.name === selection.name)?.child;
  if (!link) return;
  const { links, joints } = subtree(robot, link);
  if (links.size >= robot.links.length) {
    s().setStatus("不能删除全部 link", "error");
    return;
  }
  editRobot((r) => {
    r.links = r.links.filter((l) => !links.has(l.name));
    r.joints = r.joints.filter((j) => !joints.has(j.name));
  });
  store.setState({ selection: null });
  s().setStatus(`已删除 ${links.size} 个 link, ${joints.size} 个 joint（Ctrl+Z 撤销）`, "ok");
}

/** Re-parents a link (drag & drop in the outliner). */
export function reparent(child: string, newParent: string) {
  const { robot } = s();
  if (!robot || child === newParent) return;
  if (subtree(robot, child).links.has(newParent)) {
    s().setStatus("不能把 link 移到它自己的子树下", "error");
    return;
  }
  editRobot((r) => {
    const j = r.joints.find((x) => x.child === child);
    if (j) j.parent = newParent;
    else r.joints.push(newJoint(uniqueName(`${child}_joint`, r.joints.map((x) => x.name)), newParent, child));
  });
}

export function updateJoint(name: string, fn: (j: Joint) => void, merge = false) {
  editRobot((r) => {
    const j = r.joints.find((x) => x.name === name);
    if (j) fn(j);
  }, merge);
  const robot = s().robot!;
  store.setState({ jointValues: initialJointValues(robot, s().jointValues) });
}

/** Absorb the current joint value into URDF origin and treat it as the new zero. */
export function setJointZero(name: string) {
  const { robot, jointValues, keyframes } = s();
  if (!robot) return;
  const joint = robot.joints.find((j) => j.name === name);
  if (!joint || !canSetJointZero(joint)) {
    s().setStatus("该关节类型不支持设为零点", "error");
    return;
  }
  if (joint.mimic) {
    s().setStatus("mimic 关节请对其跟随的源关节设零点", "error");
    return;
  }
  const q = jointValues[name] ?? 0;
  if (Math.abs(q) < 1e-12) {
    s().setStatus("当前值已是零，无需设零点");
    return;
  }
  editRobot(
    (r) => {
      const j = r.joints.find((x) => x.name === name);
      if (!j) return;
      j.origin = foldJointValue(j, q);
      shiftJointCalibration(j, q);
      for (const m of r.joints) {
        if (m.mimic?.joint === name) m.mimic.offset -= q * m.mimic.multiplier;
      }
    },
    { snapJoints: true },
  );
  const nextValues = { ...jointValues, [name]: 0 };
  const nextFrames = keyframes.map((kf) => {
    const copy = { ...kf };
    if (name in copy) copy[name] = (copy[name] ?? 0) - q;
    return copy;
  });
  store.setState({
    jointValues: initialJointValues(s().robot!, nextValues),
    keyframes: nextFrames,
    playing: false,
  });
  const unit = joint.joint_type === "prismatic" ? "m" : "rad";
  s().setStatus(`已将 ${name} 当前位置设为零点 (Δ=${q.toFixed(4)} ${unit})`, "ok");
}

export type AxisRemapTarget = "jointX" | "jointY" | "jointZ" | "worldX" | "worldY" | "worldZ";

/** Remap motion axis; folds current q into origin first when q ≠ 0 (one undo step). */
export function remapJointAxisDir(name: string, target: AxisRemapTarget | THREE.Vector3) {
  const { robot, jointValues, keyframes } = s();
  if (!robot) return;
  const joint = robot.joints.find((j) => j.name === name);
  if (!joint || !canRemapJointAxis(joint)) {
    s().setStatus("该关节类型不支持轴重定向", "error");
    return;
  }
  if (joint.mimic) {
    s().setStatus("mimic 关节请对其跟随的源关节调整轴", "error");
    return;
  }
  const q = jointValues[name] ?? 0;

  // Resolve target in parent frame from the pre-edit joint (joint-local presets).
  let dir: THREE.Vector3;
  if (target instanceof THREE.Vector3) dir = target.clone();
  else if (target === "jointX") dir = jointFrameAxisInParent(joint, 0);
  else if (target === "jointY") dir = jointFrameAxisInParent(joint, 1);
  else if (target === "jointZ") dir = jointFrameAxisInParent(joint, 2);
  else if (target === "worldX") dir = worldDirInParent(joint.parent, new THREE.Vector3(1, 0, 0));
  else if (target === "worldY") dir = worldDirInParent(joint.parent, new THREE.Vector3(0, 1, 0));
  else dir = worldDirInParent(joint.parent, new THREE.Vector3(0, 0, 1));

  const cur = axisInParent(joint);
  if (Math.abs(q) < 1e-12 && cur.dot(dir.clone().normalize()) > 1 - 1e-8 && Math.abs(joint.axis[2]) > 0.99) {
    s().setStatus("轴已对齐目标方向");
    return;
  }

  editRobot(
    (r) => {
      const j = r.joints.find((x) => x.name === name);
      if (!j) return;
      if (Math.abs(q) > 1e-12) {
        j.origin = foldJointValue(j, q);
        shiftJointCalibration(j, q);
        for (const m of r.joints) {
          if (m.mimic?.joint === name) m.mimic.offset -= q * m.mimic.multiplier;
        }
      }
      // After folding, joint-local X/Y/Z targets still refer to the pre-fold frame
      // for world/explicit vectors; joint-local presets were captured above.
      remapAxisMath(r, j, dir);
    },
    { snapJoints: true },
  );
  const nextValues = { ...jointValues, [name]: 0 };
  const nextFrames =
    Math.abs(q) > 1e-12
      ? keyframes.map((kf) => {
          const copy = { ...kf };
          if (name in copy) copy[name] = (copy[name] ?? 0) - q;
          return copy;
        })
      : keyframes;
  store.setState({
    jointValues: initialJointValues(s().robot!, nextValues),
    keyframes: nextFrames,
    playing: false,
  });
  s().setStatus(`已重定向 ${name} 的运动轴（已补偿子 link）`, "ok");
}

const CONSTRAINT_PICKS: Record<FeatureConstraint, { moving: string; reference: string; count: number }> = {
  parallel: { moving: "移动侧直线", reference: "参考直线", count: 2 },
  collinear: { moving: "移动侧点", reference: "参考直线", count: 2 },
  concentric: { moving: "移动侧圆心", reference: "参考圆心", count: 2 },
  axisAlign: { moving: "目标直线（关节轴对齐到此）", reference: "", count: 1 },
};

export function beginFeatureAlign(opts: { joint?: string; constraint?: FeatureConstraint; axisOnly?: boolean } = {}) {
  const { robot, selection, mode } = s();
  if (!robot || mode === "edit") {
    s().setStatus("请在对象模式下使用特征对齐", "error");
    return;
  }
  const jointName =
    opts.joint ??
    (selection?.kind === "joint" ? selection.name : selection?.kind === "link" ? robot.joints.find((j) => j.child === selection.name)?.name : undefined);
  if (!jointName || !robot.joints.some((j) => j.name === jointName)) {
    s().setStatus("请先选择要对齐的关节（或子 link）", "error");
    return;
  }
  const constraint = opts.constraint ?? (opts.axisOnly ? "axisAlign" : "concentric");
  const state: FeatureAlignState = {
    joint: jointName,
    constraint,
    picks: [],
    axisOnly: !!opts.axisOnly || constraint === "axisAlign",
  };
  store.setState({
    featureAlign: state,
    selection: { kind: "joint", name: jointName },
    gizmo: "none",
    modalHint: featureAlignHint(state),
  });
  s().setStatus(featureAlignHint(state));
}

export function cancelFeatureAlign() {
  if (!s().featureAlign) return;
  store.setState({ featureAlign: null, modalHint: null });
  s().setStatus("已取消特征对齐");
}

export function setFeatureAlignConstraint(constraint: FeatureConstraint) {
  const fa = s().featureAlign;
  if (!fa) return;
  const next: FeatureAlignState = {
    ...fa,
    constraint,
    picks: [],
    axisOnly: constraint === "axisAlign",
  };
  store.setState({ featureAlign: next, modalHint: featureAlignHint(next) });
  s().setStatus(featureAlignHint(next));
}

export function featureAlignHint(fa: FeatureAlignState): string {
  const meta = CONSTRAINT_PICKS[fa.constraint];
  const need = meta.count;
  if (fa.picks.length >= need) return `特征已选齐 — Enter 应用，Esc 取消`;
  const which = fa.picks.length === 0 ? meta.moving : meta.reference;
  const kindHint =
    fa.constraint === "concentric"
      ? "点击圆柱面附近以拟合圆心"
      : fa.constraint === "collinear" && fa.picks.length === 0
        ? "点击顶点或边中点"
        : "点击网格边以拾取直线";
  return `特征对齐 [${fa.joint}] ${fa.constraint}: 选择${which}（${kindHint}）(${fa.picks.length}/${need})`;
}

export function pushFeaturePick(pick: FeaturePick) {
  const fa = s().featureAlign;
  if (!fa) return;
  const need = CONSTRAINT_PICKS[fa.constraint].count;
  const picks = [...fa.picks, pick].slice(0, need);
  const next = { ...fa, picks };
  store.setState({ featureAlign: next, modalHint: featureAlignHint(next) });
  s().setStatus(featureAlignHint(next));
  if (picks.length >= need) applyFeatureAlign();
}

export function applyFeatureAlign() {
  const fa = s().featureAlign;
  const robot = s().robot;
  if (!fa || !robot) return;
  const need = CONSTRAINT_PICKS[fa.constraint].count;
  if (fa.picks.length < need) {
    s().setStatus(featureAlignHint(fa), "error");
    return;
  }
  const ok = applyFeatureConstraint(fa);
  if (ok) {
    const robot = s().robot!;
    store.setState({
      featureAlign: null,
      modalHint: null,
      jointValues: initialJointValues(robot, s().jointValues),
    });
    s().setStatus(`已应用特征对齐 (${fa.constraint}) 到 ${fa.joint}`, "ok");
  }
}

// ---------------------------------------------------------- mesh geometry

function dirOf(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function relativePath(fromDir: string, to: string) {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** Picks a new mesh path and URDF reference next to the project's meshes. */
export function newMeshLocation(base: string): { path: string; reference: string } {
  const { project, meshPaths } = s();
  const urdfDir = dirOf(project?.urdfPath ?? "urdf/robot.urdf");
  const existing = Object.values(meshPaths).find((p): p is string => !!p);
  const meshDir = existing ? dirOf(existing) : [dirOf(urdfDir), "meshes"].filter(Boolean).join("/");
  const taken = new Set([...(project?.files ?? []), ...allMeshes().map((m) => m.path)]);
  let name = `${base}.stl`;
  for (let i = 1; taken.has(meshDir ? `${meshDir}/${name}` : name); i++) name = `${base}_${i}.stl`;
  const path = meshDir ? `${meshDir}/${name}` : name;
  return { path, reference: relativePath(urdfDir, path) };
}

/** Registers a new mesh file (in memory until saved). */
export function registerNewMesh(path: string, reference: string, editor: MeshEditor, format: MeshFormat = "stl") {
  addMesh(path, editor, format);
  const project = s().project!;
  store.setState({
    meshPaths: { ...s().meshPaths, [reference]: path },
    meshInfo: { ...s().meshInfo, [path]: { status: "ready", format } },
    project: { ...project, files: [...project.files, path] },
    meshVersion: s().meshVersion + 1,
  });
}

function primitiveEditor(g: Geometry): MeshEditor | null {
  const ed = MeshEditor.empty();
  const scale = (x: number, y: number, z: number) =>
    ed.run({ op: "transform", matrix: [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1] });
  if (g.type === "box") {
    ed.run({ op: "add_primitive", shape: "cube", size: 1 });
    scale(...g.size);
  } else if (g.type === "cylinder") {
    ed.run({ op: "add_primitive", shape: "cylinder", size: 1, segments: 32 });
    scale(g.radius * 2, g.radius * 2, g.length);
  } else if (g.type === "sphere") {
    ed.run({ op: "add_primitive", shape: "uv_sphere", size: 1, segments: 32, rings: 16 });
    scale(g.radius * 2, g.radius * 2, g.radius * 2);
  } else {
    ed.free();
    return null;
  }
  ed.run({ op: "select_all", action: "deselect" });
  ed.clearHistory();
  return ed;
}

/** Converts a box/cylinder/sphere into an editable STL mesh. */
export function convertToMesh(link: string, role: "visual" | "collision", index: number) {
  const robot = s().robot;
  const l = robot?.links.find((x) => x.name === link);
  const item = role === "visual" ? l?.visuals[index] : l?.collisions[index];
  if (!item) return;
  const ed = primitiveEditor(item.geometry);
  if (!ed) return;
  const { path, reference } = newMeshLocation(`${link}_${role}${index}`);
  registerNewMesh(path, reference, ed);
  editRobot((r) => {
    const rl = r.links.find((x) => x.name === link)!;
    const it = role === "visual" ? rl.visuals[index] : rl.collisions[index];
    it.geometry = { type: "mesh", filename: reference, scale: null };
  });
  s().setStatus(`已转换为网格 ${path}（保存时写入）`, "ok");
}

/**
 * Converts a mesh file to another format (STL / OBJ / DAE): writes a copy
 * next to it (on save) and points every reference to the file at the copy.
 * Material slots carry over as far as the target format allows.
 */
export function convertMeshFormat(reference: string, format: MeshFormat) {
  const { project, meshPaths } = s();
  const path = meshPaths[reference];
  const entry = getMesh(path);
  if (!project || !path || !entry) return;
  if (entry.format === format) return;
  if (s().mode === "edit") {
    s().setStatus("请先退出编辑模式再转换格式", "error");
    return;
  }
  const stem = path.replace(/\.[^./]+$/, "");
  const taken = new Set([...project.files, ...allMeshes().map((m) => m.path)]);
  let newPath = `${stem}.${format}`;
  for (let i = 1; taken.has(newPath); i++) newPath = `${stem}_${i}.${format}`;
  const newRef = siblingReference(reference, newPath.split("/").pop()!);
  registerNewMesh(newPath, newRef, entry.editor.clone(), format);
  editRobot((r) => {
    for (const l of r.links) {
      for (const it of [...l.visuals, ...l.collisions]) {
        if (it.geometry.type === "mesh" && it.geometry.filename === reference) it.geometry.filename = newRef;
      }
    }
  });
  const colors = (entry.editor.materials() as unknown[]).length;
  const note = colors && format === "stl" ? "，STL 仅保留颜色 (不含材质名与透明度)" : "";
  s().setStatus(`已转换为 ${newPath}（保存时写入${note}）`, "ok");
}

// ------------------------------------------------------- primitive fitting

export interface FittedShape {
  /** In the link frame, ready to use as a URDF <origin>. */
  origin: Pose;
  geometry: Geometry;
  result: FitResult;
}

/**
 * "replace_collision": replaces all of the link's collisions (fitting a visual).
 * "replace_source": replaces what was fitted — the whole visual/collision item,
 *   or, for a selection, removes the selected part from the mesh and adds the
 *   shapes next to the item.
 * "replace_mesh": replaces the selection inside the edited mesh (`fitReplaceInMesh`).
 */
export type FitOutput = "add_collision" | "replace_collision" | "add_visual" | "replace_source" | "replace_mesh";

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0;

function geometryItem(link: string, role: "visual" | "collision", index: number) {
  const l = s().robot?.links.find((x) => x.name === link);
  return role === "visual" ? l?.visuals[index] : l?.collisions[index];
}

/** Opens the fit dialog for the edited mesh's selection, or a whole mesh in object mode. */
export function openFitDialog(target?: FitTarget) {
  const st = s();
  let t: FitTarget | null = target ?? null;
  if (!t && st.mode === "edit" && st.editTarget) t = { ...st.editTarget, all: false };
  if (!t) {
    const found = findEditTarget();
    if (found) t = { ...found, all: true };
  }
  if (!t) {
    s().setStatus("所选 link 没有可拟合的网格", "error");
    return;
  }
  store.setState({ fitTarget: t, dialog: "fit" });
}

/** Fits shapes to the target mesh and expresses them in the link frame. Throws on failure. */
export function computeFit(t: FitTarget, opts: Omit<FitOptions, "all" | "scale">): FittedShape[] {
  const item = geometryItem(t.link, t.role, t.index);
  const entry = getMesh(t.meshPath);
  if (!item || item.geometry.type !== "mesh" || !entry) throw new Error("网格不可用");
  const scale = item.geometry.scale ?? [1, 1, 1];
  const results = entry.editor.fitPrimitives({ ...opts, all: t.all, scale }) as FitResult[];
  // The mesh scale applies inside the <origin> frame, so compose origin * fit.
  const one = new THREE.Vector3(1, 1, 1);
  const o = item.origin;
  const originM = new THREE.Matrix4().compose(
    new THREE.Vector3(...o.xyz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rpy[0], o.rpy[1], o.rpy[2], "ZYX")),
    one,
  );
  return results.map((r) => {
    const m = originM.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...r.center), new THREE.Quaternion(...r.rotation), one));
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(pos, q, new THREE.Vector3());
    const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
    const g = r.geometry;
    const geometry: Geometry =
      g.type === "box"
        ? { type: "box", size: [r6(g.size[0]), r6(g.size[1]), r6(g.size[2])] }
        : g.type === "cylinder"
          ? { type: "cylinder", radius: r6(g.radius), length: r6(g.length) }
          : { type: "sphere", radius: r6(g.radius) };
    return { origin: { xyz: [r6(pos.x), r6(pos.y), r6(pos.z)], rpy: [r6(e.x), r6(e.y), r6(e.z)] }, geometry, result: r };
  });
}

export function applyFit(t: FitTarget, shapes: FittedShape[], output: Exclude<FitOutput, "replace_mesh">) {
  if (!shapes.length) return;
  const st = s();
  const editing = st.mode === "edit" && st.editTarget?.link === t.link && st.editTarget.role === t.role && st.editTarget.index === t.index;
  const entry = getMesh(t.meshPath);
  // A selection fit removes the fitted part from the mesh; the item itself
  // goes away when nothing of the mesh remains.
  const cut = output === "replace_source" && !t.all && !!entry;
  let removeItem = output === "replace_source" && t.all;
  if (cut && entry.editor.stats().verts === entry.editor.stats().selVerts) removeItem = true;
  if ((removeItem && editing) || (output === "replace_collision" && st.mode === "edit" && st.editTarget?.link === t.link && st.editTarget.role === "collision")) {
    exitEditMode();
  }
  undoGroup(() => {
    if (cut && !removeItem) {
      entry.editor.run({ op: "delete", kind: entry.editor.stats().selFaces ? "faces" : "verts" });
      store.setState((x) => ({ meshVersion: x.meshVersion + 1, meshStats: editing ? entry.editor.stats() : x.meshStats }));
    }
    editRobot((r) => {
      const l = r.links.find((x) => x.name === t.link)!;
      const src = t.role === "visual" ? l.visuals[t.index] : l.collisions[t.index];
      const single = shapes.length === 1 && removeItem;
      const name = (i: number) => (single ? src?.name ?? null : shapes.length > 1 ? `fit_${i}` : null);
      const material = t.role === "visual" ? structuredClone(l.visuals[t.index]?.material ?? null) : null;
      const visuals = shapes.map((sh, i) => ({ name: name(i), origin: sh.origin, geometry: sh.geometry, material }));
      const cols = shapes.map((sh, i) => ({ name: name(i), origin: sh.origin, geometry: sh.geometry }));
      if (output === "add_visual") l.visuals.push(...visuals);
      else if (output === "add_collision") l.collisions.push(...cols);
      else if (output === "replace_collision") l.collisions = cols;
      // New shapes go after the source item so its index (the edit target) stays valid.
      else if (t.role === "visual") l.visuals.splice(removeItem ? t.index : t.index + 1, removeItem ? 1 : 0, ...visuals);
      else l.collisions.splice(removeItem ? t.index : t.index + 1, removeItem ? 1 : 0, ...cols);
    });
  });
  const toCollision = output === "add_collision" || output === "replace_collision" || (output === "replace_source" && t.role === "collision");
  if (toCollision) store.setState({ showCollision: true });
  const what = toCollision ? "碰撞体" : "外观";
  const verb = output === "add_collision" || output === "add_visual" ? "添加" : "替换为";
  s().setStatus(`已${verb} ${shapes.length} 个${what}${cut && !removeItem ? "（已从网格中移除被拟合部分）" : ""}`, "ok");
}

// --------------------------------------------------------------- edit mode

export function findEditTarget(): EditTarget | null {
  const { robot, selection, meshPaths } = s();
  if (!robot || !selection) return null;
  const linkName = selection.kind === "link" ? selection.name : robot.joints.find((j) => j.name === selection.name)?.child;
  const link = robot.links.find((l) => l.name === linkName);
  if (!link) return null;
  const pick = (role: "visual" | "collision", geoms: Geometry[]) => {
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g.type === "mesh" && meshPaths[g.filename] && getMesh(meshPaths[g.filename])) {
        return { link: link.name, role, index: i, meshPath: meshPaths[g.filename]! };
      }
    }
    return null;
  };
  const vis = s().showVisual || !s().showCollision;
  return vis
    ? pick("visual", link.visuals.map((v) => v.geometry)) ?? pick("collision", link.collisions.map((c) => c.geometry))
    : pick("collision", link.collisions.map((c) => c.geometry)) ?? pick("visual", link.visuals.map((v) => v.geometry));
}

export function enterEditMode(target?: EditTarget) {
  const t = target ?? findEditTarget();
  if (!t) {
    s().setStatus("所选 link 没有可编辑的网格（基本几何体可在属性面板中“转换为网格”）", "error");
    return;
  }
  const entry = getMesh(t.meshPath);
  if (!entry) return;
  if (s().playing) store.setState({ playing: false });
  store.setState({
    mode: "edit",
    editTarget: t,
    selection: { kind: "link", name: t.link },
    meshStats: entry.editor.stats(),
    lastOp: null,
    featureAlign: null,
    modalHint: null,
  });
  s().setStatus(`编辑网格 ${t.meshPath}（Tab 退出）`);
}

export function exitEditMode() {
  store.setState({ mode: "object", editTarget: null, meshStats: null, lastOp: null, modalHint: null });
  s().setStatus("对象模式");
}
