import { useState } from "react";
import { adjustLast } from "../edit/meshOps";
import { useStore } from "../state/store";
import { Check, NumField, Select } from "./widgets";

/** Blender's "Adjust Last Operation" panel (bottom-left of the viewport). */
export function AdjustPanel() {
  const last = useStore((s) => s.lastOp);
  const mode = useStore((s) => s.mode);
  const [open, setOpen] = useState(true);
  if (!last || mode !== "edit") return null;
  const set = (key: string, v: unknown) => adjustLast({ ...last.cmd, [key]: v });
  return (
    <div className="adjust-panel">
      <div className="adjust-head" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {last.label}
      </div>
      {open && (
        <div className="adjust-body">
          {last.params.length === 0 && <div className="dim">无可调参数</div>}
          {last.params.map((p) => {
            const v = last.cmd[p.key];
            if (p.type === "bool") return <Check key={p.key} label={p.label} checked={!!v} onChange={(b) => set(p.key, b)} />;
            if (p.type === "enum")
              return (
                <div key={p.key} className="field-row">
                  <span className="row-label">{p.label}</span>
                  <Select value={String(v)} options={p.options ?? []} onChange={(x) => set(p.key, x)} />
                </div>
              );
            return (
              <div key={p.key} className="field-row">
                <span className="row-label">{p.label}</span>
                <NumField value={Number(v)} min={p.min} max={p.max} step={p.step} int={p.type === "int"} label="" onChange={(x) => set(p.key, x)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
