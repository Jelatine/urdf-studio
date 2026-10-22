import { create } from "zustand";
import type { Issue, Robot } from "../types/urdf";
import type { Command, MeshStats } from "../wasm";

export type Selection = { kind: "link"; name: string } | { kind: "joint"; name: string } | null;

/** The visual/collision geometry being edited in edit mode. */
export interface EditTarget {
  link: string;
  role: "visual" | "collision";
  index: number;
  meshPath: string;
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

interface State {
  project: ProjectInfo | null;
  robot: Robot | null;
  robotDirty: boolean;
  robotUndo: Robot[];
  robotRedo: Robot[];
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
  dialog: null | "help" | "search" | "separate" | "about" | "urdf-source";
  busy: string | null;

  set: (p: Partial<State>) => void;
  setStatus: (msg: string, kind?: State["statusKind"]) => void;
  /** Applies an edit to a copy of the robot with undo support. */
  editRobot: (fn: (r: Robot) => void, opts?: { merge?: boolean }) => void;
  undoRobot: () => void;
  redoRobot: () => void;
}

let lastMergeKey = 0;

export const useStore = create<State>((set, get) => ({
  project: null,
  robot: null,
  robotDirty: false,
  robotUndo: [],
  robotRedo: [],
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
  busy: null,

  set: (p) => set(p),
  setStatus: (status, statusKind = "info") => set({ status, statusKind }),

  editRobot: (fn, opts) => {
    const { robot, robotUndo } = get();
    if (!robot) return;
    const next = structuredClone(robot);
    fn(next);
    // Consecutive edits from one continuous interaction (e.g. dragging a
    // number field) collapse into a single undo step.
    const now = performance.now();
    const merge = opts?.merge && now - lastMergeKey < 800;
    lastMergeKey = now;
    set({
      robot: next,
      robotDirty: true,
      robotUndo: merge ? robotUndo : [...robotUndo.slice(-99), robot],
      robotRedo: [],
    });
  },
  undoRobot: () => {
    const { robot, robotUndo, robotRedo } = get();
    if (!robot || !robotUndo.length) return;
    const prev = robotUndo[robotUndo.length - 1];
    set({ robot: prev, robotUndo: robotUndo.slice(0, -1), robotRedo: [...robotRedo, robot], robotDirty: true });
  },
  redoRobot: () => {
    const { robot, robotUndo, robotRedo } = get();
    if (!robot || !robotRedo.length) return;
    const next = robotRedo[robotRedo.length - 1];
    set({ robot: next, robotRedo: robotRedo.slice(0, -1), robotUndo: [...robotUndo, robot], robotDirty: true });
  },
}));

export const store = useStore;
