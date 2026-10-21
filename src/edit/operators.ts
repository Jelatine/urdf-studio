// All user-facing operators: labels, shortcuts, adjustable parameters and
// popup menus. Used by the keymap, toolbar, menus and the F3 search.

import * as THREE from "three";
import {
  addChildLink,
  deleteSelection,
  enterEditMode,
  exitEditMode,
  newProject,
  openProject,
  saveProject,
} from "../state/actions";
import { store, type MenuState, type ParamSpec } from "../state/store";
import { getEngine } from "../viewport/engine";
import type { Command } from "../wasm";
import { currentEntry, redoMesh, runCmd, undoMesh } from "./meshOps";

const s = () => store.getState();
const eng = () => getEngine();

export type OpMode = "edit" | "object" | "any";

export interface Operator {
  id: string;
  label: string;
  group: string;
  keys?: string;
  mode: OpMode;
  run: () => void;
}

const ANGLE = (key = "angle", label = "角度 (°)"): ParamSpec => ({ key, label, type: "number", min: 0, max: 180, step: 0.5 });

/** Runs a command and registers it for the "adjust last operation" panel. */
function cmd(c: Command, label: string, params: ParamSpec[] = []) {
  return () => {
    runCmd(c, { label, params });
  };
}

function selectMode(mode: "vert" | "edge" | "face") {
  return () => runCmd({ op: "set_select_mode", mode }, { label: `选择模式: ${{ vert: "点", edge: "边", face: "面" }[mode]}`, noAdjust: true });
}

function extrudeAndMove() {
  const out = runCmd({ op: "extrude" }, { label: "挤出", noAdjust: true });
  if (!out) return;
  const e = eng();
  const ov = e?.overlay;
  let normal: THREE.Vector3 | undefined;
  if (out.normal && ov) {
    normal = new THREE.Vector3(...out.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(ov.group.matrixWorld)).normalize();
  }
  e?.startTransform("translate", { normal });
}

function duplicateAndMove() {
  if (runCmd({ op: "duplicate" }, { label: "复制", noAdjust: true })) eng()?.startTransform("translate");
}

function ripAndMove() {
  if (runCmd({ op: "rip" }, { label: "撕裂 (沿边拆分)", noAdjust: true })) eng()?.startTransform("translate");
}

function linkedFlat() {
  const st = s().meshStats;
  if (st && st.selFaces === 0) {
    const f = eng()?.faceAtCursor();
    if (f == null) {
      s().setStatus("请先选择一个面，或将鼠标放在面上", "error");
      return;
    }
    runCmd({ op: "set_select_mode", mode: "face" }, { label: "面模式", noAdjust: true });
    runCmd({ op: "select_elems", kind: "face", ids: [f], mode: "set" }, { label: "选择", noAdjust: true });
  }
  runCmd({ op: "select_linked_flat", angle: 1, relative_to_seed: false }, {
    label: "选择相连平展面",
    params: [ANGLE("angle", "锐度 (°)"), { key: "relative_to_seed", label: "相对种子面 (共面区域)", type: "bool" }],
  });
}

function dissolveByMode() {
  const mode = s().meshStats?.mode ?? "vert";
  const op = mode === "vert" ? "dissolve_verts" : mode === "edge" ? "dissolve_edges" : "dissolve_faces";
  runCmd({ op }, { label: "融并" });
}

export function openMenu(title: string, items: MenuState["items"]) {
  const e = eng();
  let x = 200;
  let y = 200;
  if (e) {
    const r = e.renderer.domElement.getBoundingClientRect();
    x = r.left + e.mouse.x;
    y = r.top + e.mouse.y;
  }
  store.setState({ menu: { title, x, y, items } });
}

const item = (label: string, run: () => void, hint?: string) => ({ label, run, hint });
const divider = { label: "", run: () => {}, divider: true };

export const menus = {
  delete: () =>
    openMenu("删除", [
      item("顶点", cmd({ op: "delete", kind: "verts" }, "删除顶点")),
      item("边", cmd({ op: "delete", kind: "edges" }, "删除边")),
      item("面", cmd({ op: "delete", kind: "faces" }, "删除面")),
      item("仅边和面", cmd({ op: "delete", kind: "only_edges_faces" }, "仅删除边和面")),
      item("仅面", cmd({ op: "delete", kind: "only_faces" }, "仅删除面")),
      divider,
      item("融并顶点", cmd({ op: "dissolve_verts" }, "融并顶点")),
      item("融并边", cmd({ op: "dissolve_edges" }, "融并边")),
      item("融并面", cmd({ op: "dissolve_faces" }, "融并面")),
      item("有限融并", cmd({ op: "dissolve_limited", angle: 5 }, "有限融并", [ANGLE("angle", "最大角度 (°)")])),
    ]),
  merge: () =>
    openMenu("合并", [
      item("到中心", cmd({ op: "merge", kind: "center" }, "合并到中心")),
      item("到游标", () => runCmd({ op: "merge", kind: "cursor", cursor: eng()?.cursorLocal() ?? [0, 0, 0] }, { label: "合并到游标" })),
      item("塌陷", cmd({ op: "merge", kind: "collapse" }, "塌陷")),
      item("到首选点", cmd({ op: "merge", kind: "first" }, "合并到首选点")),
      item("到末选点", cmd({ op: "merge", kind: "last" }, "合并到末选点")),
      divider,
      item("按距离", cmd({ op: "remove_doubles", distance: 0.0001 }, "按距离合并", [{ key: "distance", label: "合并距离", type: "number", min: 0, step: 0.0001 }])),
    ]),
  normals: () =>
    openMenu("法线", [
      item("翻转", cmd({ op: "flip_normals" }, "翻转法线")),
      item("重新计算外侧", cmd({ op: "recalc_normals", inside: false }, "重新计算法线", [{ key: "inside", label: "朝内", type: "bool" }]), "Shift+N"),
      item("重新计算内侧", cmd({ op: "recalc_normals", inside: true }, "重新计算法线", [{ key: "inside", label: "朝内", type: "bool" }]), "Ctrl+Shift+N"),
    ]),
  similar: () => {
    const mode = s().meshStats?.mode ?? "vert";
    const p = (types: [string, string, number][]) =>
      types.map(([t, l, th]) =>
        item(
          l,
          cmd({ op: "select_similar", similar: t, threshold: th }, `选择相似: ${l}`, [
            { key: "threshold", label: "阈值", type: "number", min: 0, step: 0.01 },
          ]),
        ),
      );
    openMenu(
      "选择相似",
      mode === "face"
        ? p([["normal", "法线", 5], ["coplanar", "共面", 5], ["area", "面积", 0.05], ["perimeter", "周长", 0.05], ["sides", "边数", 0]])
        : mode === "edge"
          ? p([["length", "长度", 0.05], ["direction", "方向", 5], ["face_count", "相邻面数", 0]])
          : p([["normal", "法线", 5], ["edge_count", "相连边数", 0], ["face_count", "相邻面数", 0]]),
    );
  },
  add: () => {
    const prim = (shape: string, label: string, extra: ParamSpec[] = []) =>
      item(label, () =>
        runCmd(
          { op: "add_primitive", shape, size: guessSize(), segments: 32, rings: 16, offset: eng()?.cursorLocal() ?? [0, 0, 0] },
          { label: `添加${label}`, params: [{ key: "size", label: "尺寸", type: "number", min: 0, step: 0.01 }, ...extra] },
        ),
      );
    const seg: ParamSpec = { key: "segments", label: "段数", type: "int", min: 3, max: 256, step: 1 };
    openMenu("添加网格", [
      prim("cube", "立方体"),
      prim("plane", "平面"),
      prim("grid", "栅格", [seg]),
      prim("circle", "圆", [seg]),
      prim("cylinder", "圆柱", [seg]),
      prim("cone", "圆锥", [seg]),
      prim("uv_sphere", "UV 球", [seg, { key: "rings", label: "环数", type: "int", min: 2, max: 128, step: 1 }]),
    ]);
  },
  mirror: () =>
    openMenu(
      "镜像",
      (["X", "Y", "Z"] as const).map((a, i) => item(`${a} 轴 (绕选中中心)`, cmd({ op: "mirror", axis: i }, `镜像 ${a}`))),
    ),
  edge: () =>
    openMenu("边", [
      item("细分", cmd({ op: "subdivide", levels: 1 }, "细分", [{ key: "levels", label: "级别", type: "int", min: 1, max: 6, step: 1 }])),
      item("环切", () => eng()?.startLoopCut(), "Ctrl+R"),
      item("桥接循环边", cmd({ op: "bridge" }, "桥接循环边")),
      item("撕裂 (沿边拆分)", ripAndMove, "V"),
      item("连接顶点", cmd({ op: "connect" }, "连接顶点路径"), "J"),
      divider,
      item("选择锐边", cmd({ op: "select_sharp_edges", angle: 30 }, "选择锐边", [ANGLE("angle", "锐度 (°)")])),
      item("选择边界循环", cmd({ op: "select_boundary_loop" }, "选择边界循环")),
      item("选择循环内侧区域", cmd({ op: "select_inner_region" }, "选择内侧区域")),
    ]),
  face: () =>
    openMenu("面", [
      item("挤出面", extrudeAndMove, "E"),
      item("挤出各个面", () =>
        eng()?.startParamDrag({ op: "extrude_individual", offset: 0 }, "offset", "挤出各个面", [{ key: "offset", label: "偏移", type: "number", step: 0.001 }]),
      "Alt+E"),
      item("内插面", insetModal, "I"),
      item("单独内插", () => insetModal(true)),
      item("尖分 (Poke)", cmd({ op: "poke" }, "尖分面")),
      item("三角化", cmd({ op: "triangulate" }, "三角化面"), "Ctrl+T"),
      item("三角转四边", cmd({ op: "tris_to_quads", angle: 40 }, "三角面转四边面", [ANGLE("angle", "最大角度 (°)")]), "Alt+J"),
      item("填充", cmd({ op: "fill", triangulate: false }, "填充", [{ key: "triangulate", label: "三角化", type: "bool" }]), "F"),
      item("切分 (Bisect)", () => eng()?.startBisect()),
      divider,
      item("选择相连平展面", linkedFlat, "Shift+F"),
      item("按边数选择", cmd({ op: "select_by_sides", sides: 4, compare: "greater" }, "按边数选择面", [
        { key: "sides", label: "边数", type: "int", min: 3, step: 1 },
        { key: "compare", label: "比较", type: "enum", options: [
          { value: "equal", label: "等于" }, { value: "greater", label: "大于" }, { value: "less", label: "小于" }, { value: "not_equal", label: "不等于" },
        ] },
      ])),
    ]),
  vertex: () =>
    openMenu("顶点", [
      item("连接顶点路径", cmd({ op: "connect" }, "连接顶点路径"), "J"),
      item("填充/建边面", cmd({ op: "fill", triangulate: false }, "填充"), "F"),
      item("平滑顶点", cmd({ op: "smooth", factor: 0.5, iterations: 1 }, "平滑顶点", [
        { key: "factor", label: "系数", type: "number", min: 0, max: 1, step: 0.05 },
        { key: "iterations", label: "迭代", type: "int", min: 1, max: 100, step: 1 },
      ])),
      item("按距离合并", cmd({ op: "remove_doubles", distance: 0.0001 }, "按距离合并", [{ key: "distance", label: "合并距离", type: "number", min: 0, step: 0.0001 }])),
      item("拆分 (Y)", cmd({ op: "split" }, "拆分"), "Y"),
      item("分离 (P)", () => store.setState({ dialog: "separate" }), "P"),
    ]),
  select: () =>
    openMenu("选择", [
      item("全选", cmd({ op: "select_all", action: "select" }, "全选"), "A"),
      item("取消选择", cmd({ op: "select_all", action: "deselect" }, "取消选择"), "Alt+A"),
      item("反选", cmd({ op: "select_all", action: "invert" }, "反选"), "Ctrl+I"),
      item("框选", () => eng()?.startBoxSelect(), "B"),
      item("刷选", () => eng()?.startCircleSelect(), "C"),
      divider,
      item("选择相连", cmd({ op: "select_linked" }, "选择相连"), "Ctrl+L"),
      item("选择相连平展面", linkedFlat, "Shift+F"),
      item("扩展选区", cmd({ op: "select_more" }, "扩展选区"), "Ctrl++"),
      item("缩减选区", cmd({ op: "select_less" }, "缩减选区"), "Ctrl+-"),
      item("选择相似…", () => menus.similar(), "Shift+G"),
      item("随机选择", cmd({ op: "select_random", ratio: 0.5, seed: 1 }, "随机选择", [
        { key: "ratio", label: "比例", type: "number", min: 0, max: 1, step: 0.05 },
        { key: "seed", label: "种子", type: "int", min: 0, step: 1 },
      ])),
      item("选择非流形", cmd({ op: "select_non_manifold" }, "选择非流形"), "Ctrl+Shift+Alt+M"),
      item("选择松散元素", cmd({ op: "select_loose" }, "选择松散元素")),
    ]),
};

function guessSize(): number {
  const b = currentEntry()?.editor.bounds();
  if (!b) return 0.1;
  const d = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  return Math.max(Math.round(d * 0.25 * 1000) / 1000, 0.001);
}

function insetModal(individual = false) {
  eng()?.startParamDrag({ op: "inset", thickness: 0, depth: 0, individual }, "thickness", "内插面", [
    { key: "thickness", label: "厚度", type: "number", min: 0, step: 0.001 },
    { key: "depth", label: "深度", type: "number", step: 0.001 },
    { key: "individual", label: "单独", type: "bool" },
  ], { min: 0 });
}

function contextMenu() {
  if (s().mode !== "edit") return;
  const mode = s().meshStats?.mode ?? "vert";
  if (mode === "vert") menus.vertex();
  else if (mode === "edge") menus.edge();
  else menus.face();
}

function undo() {
  if (s().mode === "edit") undoMesh();
  else s().undoRobot();
}

function redo() {
  if (s().mode === "edit") redoMesh();
  else s().redoRobot();
}

function toggleEdit() {
  if (s().mode === "edit") exitEditMode();
  else enterEditMode();
}

function togglePlay() {
  const p = s().playing;
  store.setState({ playing: p ? false : "sweep" });
}

export const operators: Operator[] = [
  // ---- file
  { id: "file.open", label: "打开 URDF / ZIP…", group: "文件", keys: "Ctrl+O", mode: "any", run: () => void openProject() },
  { id: "file.new", label: "新建机器人", group: "文件", keys: "Ctrl+N", mode: "any", run: () => void newProject() },
  { id: "file.save", label: "保存", group: "文件", keys: "Ctrl+S", mode: "any", run: () => void saveProject("inplace") },
  { id: "file.saveZip", label: "另存为 ZIP 压缩包…", group: "文件", keys: "Ctrl+Shift+S", mode: "any", run: () => void saveProject("zip") },
  { id: "file.saveFolder", label: "导出到文件夹…", group: "文件", mode: "any", run: () => void saveProject("folder") },
  { id: "file.source", label: "查看 URDF 源码", group: "文件", mode: "any", run: () => store.setState({ dialog: "urdf-source" }) },
  // ---- general
  { id: "edit.toggle", label: "切换编辑模式", group: "通用", keys: "Tab", mode: "any", run: toggleEdit },
  { id: "edit.undo", label: "撤销", group: "通用", keys: "Ctrl+Z", mode: "any", run: undo },
  { id: "edit.redo", label: "重做", group: "通用", keys: "Ctrl+Shift+Z", mode: "any", run: redo },
  { id: "ui.search", label: "搜索操作", group: "通用", keys: "F3", mode: "any", run: () => store.setState({ dialog: "search" }) },
  { id: "ui.help", label: "快捷键帮助", group: "通用", keys: "F1", mode: "any", run: () => store.setState({ dialog: "help" }) },
  { id: "ui.context", label: "上下文菜单", group: "通用", keys: "W / 右键单击", mode: "edit", run: contextMenu },
  // ---- view
  { id: "view.all", label: "查看全部", group: "视图", keys: "Home", mode: "any", run: () => eng()?.frameAll() },
  { id: "view.selected", label: "查看所选", group: "视图", keys: "Numpad . / F", mode: "any", run: () => eng()?.frameSelected() },
  { id: "view.front", label: "前视图", group: "视图", keys: "Numpad 1", mode: "any", run: () => eng()?.setView("front") },
  { id: "view.back", label: "后视图", group: "视图", keys: "Ctrl+Numpad 1", mode: "any", run: () => eng()?.setView("back") },
  { id: "view.right", label: "右视图", group: "视图", keys: "Numpad 3", mode: "any", run: () => eng()?.setView("right") },
  { id: "view.left", label: "左视图", group: "视图", keys: "Ctrl+Numpad 3", mode: "any", run: () => eng()?.setView("left") },
  { id: "view.top", label: "顶视图", group: "视图", keys: "Numpad 7", mode: "any", run: () => eng()?.setView("top") },
  { id: "view.bottom", label: "底视图", group: "视图", keys: "Ctrl+Numpad 7", mode: "any", run: () => eng()?.setView("bottom") },
  { id: "view.ortho", label: "透视/正交切换", group: "视图", keys: "Numpad 5", mode: "any", run: () => eng()?.toggleOrtho() },
  { id: "view.xray", label: "透视模式 (X-Ray)", group: "视图", keys: "Alt+Z", mode: "any", run: () => store.setState({ xray: !s().xray }) },
  { id: "view.wire", label: "线框显示", group: "视图", keys: "Shift+Z", mode: "any", run: () => store.setState({ wireframe: !s().wireframe }) },
  { id: "view.collision", label: "显示碰撞体", group: "视图", mode: "any", run: () => store.setState({ showCollision: !s().showCollision }) },
  // ---- object mode
  { id: "obj.addLink", label: "添加子 link", group: "对象", keys: "Shift+A", mode: "object", run: () => addChildLink() },
  { id: "obj.delete", label: "删除 link (含子树)", group: "对象", keys: "X / Delete", mode: "object", run: deleteSelection },
  { id: "obj.move", label: "移动关节原点 (操纵器)", group: "对象", keys: "G", mode: "object", run: () => store.setState({ gizmo: "translate" }) },
  { id: "obj.rotate", label: "旋转关节原点 (操纵器)", group: "对象", keys: "R", mode: "object", run: () => store.setState({ gizmo: "rotate" }) },
  { id: "obj.gizmoOff", label: "隐藏操纵器", group: "对象", keys: "Esc", mode: "object", run: () => store.setState({ gizmo: "none" }) },
  { id: "sim.play", label: "播放/暂停运动模拟", group: "模拟", keys: "Space", mode: "object", run: togglePlay },
  // ---- edit: select
  { id: "sel.vert", label: "顶点选择模式", group: "选择", keys: "1", mode: "edit", run: selectMode("vert") },
  { id: "sel.edge", label: "边选择模式", group: "选择", keys: "2", mode: "edit", run: selectMode("edge") },
  { id: "sel.face", label: "面选择模式", group: "选择", keys: "3", mode: "edit", run: selectMode("face") },
  { id: "sel.all", label: "全选", group: "选择", keys: "A", mode: "edit", run: cmd({ op: "select_all", action: "select" }, "全选") },
  { id: "sel.none", label: "取消选择", group: "选择", keys: "Alt+A", mode: "edit", run: cmd({ op: "select_all", action: "deselect" }, "取消选择") },
  { id: "sel.invert", label: "反选", group: "选择", keys: "Ctrl+I", mode: "edit", run: cmd({ op: "select_all", action: "invert" }, "反选") },
  { id: "sel.box", label: "框选", group: "选择", keys: "B / 左键拖动", mode: "edit", run: () => eng()?.startBoxSelect() },
  { id: "sel.circle", label: "刷选", group: "选择", keys: "C", mode: "edit", run: () => eng()?.startCircleSelect() },
  { id: "sel.linked", label: "选择相连", group: "选择", keys: "Ctrl+L", mode: "edit", run: cmd({ op: "select_linked" }, "选择相连") },
  { id: "sel.linkedPick", label: "选择光标下相连项", group: "选择", keys: "L", mode: "edit", run: () => eng()?.selectLinkedUnderCursor(false) },
  { id: "sel.unlinkedPick", label: "取消选择光标下相连项", group: "选择", keys: "Shift+L", mode: "edit", run: () => eng()?.selectLinkedUnderCursor(true) },
  { id: "sel.flat", label: "选择相连平展面 (可调角度)", group: "选择", keys: "Shift+F", mode: "edit", run: linkedFlat },
  { id: "sel.more", label: "扩展选区", group: "选择", keys: "Ctrl++", mode: "edit", run: cmd({ op: "select_more" }, "扩展选区") },
  { id: "sel.less", label: "缩减选区", group: "选择", keys: "Ctrl+-", mode: "edit", run: cmd({ op: "select_less" }, "缩减选区") },
  { id: "sel.similar", label: "选择相似…", group: "选择", keys: "Shift+G", mode: "edit", run: () => menus.similar() },
  { id: "sel.nonManifold", label: "选择非流形", group: "选择", keys: "Ctrl+Shift+Alt+M", mode: "edit", run: cmd({ op: "select_non_manifold" }, "选择非流形") },
  { id: "sel.loose", label: "选择松散元素", group: "选择", mode: "edit", run: cmd({ op: "select_loose" }, "选择松散元素") },
  { id: "sel.sharp", label: "选择锐边", group: "选择", mode: "edit", run: cmd({ op: "select_sharp_edges", angle: 30 }, "选择锐边", [ANGLE("angle", "锐度 (°)")]) },
  { id: "sel.boundary", label: "选择边界循环", group: "选择", mode: "edit", run: cmd({ op: "select_boundary_loop" }, "选择边界循环") },
  { id: "sel.inner", label: "选择循环内侧区域", group: "选择", mode: "edit", run: cmd({ op: "select_inner_region" }, "选择内侧区域") },
  { id: "sel.random", label: "随机选择", group: "选择", mode: "edit", run: cmd({ op: "select_random", ratio: 0.5, seed: 1 }, "随机选择", [{ key: "ratio", label: "比例", type: "number", min: 0, max: 1, step: 0.05 }, { key: "seed", label: "种子", type: "int", min: 0, step: 1 }]) },
  { id: "sel.loop", label: "循环边选择", group: "选择", keys: "Alt+单击", mode: "edit", run: () => s().setStatus("按住 Alt 单击一条边") },
  { id: "sel.ring", label: "环形边选择", group: "选择", keys: "Ctrl+Alt+单击", mode: "edit", run: () => s().setStatus("按住 Ctrl+Alt 单击一条边") },
  { id: "sel.path", label: "最短路径选择", group: "选择", keys: "Ctrl+单击", mode: "edit", run: () => s().setStatus("按住 Ctrl 单击目标元素") },
  { id: "sel.hide", label: "隐藏选中", group: "选择", keys: "H", mode: "edit", run: cmd({ op: "hide", unselected: false }, "隐藏") },
  { id: "sel.hideOthers", label: "隐藏未选中", group: "选择", keys: "Shift+H", mode: "edit", run: cmd({ op: "hide", unselected: true }, "隐藏未选中") },
  { id: "sel.reveal", label: "显示隐藏", group: "选择", keys: "Alt+H", mode: "edit", run: cmd({ op: "reveal", select: true }, "显示隐藏", [{ key: "select", label: "选中显示的元素", type: "bool" }]) },
  // ---- edit: mesh
  { id: "mesh.grab", label: "移动", group: "变换", keys: "G", mode: "edit", run: () => eng()?.startTransform("translate") },
  { id: "mesh.rotate", label: "旋转", group: "变换", keys: "R", mode: "edit", run: () => eng()?.startTransform("rotate") },
  { id: "mesh.scale", label: "缩放", group: "变换", keys: "S", mode: "edit", run: () => eng()?.startTransform("scale") },
  { id: "mesh.mirror", label: "镜像…", group: "变换", keys: "Ctrl+M", mode: "edit", run: () => menus.mirror() },
  { id: "mesh.proportional", label: "比例编辑开关", group: "变换", keys: "O", mode: "edit", run: () => store.setState({ proportional: { ...s().proportional, enabled: !s().proportional.enabled } }) },
  { id: "mesh.delete", label: "删除…", group: "网格", keys: "X / Delete", mode: "edit", run: () => menus.delete() },
  { id: "mesh.dissolve", label: "融并 (按模式)", group: "网格", keys: "Ctrl+X", mode: "edit", run: dissolveByMode },
  { id: "mesh.limitedDissolve", label: "有限融并", group: "网格", mode: "edit", run: cmd({ op: "dissolve_limited", angle: 5 }, "有限融并", [ANGLE("angle", "最大角度 (°)")]) },
  { id: "mesh.extrude", label: "挤出并移动", group: "网格", keys: "E", mode: "edit", run: extrudeAndMove },
  { id: "mesh.extrudeInd", label: "挤出各个面", group: "网格", keys: "Alt+E", mode: "edit", run: () => eng()?.startParamDrag({ op: "extrude_individual", offset: 0 }, "offset", "挤出各个面", [{ key: "offset", label: "偏移", type: "number", step: 0.001 }]) },
  { id: "mesh.inset", label: "内插面", group: "网格", keys: "I", mode: "edit", run: () => insetModal(false) },
  { id: "mesh.fill", label: "填充 / 建立边面", group: "网格", keys: "F", mode: "edit", run: cmd({ op: "fill", triangulate: false }, "填充", [{ key: "triangulate", label: "三角化", type: "bool" }]) },
  { id: "mesh.fillTri", label: "三角填充", group: "网格", keys: "Alt+F", mode: "edit", run: cmd({ op: "fill", triangulate: true }, "三角填充") },
  { id: "mesh.merge", label: "合并…", group: "网格", keys: "M", mode: "edit", run: () => menus.merge() },
  { id: "mesh.removeDoubles", label: "按距离合并", group: "网格", keys: "Alt+M", mode: "edit", run: cmd({ op: "remove_doubles", distance: 0.0001 }, "按距离合并", [{ key: "distance", label: "合并距离", type: "number", min: 0, step: 0.0001 }]) },
  { id: "mesh.subdivide", label: "细分", group: "网格", mode: "edit", run: cmd({ op: "subdivide", levels: 1 }, "细分", [{ key: "levels", label: "级别", type: "int", min: 1, max: 6, step: 1 }]) },
  { id: "mesh.loopcut", label: "环切", group: "网格", keys: "Ctrl+R", mode: "edit", run: () => eng()?.startLoopCut() },
  { id: "mesh.bisect", label: "切分 (Bisect)", group: "网格", mode: "edit", run: () => eng()?.startBisect() },
  { id: "mesh.rip", label: "撕裂 (沿边拆分)", group: "网格", keys: "V", mode: "edit", run: ripAndMove },
  { id: "mesh.split", label: "拆分", group: "网格", keys: "Y", mode: "edit", run: cmd({ op: "split" }, "拆分") },
  { id: "mesh.separate", label: "分离选中项…", group: "网格", keys: "P", mode: "edit", run: () => store.setState({ dialog: "separate" }) },
  { id: "mesh.duplicate", label: "复制并移动", group: "网格", keys: "Shift+D", mode: "edit", run: duplicateAndMove },
  { id: "mesh.triangulate", label: "三角化", group: "网格", keys: "Ctrl+T", mode: "edit", run: cmd({ op: "triangulate" }, "三角化面") },
  { id: "mesh.quads", label: "三角面转四边面", group: "网格", keys: "Alt+J", mode: "edit", run: cmd({ op: "tris_to_quads", angle: 40 }, "三角面转四边面", [ANGLE("angle", "最大角度 (°)")]) },
  { id: "mesh.poke", label: "尖分面", group: "网格", mode: "edit", run: cmd({ op: "poke" }, "尖分面") },
  { id: "mesh.bridge", label: "桥接循环边", group: "网格", mode: "edit", run: cmd({ op: "bridge" }, "桥接循环边") },
  { id: "mesh.connect", label: "连接顶点路径", group: "网格", keys: "J", mode: "edit", run: cmd({ op: "connect" }, "连接顶点路径") },
  { id: "mesh.smooth", label: "平滑顶点", group: "网格", mode: "edit", run: cmd({ op: "smooth", factor: 0.5, iterations: 1 }, "平滑顶点", [{ key: "factor", label: "系数", type: "number", min: 0, max: 1, step: 0.05 }, { key: "iterations", label: "迭代", type: "int", min: 1, max: 100, step: 1 }]) },
  { id: "mesh.flip", label: "翻转法线", group: "网格", mode: "edit", run: cmd({ op: "flip_normals" }, "翻转法线") },
  { id: "mesh.normalsOut", label: "重新计算法线 (外侧)", group: "网格", keys: "Shift+N", mode: "edit", run: cmd({ op: "recalc_normals", inside: false }, "重新计算法线", [{ key: "inside", label: "朝内", type: "bool" }]) },
  { id: "mesh.normalsIn", label: "重新计算法线 (内侧)", group: "网格", keys: "Ctrl+Shift+N", mode: "edit", run: cmd({ op: "recalc_normals", inside: true }, "重新计算法线", [{ key: "inside", label: "朝内", type: "bool" }]) },
  { id: "mesh.normalsMenu", label: "法线…", group: "网格", keys: "Alt+N", mode: "edit", run: () => menus.normals() },
  { id: "mesh.add", label: "添加网格…", group: "网格", keys: "Shift+A", mode: "edit", run: () => menus.add() },
  { id: "menu.vertex", label: "顶点菜单", group: "菜单", keys: "Ctrl+V", mode: "edit", run: () => menus.vertex() },
  { id: "menu.edge", label: "边菜单", group: "菜单", keys: "Ctrl+E", mode: "edit", run: () => menus.edge() },
  { id: "menu.face", label: "面菜单", group: "菜单", keys: "Ctrl+F", mode: "edit", run: () => menus.face() },
  { id: "menu.select", label: "选择菜单", group: "菜单", mode: "edit", run: () => menus.select() },
];

export const opById = new Map(operators.map((o) => [o.id, o]));

export function runOp(id: string) {
  const op = opById.get(id);
  if (!op) return;
  const mode = s().mode;
  if (op.mode !== "any" && op.mode !== mode) {
    s().setStatus(`"${op.label}" 仅在${op.mode === "edit" ? "编辑" : "对象"}模式可用`, "error");
    return;
  }
  op.run();
}
