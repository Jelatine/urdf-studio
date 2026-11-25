import { useEffect, useRef, useState } from "react";
import { OrthographicCamera, Quaternion, Vector3 } from "three";
import { useShallow } from "zustand/react/shallow";
import { runOp } from "../edit/operators";
import { Icon } from "../panels/Icon";
import { useStore } from "../state/store";
import type { Engine } from "./engine";

const layers = [
  ["showVisual", "外观网格"],
  ["showCollision", "碰撞体"],
  ["showFrames", "连杆坐标系"],
  ["showAxes", "关节轴"],
  ["wireframe", "线框"],
  ["xray", "X-Ray"],
] as const;

const axes = [
  { axis: "X", color: "#f58b92", vector: new Vector3(1, 0, 0) },
  { axis: "Y", color: "#98d8a2", vector: new Vector3(0, 1, 0) },
  { axis: "Z", color: "#8dbeff", vector: new Vector3(0, 0, 1) },
];

function Compass({ rotation }: { rotation: Quaternion }) {
  const inverse = rotation.clone().invert();
  const projected = axes.map((axis) => ({ ...axis, tip: axis.vector.clone().applyQuaternion(inverse) }))
    .sort((a, b) => a.tip.z - b.tip.z);
  return (
    <svg className="view-compass" viewBox="0 0 88 88" role="img" aria-label="相机坐标方向，Z 轴向上">
      <circle cx="44" cy="44" r="41" className="compass-back" />
      {projected.map(({ axis, color, tip }) => {
        const x = 44 + tip.x * 29;
        const y = 44 - tip.y * 29;
        return (
          <g key={axis} color={color} opacity={tip.z < -0.55 ? 0.65 : 1}>
            <line x1="44" y1="44" x2={x} y2={y} stroke="currentColor" strokeWidth="1.5" />
            <circle cx={x} cy={y} r="8" fill="currentColor" />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central">{axis}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function ViewControls({ engine }: { engine: Engine }) {
  const [ortho, setOrtho] = useState(false);
  const [grid, setGrid] = useState(() => engine.gridVisible);
  const [display, setDisplay] = useState(false);
  const displayRef = useRef<HTMLDivElement>(null);
  const flags = useStore(useShallow((s) => ({
    showVisual: s.showVisual, showCollision: s.showCollision, showFrames: s.showFrames,
    showAxes: s.showAxes, xray: s.xray, wireframe: s.wireframe,
  })));
  const editingTool = useStore((s) => !!s.modalHint);

  useEffect(() => {
    const sync = () => setOrtho(engine.camera instanceof OrthographicCamera);
    sync();
    engine.controls.addEventListener("change", sync);
    return () => engine.controls.removeEventListener("change", sync);
  }, [engine]);

  useEffect(() => {
    if (!display) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !displayRef.current?.contains(event.target)) setDisplay(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [display]);

  return (
    <div className="view-actions" role="group" aria-label="相机与显示">
      <button title="切换透视或正交 (Numpad 5)" aria-pressed={ortho} onClick={() => runOp("view.ortho")} disabled={editingTool}>
        <Icon name="cube" /> {ortho ? "正交" : "透视"}
      </button>
      <select aria-label="标准视图" value="" disabled={editingTool} onChange={(e) => {
        if (e.target.value === "diagonal") engine.setViewDirection(new Vector3(1.2, -1.6, 1));
        else runOp(`view.${e.target.value}`);
      }}>
        <option value="" disabled>标准视图</option>
        <option value="diagonal">斜视</option>
        <option value="front">前视（−Y）</option>
        <option value="back">后视（+Y）</option>
        <option value="left">左视（−X）</option>
        <option value="right">右视（+X）</option>
        <option value="top">顶视（+Z）</option>
        <option value="bottom">底视（−Z）</option>
      </select>
      <button title="聚焦所选 (Numpad .)" aria-label="聚焦所选" onClick={() => runOp("view.selected")} disabled={editingTool}><Icon name="focus" /></button>
      <button title="查看全部 (Home)" aria-label="查看全部" onClick={() => runOp("view.all")} disabled={editingTool}><Icon name="frame" /></button>
      <div className="view-display" ref={displayRef} onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDisplay(false);
      }} onKeyDown={(e) => {
        if (e.key === "Escape" && display) {
          e.stopPropagation();
          setDisplay(false);
          e.currentTarget.querySelector("button")?.focus();
        }
      }}>
        <button aria-expanded={display} aria-controls="view-layers" onClick={() => setDisplay(!display)}><Icon name="eye" /> 显示</button>
        <div className="view-layers" id="view-layers" hidden={!display}>
          <label><input type="checkbox" checked={grid} onChange={(e) => {
            setGrid(e.target.checked);
            engine.setGridVisible(e.target.checked);
          }} /> 地面网格</label>
          {layers.map(([key, label]) => (
            <label key={key}><input type="checkbox" checked={flags[key]} onChange={(e) => useStore.setState({ [key]: e.target.checked })} /> {label}</label>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ViewNavigation({ engine }: { engine: Engine }) {
  const [rotation, setRotation] = useState(() => engine.camera.quaternion.clone());
  const editingTool = useStore((s) => !!s.modalHint);
  useEffect(() => {
    const sync = () => setRotation((prev) => prev.equals(engine.camera.quaternion) ? prev : engine.camera.quaternion.clone());
    sync();
    engine.controls.addEventListener("change", sync);
    return () => engine.controls.removeEventListener("change", sync);
  }, [engine]);
  return (
    <div className="view-navigation" role="group" aria-label="视口导航">
      <Compass rotation={rotation} />
      <div className="view-zoom">
        <button aria-label="放大" title="放大" disabled={editingTool} onClick={() => engine.zoom(true)}>+</button>
        <button aria-label="缩小" title="缩小" disabled={editingTool} onClick={() => engine.zoom(false)}>−</button>
      </div>
    </div>
  );
}
