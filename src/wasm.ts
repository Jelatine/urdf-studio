import init from "./wasm/pkg/mesh_wasm";

export * from "./wasm/pkg/mesh_wasm";

let ready: Promise<unknown> | null = null;

export function initWasm() {
  ready ??= init();
  return ready;
}

/** Mesh statistics returned by `MeshEditor.stats()`. */
export interface MeshStats {
  verts: number;
  edges: number;
  faces: number;
  selVerts: number;
  selEdges: number;
  selFaces: number;
  mode: "vert" | "edge" | "face";
  canUndo: boolean;
  canRedo: boolean;
  version: number;
  dirty: boolean;
}

export interface CmdOutput {
  normal?: [number, number, number] | null;
  count?: number | null;
}

/** A mesh-core command, e.g. `{ op: "inset", thickness: 0.1, depth: 0, individual: false }`. */
export type Command = { op: string } & Record<string, unknown>;

/** Options for `MeshEditor.fitPrimitives` (mirrors `mesh_core::fit::FitOptions`). */
export interface FitOptions {
  shape: "auto" | "box" | "cylinder" | "sphere";
  mode: "enclose" | "least_squares";
  axis: "auto" | "x" | "y" | "z";
  aligned: boolean;
  per_island: boolean;
  all: boolean;
  scale: [number, number, number];
}

export interface FitResult {
  geometry:
    | { type: "box"; size: [number, number, number] }
    | { type: "cylinder"; radius: number; length: number }
    | { type: "sphere"; radius: number };
  /** In (scaled) mesh coordinates. */
  center: [number, number, number];
  /** Quaternion [x, y, z, w]. */
  rotation: [number, number, number, number];
  volume: number;
  rms: number;
  max_dev: number;
  points: number;
}
