// Loaded meshes, one MeshEditor (WASM) per project file. All visuals and
// collisions referencing the same file share one editor and one geometry.

import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { backend } from "../io/project";
import { MeshEditor, objMtllibs } from "../wasm";

export type MeshFormat = "stl" | "obj" | "dae";

export const MESH_FORMATS: MeshFormat[] = ["stl", "obj", "dae"];

/** A material slot of a mesh (`MeshEditor.materials()`); colors are sRGB. */
export interface MeshMaterial {
  name: string;
  color: [number, number, number, number];
}

export interface MeshEntry {
  path: string;
  editor: MeshEditor;
  format: MeshFormat;
  /** Created in this session (separated parts, converted primitives). */
  isNew: boolean;
  /** OBJ material library written next to the mesh (when it has materials). */
  mtlPath: string | null;
  /** Object-mode geometry; has a "color" attribute when the mesh has materials. */
  geometry: THREE.BufferGeometry;
  geometryVersion: number;
}

const entries = new Map<string, MeshEntry>();
const pending = new Map<string, Promise<MeshEntry>>();

export function formatOf(path: string): MeshFormat | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "stl" || ext === "obj" || ext === "dae" ? ext : null;
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, rel: string) {
  const out = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** Path of the OBJ's material library next to it (`name.mtl`). */
export function mtlPathFor(objPath: string) {
  return objPath.replace(/\.[^./]+$/, "") + ".mtl";
}

const WHITE = new THREE.Color(1, 1, 1);

/** sRGB color of a Collada material, or null when the file gives none. */
function colladaColor(m: THREE.Material, vertex: THREE.Color | null): [number, number, number, number] | null {
  const mat = m as THREE.MeshPhongMaterial;
  const unset = !mat.color || (mat.color.equals(WHITE) && (!!mat.map || !mat.name)) || mat.name === THREE.Loader.DEFAULT_MATERIAL_NAME;
  if (unset && !vertex) return null;
  const c = (unset ? WHITE : mat.color).clone();
  if (vertex) c.multiply(vertex);
  const rgb = c.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return [rgb.r, rgb.g, rgb.b, mat.transparent ? mat.opacity : 1];
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
  // Per-triangle colors, merged into slots by name and color.
  const triColors: ([number, number, number, number] | null)[] = [];
  const triNames: string[] = [];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = (mesh.geometry as THREE.BufferGeometry).clone();
    g.applyMatrix4(mesh.matrixWorld);
    const ng = g.index ? g.toNonIndexed() : g;
    const pos = ng.getAttribute("position");
    const col = ng.getAttribute("color") as THREE.BufferAttribute | undefined;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = ng.groups.length ? ng.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const grp of groups) {
      const mat = mats[grp.materialIndex ?? 0] ?? mats[0];
      const end = Math.min(grp.start + grp.count, pos.count);
      for (let i = grp.start; i + 2 < end; i += 3) {
        for (let k = i; k < i + 3; k++) positions.push(pos.getX(k), pos.getY(k), pos.getZ(k));
        let vertex: THREE.Color | null = null;
        if (col) {
          vertex = new THREE.Color(0, 0, 0);
          for (let k = i; k < i + 3; k++) vertex.r += col.getX(k) / 3, vertex.g += col.getY(k) / 3, vertex.b += col.getZ(k) / 3;
        }
        triColors.push(mat ? colladaColor(mat, vertex) : null);
        triNames.push(mat?.name || "material");
      }
    }
  });
  const materials: MeshMaterial[] = [];
  const triMats = new Uint32Array(triColors.length);
  if (triColors.some((c) => c)) {
    const slots = new Map<string, number>();
    triColors.forEach((c, t) => {
      const name = c ? triNames[t] : "default";
      const key = c ? `${name}|${c.map((x) => x.toFixed(4)).join(",")}` : "";
      let id = slots.get(key);
      if (id === undefined) {
        id = materials.length;
        slots.set(key, id);
        materials.push({ name, color: c ?? [0.8, 0.8, 0.8, 1] });
      }
      triMats[t] = id;
    });
  }
  return MeshEditor.fromTriangles(new Float32Array(positions), undefined, 0, materials.length ? triMats : undefined, materials);
}

async function objToEditor(path: string, text: string): Promise<{ editor: MeshEditor; mtlPath: string | null }> {
  let mtl: string | undefined;
  let mtlPath: string | null = null;
  for (const lib of objMtllibs(text)) {
    const p = joinPath(dirOf(path), lib);
    try {
      mtl = new TextDecoder().decode(await backend.read(p));
      mtlPath = p;
      break;
    } catch {
      // Missing library: materials keep their names with default colors.
    }
  }
  return { editor: MeshEditor.fromObj(text, mtl), mtlPath };
}

/** Linear vertex colors (3 per vertex) for the triangles of `objectTriPositions`. */
function triangleColors(editor: MeshEditor, materials: MeshMaterial[]): Float32Array {
  const mats = editor.objectTriMaterials();
  const lin = materials.map((m) => new THREE.Color().setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace));
  const fallback = new THREE.Color().setRGB(0.8, 0.8, 0.8, THREE.SRGBColorSpace);
  const out = new Float32Array(mats.length * 9);
  for (let t = 0; t < mats.length; t++) {
    const c = lin[mats[t]] ?? fallback;
    for (let k = 0; k < 3; k++) out.set([c.r, c.g, c.b], t * 9 + k * 3);
  }
  return out;
}

/** Sets or removes the "color" attribute from the editor's material slots. */
function applyColors(g: THREE.BufferGeometry, editor: MeshEditor) {
  const materials = editor.materials() as MeshMaterial[];
  if (materials.length) g.setAttribute("color", new THREE.BufferAttribute(triangleColors(editor, materials), 3));
  else g.deleteAttribute("color");
}

function buildGeometry(editor: MeshEditor): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(editor.objectTriPositions(), 3));
  applyColors(g, editor);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function makeEntry(path: string, editor: MeshEditor, format: MeshFormat, isNew: boolean, mtlPath: string | null = null): MeshEntry {
  const e: MeshEntry = { path, editor, format, isNew, mtlPath, geometry: buildGeometry(editor), geometryVersion: editor.geomVersion() };
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
    if (format === "obj") {
      const { editor, mtlPath } = await objToEditor(path, new TextDecoder().decode(bytes));
      return makeEntry(path, editor, format, false, mtlPath);
    }
    const editor = format === "stl" ? MeshEditor.fromStl(bytes) : daeToEditor(new TextDecoder().decode(bytes));
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
  return makeEntry(path, editor, format, true, format === "obj" ? mtlPathFor(path) : null);
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
  applyColors(entry.geometry, entry.editor);
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

/** Files belonging to a mesh: the mesh itself and its OBJ material library. */
export function meshFiles(e: MeshEntry): string[] {
  return e.mtlPath ? [e.path, e.mtlPath] : [e.path];
}

/** Serializes a mesh in its format; OBJ meshes with materials also get their `.mtl`. */
export function serializeMesh(e: MeshEntry): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const name = e.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (e.format === "stl") out.set(e.path, e.editor.toStl(name));
  else if (e.format === "dae") out.set(e.path, enc.encode(e.editor.toDae(name)));
  else {
    // Always `name.mtl` next to the OBJ: a library loaded under another
    // name may be shared with other OBJ files, so it is left alone.
    const mtl = e.editor.toMtl();
    if (mtl !== undefined) {
      e.mtlPath = mtlPathFor(e.path);
      out.set(e.mtlPath, enc.encode(mtl));
    }
    out.set(e.path, enc.encode(e.editor.toObj(name, mtl !== undefined ? `${name}.mtl` : undefined)));
  }
  return out;
}

/** Serializes modified meshes (keyed by mesh path) in their own format. */
export function modifiedFiles(): Map<string, Map<string, Uint8Array>> {
  const out = new Map<string, Map<string, Uint8Array>>();
  for (const e of entries.values()) if (isModified(e)) out.set(e.path, serializeMesh(e));
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
