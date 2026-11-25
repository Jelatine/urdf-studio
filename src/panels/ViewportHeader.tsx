import { runCmd } from "../edit/meshOps";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "./Icon";
import { applyFeatureAlign, featureAlignReady, cancelFeatureAlign, enterEditMode, exitEditMode, setFeatureAlignConstraint } from "../state/actions";
import { useStore, type FeatureConstraint } from "../state/store";

const ALIGN_OPTS: { id: FeatureConstraint; label: string }[] = [
  { id: "concentric", label: "圆同心" },
  { id: "collinear", label: "点共线" },
  { id: "parallel", label: "线平行" },
  { id: "axisAlign", label: "轴对齐" },
];

export function ViewportHeader() {
  const st = useStore(useShallow((s) => ({
    robot: s.robot, mode: s.mode, selectionMode: s.meshStats?.mode, featureAlign: s.featureAlign,
    proportional: s.proportional, gizmo: s.gizmo,
  })));
  const robot = st.robot;
  if (!robot) return null;
  const smode = st.selectionMode ?? "vert";
  const fa = st.featureAlign;
  return (
    <div className="vp-header">
      <div className="seg">
        <button className={st.mode === "object" ? "active" : ""} onClick={() => st.mode === "edit" && exitEditMode()} aria-pressed={st.mode === "object"} title="对象模式 (Tab)">
          对象
        </button>
        <button className={st.mode === "edit" ? "active" : ""} onClick={() => st.mode === "object" && enterEditMode()} aria-pressed={st.mode === "edit"} title="编辑模式 (Tab)">
          编辑
        </button>
      </div>
      {st.mode === "edit" ? (
        <>
          <div className="seg">
            {(["vert", "edge", "face"] as const).map((m, i) => (
              <button
                key={m}
                className={smode === m ? "active" : ""}
                aria-pressed={smode === m}
                title={`${["顶点", "边", "面"][i]}选择模式 (${i + 1})`}
                onClick={() => runCmd({ op: "set_select_mode", mode: m }, { label: "选择模式", noAdjust: true })}
              >
                {["点", "边", "面"][i]}
              </button>
            ))}
          </div>
          <div className="seg">
            <button
              className={st.proportional.enabled ? "active" : ""}
              aria-pressed={st.proportional.enabled}
              title="比例编辑 (O)"
              onClick={() => useStore.setState({ proportional: { ...st.proportional, enabled: !st.proportional.enabled } })}
            >
              <Icon name="circle" /> 比例编辑
            </button>
          </div>
        </>
      ) : fa ? (
        <>
          <div className="seg">
            <span className="dim" style={{ padding: "0 6px" }}>
              特征对齐
            </span>
            {ALIGN_OPTS.map((o) => (
              <button key={o.id} className={fa.constraint === o.id ? "active" : ""} onClick={() => setFeatureAlignConstraint(o.id)} title={o.label}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="seg">
            <button onClick={applyFeatureAlign} disabled={!featureAlignReady(fa)} title="Enter">
              应用
            </button>
            <button onClick={() => cancelFeatureAlign()} title="Esc">
              取消
            </button>
          </div>
        </>
      ) : (
        <div className="seg" role="group" aria-label="关节原点操纵器">
          {(["translate", "rotate", "none"] as const).map((g) => (
            <button key={g} className={st.gizmo === g ? "active" : ""} aria-pressed={st.gizmo === g} onClick={() => useStore.setState({ gizmo: g })} title="关节原点操纵器 (G / R / Esc)">
              {g === "translate" ? <><Icon name="move" /> 移动</> : g === "rotate" ? <><Icon name="rotate" /> 旋转</> : "隐藏操纵器"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
