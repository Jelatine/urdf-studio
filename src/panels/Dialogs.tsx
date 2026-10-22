import { useEffect, useMemo, useRef, useState } from "react";
import { separateSelection } from "../edit/meshOps";
import { operators, runOp } from "../edit/operators";
import { useStore, type ConfirmRequest } from "../state/store";
import { writeUrdf } from "../wasm";

function Modal(props: { title: string; children: React.ReactNode; wide?: boolean }) {
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && useStore.setState({ dialog: null })}>
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
  if (confirm) return <ConfirmDialog req={confirm} />;
  if (dialog === "search") return <SearchDialog />;
  if (dialog === "help") return <HelpDialog />;
  if (dialog === "separate") return <SeparateDialog />;
  if (dialog === "urdf-source") return <UrdfSourceDialog />;
  return null;
}
