// Project I/O. In the desktop app files go through the Rust backend
// (src-tauri); in a plain browser (vite dev) an in-memory fallback is used so
// the editor can be developed and tested without Tauri.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readZip, urdfCandidates, writeZip } from "../wasm";

export type SaveMode = "inplace" | "zip" | "folder";

export interface OpenedProject {
  kind: "zip" | "folder" | "memory";
  /** Opened file path (desktop) or file name (browser). */
  origin: string | null;
  urdfPath: string;
  urdfText: string;
  candidates: string[];
  files: string[];
}

export interface SaveRequest {
  urdfText: string;
  modified: Map<string, Uint8Array>;
  /** Files referenced by the robot (meshes), used for folder→zip export. */
  include: string[];
  remove: string[];
  mode: SaveMode;
}

export interface ProjectBackend {
  readonly native: boolean;
  open(): Promise<OpenedProject | null>;
  openPath(path: string): Promise<OpenedProject>;
  openFiles?(files: File[]): Promise<OpenedProject>;
  selectUrdf(path: string): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  /** Returns where the project was saved, or null when cancelled. */
  save(req: SaveRequest): Promise<string | null>;
  newProject(urdfText: string): Promise<OpenedProject>;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const NEW_URDF_PATH = "robot/urdf/robot.urdf";

class TauriBackend implements ProjectBackend {
  readonly native = true;
  private kind: OpenedProject["kind"] = "memory";
  private hasOrigin = false;

  async open() {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "URDF / ZIP", extensions: ["urdf", "zip"] }],
    });
    if (!path) return null;
    return this.openPath(path as string);
  }

  async openPath(path: string) {
    const r = await invoke<OpenedProject>("open_project", { path });
    this.kind = r.kind;
    this.hasOrigin = true;
    return r;
  }

  selectUrdf(path: string) {
    return invoke<string>("select_urdf", { path });
  }

  async read(path: string) {
    const buf = await invoke<ArrayBuffer>("read_project_file", { path });
    return new Uint8Array(buf);
  }

  async save(req: SaveRequest) {
    let mode = req.mode;
    if (mode === "inplace" && !this.hasOrigin) mode = "zip";
    let target: string | null = null;
    if (mode === "zip") {
      target = await saveDialog({ filters: [{ name: "ZIP", extensions: ["zip"] }], defaultPath: "robot.zip" });
      if (!target) return null;
    } else if (mode === "folder") {
      const dir = await openDialog({ directory: true, multiple: false, title: "选择导出目录" });
      if (!dir) return null;
      target = dir as string;
    }
    for (const [path, data] of req.modified) {
      await invoke("stage_file", data, { headers: { "x-path": encodeURIComponent(path) } });
    }
    const saved = await invoke<string>("save_project", {
      args: { urdfText: req.urdfText, mode, target, include: req.include, remove: req.remove },
    });
    if (mode === "zip" && this.kind === "memory") this.hasOrigin = false;
    return saved;
  }

  async newProject(urdfText: string) {
    await invoke("new_project", { urdfText });
    this.kind = "memory";
    this.hasOrigin = false;
    return {
      kind: "memory" as const,
      origin: null,
      urdfPath: NEW_URDF_PATH,
      urdfText,
      candidates: [NEW_URDF_PATH],
      files: [NEW_URDF_PATH],
    };
  }
}

function pickFiles(opts: { accept?: string; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (opts.accept) input.accept = opts.accept;
    if (opts.directory) input.setAttribute("webkitdirectory", "");
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

function download(name: string, data: Uint8Array) {
  const blob = new Blob([data as BlobPart], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** In-memory project used when running in a regular browser. */
class BrowserBackend implements ProjectBackend {
  readonly native = false;
  private files = new Map<string, Uint8Array>();
  private urdfPath = "";
  private name = "robot";

  async open() {
    const files = await pickFiles({ accept: ".urdf,.zip,.stl,.dae,.obj,.xml" });
    if (!files.length) return null;
    return this.openFiles(files);
  }

  async openFiles(files: File[]): Promise<OpenedProject> {
    this.files.clear();
    for (const f of files) {
      const data = new Uint8Array(await f.arrayBuffer());
      if (f.name.toLowerCase().endsWith(".zip")) {
        for (const e of readZip(data) as { path: string; data: Uint8Array }[]) this.files.set(e.path, e.data);
        this.name = f.name.replace(/\.zip$/i, "");
      } else {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        this.files.set(rel, data);
      }
    }
    const candidates = urdfCandidates([...this.files.keys()]);
    if (!candidates.length) throw new Error("没有找到 .urdf 文件");
    this.urdfPath = candidates[0];
    if (!files[0].name.toLowerCase().endsWith(".zip")) this.name = this.urdfPath.split("/").pop()!.replace(/\.urdf$/i, "");
    return {
      kind: "memory",
      origin: files.length === 1 ? files[0].name : `${files.length} files`,
      urdfPath: this.urdfPath,
      urdfText: new TextDecoder().decode(this.files.get(this.urdfPath)),
      candidates,
      files: [...this.files.keys()],
    };
  }

  async openPath(path: string): Promise<OpenedProject> {
    // Used by the built-in examples: fetch a zip served by vite.
    const res = await fetch(path);
    if (!res.ok) throw new Error(`无法加载 ${path}`);
    const blob = await res.blob();
    return this.openFiles([new File([blob], path.split("/").pop() ?? "project.zip")]);
  }

  async selectUrdf(path: string) {
    this.urdfPath = path;
    return new TextDecoder().decode(this.files.get(path));
  }

  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`file not found: ${path}`);
    return f;
  }

  async save(req: SaveRequest) {
    for (const [p, d] of req.modified) this.files.set(p, d);
    this.files.set(this.urdfPath, new TextEncoder().encode(req.urdfText));
    for (const r of req.remove) this.files.delete(r);
    const paths = [...this.files.keys()];
    const zip = writeZip(paths, paths.map((p) => this.files.get(p)!) as unknown as Array<unknown>);
    download(`${this.name}.zip`, zip);
    return `${this.name}.zip`;
  }

  async newProject(urdfText: string) {
    this.files.clear();
    this.urdfPath = NEW_URDF_PATH;
    this.name = "robot";
    this.files.set(NEW_URDF_PATH, new TextEncoder().encode(urdfText));
    return {
      kind: "memory" as const,
      origin: null,
      urdfPath: NEW_URDF_PATH,
      urdfText,
      candidates: [NEW_URDF_PATH],
      files: [NEW_URDF_PATH],
    };
  }

  /** Opens a whole folder (browser only). */
  async openFolder() {
    const files = await pickFiles({ directory: true });
    if (!files.length) return null;
    return this.openFiles(files);
  }
}

export const backend: ProjectBackend & { openFolder?: () => Promise<OpenedProject | null> } = isTauri()
  ? new TauriBackend()
  : new BrowserBackend();
