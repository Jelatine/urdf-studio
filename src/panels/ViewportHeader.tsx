import { runCmd } from "../edit/meshOps";
import { runOp } from "../edit/operators";
import { beginFeatureAlign, cancelFeatureAlign, enterEditMode, exitEditMode, setFeatureAlignConstraint } from "../state/actions";
import { useStore, type FeatureConstraint } from "../state/store";

const ALIGN_OPTS: { id: FeatureConstraint; label: string }[] = [
  { id: "concentric", label: "圆同心" },
  { id: "collinear", label: "点共线" },
  { id: "parallel", label: "线平行" },
  { id: "axisAlign", label: "轴对齐" },
];

export function ViewportHeader() {
  const st = useStore();
  const robot = st.robot;
  if (!robot) return null;
  const smode = st.meshStats?.mode ?? "vert";
  const fa = st.featureAlign;
  const toggle = (key: "showVisual" | "showCollision" | "showFrames" | "showAxes" | "xray" | "wireframe") => useStore.setState({ [key]: !st[key] });
  return (
    <div className="vp-header">
      <div className="seg">
        <button className={st.mode === "object" ? "active" : ""} onClick={() => st.mode === "edit" && exitEditMode()} title="对象模式 (Tab)">
          对象
        </button>
        <button className={st.mode === "edit" ? "active" : ""} onClick={() => st.mode === "object" && enterEditMode()} title="编辑模式 (Tab)">
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
              title="比例编辑 (O)"
              onClick={() => useStore.setState({ proportional: { ...st.proportional, enabled: !st.proportional.enabled } })}
            >
              ◎ 比例编辑
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
            <button onClick={() => cancelFeatureAlign()} title="Esc">
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="seg">
            {(["translate", "rotate", "none"] as const).map((g) => (
              <button key={g} className={st.gizmo === g ? "active" : ""} onClick={() => useStore.setState({ gizmo: g })} title="关节原点操纵器 (G / R / Esc)">
                {g === "translate" ? "移动" : g === "rotate" ? "旋转" : "无"}
              </button>
            ))}
          </div>
          <div className="seg">
            <button title="特征对齐 (Shift+Alt+A)" onClick={() => beginFeatureAlign({})}>
              特征对齐
            </button>
          </div>
          <div className="seg">
            <button className={st.showVisual ? "active" : ""} onClick={() => toggle("showVisual")}>
              外观
            </button>
            <button className={st.showCollision ? "active" : ""} onClick={() => toggle("showCollision")}>
              碰撞
            </button>
            <button className={st.showFrames ? "active" : ""} onClick={() => toggle("showFrames")} title="显示 link 坐标系">
              坐标系
            </button>
            <button className={st.showAxes ? "active" : ""} onClick={() => toggle("showAxes")} title="显示关节轴">
              关节轴
            </button>
          </div>
        </>
      )}
      <span className="spacer" />
      <div className="seg">
        <button className={st.xray ? "active" : ""} onClick={() => toggle("xray")} title="X-Ray 透视 (Alt+Z)">
          X-Ray
        </button>
        <button className={st.wireframe ? "active" : ""} onClick={() => toggle("wireframe")} title="线框 (Shift+Z)">
          线框
        </button>
      </div>
      <div className="seg">
        <button onClick={() => runOp("view.front")} title="前视图 (Numpad 1)">
          前
        </button>
        <button onClick={() => runOp("view.right")} title="右视图 (Numpad 3)">
          右
        </button>
        <button onClick={() => runOp("view.top")} title="顶视图 (Numpad 7)">
          顶
        </button>
        <button onClick={() => runOp("view.ortho")} title="透视/正交 (Numpad 5)">
          正交
        </button>
        <button onClick={() => runOp("view.selected")} title="查看所选 (Numpad .)">
          聚焦
        </button>
        <button onClick={() => runOp("view.all")} title="查看全部 (Home)">
          全部
        </button>
      </div>
    </div>
  );
}
