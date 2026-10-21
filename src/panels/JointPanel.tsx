import { useState } from "react";
import { effectiveJointValues, initialJointValues } from "../state/actions";
import { useStore } from "../state/store";
import { resetSimulation } from "../sim/simulation";
import { isMovable, jointRange } from "../types/urdf";
import { RAD2DEG } from "./widgets";

export function JointPanel() {
  const robot = useStore((s) => s.robot);
  const values = useStore((s) => s.jointValues);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.simSpeed);
  const keyframes = useStore((s) => s.keyframes);
  const selection = useStore((s) => s.selection);
  const mode = useStore((s) => s.mode);
  const [open, setOpen] = useState(true);
  if (!robot || mode === "edit") return null;
  const joints = robot.joints.filter(isMovable);
  const effective = effectiveJointValues(robot, values);
  const set = (name: string, v: number) => useStore.setState({ jointValues: { ...values, [name]: v } });
  const play = (p: typeof playing) => {
    resetSimulation();
    useStore.setState({ playing: playing === p ? false : p });
  };
  return (
    <div className={`joint-panel ${open ? "" : "collapsed"}`}>
      <div className="joint-panel-head">
        <span className="caret" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </span>
        <b>运动模拟</b>
        <span className="dim">{joints.length} 个可动关节</span>
        <span className="spacer" />
        <button className={playing === "sweep" ? "active" : ""} onClick={() => play("sweep")} title="所有关节在限位内正弦扫动 (Space)">
          {playing === "sweep" ? "⏸" : "▶"} 扫动
        </button>
        <button className={playing === "random" ? "active" : ""} onClick={() => play("random")} title="按速度限制运动到随机目标">
          {playing === "random" ? "⏸" : "▶"} 随机
        </button>
        <button className={playing === "keyframes" ? "active" : ""} onClick={() => play("keyframes")} title="循环播放关键帧">
          {playing === "keyframes" ? "⏸" : "▶"} 关键帧 ({keyframes.length})
        </button>
        <button onClick={() => useStore.setState({ keyframes: [...keyframes, { ...values }] })} title="把当前姿态添加为关键帧">
          + 帧
        </button>
        <button onClick={() => useStore.setState({ keyframes: [] })} disabled={!keyframes.length}>
          清除帧
        </button>
        <button
          onClick={() => {
            useStore.setState({ playing: false, jointValues: initialJointValues(robot, {}) });
          }}
        >
          归零
        </button>
        <label className="speed">
          速度
          <input type="range" min={0.1} max={4} step={0.1} value={speed} onChange={(e) => useStore.setState({ simSpeed: Number(e.target.value) })} />
          {speed.toFixed(1)}×
        </label>
      </div>
      {open && (
        <div className="joint-sliders">
          {joints.length === 0 && <div className="dim pad">没有可动关节</div>}
          {joints.map((j) => {
            const [lo, hi] = jointRange(j);
            const v = effective[j.name] ?? 0;
            const angular = j.joint_type !== "prismatic";
            const sel = selection?.kind === "joint" && selection.name === j.name;
            return (
              <div key={j.name} className={`joint-slider ${sel ? "selected" : ""}`}>
                <span className="jname" onClick={() => useStore.setState({ selection: { kind: "joint", name: j.name } })} title={j.joint_type}>
                  {j.name}
                  {j.mimic && <span className="dim"> (mimic {j.mimic.joint})</span>}
                </span>
                <input type="range" min={lo} max={hi} step={(hi - lo) / 2000} value={v} disabled={!!j.mimic} onChange={(e) => set(j.name, Number(e.target.value))} />
                <span className="jval">{angular ? `${(v * RAD2DEG).toFixed(1)}°` : `${v.toFixed(4)} m`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
