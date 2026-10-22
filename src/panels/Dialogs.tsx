import { useEffect, useMemo, useRef, useState } from "react";
import { separateSelection } from "../edit/meshOps";
import { operators, runOp } from "../edit/operators";
import { applyFit, computeFit, type FitOutput, type FittedShape } from "../state/actions";
import { useStore, type ConfirmRequest, type FitTarget } from "../state/store";
import { writeUrdf, type FitOptions } from "../wasm";
import { Check, Row, Select } from "./widgets";

/** `floating` keeps the viewport visible and usable behind the dialog. */
function Modal(props: { title: string; children: React.ReactNode; wide?: boolean; floating?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.setState({ dialog: null });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  return (
    <div
      className={`modal-backdrop ${props.floating ? "floating" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && useStore.setState({ dialog: null })}
    >
      <div className={`modal ${props.wide ? "wide" : ""}`}>
        <div className="modal-title">
          {props.title}
          <button className="icon-btn" onClick={() => useStore.setState({ dialog: null })}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

function SearchDialog() {
  const mode = useStore((s) => s.mode);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const list = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return operators
      .filter((o) => o.mode === "any" || o.mode === mode)
      .filter((o) => terms.every((t) => `${o.label} ${o.group} ${o.id} ${o.keys ?? ""}`.toLowerCase().includes(t)));
  }, [q, mode]);
  const run = (i: number) => {
    const op = list[i];
    if (!op) return;
    useStore.setState({ dialog: null });
    setTimeout(() => runOp(op.id), 0);
  };
  return (
    <Modal title="搜索操作 (F3)">
      <input
        ref={input}
        className="search-input"
        placeholder="输入操作名称，例如 挤出 / 平展 / 合并…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive(Math.min(active + 1, list.length - 1));
          else if (e.key === "ArrowUp") setActive(Math.max(active - 1, 0));
          else if (e.key === "Enter") run(active);
          else return;
          e.preventDefault();
        }}
      />
      <div className="search-list">
        {list.map((o, i) => (
          <button key={o.id} className={`menu-item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => run(i)}>
            <span>
              <span className="dim">{o.group} ›</span> {o.label}
            </span>
            {o.keys && <span className="keys">{o.keys}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function HelpDialog() {
  const groups = useMemo(() => {
    const m = new Map<string, typeof operators>();
    for (const o of operators) {
      if (!o.keys) continue;
      m.set(o.group, [...(m.get(o.group) ?? []), o]);
    }
    return [...m.entries()];
  }, []);
  return (
    <Modal title="快捷键" wide>
      <div className="help-intro">
        <b>导航:</b> 中键拖动旋转 · Shift+中键 / 右键拖动平移 · 滚轮缩放 · Alt+左键拖动旋转 (触控板) · Shift+右键 放置 3D 游标
        <br />
        <b>编辑模式选择:</b> 单击选择 · Shift+单击 加选/切换 · Ctrl+单击 最短路径 · Alt+单击 循环边 · Ctrl+Alt+单击 环形边 · 左键拖动 框选 (Shift 加选, Ctrl 减选)
        <br />
        <b>变换中:</b> X/Y/Z 约束轴 (再按一次为局部轴, Shift+轴 排除该轴) · 直接输入数字 · 按住 Ctrl 吸附 · 滚轮调整比例编辑半径 · 左键/Enter 确认 · 右键/Esc 取消
      </div>
      <div className="help-grid">
        {groups.map(([g, ops]) => (
          <div key={g} className="help-group">
            <h4>{g}</h4>
            {ops.map((o) => (
              <div key={o.id} className="help-row">
                <span>{o.label}</span>
                <kbd>{o.keys}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SeparateDialog() {
  const choose = (asLink: boolean) => {
    useStore.setState({ dialog: null });
    separateSelection(asLink);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "1") choose(false);
      if (e.key === "2") choose(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <Modal title="分离选中项 (P)">
      <p>把选中的几何体从当前网格中移出，保存为新的网格文件：</p>
      <div className="button-col">
        <button className="primary" onClick={() => choose(false)}>
          1 · 作为同一 link 的新几何体
        </button>
        <button onClick={() => choose(true)}>2 · 作为新的 link (通过 fixed 关节连接)</button>
      </div>
    </Modal>
  );
}

type FitParams = Omit<FitOptions, "all" | "scale">;

// Remembered between invocations of the dialog.
let lastFit: { params: FitParams; output: FitOutput } = {
  params: { shape: "auto", mode: "enclose", axis: "auto", aligned: false, per_island: false },
  output: "add_collision",
};

const SHAPE_NAMES = { box: "立方体", cylinder: "圆柱", sphere: "球" };
const FIT_ERRORS: Record<string, string> = { "nothing selected": "没有选中任何元素" };

const num = (v: number) => `${+v.toPrecision(4)}`;

function describe(g: FittedShape["geometry"]) {
  if (g.type === "box") return `${SHAPE_NAMES.box} ${g.size.map(num).join(" × ")}`;
  if (g.type === "cylinder") return `${SHAPE_NAMES.cylinder} 半径 ${num(g.radius)} · 长 ${num(g.length)}`;
  if (g.type === "sphere") return `${SHAPE_NAMES.sphere} 半径 ${num(g.radius)}`;
  return "";
}

function FitDialog({ target }: { target: FitTarget }) {
  const meshVersion = useStore((s) => s.meshVersion);
  const robot = useStore((s) => s.robot);
  const [params, setParams] = useState(lastFit.params);
  const [output, setOutput] = useState(lastFit.output);
  const set = (p: Partial<FitParams>) => setParams((x) => ({ ...x, ...p }));
  const fit = useMemo((): { shapes: FittedShape[]; error?: string } => {
    try {
      return { shapes: computeFit(target, params) };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { shapes: [], error: FIT_ERRORS[m] ?? m };
    }
    // meshVersion: refit when the selection changes while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, params, meshVersion, robot]);
  useEffect(() => {
    useStore.setState({ fitPreview: fit.shapes.length ? { link: target.link, items: fit.shapes } : null });
  }, [fit, target.link]);
  useEffect(() => () => useStore.setState({ fitPreview: null }), []);
  useEffect(() => {
    lastFit = { params, output };
  }, [params, output]);
  const apply = () => {
    if (!fit.shapes.length) return;
    useStore.setState({ dialog: null });
    applyFit(target, fit.shapes, output);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      applyRef.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const showCyl = params.shape === "auto" || params.shape === "cylinder";
  const showBox = params.shape === "auto" || params.shape === "box";
  const replaceLabel = target.role === "collision" ? `替换碰撞体 #${target.index}` : "替换该 link 的全部碰撞体";
  return (
    <Modal title="拟合基本形状" floating>
      <div className="fit-source dim">
        {target.link} · {target.role === "visual" ? "外观" : "碰撞"} #{target.index} · {target.all ? "整个网格" : "选中部分"}
      </div>
      <Row label="形状">
        <Select
          value={params.shape}
          onChange={(shape) => set({ shape })}
          options={[
            { value: "auto", label: "自动 (选最合适的)" },
            { value: "box", label: "立方体" },
            { value: "cylinder", label: "圆柱" },
            { value: "sphere", label: "球" },
          ]}
        />
      </Row>
      <Row label="方式" title="包围: 形状包含所有顶点，适合碰撞体；最小二乘: 贴合表面 (立方体始终为包围)">
        <Select
          value={params.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "enclose", label: "包围 (包含所有顶点)" },
            { value: "least_squares", label: "最小二乘 (贴合表面)" },
          ]}
        />
      </Row>
      {showCyl && (
        <Row label="圆柱轴向">
          <Select
            value={params.axis}
            onChange={(axis) => set({ axis })}
            options={[
              { value: "auto", label: "自动" },
              { value: "x", label: "网格 X 轴" },
              { value: "y", label: "网格 Y 轴" },
              { value: "z", label: "网格 Z 轴" },
            ]}
          />
        </Row>
      )}
      {showBox && (
        <Row label="立方体">
          <Check label="与网格坐标轴对齐" checked={params.aligned} onChange={(aligned) => set({ aligned })} />
        </Row>
      )}
      <Row label="分块">
        <Check label="每个相连部分单独拟合" checked={params.per_island} onChange={(per_island) => set({ per_island })} />
      </Row>
      <Row label="输出">
        <Select
          value={output}
          onChange={setOutput}
          options={[
            { value: "add_collision", label: "添加为新的碰撞体" },
            { value: "replace_collision", label: replaceLabel },
            { value: "add_visual", label: "添加为外观" },
          ]}
        />
      </Row>
      <div className="fit-results">
        {fit.error && <div className="fit-error">{fit.error}</div>}
        {fit.shapes.slice(0, 20).map((sh, i) => (
          <div key={i} className="fit-result">
            <span>{describe(sh.geometry)}</span>
            <span className="dim" title="顶点和面中心到形状表面的距离">
              偏差 RMS {num(sh.result.rms)} · 最大 {num(sh.result.max_dev)}
            </span>
          </div>
        ))}
        {fit.shapes.length > 20 && <div className="dim">… 共 {fit.shapes.length} 个形状</div>}
      </div>
      <div className="fit-actions">
        <button onClick={() => useStore.setState({ dialog: null })}>取消</button>
        <button className="primary" disabled={!fit.shapes.length} onClick={apply}>
          应用{fit.shapes.length > 1 ? ` (${fit.shapes.length})` : ""}
        </button>
      </div>
    </Modal>
  );
}

function UrdfSourceDialog() {
  const robot = useStore((s) => s.robot);
  const text = useMemo(() => (robot ? writeUrdf(robot) : ""), [robot]);
  return (
    <Modal title="URDF 源码 (保存时的输出)" wide>
      <div className="button-row">
        <button onClick={() => void navigator.clipboard.writeText(text)}>复制</button>
      </div>
      <textarea className="source" readOnly value={text} />
    </Modal>
  );
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") req.resolve(null);
      else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) req.resolve(req.defaultId ?? null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [req]);
  return (
    <div className="modal-backdrop confirm-backdrop">
      <div className="modal confirm" role="alertdialog" aria-labelledby="confirm-title">
        <div className="confirm-body">
          <div className="confirm-icon">!</div>
          <div>
            <div id="confirm-title" className="confirm-title">
              {req.title}
            </div>
            <div className="confirm-msg">{req.message}</div>
          </div>
        </div>
        <div className="confirm-actions">
          {req.buttons.map((b) => (
            <button
              key={b.id}
              ref={b.id === req.defaultId ? primary : undefined}
              className={b.kind ?? ""}
              onClick={() => req.resolve(b.id === "cancel" ? null : b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const confirm = useStore((s) => s.confirm);
  const fitTarget = useStore((s) => s.fitTarget);
  if (confirm) return <ConfirmDialog req={confirm} />;
  if (dialog === "fit" && fitTarget) return <FitDialog target={fitTarget} />;
  if (dialog === "search") return <SearchDialog />;
  if (dialog === "help") return <HelpDialog />;
  if (dialog === "separate") return <SeparateDialog />;
  if (dialog === "urdf-source") return <UrdfSourceDialog />;
  return null;
}
