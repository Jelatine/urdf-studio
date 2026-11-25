import { useEffect, useRef, useState, type ReactNode } from "react";
import { runOp } from "../edit/operators";
import { AdjustPanel } from "../panels/AdjustPanel";
import { EditToolbar } from "../panels/EditToolbar";
import { ViewportHeader } from "../panels/ViewportHeader";
import { useStore } from "../state/store";
import { Engine } from "./engine";
import { ViewControls, ViewNavigation } from "./ViewControls";

export function Viewport({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const hasRobot = useStore((s) => !!s.robot);
  const mode = useStore((s) => s.mode);
  const hint = useStore((s) => s.modalHint);
  const stats = useStore((s) => s.meshStats);
  const target = useStore((s) => s.editTarget);

  useEffect(() => {
    let viewport: Engine;
    try {
      viewport = new Engine(ref.current!);
    } catch (error) {
      console.error(error);
      setUnavailable(true);
      return;
    }
    viewport.onContextMenu = () => runOp("ui.context");
    setEngine(viewport);
    return () => viewport.dispose();
  }, []);

  return (
    <section className="viewport-wrap" aria-label="三维视图">
      <div className="viewport-bar">
        <span className="viewport-title">三维视图</span>
        {engine && hasRobot && <><ViewportHeader /><ViewControls engine={engine} /></>}
        {unavailable && <span role="status" className="viewport-error">无法启动 WebGL 三维视图</span>}
      </div>
      <div className="viewport-stage">
        <div className="viewport" ref={ref} />
        {engine && hasRobot && <ViewNavigation engine={engine} />}
        {engine && mode === "edit" && <EditToolbar />}
        {hint && <div className="modal-hint">{hint}</div>}
        {mode === "edit" && stats && (
          <div className="mesh-stats">
            <div className="mesh-name" title={target?.meshPath}>{target?.meshPath}</div>
            <div>
              顶点 {stats.selVerts}/{stats.verts} · 边 {stats.selEdges}/{stats.edges} · 面 {stats.selFaces}/{stats.faces}
            </div>
          </div>
        )}
        <AdjustPanel />
        {engine && hasRobot && (
          <div className="view-input-hint">
            <span>中键 / Alt+拖动 旋转</span>
            <span>右键拖动 平移</span>
            <span>滚轮 缩放</span>
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
