import { create } from "zustand";
import type { Geometry, Issue, Pose, Robot } from "../types/urdf";
import type { Command, MeshStats } from "../wasm";

export type Selection = { kind: "link"; name: string } | { kind: "joint"; name: string } | null;

/** The visual/collision geometry being edited in edit mode. */
export interface EditTarget {
  link: string;
  role: "visual" | "collision";
  index: number;
  meshPath: string;
}

/** Source of "fit primitive": a mesh geometry, its selection or all of it. */
export interface FitTarget extends EditTarget {
  all: boolean;
}

/** Shapes drawn in the viewport while the fit dialog is open (link frame). */
export interface FitPreview {
  link: string;
  items: { origin: Pose; geometry: Geometry }[];
}

export interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "bool" | "enum" | "int";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export interface LastOp {
  label: string;
  cmd: Command;
  params: ParamSpec[];
}

export interface MeshInfo {
  status: "loading" | "ready" | "missing" | "error";
  error?: string;
  format?: "stl" | "obj" | "dae";
}

export interface ProjectInfo {
  kind: "zip" | "folder" | "memory";
  origin: string | null;
  urdfPath: string;
  candidates: string[];
  files: string[];
}

export interface Proportional {
  enabled: boolean;
  radius: number;
  falloff: "smooth" | "sphere" | "root" | "sharp" | "linear" | "constant";
  connected: boolean;
}

export interface MenuState {
  title: string;
  x: number;
  y: number;
  items: { label: string; hint?: string; run: () => void; divider?: boolean }[];
}

/** An in-app confirmation dialog; `resolve` receives the chosen button id (or null on cancel). */
export interface ConfirmRequest {
  title: string;
  message: string;
  buttons: { id: string; label: string; kind?: "primary" | "danger" }[];
  /** Button triggered by Enter. */
  defaultId?: string;
  resolve: (id: string | null) => void;
}

/** Runtime joint state snapshotted with a robot undo step (null = leave values alone). */
export type JointSnap = { values: Record<string, number>; keyframes: Record<string, number>[] } | null;

export type FeatureConstraint = "parallel" | "collinear" | "concentric" | "axisAlign";

export type FeatureKind = "line" | "point" | "circle";

/** A world-space geometric feature picked for alignment. */
export interface FeaturePick {
  kind: FeatureKind;
  /** World-space point (line point / circle center / vertex). */
  origin: [number, number, number];
  /** World-space unit direction (line / circle axis); zero for plain points. */
  direction: [number, number, number];
  label: string;
}

export interface FeatureAlignState {
  joint: string;
  constraint: FeatureConstraint;
  /** Moving feature first, then reference. */
  picks: FeaturePick[];
  /** When true, only remaps axis from a single line (no second pick). */
  axisOnly: boolean;
}

interface State {
  project: ProjectInfo | null;
  robot: Robot | null;
  robotDirty: boolean;
  robotUndo: Robot[];
  robotRedo: Robot[];
  /** Global undo sequence numbers of the robot steps (parallel to robotUndo/robotRedo, see history.ts). */
  robotUndoSeq: number[];
  robotRedoSeq: number[];
  /** Parallel to robotUndo/robotRedo: restore jointValues/keyframes when non-null. */
  jointSnapUndo: JointSnap[];
  jointSnapRedo: JointSnap[];
  issues: Issue[];
  /** filename (as written in the URDF) -> project path, or null if missing. */
  meshPaths: Record<string, string | null>;
  meshInfo: Record<string, MeshInfo>;
  /** Bumped whenever any mesh geometry changes. */
  meshVersion: number;

  selection: Selection;
  mode: "object" | "edit";
  editTarget: EditTarget | null;
  meshStats: MeshStats | null;
  lastOp: LastOp | null;
  proportional: Proportional;
  gizmo: "translate" | "rotate" | "none";
  /** Object-mode feature alignment tool. */
  featureAlign: FeatureAlignState | null;

  jointValues: Record<string, number>;
  playing: false | "sweep" | "random" | "keyframes";
  simSpeed: number;
  keyframes: Record<string, number>[];

  showVisual: boolean;
  showCollision: boolean;
  showFrames: boolean;
  showAxes: boolean;
  xray: boolean;
  wireframe: boolean;

  status: string;
  statusKind: "info" | "error" | "ok";
  modalHint: string | null;
  menu: MenuState | null;
  confirm: ConfirmRequest | null;
  dialog: null | "help" | "search" | "separate" | "about" | "urdf-source" | "fit";
  fitTarget: FitTarget | null;
  fitPreview: FitPreview | null;
  busy: string | null;

  set: (p: Partial<State>) => void;
  setStatus: (msg: string, kind?: State["statusKind"]) => void;
  /** Applies an edit to a copy of the robot with undo support. */
  editRobot: (fn: (r: Robot) => void, opts?: { merge?: boolean; snapJoints?: boolean }) => void;
  undoRobot: () => void;
  redoRobot: () => void;
}

let lastMergeKey = 0;

// Supplies the global undo sequence number of a new robot step (history.ts).
let undoSeqSource: () => number = () => 0;
export function setUndoSeqSource(f: () => number) {
  undoSeqSource = f;
}

export const useStore = create<State>((set, get) => ({
  project: null,
  robot: null,
  robotDirty: false,
  robotUndo: [],
  robotRedo: [],
  robotUndoSeq: [],
  robotRedoSeq: [],
  jointSnapUndo: [],
  jointSnapRedo: [],
  issues: [],
  meshPaths: {},
  meshInfo: {},
  meshVersion: 0,

  selection: null,
  mode: "object",
  editTarget: null,
  meshStats: null,
  lastOp: null,
  proportional: { enabled: false, radius: 0.05, falloff: "smooth", connected: false },
  gizmo: "translate",
  featureAlign: null,

  jointValues: {},
  playing: false,
  simSpeed: 1,
  keyframes: [],

  showVisual: true,
  showCollision: false,
  showFrames: false,
  showAxes: true,
  xray: false,
  wireframe: false,

  status: "就绪",
  statusKind: "info",
  modalHint: null,
  menu: null,
  confirm: null,
  dialog: null,
  fitTarget: null,
  fitPreview: null,
  busy: null,

  set: (p) => set(p),
  setStatus: (status, statusKind = "info") => set({ status, statusKind }),

  editRobot: (fn, opts) => {
    const { robot, robotUndo, robotUndoSeq, jointSnapUndo, jointValues, keyframes } = get();
    if (!robot) return;
    const next = structuredClone(robot);
    fn(next);
    // Consecutive edits from one continuous interaction (e.g. dragging a
    // number field) collapse into a single undo step.
    const now = performance.now();
    const merge = opts?.merge && now - lastMergeKey < 800;
    lastMergeKey = now;
    const snap: JointSnap = opts?.snapJoints
      ? { values: { ...jointValues }, keyframes: keyframes.map((k) => ({ ...k })) }
      : null;
    set({
      robot: next,
      robotDirty: true,
      robotUndo: merge ? robotUndo : [...robotUndo.slice(-99), robot],
      robotUndoSeq: merge ? robotUndoSeq : [...robotUndoSeq.slice(-99), undoSeqSource()],
      jointSnapUndo: merge ? jointSnapUndo : [...jointSnapUndo.slice(-99), snap],
      robotRedo: [],
      robotRedoSeq: [],
      jointSnapRedo: [],
    });
  },
  undoRobot: () => {
    const { robot, robotUndo, robotRedo, robotUndoSeq, robotRedoSeq, jointSnapUndo, jointSnapRedo, jointValues, keyframes } =
      get();
    if (!robot || !robotUndo.length) return;
    const prev = robotUndo[robotUndo.length - 1];
    const snap = jointSnapUndo[jointSnapUndo.length - 1] ?? null;
    const curSnap: JointSnap = snap ? { values: { ...jointValues }, keyframes: keyframes.map((k) => ({ ...k })) } : null;
    set({
      robot: prev,
      robotUndo: robotUndo.slice(0, -1),
      robotRedo: [...robotRedo, robot],
      robotUndoSeq: robotUndoSeq.slice(0, -1),
      robotRedoSeq: [...robotRedoSeq, robotUndoSeq[robotUndoSeq.length - 1] ?? 0],
      jointSnapUndo: jointSnapUndo.slice(0, -1),
      jointSnapRedo: [...jointSnapRedo, curSnap],
      ...(snap ? { jointValues: snap.values, keyframes: snap.keyframes, playing: false as const } : {}),
      robotDirty: true,
    });
  },
  redoRobot: () => {
    const { robot, robotUndo, robotRedo, robotUndoSeq, robotRedoSeq, jointSnapUndo, jointSnapRedo, jointValues, keyframes } =
      get();
    if (!robot || !robotRedo.length) return;
    const next = robotRedo[robotRedo.length - 1];
    const snap = jointSnapRedo[jointSnapRedo.length - 1] ?? null;
    const curSnap: JointSnap = snap ? { values: { ...jointValues }, keyframes: keyframes.map((k) => ({ ...k })) } : null;
    set({
      robot: next,
      robotRedo: robotRedo.slice(0, -1),
      robotUndo: [...robotUndo, robot],
      robotRedoSeq: robotRedoSeq.slice(0, -1),
      robotUndoSeq: [...robotUndoSeq, robotRedoSeq[robotRedoSeq.length - 1] ?? 0],
      jointSnapRedo: jointSnapRedo.slice(0, -1),
      jointSnapUndo: [...jointSnapUndo, curSnap],
      ...(snap ? { jointValues: snap.values, keyframes: snap.keyframes, playing: false as const } : {}),
      robotDirty: true,
    });
  },
}));

export const store = useStore;
