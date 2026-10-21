import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";

/** Blender-style popup menu at the mouse position (X, M, Shift+A, ...). */
export function PopupMenu() {
  const menu = useStore((s) => s.menu);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!menu) return;
    setActive(menu.items.findIndex((i) => !i.divider));
    // Keep the menu on screen.
    const w = 240;
    const h = menu.items.length * 26 + 32;
    setPos({ x: Math.min(menu.x - 20, window.innerWidth - w - 8), y: Math.min(menu.y - 14, window.innerHeight - h - 8) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => useStore.setState({ menu: null });
    const choose = (i: number) => {
      const it = menu.items[i];
      if (!it || it.divider) return;
      close();
      it.run();
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const real = menu.items.map((it, i) => (it.divider ? -1 : i)).filter((i) => i >= 0);
      if (e.key === "Escape") close();
      else if (e.key === "Enter" || e.key === " ") choose(active);
      else if (e.key === "ArrowDown") setActive(real[(real.indexOf(active) + 1) % real.length]);
      else if (e.key === "ArrowUp") setActive(real[(real.indexOf(active) - 1 + real.length) % real.length]);
      else if (/^[1-9]$/.test(e.key)) choose(real[Number(e.key) - 1]);
    };
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", down, true);
    };
  }, [menu, active]);

  if (!menu) return null;
  let n = 0;
  return (
    <div className="popup-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <div className="popup-title">{menu.title}</div>
      {menu.items.map((it, i) =>
        it.divider ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${i === active ? "active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              useStore.setState({ menu: null });
              it.run();
            }}
          >
            <span>
              <span className="accel">{++n <= 9 ? n : ""}</span>
              {it.label}
            </span>
            {it.hint && <span className="keys">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
