// Blender-style keymap. Matching uses `KeyboardEvent.code` so that
// Alt/Option combinations work on macOS (where `key` becomes e.g. "å").

import { store } from "../state/store";
import { getEngine } from "../viewport/engine";
import { runOp, type OpMode } from "./operators";

interface Binding {
  codes: string[];
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  mode: OpMode;
  op: string;
}

const b = (codes: string | string[], op: string, mode: OpMode, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): Binding => ({
  codes: Array.isArray(codes) ? codes : [codes],
  op,
  mode,
  ...mods,
});
const C = { ctrl: true };
const S = { shift: true };
const A = { alt: true };
const CS = { ctrl: true, shift: true };

export const bindings: Binding[] = [
  // any mode
  b("Tab", "edit.toggle", "any"),
  b("KeyZ", "edit.undo", "any", C),
  b("KeyZ", "edit.redo", "any", CS),
  b("KeyY", "edit.redo", "any", C),
  b("F3", "ui.search", "any"),
  b("F1", "ui.help", "any"),
  b("Home", "view.all", "any"),
  b("NumpadDecimal", "view.selected", "any"),
  b("Numpad1", "view.front", "any"),
  b("Numpad1", "view.back", "any", C),
  b("Numpad3", "view.right", "any"),
  b("Numpad3", "view.left", "any", C),
  b("Numpad7", "view.top", "any"),
  b("Numpad7", "view.bottom", "any", C),
  b("Numpad5", "view.ortho", "any"),
  b("KeyZ", "view.xray", "any", A),
  b("KeyZ", "view.wire", "any", S),
  b("KeyO", "file.open", "any", C),
  b("KeyN", "file.new", "any", C),
  b("KeyS", "file.save", "any", C),
  b("KeyS", "file.saveZip", "any", CS),
  // object mode
  b("KeyA", "obj.addLink", "object", S),
  b(["KeyX", "Delete"], "obj.delete", "object"),
  b("KeyG", "obj.move", "object"),
  b("KeyR", "obj.rotate", "object"),
  b("Escape", "obj.gizmoOff", "object"),
  b("Space", "sim.play", "object"),
  b("KeyF", "view.selected", "object"),
  b("KeyF", "obj.fit", "object", { shift: true, alt: true }),
  // edit mode: selection
  b("Digit1", "sel.vert", "edit"),
  b("Digit2", "sel.edge", "edit"),
  b("Digit3", "sel.face", "edit"),
  b("KeyA", "sel.all", "edit"),
  b("KeyA", "sel.none", "edit", A),
  b("KeyI", "sel.invert", "edit", C),
  b("KeyB", "sel.box", "edit"),
  b("KeyC", "sel.circle", "edit"),
  b("KeyL", "sel.linked", "edit", C),
  b("KeyL", "sel.linkedPick", "edit"),
  b("KeyL", "sel.unlinkedPick", "edit", S),
  b("KeyF", "sel.flat", "edit", S),
  b(["Equal", "NumpadAdd"], "sel.more", "edit", C),
  b(["Minus", "NumpadSubtract"], "sel.less", "edit", C),
  b("KeyG", "sel.similar", "edit", S),
  b("KeyM", "sel.nonManifold", "edit", { ctrl: true, shift: true, alt: true }),
  b("KeyH", "sel.hide", "edit"),
  b("KeyH", "sel.hideOthers", "edit", S),
  b("KeyH", "sel.reveal", "edit", A),
  // edit mode: mesh
  b("KeyG", "mesh.grab", "edit"),
  b("KeyR", "mesh.rotate", "edit"),
  b("KeyS", "mesh.scale", "edit"),
  b("KeyM", "mesh.mirror", "edit", C),
  b("KeyO", "mesh.proportional", "edit"),
  b(["KeyX", "Delete"], "mesh.delete", "edit"),
  b(["KeyX", "Delete"], "mesh.dissolve", "edit", C),
  b("KeyE", "mesh.extrude", "edit"),
  b("KeyE", "mesh.extrudeInd", "edit", A),
  b("KeyI", "mesh.inset", "edit"),
  b("KeyF", "mesh.fill", "edit"),
  b("KeyF", "mesh.fillTri", "edit", A),
  b("KeyM", "mesh.merge", "edit"),
  b("KeyM", "mesh.removeDoubles", "edit", A),
  b("KeyR", "mesh.loopcut", "edit", C),
  b("KeyV", "mesh.rip", "edit"),
  b("KeyY", "mesh.split", "edit"),
  b("KeyP", "mesh.separate", "edit"),
  b("KeyF", "mesh.fit", "edit", { shift: true, alt: true }),
  b("KeyD", "mesh.duplicate", "edit", S),
  b("KeyT", "mesh.triangulate", "edit", C),
  b("KeyJ", "mesh.quads", "edit", A),
  b("KeyJ", "mesh.connect", "edit"),
  b("KeyN", "mesh.normalsOut", "edit", S),
  b("KeyN", "mesh.normalsIn", "edit", CS),
  b("KeyN", "mesh.normalsMenu", "edit", A),
  b("KeyA", "mesh.add", "edit", S),
  b("KeyV", "menu.vertex", "edit", C),
  b("KeyE", "menu.edge", "edit", C),
  b("KeyF", "menu.face", "edit", C),
  b("KeyW", "ui.context", "edit"),
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export function matchBinding(e: KeyboardEvent, mode: "edit" | "object"): Binding | undefined {
  const ctrl = e.ctrlKey || e.metaKey;
  return bindings.find(
    (x) =>
      x.codes.includes(e.code) &&
      !!x.ctrl === ctrl &&
      !!x.shift === e.shiftKey &&
      !!x.alt === e.altKey &&
      (x.mode === "any" || x.mode === mode),
  );
}

export function installKeymap(): () => void {
  const down = (e: KeyboardEvent) => {
    if (isTyping(e)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    const st = store.getState();
    if (st.menu || st.dialog || st.confirm) return; // handled by the open menu/dialog
    const eng = getEngine();
    if (eng?.modal) {
      if (eng.handleModalKey(e)) e.preventDefault();
      return;
    }
    // Numpad orbit steps.
    const steps: Record<string, [number, number]> = {
      Numpad4: [-Math.PI / 12, 0],
      Numpad6: [Math.PI / 12, 0],
      Numpad8: [0, Math.PI / 12],
      Numpad2: [0, -Math.PI / 12],
    };
    if (steps[e.code] && !e.ctrlKey && !e.metaKey) {
      eng?.orbitStep(...steps[e.code]);
      e.preventDefault();
      return;
    }
    const bnd = matchBinding(e, st.mode);
    if (!bnd) return;
    e.preventDefault();
    runOp(bnd.op);
  };
  const up = (e: KeyboardEvent) => getEngine()?.handleModalKeyUp(e);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
  };
}
