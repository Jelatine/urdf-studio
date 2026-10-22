// Loaded meshes, one MeshEditor (WASM) per project file. All visuals and
// collisions referencing the same file share one editor and one geometry.

import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { backend } from "../io/project";
import { MeshEditor } from "../wasm";

export type MeshFormat = "stl" | "obj" | "dae";

export interface MeshEntry {
  path: string;
  editor: MeshEditor;
  format: MeshFormat;
  /** Created in this session (separated parts, converted primitives). */
  isNew: boolean;
  geometry: THREE.BufferGeometry;
  geometryVersion: number;
}

const entries = new Map<string, MeshEntry>();
const pending = new Map<string, Promise<MeshEntry>>();

export function formatOf(path: string): MeshFormat | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "stl" || ext === "obj" || ext === "dae" ? ext : null;
}

function daeToEditor(text: string): MeshEditor {
  const collada = new ColladaLoader().parse(text, "");
  if (!collada) throw new Error("无法解析 Collada (DAE) 文件");
  const scene = collada.scene;
  // ColladaLoader rotates Z-up assets into three's Y-up convention; the robot
  // scene here is Z-up (like ROS), so undo that and rotate Y-up assets instead.
  const yUp = /<up_axis>\s*Y_UP\s*<\/up_axis>/i.test(text);
  scene.rotation.set(yUp ? Math.PI / 2 : 0, 0, 0);
  scene.updateMatrixWorld(true);
  const positions: number[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = (mesh.geometry as THREE.BufferGeometry).clone();
    g.applyMatrix4(mesh.matrixWorld);
    const ng = g.index ? g.toNonIndexed() : g;
    const pos = ng.getAttribute("position");
    for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  });
  return MeshEditor.fromTriangles(new Float32Array(positions), undefined, 0);
}

function buildGeometry(editor: MeshEditor): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(editor.objectTriPositions(), 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function makeEntry(path: string, editor: MeshEditor, format: MeshFormat, isNew: boolean): MeshEntry {
  const e: MeshEntry = { path, editor, format, isNew, geometry: buildGeometry(editor), geometryVersion: editor.geomVersion() };
  entries.set(path, e);
  return e;
}

export async function loadMesh(path: string): Promise<MeshEntry> {
  const existing = entries.get(path);
  if (existing) return existing;
  const inflight = pending.get(path);
  if (inflight) return inflight;
  const p = (async () => {
    const format = formatOf(path);
    if (!format) throw new Error(`不支持的网格格式: ${path}`);
    const bytes = await backend.read(path);
    let editor: MeshEditor;
    if (format === "stl") editor = MeshEditor.fromStl(bytes);
    else if (format === "obj") editor = MeshEditor.fromObj(new TextDecoder().decode(bytes));
    else editor = daeToEditor(new TextDecoder().decode(bytes));
    return makeEntry(path, editor, format, false);
  })();
  pending.set(path, p);
  try {
    return await p;
  } finally {
    pending.delete(path);
  }
}

export function getMesh(path: string | null | undefined): MeshEntry | undefined {
  return path ? entries.get(path) : undefined;
}

export function addMesh(path: string, editor: MeshEditor, format: MeshFormat = "stl"): MeshEntry {
  entries.get(path)?.geometry.dispose();
  return makeEntry(path, editor, format, true);
}

/** Refreshes the object-mode geometry if the editor changed. Returns true when updated. */
export function syncGeometry(entry: MeshEntry): boolean {
  const v = entry.editor.geomVersion();
  if (v === entry.geometryVersion) return false;
  const pos = entry.editor.objectTriPositions();
  const attr = entry.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (attr && attr.array.length === pos.length) {
    (attr.array as Float32Array).set(pos);
    attr.needsUpdate = true;
  } else {
    entry.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  }
  entry.geometry.computeVertexNormals();
  entry.geometry.computeBoundingSphere();
  entry.geometry.computeBoundingBox();
  entry.geometryVersion = v;
  return true;
}

export function clearMeshes() {
  for (const e of entries.values()) {
    e.geometry.dispose();
    e.editor.free();
  }
  entries.clear();
}

export function allMeshes() {
  return [...entries.values()];
}

export function isModified(e: MeshEntry) {
  return e.isNew || (e.editor.stats() as { dirty: boolean }).dirty;
}

/** Serializes modified meshes in their original format. */
export function modifiedFiles(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  for (const e of entries.values()) {
    if (!isModified(e)) continue;
    const name = e.path.split("/").pop()!.replace(/\.[^.]+$/, "");
    if (e.format === "stl") out.set(e.path, e.editor.toStl(name));
    else if (e.format === "obj") out.set(e.path, enc.encode(e.editor.toObj(name)));
    else out.set(e.path, enc.encode(e.editor.toDae(name)));
  }
  return out;
}

export function markSaved(paths: string[]) {
  for (const p of paths) {
    const e = entries.get(p);
    if (!e) continue;
    e.editor.setDirty(false);
    e.isNew = false;
  }
}
