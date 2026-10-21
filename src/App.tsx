import { useEffect } from "react";
import { installKeymap } from "./edit/keymap";
import { runOp } from "./edit/operators";
import { backend } from "./io/project";
import { Dialogs } from "./panels/Dialogs";
import { Inspector } from "./panels/Inspector";
import { JointPanel } from "./panels/JointPanel";
import { MenuBar } from "./panels/MenuBar";
import { PopupMenu } from "./panels/PopupMenu";
import { Outliner } from "./panels/Outliner";
import { StatusBar } from "./panels/StatusBar";
import { hasUnsavedChanges, openProject } from "./state/actions";
import { useStore } from "./state/store";
import { Viewport } from "./viewport/Viewport";

export default function App() {
  const robot = useStore((s) => s.robot);
  const busy = useStore((s) => s.busy);

  useEffect(() => installKeymap(), []);

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
      <MenuBar />
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
