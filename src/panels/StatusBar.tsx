import { useStore } from "../state/store";

export function StatusBar() {
  const status = useStore((s) => s.status);
  const kind = useStore((s) => s.statusKind);
  const mode = useStore((s) => s.mode);
  const stats = useStore((s) => s.meshStats);
  const prop = useStore((s) => s.proportional);
  const xray = useStore((s) => s.xray);
  const issues = useStore((s) => s.issues);
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <div className="statusbar">
      <span className={`mode-badge ${mode}`}>{mode === "edit" ? "编辑模式" : "对象模式"}</span>
      <span className={`status ${kind}`}>{status}</span>
      <span className="spacer" />
      {mode === "edit" && stats && (
        <span className="dim">
          {stats.mode === "vert" ? "点" : stats.mode === "edge" ? "边" : "面"}模式 · V {stats.selVerts}/{stats.verts} E {stats.selEdges}/{stats.edges} F {stats.selFaces}/
          {stats.faces}
          {prop.enabled ? " · 比例编辑" : ""}
          {xray ? " · X-Ray" : ""}
        </span>
      )}
      {errors > 0 && <span className="status error">✕ {errors} 个错误</span>}
      <span className="dim">F1 快捷键 · F3 搜索</span>
    </div>
  );
}
