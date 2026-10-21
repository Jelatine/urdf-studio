import { useEffect, useRef } from "react";
import { runOp } from "../edit/operators";
import { AdjustPanel } from "../panels/AdjustPanel";
import { EditToolbar } from "../panels/EditToolbar";
import { ViewportHeader } from "../panels/ViewportHeader";
import { useStore } from "../state/store";
import { Engine } from "./engine";

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null);
  const mode = useStore((s) => s.mode);
  const hint = useStore((s) => s.modalHint);
  const stats = useStore((s) => s.meshStats);
  const target = useStore((s) => s.editTarget);

  useEffect(() => {
    const engine = new Engine(ref.current!);
    engine.onContextMenu = () => runOp("ui.context");
    return () => engine.dispose();
  }, []);

  return (
    <div className="viewport-wrap">
      <div className="viewport" ref={ref} />
      <ViewportHeader />
      {mode === "edit" && <EditToolbar />}
      {hint && <div className="modal-hint">{hint}</div>}
      {mode === "edit" && stats && (
        <div className="mesh-stats">
          <div className="mesh-name">{target?.meshPath}</div>
          <div>
            顶点 {stats.selVerts}/{stats.verts} · 边 {stats.selEdges}/{stats.edges} · 面 {stats.selFaces}/{stats.faces}
          </div>
        </div>
      )}
      <AdjustPanel />
    </div>
  );
}
