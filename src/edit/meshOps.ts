// Runs mesh-core commands on the mesh being edited and keeps the UI in sync.

import { getMesh, type MeshEntry } from "../mesh/registry";
import { editRobot, newMeshLocation, registerNewMesh } from "../state/actions";
import { store, type ParamSpec } from "../state/store";
import { uniqueName } from "../types/urdf";
import type { CmdOutput, Command, MeshStats } from "../wasm";

const s = () => store.getState();

export function currentEntry(): MeshEntry | undefined {
  const t = s().editTarget;
  return t ? getMesh(t.meshPath) : undefined;
}

/** Call after any change to the edited mesh (geometry or selection). */
export function meshChanged() {
  const e = currentEntry();
  if (!e) return;
  store.setState((st) => ({ meshStats: e.editor.stats() as MeshStats, meshVersion: st.meshVersion + 1 }));
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const MESSAGES: Record<string, string> = {
  "nothing selected": "没有选中任何元素",
  "select at least 2 vertices": "至少需要选择 2 个顶点",
};

export interface RunOptions {
  label: string;
  params?: ParamSpec[];
  /** Don't register for "adjust last operation". */
  noAdjust?: boolean;
}

export function runCmd(cmd: Command, opts: RunOptions): CmdOutput | null {
  const e = currentEntry();
  if (!e) return null;
  try {
    const out = e.editor.run(cmd) as CmdOutput;
    meshChanged();
    // Any new command invalidates the previous "adjust last operation".
    store.setState({ lastOp: opts.noAdjust ? null : { label: opts.label, cmd, params: opts.params ?? [] } });
    if (out?.count != null) s().setStatus(`${opts.label}: ${out.count}`);
    else s().setStatus(opts.label);
    return out ?? {};
  } catch (err) {
    const m = errMsg(err);
    s().setStatus(`${opts.label}: ${MESSAGES[m] ?? m}`, "error");
    return null;
  }
}

/** Re-runs the last operation with changed parameters. */
export function adjustLast(cmd: Command) {
  const e = currentEntry();
  const last = s().lastOp;
  if (!e || !last) return;
  try {
    e.editor.adjust(cmd);
    store.setState({ lastOp: { ...last, cmd } });
    meshChanged();
  } catch (err) {
    s().setStatus(`${last.label}: ${MESSAGES[errMsg(err)] ?? errMsg(err)}`, "error");
  }
}

export function undoMesh() {
  const e = currentEntry();
  if (!e) return;
  const label = e.editor.undo();
  store.setState({ lastOp: null });
  meshChanged();
  s().setStatus(label ? `撤销: ${label}` : "没有可撤销的操作");
}

export function redoMesh() {
  const e = currentEntry();
  if (!e) return;
  const label = e.editor.redo();
  store.setState({ lastOp: null });
  meshChanged();
  s().setStatus(label ? `重做: ${label}` : "没有可重做的操作");
}

/**
 * Separate (P): moves the selection into a new mesh file, attached either as
 * another visual/collision of the same link or as a new link with a fixed joint.
 */
export function separateSelection(asNewLink: boolean) {
  const e = currentEntry();
  const t = s().editTarget;
  const robot = s().robot;
  if (!e || !t || !robot) return;
  let part;
  try {
    part = e.editor.separate();
  } catch (err) {
    s().setStatus(`分离: ${MESSAGES[errMsg(err)] ?? errMsg(err)}`, "error");
    return;
  }
  part.run({ op: "select_all", action: "deselect" });
  part.clearHistory();
  const base = e.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const { path, reference } = newMeshLocation(`${base}_part`);
  registerNewMesh(path, reference, part);
  const link = robot.links.find((l) => l.name === t.link)!;
  const src = t.role === "visual" ? link.visuals[t.index] : link.collisions[t.index];
  const scale = src.geometry.type === "mesh" ? src.geometry.scale : null;
  editRobot((r) => {
    const rl = r.links.find((l) => l.name === t.link)!;
    const geometry = { type: "mesh" as const, filename: reference, scale };
    if (!asNewLink) {
      if (t.role === "visual") rl.visuals.push({ ...structuredClone(src as typeof rl.visuals[0]), geometry });
      else rl.collisions.push({ ...structuredClone(src), geometry });
      return;
    }
    const name = uniqueName(`${t.link}_part`, r.links.map((l) => l.name));
    const nl = { name, inertial: null, visuals: [] as typeof rl.visuals, collisions: [] as typeof rl.collisions, extras: [] };
    if (t.role === "visual") nl.visuals.push({ ...structuredClone(src as typeof rl.visuals[0]), geometry });
    else nl.collisions.push({ ...structuredClone(src), geometry });
    r.links.push(nl);
    r.joints.push({
      name: uniqueName(`${name}_joint`, r.joints.map((j) => j.name)),
      joint_type: "fixed",
      origin: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
      parent: t.link,
      child: name,
      axis: [0, 0, 1],
      limit: null,
      dynamics: null,
      mimic: null,
      safety_controller: null,
      calibration: null,
      extras: [],
    });
  });
  store.setState({ lastOp: null });
  meshChanged();
  s().setStatus(`已分离到 ${path}${asNewLink ? "（新 link）" : ""}`, "ok");
}
