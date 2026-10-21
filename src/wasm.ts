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
