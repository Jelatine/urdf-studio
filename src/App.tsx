import { useEffect } from "react";
import { installKeymap } from "./edit/keymap";
import { runOp } from "./edit/operators";
import { backend } from "./io/project";
import { appWindow } from "./io/window";
import { Dialogs } from "./panels/Dialogs";
import { Inspector } from "./panels/Inspector";
import { JointPanel } from "./panels/JointPanel";
import { PopupMenu } from "./panels/PopupMenu";
import { TitleBar } from "./panels/TitleBar";
import { Outliner } from "./panels/Outliner";
import { StatusBar } from "./panels/StatusBar";
import { confirmDiscard, hasUnsavedChanges, openProject } from "./state/actions";
import { useStore } from "./state/store";
import { Viewport } from "./viewport/Viewport";

export default function App() {
  const robot = useStore((s) => s.robot);
  const busy = useStore((s) => s.busy);

  useEffect(() => installKeymap(), []);

  // No browser context menu (back / reload / save as…) anywhere; only editable
  // text fields keep the native cut/copy/paste menu.
  useEffect(() => {
    const menu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const editable = (t instanceof HTMLInputElement && !t.readOnly) || (t instanceof HTMLTextAreaElement && !t.readOnly) || t.isContentEditable;
      if (!editable) e.preventDefault();
    };
    // Browser-level reload/print/find shortcuts make no sense in the desktop app.
    const keys = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "F5" || e.key === "F7" || (ctrl && ["KeyR", "KeyP", "KeyF", "KeyG", "KeyU"].includes(e.code))) e.preventDefault();
    };
    window.addEventListener("contextmenu", menu);
    if (appWindow) window.addEventListener("keydown", keys, true);
    return () => {
      window.removeEventListener("contextmenu", menu);
      window.removeEventListener("keydown", keys, true);
    };
  }, []);

  // Closing the desktop window asks about unsaved changes first.
  useEffect(() => {
    if (!appWindow) return;
    const w = appWindow;
    let closing = false;
    const off = w.onCloseRequested(async (e) => {
      if (!hasUnsavedChanges()) return;
      e.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (await confirmDiscard()) await w.destroy();
      } finally {
        closing = false;
      }
    });
    return () => void off.then((f) => f());
  }, []);

  const robotName = useStore((s) => s.robot?.name);
  const dirty = useStore((s) => s.robotDirty);
  useEffect(() => {
    const title = robotName ? `${dirty ? "● " : ""}${robotName} — URDF Studio` : "URDF Studio";
    document.title = title;
    void appWindow?.setTitle(title);
  }, [robotName, dirty]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Drag & drop a .urdf/.zip (or a folder's files) onto the window (browser mode).
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length && backend.openFiles) await openProject(await backend.openFiles(files));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <aside className="side left">
          <Outliner />
        </aside>
        <section className="center">
          <Viewport />
          {!robot && (
            <div className="welcome">
              <h1>URDF Studio</h1>
              <p>URDF 机器人模型编辑器 · Blender 风格网格编辑</p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => runOp("file.open")}>
                  打开 URDF / ZIP
                </button>
                <button onClick={() => runOp("file.new")}>新建机器人</button>
                {!backend.native && (
                  <button onClick={() => void backend.openPath("examples/demo_arm.zip").then(openProject)}>
                    加载示例机械臂
                  </button>
                )}
              </div>
              <p className="hint">也可以把 .urdf / .zip 文件拖到窗口中 · 按 F1 查看快捷键</p>
            </div>
          )}
          <JointPanel />
        </section>
        <aside className="side right">
          <Inspector />
        </aside>
      </div>
      <StatusBar />
      <PopupMenu />
      <Dialogs />
      {busy && <div className="busy">{busy}</div>}
    </div>
  );
}
