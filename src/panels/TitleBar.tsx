import { useEffect, useRef, useState } from "react";
import { menus, opById, runOp } from "../edit/operators";
import { backend } from "../io/project";
import { appWindow, customControls, macOverlay, platform } from "../io/window";
import logo from "../../src-tauri/icons/64x64.png";
import { openFolderBrowser } from "../state/actions";
import { useStore } from "../state/store";

type Entry = string | "-" | { label: string; run: () => void; keys?: string };

const MENUS: { title: string; entries: Entry[]; mode?: "edit" | "object" }[] = [
  {
    title: "文件",
    entries: [
      "file.new",
      "file.open",
      ...(!backend.native ? [{ label: "打开文件夹…", run: () => void openFolderBrowser() }] : []),
      "-",
      "file.save",
      "file.saveZip",
      ...(backend.native ? ["file.saveFolder"] : []),
      "-",
      "file.source",
    ],
  },
  { title: "编辑", entries: ["edit.undo", "edit.redo", "-", "edit.toggle", "ui.search"] },
  {
    title: "视图",
    entries: ["view.all", "view.selected", "-", "view.front", "view.right", "view.top", "view.back", "view.left", "view.bottom", "view.ortho", "-", "view.xray", "view.wire", "view.collision"],
  },
  { title: "对象", mode: "object", entries: ["obj.addLink", "obj.delete", "-", "obj.move", "obj.rotate", "obj.gizmoOff", "-", "sim.play"] },
  {
    title: "选择",
    mode: "edit",
    entries: [
      "sel.vert", "sel.edge", "sel.face", "-",
      "sel.all", "sel.none", "sel.invert", "sel.box", "sel.circle", "-",
      "sel.linked", "sel.linkedPick", "sel.flat", "sel.more", "sel.less", "sel.similar", "-",
      "sel.loop", "sel.ring", "sel.path", "-",
      "sel.nonManifold", "sel.loose", "sel.sharp", "sel.boundary", "sel.inner", "sel.random", "-",
      "sel.hide", "sel.hideOthers", "sel.reveal",
    ],
  },
  {
    title: "网格",
    mode: "edit",
    entries: [
      "mesh.grab", "mesh.rotate", "mesh.scale", "mesh.mirror", "mesh.proportional", "-",
      "mesh.extrude", "mesh.extrudeInd", "mesh.inset", "mesh.duplicate", "mesh.fill", "mesh.fillTri", "mesh.bridge", "-",
      "mesh.loopcut", "mesh.subdivide", "mesh.bisect", "mesh.connect", "mesh.poke", "-",
      "mesh.merge", "mesh.removeDoubles", "mesh.rip", "mesh.split", "mesh.separate", "-",
      "mesh.delete", "mesh.dissolve", "mesh.limitedDissolve", "-",
      "mesh.triangulate", "mesh.quads", "mesh.smooth", "-",
      "mesh.flip", "mesh.normalsOut", "mesh.normalsIn", "-",
      "mesh.add",
    ],
  },
  { title: "帮助", entries: ["ui.help", "ui.search"] },
];

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!appWindow) return;
    const w = appWindow;
    const sync = () => void w.isMaximized().then(setMaximized);
    sync();
    const off = w.onResized(sync);
    return () => void off.then((f) => f());
  }, []);
  if (!appWindow) return null;
  const w = appWindow;
  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => void w.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button className="win-btn" title={maximized ? "还原" : "最大化"} onClick={() => void w.toggleMaximize()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M2.5 2.5V.5h7v7h-2" />
            <rect x=".5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <rect x=".5" y=".5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button className="win-btn close" title="关闭" onClick={() => void w.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor">
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}

export function TitleBar() {
  const [open, setOpen] = useState<number | null>(null);
  const mode = useStore((s) => s.mode);
  const project = useStore((s) => s.project);
  const robot = useStore((s) => s.robot);
  const dirty = useStore((s) => s.robotDirty);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  const visible = MENUS.filter((m) => !m.mode || m.mode === mode);
  return (
    <header className={`titlebar ${platform} ${macOverlay ? "mac-overlay" : ""}`} data-tauri-drag-region>
      <img className="app-logo" src={logo} alt="" draggable={false} />
      <nav className="menus" ref={ref}>
        {visible.map((m, i) => (
          <div key={m.title} className={`menu ${open === i ? "open" : ""}`}>
            <button className="menu-title" onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}>
              {m.title}
            </button>
            {open === i && (
              <div className="menu-drop">
                {m.entries.map((e, k) => {
                  if (e === "-") return <div key={k} className="menu-sep" />;
                  const op = typeof e === "string" ? opById.get(e) : null;
                  const label = typeof e === "string" ? op?.label : e.label;
                  const keys = typeof e === "string" ? op?.keys : e.keys;
                  return (
                    <button
                      key={k}
                      className="menu-item"
                      onClick={() => {
                        setOpen(null);
                        if (typeof e === "string") runOp(e);
                        else e.run();
                      }}
                    >
                      <span>{label}</span>
                      {keys && <span className="keys">{keys}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {mode === "edit" && (
          <div className="menu">
            <button className="menu-title" onClick={() => menus.face()}>
              面
            </button>
          </div>
        )}
      </nav>
      <div className="title-center">
        {robot ? (
          <>
            <span className="title-name">
              {dirty && <span className="dirty-dot" title="有未保存的修改" />}
              {robot.name}
            </span>
            <span className="title-path">{project?.origin ?? "未保存的新项目"}</span>
            <span className={`mode-pill ${mode}`}>{mode === "edit" ? "编辑模式" : "对象模式"}</span>
          </>
        ) : (
          <span className="title-name">URDF Studio</span>
        )}
      </div>
      <div className="drag-fill" data-tauri-drag-region />
      {customControls && <WindowControls />}
    </header>
  );
}
