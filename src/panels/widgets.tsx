import { useEffect, useState, type ReactNode } from "react";

const fmt = (v: number, digits = 6) => {
  if (!Number.isFinite(v)) return "";
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
};

/**
 * Numeric input that commits on Enter/blur and supports dragging the label
 * to scrub the value (like Blender's number fields).
 */
export function NumField(props: {
  label?: string;
  value: number;
  onChange: (v: number, scrubbing?: boolean) => void;
  step?: number;
  min?: number;
  max?: number;
  digits?: number;
  title?: string;
  int?: boolean;
}) {
  const { value, onChange, step = 0.01, min = -Infinity, max = Infinity, digits = 6 } = props;
  const [text, setText] = useState(fmt(value, digits));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value, digits));
  }, [value, focused, digits]);

  const clamp = (v: number) => Math.min(max, Math.max(min, props.int ? Math.round(v) : v));
  const commit = () => {
    // Allow simple expressions like "90*pi/180" or "0.5/2".
    const expr = text.replace(/pi/gi, String(Math.PI)).replace(/deg/gi, `*${Math.PI / 180}`);
    let v = Number(expr);
    if (!Number.isFinite(v) && /^[\d+\-*/().\se]+$/.test(expr)) {
      try {
        v = Number(Function(`"use strict";return (${expr})`)());
      } catch {
        v = NaN;
      }
    }
    if (Number.isFinite(v)) onChange(clamp(v));
    else setText(fmt(value, digits));
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = value;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const k = ev.shiftKey ? 0.1 : ev.ctrlKey ? 10 : 1;
      onChange(clamp(v0 + Math.round(dx / 2) * step * k), true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <label className="num-field" title={props.title}>
      {props.label !== undefined && (
        <span className="num-label" onPointerDown={scrub} title="拖动调整数值 (Shift 精细, Ctrl 粗调)">
          {props.label}
        </span>
      )}
      <input
        value={text}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            onChange(clamp(value + (e.key === "ArrowUp" ? step : -step)));
          }
        }}
      />
    </label>
  );
}

export function Vec3Field(props: {
  label: ReactNode;
  value: [number, number, number];
  onChange: (v: [number, number, number], scrubbing?: boolean) => void;
  step?: number;
  names?: [string, string, string];
}) {
  const names = props.names ?? ["X", "Y", "Z"];
  return (
    <div className="field-row">
      <span className="row-label">{props.label}</span>
      <div className="vec3">
        {[0, 1, 2].map((i) => (
          <NumField
            key={i}
            label={names[i]}
            value={props.value[i]}
            step={props.step}
            onChange={(v, scrub) => {
              const next = [...props.value] as [number, number, number];
              next[i] = v;
              props.onChange(next, scrub);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function Row(props: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="field-row" title={props.title}>
      <span className="row-label">{props.label}</span>
      <div className="row-value">{props.children}</div>
    </div>
  );
}

export function TextField(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <input
      className="text-field"
      value={text}
      placeholder={props.placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== props.value && props.onChange(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Section(props: { title: ReactNode; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <div className="section">
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="section-title">{props.title}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          {props.actions}
        </span>
      </div>
      {open && <div className="section-body">{props.children}</div>}
    </div>
  );
}

export function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="check" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Select<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select className="select" value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export const RAD2DEG = 180 / Math.PI;
