import { menus, opById, runOp } from "../edit/operators";

const TOOLS: (string | "-")[] = [
  "sel.box",
  "sel.circle",
  "sel.linked",
  "sel.flat",
  "sel.similar",
  "-",
  "mesh.grab",
  "mesh.rotate",
  "mesh.scale",
  "-",
  "mesh.extrude",
  "mesh.inset",
  "mesh.loopcut",
  "mesh.bisect",
  "mesh.subdivide",
  "mesh.fill",
  "mesh.bridge",
  "-",
  "mesh.merge",
  "mesh.rip",
  "mesh.separate",
  "mesh.delete",
  "mesh.limitedDissolve",
  "mesh.add",
];

const ICONS: Record<string, string> = {
  "sel.box": "⬚",
  "sel.circle": "◯",
  "sel.linked": "⛓",
  "sel.flat": "▱",
  "sel.similar": "≈",
  "mesh.grab": "✥",
  "mesh.rotate": "⟲",
  "mesh.scale": "⤢",
  "mesh.extrude": "⇡",
  "mesh.inset": "⧈",
  "mesh.loopcut": "⫼",
  "mesh.bisect": "⫽",
  "mesh.subdivide": "⊞",
  "mesh.fill": "◼",
  "mesh.bridge": "⌇",
  "mesh.merge": "⤝",
  "mesh.rip": "✂",
  "mesh.separate": "⇲",
  "mesh.delete": "✕",
  "mesh.limitedDissolve": "◌",
  "mesh.add": "＋",
};

export function EditToolbar() {
  return (
    <div className="edit-toolbar">
      {TOOLS.map((id, i) => {
        if (id === "-") return <div key={i} className="tool-sep" />;
        const op = opById.get(id)!;
        return (
          <button key={id} className="tool" title={`${op.label}${op.keys ? `  (${op.keys})` : ""}`} onClick={() => (id === "sel.similar" ? menus.similar() : runOp(id))}>
            {ICONS[id] ?? "•"}
          </button>
        );
      })}
    </div>
  );
}
