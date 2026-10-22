// One undo history across the robot model and every mesh editor.
//
// The robot (store.robotUndo/robotRedo) and each MeshEditor keep their own
// snapshots; every step gets a global sequence number so that undo/redo act
// on the most recent change regardless of the current mode, and operations
// touching both (e.g. separate into a new link) undo as one step.

import { allMeshes } from "../mesh/registry";
import type { MeshEditor } from "../wasm";
import { setUndoSeqSource, store } from "./store";

const s = () => store.getState();

let seq = 0;
let groupSeq: number | null = null;
/** Mesh step id -> sequence number, per editor. */
const meshSeqs = new WeakMap<MeshEditor, Map<number, number>>();

const nextSeq = () => groupSeq ?? ++seq;

function seqsOf(ed: MeshEditor) {
  let m = meshSeqs.get(ed);
  if (!m) meshSeqs.set(ed, (m = new Map()));
  return m;
}

/**
 * Stamps mesh steps recorded since the last call (they don't report
 * themselves). A new step invalidates the redo steps of all other histories.
 */
export function syncHistory() {
  const fresh = new Set<MeshEditor>();
  for (const { editor } of allMeshes()) {
    const m = seqsOf(editor);
    for (const id of editor.undoIds()) {
      if (m.has(id)) continue;
      m.set(id, nextSeq());
      fresh.add(editor);
    }
  }
  if (!fresh.size) return;
  for (const { editor } of allMeshes()) if (!fresh.has(editor)) editor.clearRedo();
  if (s().robotRedo.length) store.setState({ robotRedo: [], robotRedoSeq: [] });
}

// New robot steps: order them after pending mesh steps and drop mesh redo.
setUndoSeqSource(() => {
  syncHistory();
  for (const { editor } of allMeshes()) editor.clearRedo();
  return nextSeq();
});

/** Runs `fn` so that all robot and mesh steps it records undo together. */
export function undoGroup<T>(fn: () => T): T {
  syncHistory();
  groupSeq = ++seq;
  try {
    const r = fn();
    syncHistory();
    return r;
  } finally {
    groupSeq = null;
  }
}

const undoTopSeq = (ed: MeshEditor) => {
  const ids = ed.undoIds();
  return ids.length ? seqsOf(ed).get(ids[ids.length - 1]) : undefined;
};
const redoTopSeq = (ed: MeshEditor) => {
  const id = ed.redoId();
  return id >= 0 ? seqsOf(ed).get(id) : undefined;
};
const last = (a: number[]) => a[a.length - 1];

export interface HistoryStep {
  labels: string[];
  robot: boolean;
}

/**
 * Undoes the most recent step (robot and/or mesh). `skipSelection` passes over
 * mesh selection-only steps, which are invisible outside edit mode.
 */
export function undoStep(skipSelection: boolean): HistoryStep | null {
  syncHistory();
  for (let guard = 0; guard < 10000; guard++) {
    const robotTop = last(s().robotUndoSeq) ?? -1;
    const top = Math.max(robotTop, ...allMeshes().map((e) => undoTopSeq(e.editor) ?? -1));
    if (top < 0) return null;
    const step: HistoryStep = { labels: [], robot: false };
    if (robotTop === top) {
      s().undoRobot();
      step.robot = true;
      step.labels.push("URDF 编辑");
    }
    let onlySelection = !step.robot;
    for (const { editor } of allMeshes()) {
      while (undoTopSeq(editor) === top) {
        const label = editor.undoLabel() ?? "";
        if (!/select/i.test(label)) onlySelection = false;
        editor.undo();
        step.labels.push(label);
      }
    }
    if (skipSelection && onlySelection) continue;
    return step;
  }
  return null;
}

/** Redoes the step undone last. */
export function redoStep(skipSelection: boolean): HistoryStep | null {
  for (let guard = 0; guard < 10000; guard++) {
    const robotTop = last(s().robotRedoSeq) ?? Infinity;
    const top = Math.min(robotTop, ...allMeshes().map((e) => redoTopSeq(e.editor) ?? Infinity));
    if (top === Infinity) return null;
    const step: HistoryStep = { labels: [], robot: false };
    if (robotTop === top) {
      s().redoRobot();
      step.robot = true;
      step.labels.push("URDF 编辑");
    }
    let onlySelection = !step.robot;
    for (const { editor } of allMeshes()) {
      while (redoTopSeq(editor) === top) {
        const label = editor.redo() ?? "";
        if (!/select/i.test(label)) onlySelection = false;
        step.labels.push(label);
      }
    }
    if (skipSelection && onlySelection) continue;
    return step;
  }
  return null;
}
