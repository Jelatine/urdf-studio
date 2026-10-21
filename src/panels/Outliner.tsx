import { useState } from "react";
import { addChildLink, deleteSelection, reparent, switchUrdf } from "../state/actions";
import { useStore } from "../state/store";
import { childrenMap, rootLinks, type Joint, type Robot } from "../types/urdf";

const JOINT_ICON: Record<string, string> = {
  revolute: "⟳",
  continuous: "∞",
  prismatic: "⇕",
  fixed: "◆",
  floating: "✥",
  planar: "▱",
};

interface TreeNode {
  name: string;
  children: { joint: Joint; node: TreeNode }[];
}

/** Builds the link tree once per render (cycle-safe, no mutation during render). */
function buildTree(robot: Robot): TreeNode[] {
  const kids = childrenMap(robot);
  const seen = new Set<string>();
  const build = (name: string): TreeNode => {
    seen.add(name);
    const children = (kids.get(name) ?? []).filter((j) => !seen.has(j.child)).map((joint) => ({ joint, node: build(joint.child) }));
    return { name, children };
  };
  const out = rootLinks(robot).map(build);
  for (const l of robot.links) if (!seen.has(l.name)) out.push(build(l.name));
  return out;
}

function LinkNode(props: { node: TreeNode; depth: number }) {
  const { node, depth } = props;
  const name = node.name;
  const selection = useStore((s) => s.selection);
  const issues = useStore((s) => s.issues);
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const joints = node.children.map((c) => c.joint);
  const sel = selection?.kind === "link" && selection.name === name;
  const err = issues.some((i) => i.target === name && i.level === "error");
  return (
    <div>
      <div
        className={`tree-row ${sel ? "selected" : ""} ${dragOver ? "drag-over" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => useStore.setState({ selection: { kind: "link", name } })}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/link", name)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/link")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const child = e.dataTransfer.getData("text/link");
          if (child) reparent(child, name);
        }}
        title="拖动到另一个 link 上可改变父级"
      >
        <span className="twisty" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
          {joints.length ? (open ? "▾" : "▸") : " "}
        </span>
        <span className="icon link-icon">▣</span>
        <span className={err ? "has-error" : ""}>{name}</span>
      </div>
      {open &&
        node.children.map(({ joint: j, node: child }) => (
          <div key={j.name}>
            <div
              className={`tree-row joint ${selection?.kind === "joint" && selection.name === j.name ? "selected" : ""}`}
              style={{ paddingLeft: 20 + depth * 14 }}
              onClick={() => useStore.setState({ selection: { kind: "joint", name: j.name } })}
              title={`${j.joint_type}: ${j.parent} → ${j.child}`}
            >
              <span className="icon joint-icon">{JOINT_ICON[j.joint_type]}</span>
              <span className={issues.some((i) => i.target === j.name && i.level === "error") ? "has-error" : ""}>{j.name}</span>
              <span className="tree-meta">{j.joint_type}</span>
            </div>
            <LinkNode node={child} depth={depth + 1} />
          </div>
        ))}
    </div>
  );
}

export function Outliner() {
  const robot = useStore((s) => s.robot);
  const project = useStore((s) => s.project);
  const meshInfo = useStore((s) => s.meshInfo);
  const meshPaths = useStore((s) => s.meshPaths);
  const selection = useStore((s) => s.selection);
  if (!robot) return <div className="panel-empty">未打开项目</div>;
  const tree = buildTree(robot);
  const missing = Object.entries(meshPaths).filter(([, p]) => !p);
  return (
    <div className="outliner">
      <div className="panel-title">
        结构 <span className="dim">{robot.name}</span>
        <span className="panel-actions">
          <button className="icon-btn" title="添加子 link (Shift+A)" onClick={() => addChildLink()}>
            ＋
          </button>
          <button className="icon-btn" title="删除所选 link 及其子树 (X)" onClick={deleteSelection}>
            🗑
          </button>
        </span>
      </div>
      {project && project.candidates.length > 1 && (
        <div className="urdf-switch">
          <select value={project.urdfPath} onChange={(e) => void switchUrdf(e.target.value)}>
            {project.candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="tree">
        <div
          className={`tree-row ${selection === null ? "selected" : ""}`}
          onClick={() => useStore.setState({ selection: null })}
        >
          <span className="icon">🤖</span>
          <span>{robot.name}</span>
        </div>
        {tree.map((n) => (
          <LinkNode key={n.name} node={n} depth={1} />
        ))}
      </div>
      <div className="panel-title small">网格文件</div>
      <div className="mesh-list">
        {Object.entries(meshInfo).map(([p, info]) => (
          <div key={p} className={`mesh-row ${info.status}`} title={info.error ?? p}>
            <span className="mesh-status">{info.status === "ready" ? "●" : info.status === "loading" ? "◌" : "✕"}</span>
            {p.split("/").pop()}
          </div>
        ))}
        {missing.map(([f]) => (
          <div key={f} className="mesh-row missing" title={`未找到: ${f}`}>
            <span className="mesh-status">✕</span>
            {f.split("/").pop()}
          </div>
        ))}
      </div>
    </div>
  );
}
