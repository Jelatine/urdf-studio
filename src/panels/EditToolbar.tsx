import { Icon, type IconName } from "./Icon";
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

const ICONS: Record<string, IconName> = {
  "sel.box": "box",
  "sel.circle": "circle",
  "sel.linked": "link",
  "sel.flat": "face",
  "sel.similar": "similar",
  "mesh.grab": "move",
  "mesh.rotate": "rotate",
  "mesh.scale": "scale",
  "mesh.extrude": "extrude",
  "mesh.inset": "inset",
  "mesh.loopcut": "loop",
  "mesh.bisect": "cut",
  "mesh.subdivide": "grid",
  "mesh.fill": "fill",
  "mesh.bridge": "bridge",
  "mesh.merge": "merge",
  "mesh.rip": "cut",
  "mesh.separate": "split",
  "mesh.delete": "trash",
  "mesh.limitedDissolve": "dissolve",
  "mesh.add": "plus",
};

export function EditToolbar() {
  return (
    <div className="edit-toolbar" role="group" aria-label="网格编辑工具">
      {TOOLS.map((id, i) => {
        if (id === "-") return <div key={i} className="tool-sep" />;
        const op = opById.get(id)!;
        return (
          <button key={id} className="tool" aria-label={op.label} title={`${op.label}${op.keys ? `  (${op.keys})` : ""}`} onClick={() => (id === "sel.similar" ? menus.similar() : runOp(id))}>
            <Icon name={ICONS[id]} />
          </button>
        );
      })}
    </div>
  );
}
