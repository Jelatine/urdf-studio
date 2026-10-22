// The 3D viewport: rendering, camera navigation, object/edit mode picking and
// Blender-style modal tools (grab/rotate/scale, box/circle select, parameter
// drags, loop cut, bisect).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { adjustLast, currentEntry, meshChanged, runCmd, undoMesh } from "../edit/meshOps";
import { allMeshes, syncGeometry } from "../mesh/registry";
import { effectiveJointValues, enterEditMode, updateJoint } from "../state/actions";
import { store, type ParamSpec } from "../state/store";
import { stepSimulation } from "../sim/simulation";
import type { Command } from "../wasm";
import { EditOverlay } from "./editOverlay";
import { applyPose, hasMeshColors, poseFromObject, primitiveGeometry, RobotView, type GeomRef } from "./robotView";

THREE.Mesh.prototype.raycast = acceleratedRaycast;
(THREE.BufferGeometry.prototype as unknown as Record<string, unknown>).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as Record<string, unknown>).disposeBoundsTree = disposeBoundsTree;

const s = () => store.getState();

type TransformType = "translate" | "rotate" | "scale";

interface TransformModal {
  kind: "transform";
  type: TransformType;
  startX: number;
  startY: number;
  pivot: THREE.Vector3;
  pivotScreen: THREE.Vector2;
  axis: THREE.Vector3 | null;
  axisLabel: string | null;
  space: "global" | "local" | "normal";
  planar: boolean;
  numeric: string;
  snap: boolean;
  objMatrix: THREE.Matrix4;
  objInv: THREE.Matrix4;
  normalAxis: THREE.Vector3 | null;
  propRadius: number;
  lastValue: string;
}

interface ParamModal {
  kind: "param";
  cmd: Command;
  key: string;
  label: string;
  params: ParamSpec[];
  pivotScreen: THREE.Vector2;
  startDist: number;
  unitsPerPx: number;
  initial: number;
  min: number;
  max: number;
  numeric: string;
  value: number;
}

interface BoxModal {
  kind: "box";
  /** B key: waiting for the drag; otherwise dragging from a click. */
  armed: boolean;
  op: "set" | "add" | "sub";
  x0: number;
  y0: number;
  dragging: boolean;
}

interface CircleModal {
  kind: "circle";
  radius: number;
  painting: null | "add" | "sub";
}

interface PickModal {
  kind: "loopcut" | "bisect";
  x0?: number;
  y0?: number;
  dragging?: boolean;
}

type Modal = TransformModal | ParamModal | BoxModal | CircleModal | PickModal;

export interface PickResult {
  kind: "vert" | "edge" | "face";
  id: number;
}

let current: Engine | null = null;
export const getEngine = () => current;

/** Three orthogonal circles outlining a sphere. */
function greatCircles(r: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const n = 64;
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < n; i++) {
      for (const k of [i, i + 1]) {
        const a = (k / n) * Math.PI * 2;
        const p = [Math.cos(a) * r, Math.sin(a) * r, 0];
        pts.push(p[(3 - axis) % 3], p[(4 - axis) % 3], p[(5 - axis) % 3]);
      }
    }
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perspCam: THREE.PerspectiveCamera;
  readonly orthoCam: THREE.OrthographicCamera;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly robotView = new RobotView();
  overlay: EditOverlay | null = null;
  overlayGeom: GeomRef | null = null;
  private overlayGeomVersion = -1;
  private overlayMode = "";
  /** Shapes proposed by the fit dialog. */
  private fitPreview: THREE.Group | null = null;
  readonly raycaster = new THREE.Raycaster();
  readonly cursor3d = new THREE.Group();
  private grid: THREE.Group;
  private boxDiv: HTMLDivElement;
  private circleDiv: HTMLDivElement;
  private lineSvg: SVGSVGElement;
  mouse = new THREE.Vector2();
  private down: { x: number; y: number; button: number; alt: boolean; shift: boolean; ctrl: boolean; moved: boolean } | null = null;
  modal: Modal | null = null;
  /** Right-click without dragging in edit mode. */
  onContextMenu: (() => void) | null = null;
  private unsub: () => void;
  private ro: ResizeObserver;
  private raf = 0;
  private lastTime = performance.now();
  private gizmoJoint: string | null = null;
  private needsRebuild = true;
  private framedOnce = false;

  constructor(readonly container: HTMLElement) {
    current = this;
    if (import.meta.env.DEV) (window as unknown as { __engine: Engine }).__engine = this;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x2b2d31);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.perspCam = new THREE.PerspectiveCamera(45, 1, 0.005, 500);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    for (const c of [this.perspCam, this.orthoCam]) c.up.set(0, 0, 1);
    this.camera = this.perspCam;
    this.perspCam.position.set(1.2, -1.6, 1.0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace("local");
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
      if (!(e as unknown as { value: boolean }).value) this.commitGizmo();
    });
    this.scene.add(this.gizmo.getHelper());

    const hemi = new THREE.HemisphereLight(0xffffff, 0x404050, 1.6);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(2, -3, 4);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-3, 2, -1);
    this.scene.add(dir2);

    this.grid = this.makeGrid();
    this.scene.add(this.grid);
    this.scene.add(this.robotView.root);
    this.makeCursor();

    this.boxDiv = document.createElement("div");
    this.boxDiv.className = "box-select";
    this.circleDiv = document.createElement("div");
    this.circleDiv.className = "circle-select";
    this.lineSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.lineSvg.setAttribute("class", "line-overlay");
    container.append(this.boxDiv, this.circleDiv, this.lineSvg);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    el.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("dblclick", this.onDoubleClick);
    el.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    this.unsub = store.subscribe((st, prev) => this.onStore(st, prev));
    this.onStore(s(), s());
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsub();
    this.ro.disconnect();
    window.removeEventListener("pointerup", this.onPointerUp);
    this.overlay?.dispose();
    this.clearFitPreview();
    this.robotView.dispose();
    this.gizmo.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.boxDiv.remove();
    this.circleDiv.remove();
    this.lineSvg.remove();
    if (current === this) current = null;
  }

  // ------------------------------------------------------------ scene setup

  private makeGrid() {
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(10, 100, 0x45474c, 0x37393d);
    grid.rotation.x = Math.PI / 2;
    g.add(grid);
    const axis = (to: THREE.Vector3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([to.clone().multiplyScalar(-5), to.clone().multiplyScalar(5)]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    };
    g.add(axis(new THREE.Vector3(1, 0, 0), 0x9c3b45), axis(new THREE.Vector3(0, 1, 0), 0x6b9a2e));
    return g;
  }

  private makeCursor() {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 32 }, (_, i) => new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2), Math.sin((i / 32) * Math.PI * 2), 0)),
      ),
      new THREE.LineDashedMaterial({ color: 0xff3030, dashSize: 0.2, gapSize: 0.2, depthTest: false }),
    );
    ring.computeLineDistances();
    const axes = new THREE.AxesHelper(1.4);
    (axes.material as THREE.Material).depthTest = false;
    this.cursor3d.add(ring, axes);
    this.cursor3d.renderOrder = 30;
    this.cursor3d.scale.setScalar(0.02);
    this.scene.add(this.cursor3d);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const dist = this.orthoCam.userData.height ?? 1;
    this.orthoCam.left = (-dist * w) / h / 2;
    this.orthoCam.right = (dist * w) / h / 2;
    this.orthoCam.top = dist / 2;
    this.orthoCam.bottom = -dist / 2;
    this.orthoCam.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (s().playing) stepSimulation(dt);
    if (this.needsRebuild) this.rebuildRobot();
    const scale = this.robotView.helperSize * 0.25 * this.pixelScale(this.cursor3d.position) * 40;
    this.cursor3d.scale.setScalar(Math.max(scale, 1e-4));
    this.renderer.render(this.scene, this.camera);
  };

  /** World units per screen pixel at a point. */
  pixelScale(p: THREE.Vector3) {
    const h = Math.max(1, this.container.clientHeight);
    if (this.camera instanceof THREE.OrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    const d = this.camera.position.distanceTo(p);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2)) / h;
  }

  // ------------------------------------------------------------ store sync

  private onStore(st: ReturnType<typeof s>, prev: ReturnType<typeof s>) {
    const first = st === prev;
    if (
      first ||
      st.robot !== prev.robot ||
      st.meshPaths !== prev.meshPaths ||
      st.meshInfo !== prev.meshInfo ||
      st.showVisual !== prev.showVisual ||
      st.showCollision !== prev.showCollision ||
      st.showFrames !== prev.showFrames ||
      st.showAxes !== prev.showAxes ||
      st.wireframe !== prev.wireframe
    ) {
      this.needsRebuild = true;
    }
    if (st.meshVersion !== prev.meshVersion) this.onMeshVersion();
    if (st.jointValues !== prev.jointValues && !this.needsRebuild) this.applyJoints();
    if (st.selection !== prev.selection || st.gizmo !== prev.gizmo || st.mode !== prev.mode) this.updateSelectionVisuals();
    if (st.mode !== prev.mode || st.editTarget !== prev.editTarget) this.setupOverlay();
    if (st.xray !== prev.xray) this.overlay?.setXray(st.xray);
    if (st.fitPreview !== prev.fitPreview && !this.needsRebuild) this.updateFitPreview();
  }

  private rebuildRobot() {
    this.needsRebuild = false;
    const st = s();
    if (!st.robot) {
      this.robotView.dispose();
      this.setupOverlay();
      return;
    }
    this.robotView.build(st.robot, {
      meshPaths: st.meshPaths,
      showVisual: st.showVisual,
      showCollision: st.showCollision,
      showFrames: st.showFrames,
      showAxes: st.showAxes,
      wireframe: st.wireframe,
    });
    this.applyJoints();
    this.updateSelectionVisuals();
    this.setupOverlay();
    this.updateFitPreview();
    const loading = Object.values(st.meshInfo).some((m) => m.status === "loading");
    if (!this.framedOnce && !loading && this.robotView.geoms.length) {
      this.framedOnce = true;
      this.frameAll();
    }
  }

  /** Called by actions when a new project is loaded. */
  resetFraming() {
    this.framedOnce = false;
  }

  private applyJoints() {
    const st = s();
    if (!st.robot) return;
    this.robotView.setJointValues(st.robot, effectiveJointValues(st.robot, st.jointValues));
  }

  private onMeshVersion() {
    for (const e of allMeshes()) {
      if (syncGeometry(e)) {
        const g = e.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
        if (g.boundsTree) disposeBoundsTree.call(g);
      }
    }
    // A mesh gained or lost its colors: visuals switch between them and the URDF material.
    const stale = this.robotView.geoms.some(
      (g) => g.role === "visual" && g.meshPath && (g.mesh.material as THREE.MeshStandardMaterial).vertexColors !== hasMeshColors(g.mesh.geometry),
    );
    if (stale) this.needsRebuild = true;
    this.refreshOverlay();
  }

  private refreshOverlay() {
    const ov = this.overlay;
    const entry = currentEntry();
    if (!ov || !entry) return;
    const stats = s().meshStats;
    const mode = stats?.mode ?? "vert";
    const gv = entry.editor.geomVersion();
    if (gv !== this.overlayGeomVersion || mode !== this.overlayMode) {
      ov.rebuild(mode);
      this.overlayGeomVersion = gv;
      this.overlayMode = mode;
    } else {
      ov.updateSelection();
    }
  }

  private clearFitPreview() {
    this.fitPreview?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.geometry) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this.fitPreview?.removeFromParent();
    this.fitPreview = null;
  }

  private updateFitPreview() {
    this.clearFitPreview();
    const p = s().fitPreview;
    const frame = p && this.robotView.links.get(p.link);
    if (!p || !frame) return;
    const group = new THREE.Group();
    group.name = "fit-preview";
    for (const it of p.items) {
      const geo = primitiveGeometry(it.geometry);
      if (!geo) continue;
      const origin = new THREE.Group();
      applyPose(origin, it.origin);
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.18, depthWrite: false, depthTest: false }));
      const outline = it.geometry.type === "sphere" ? greatCircles(it.geometry.radius) : new THREE.EdgesGeometry(geo, 20);
      const lines = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ color: 0xffa040, depthTest: false }));
      fill.renderOrder = 30;
      lines.renderOrder = 31;
      origin.add(fill, lines);
      group.add(origin);
    }
    frame.add(group);
    this.fitPreview = group;
  }

  private setupOverlay() {
    const st = s();
    const target = st.mode === "edit" ? st.editTarget : null;
    const geom = target ? this.robotView.findGeom(target.link, target.role, target.index) ?? null : null;
    const entry = currentEntry();
    if (this.overlay && (!target || !geom || this.overlay.editor !== entry?.editor || this.overlayGeom !== geom)) {
      if (this.modal?.kind === "transform") currentEntry()?.editor.endTransform(false);
      this.modal = null;
      this.overlay.dispose();
      this.overlay = null;
      if (this.overlayGeom) this.overlayGeom.mesh.visible = true;
      this.overlayGeom = null;
    }
    if (!target || !geom || !entry) {
      // Leaving edit mode: rebuild to restore materials dimmed for editing.
      if (this.robotView.geoms.some((g) => (g.mesh.material as THREE.Material).userData.dimmed)) this.needsRebuild = true;
      return;
    }
    if (!this.overlay) {
      this.overlay = new EditOverlay(entry.editor);
      this.overlayGeom = geom;
      geom.mesh.add(this.overlay.group);
      this.overlay.setXray(st.xray);
      this.overlayGeomVersion = -1;
      this.refreshOverlay();
    }
    // Hide the edited geometry itself (the overlay draws it); dim the rest.
    geom.mesh.visible = true;
    (geom.mesh.material as THREE.Material).visible = false;
    (geom.mesh.material as THREE.Material).userData.dimmed = true;
    for (const g of this.robotView.geoms) {
      if (g === geom) continue;
      const m = g.mesh.material as THREE.Material;
      if (!m.userData.dimmed) {
        m.userData.dimmed = true;
        m.transparent = true;
        m.opacity = Math.min(m.opacity, 0.35);
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    }
  }

  private updateSelectionVisuals() {
    const st = s();
    const robot = st.robot;
    const sel = st.selection;
    const link = sel?.kind === "link" ? sel.name : null;
    const joint = sel?.kind === "joint" ? sel.name : null;
    this.robotView.setHighlight(st.mode === "edit" ? null : link, joint);
    // Gizmo: moves the joint origin of the selected joint (or the selected
    // link's parent joint) in object mode.
    this.gizmo.detach();
    this.gizmoJoint = null;
    if (!robot || st.mode !== "object" || st.gizmo === "none") return;
    const t = this.robotView.gizmoTarget(robot, sel);
    if (!t) return;
    this.gizmo.setMode(st.gizmo);
    this.gizmo.attach(t.object);
    this.gizmoJoint = t.joint;
  }

  private commitGizmo() {
    const obj = this.gizmo.object;
    const name = this.gizmoJoint;
    if (!obj || !name) return;
    const pose = poseFromObject(obj);
    updateJoint(name, (j) => {
      j.origin = pose;
    });
  }

  // ------------------------------------------------------------- camera

  setOrtho(ortho: boolean) {
    const from = this.camera;
    const target = this.controls.target;
    if (ortho === from instanceof THREE.OrthographicCamera) return;
    if (ortho) {
      const d = this.perspCam.position.distanceTo(target);
      this.orthoCam.userData.height = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum();
      this.orthoCam.position.copy(this.perspCam.position);
      this.orthoCam.quaternion.copy(this.perspCam.quaternion);
      this.camera = this.orthoCam;
    } else {
      const h = (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom;
      const d = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
      const dirv = new THREE.Vector3().subVectors(this.orthoCam.position, target).normalize();
      this.perspCam.position.copy(target).addScaledVector(dirv, d);
      this.perspCam.quaternion.copy(this.orthoCam.quaternion);
      this.camera = this.perspCam;
    }
    this.controls.object = this.camera;
    this.gizmo.camera = this.camera;
    this.controls.update();
  }

  toggleOrtho() {
    this.setOrtho(!(this.camera instanceof THREE.OrthographicCamera));
  }

  private fitBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
    const dirv = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (dirv.lengthSq() < 0.5) dirv.set(0.6, -0.8, 0.5).normalize();
    const d = radius / Math.sin(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dirv, d * 1.1);
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.orthoCam.userData.height = radius * 2.4;
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.perspCam.near = Math.max(radius / 1000, 1e-4);
    this.perspCam.far = Math.max(radius * 200, 50);
    this.perspCam.updateProjectionMatrix();
    this.controls.update();
  }

  frameAll() {
    const box = new THREE.Box3();
    if (this.overlay) box.setFromObject(this.overlay.faces);
    else box.setFromObject(this.robotView.root);
    this.fitBox(box);
  }

  frameSelected() {
    const st = s();
    if (this.overlay) {
      const b = currentEntry()?.editor.selectedBounds();
      if (!b) return this.frameAll();
      const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
      box.applyMatrix4(this.overlay.group.matrixWorld);
      return this.fitBox(box);
    }
    const sel = st.selection;
    if (!sel || !st.robot) return this.frameAll();
    const linkName = sel.kind === "link" ? sel.name : st.robot.joints.find((j) => j.name === sel.name)?.child;
    const box = new THREE.Box3();
    for (const g of this.robotView.geoms) if (g.link === linkName) box.expandByObject(g.mesh);
    if (box.isEmpty()) {
      const frame = linkName ? this.robotView.links.get(linkName) : undefined;
      if (frame) {
        const p = frame.getWorldPosition(new THREE.Vector3());
        box.setFromCenterAndSize(p, new THREE.Vector3(0.1, 0.1, 0.1));
      }
    }
    this.fitBox(box);
  }

  /** Axis-aligned views (Numpad 1/3/7 and Ctrl variants). */
  setView(view: "front" | "back" | "right" | "left" | "top" | "bottom") {
    const t = this.controls.target;
    const d = this.camera.position.distanceTo(t);
    const dirs: Record<string, [number, number, number]> = {
      front: [0, -1, 0],
      back: [0, 1, 0],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0, 0, 1],
      bottom: [0, 0, -1],
    };
    const v = new THREE.Vector3(...dirs[view]);
    this.camera.position.copy(t).addScaledVector(v, d);
    this.camera.up.set(0, 0, 1);
    if (view === "top" || view === "bottom") {
      // Avoid the degenerate up vector; keep +Y pointing up on screen.
      this.camera.position.y -= d * 1e-4;
    }
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Numpad 2/4/6/8 orbit steps. */
  orbitStep(yaw: number, pitch: number) {
    const t = this.controls.target;
    const off = new THREE.Vector3().subVectors(this.camera.position, t);
    const sph = new THREE.Spherical().setFromVector3(new THREE.Vector3(off.x, off.z, -off.y));
    sph.theta += yaw;
    sph.phi = THREE.MathUtils.clamp(sph.phi - pitch, 0.01, Math.PI - 0.01);
    const v = new THREE.Vector3().setFromSpherical(sph);
    this.camera.position.copy(t).add(new THREE.Vector3(v.x, -v.z, v.y));
    this.camera.lookAt(t);
    this.controls.update();
  }

  // ------------------------------------------------------------- picking

  private ndc(x: number, y: number) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1);
  }

  rayAt(x: number, y: number): THREE.Ray {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    return this.raycaster.ray.clone();
  }

  project(p: THREE.Vector3): THREE.Vector2 {
    const v = p.clone().project(this.camera);
    return new THREE.Vector2((v.x * 0.5 + 0.5) * this.container.clientWidth, (-v.y * 0.5 + 0.5) * this.container.clientHeight);
  }

  private mvp(): Float64Array {
    this.camera.updateMatrixWorld();
    const m = new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.overlay!.group.matrixWorld);
    return Float64Array.from(m.elements);
  }

  private bvhReady = -1;

  private ensureBvh() {
    const entry = currentEntry();
    if (!entry || !this.overlay) return;
    const v = entry.editor.geomVersion();
    if (this.bvhReady !== v) {
      this.overlay.ensureBvh();
      this.bvhReady = v;
    }
  }

  /** Whether a mesh-local point is unoccluded by the edited mesh. */
  private visibleLocal(local: THREE.Vector3): boolean {
    if (s().xray || !this.overlay) return true;
    const world = local.clone().applyMatrix4(this.overlay.group.matrixWorld);
    let origin: THREE.Vector3;
    if (this.camera instanceof THREE.OrthographicCamera) {
      const fwd = this.camera.getWorldDirection(new THREE.Vector3());
      origin = world.clone().addScaledVector(fwd, -100);
    } else origin = this.camera.position.clone();
    const dirv = world.clone().sub(origin);
    const dist = dirv.length();
    this.raycaster.set(origin, dirv.normalize());
    this.raycaster.near = 0;
    this.raycaster.far = dist;
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    const hits = this.raycaster.intersectObject(this.overlay.faces, false);
    this.raycaster.far = Infinity;
    (this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
    if (!hits.length) return true;
    return hits[0].distance >= dist - Math.max(1e-6, dist * 2e-4) - this.pixelScale(world) * 1.5;
  }

  private faceUnder(x: number, y: number): number | null {
    if (!this.overlay) return null;
    this.ensureBvh();
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hits = this.raycaster.intersectObject(this.overlay.faces, false);
    if (!hits.length || hits[0].faceIndex == null) return null;
    return this.overlay.triFaces[hits[0].faceIndex];
  }

  /** Picks the element under the cursor in the current select mode. */
  pick(x: number, y: number, kind?: "vert" | "edge" | "face"): PickResult | null {
    const entry = currentEntry();
    if (!entry || !this.overlay) return null;
    const mode = kind ?? s().meshStats?.mode ?? "vert";
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.ensureBvh();
    if (mode === "face") {
      const f = this.faceUnder(x, y);
      if (f != null) return { kind: "face", id: f };
      if (s().xray) {
        const near = entry.editor.inCircle("face", this.mvp(), w, h, x, y, 12);
        return near.length ? { kind: "face", id: near[0] } : null;
      }
      return null;
    }
    if (mode === "vert") {
      const cands = entry.editor.pickVerts(this.mvp(), w, h, x, y, 14, 32);
      for (const v of cands) {
        const p = entry.editor.vertPosition(v);
        if (this.visibleLocal(new THREE.Vector3(p[0], p[1], p[2]))) return { kind: "vert", id: v };
      }
      return null;
    }
    const pairs = entry.editor.pickEdges(this.mvp(), w, h, x, y, 12, 32);
    for (let i = 0; i < pairs.length; i += 2) {
      const e = pairs[i];
      const t = pairs[i + 1];
      const [a, b] = entry.editor.edgeVerts(e);
      const pa = entry.editor.vertPosition(a);
      const pb = entry.editor.vertPosition(b);
      const p = new THREE.Vector3(pa[0], pa[1], pa[2]).lerp(new THREE.Vector3(pb[0], pb[1], pb[2]), t);
      if (this.visibleLocal(p)) return { kind: "edge", id: e };
    }
    return null;
  }

  private filterVisible(kind: "vert" | "edge" | "face", ids: Uint32Array): number[] {
    const entry = currentEntry()!;
    if (s().xray) return Array.from(ids);
    this.ensureBvh();
    const pos = (v: number) => {
      const p = entry.editor.vertPosition(v);
      return new THREE.Vector3(p[0], p[1], p[2]);
    };
    if (kind === "vert") return Array.from(ids).filter((v) => this.visibleLocal(pos(v)));
    if (kind === "edge") {
      return Array.from(ids).filter((e) => {
        const [a, b] = entry.editor.edgeVerts(e);
        return this.visibleLocal(pos(a).lerp(pos(b), 0.5));
      });
    }
    const ov = this.overlay!;
    const centers = ov.faceDots.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = new Map<number, number>();
    ov.faceIds.forEach((f, i) => index.set(f, i));
    return Array.from(ids).filter((f) => {
      const i = index.get(f);
      if (i === undefined) return false;
      return this.visibleLocal(new THREE.Vector3(centers.getX(i), centers.getY(i), centers.getZ(i)));
    });
  }

  private clickSelect(x: number, y: number, mods: { shift: boolean; ctrl: boolean; alt: boolean }) {
    const entry = currentEntry();
    if (!entry) return;
    const mode = s().meshStats?.mode ?? "vert";
    if (mods.alt) {
      const hit = this.pick(x, y, "edge");
      if (!hit) return;
      runCmd(
        { op: "select_loop", edge: hit.id, ring: mods.ctrl, mode: mods.shift ? "toggle" : "set" },
        { label: mods.ctrl ? "选择环形边" : "选择循环边", noAdjust: true },
      );
      return;
    }
    const hit = this.pick(x, y);
    if (mods.ctrl && hit) {
      runCmd({ op: "select_shortest_path", target: hit.id }, { label: "最短路径", noAdjust: true });
      return;
    }
    if (!hit) {
      if (!mods.shift) runCmd({ op: "select_all", action: "deselect" }, { label: "取消选择", noAdjust: true });
      return;
    }
    // Shift-click: toggle, but make an unselected-but-not-active element active first (Blender).
    runCmd(
      { op: "select_elems", kind: mode, ids: [hit.id], mode: mods.shift ? "toggle" : "set" },
      { label: "选择", noAdjust: true },
    );
  }

  /** L / Shift+L: select linked under the cursor. */
  selectLinkedUnderCursor(deselect: boolean) {
    const hit = this.pick(this.mouse.x, this.mouse.y);
    if (!hit) {
      s().setStatus("光标下没有元素");
      return;
    }
    runCmd({ op: "select_linked_pick", kind: hit.kind, index: hit.id, deselect }, { label: deselect ? "取消选择相连" : "选择相连", noAdjust: true });
  }

  /** Face under the cursor (for "select linked flat faces" without a selection). */
  faceAtCursor(): number | null {
    return this.faceUnder(this.mouse.x, this.mouse.y);
  }

  private objectClick(x: number, y: number, shift: boolean): GeomRef | null {
    const meshes = this.robotView.geoms.filter((g) => g.origin.visible).map((g) => g.mesh);
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    for (const m of meshes) {
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
      if (!g.boundsTree && g.getAttribute("position")?.count > 300) computeBoundsTree.call(g, { indirect: true });
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits[0]?.object as THREE.Mesh | undefined;
    if (!hit) {
      if (!shift) store.setState({ selection: null });
      return null;
    }
    const ref = this.robotView.geoms.find((g) => g.mesh === hit) ?? null;
    if (ref) store.setState({ selection: { kind: "link", name: ref.link } });
    return ref;
  }

  /** Shift+Right click: place the 3D cursor on the surface under the mouse. */
  private placeCursor(x: number, y: number) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const targets = this.overlay ? [this.overlay.faces] : this.robotView.geoms.filter((g) => g.origin.visible).map((g) => g.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    let p: THREE.Vector3 | null = hits[0]?.point ?? null;
    if (!p) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      p = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    }
    if (p) {
      this.cursor3d.position.copy(p);
      s().setStatus(`3D 游标: ${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}`);
    }
  }

  /** 3D cursor in the edited mesh's local coordinates. */
  cursorLocal(): [number, number, number] {
    const p = this.cursor3d.position.clone();
    if (this.overlay) p.applyMatrix4(this.overlay.group.matrixWorld.clone().invert());
    return [p.x, p.y, p.z];
  }

  // ------------------------------------------------------------- pointer

  private onPointerDown = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    this.mouse.set(x, y);
    this.renderer.domElement.focus();
    // Emulate 3-button mouse: Alt+left drag orbits, Alt+Shift+left pans
    // (a click without moving still does loop select in edit mode).
    if (e.button === 0 && e.altKey && !this.modal) {
      this.controls.mouseButtons.LEFT = e.shiftKey && !s().editTarget ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    } else {
      this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
    }
    this.down = { x, y, button: e.button, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, moved: false };

    const m = this.modal;
    if (m) {
      e.stopImmediatePropagation();
      // A click consumed by a modal tool must not also act as a selection click.
      this.down = null;
      if (m.kind === "transform" || m.kind === "param") {
        if (e.button === 0) this.confirmModal();
        else if (e.button === 2) this.cancelModal();
        return;
      }
      if (m.kind === "box") {
        if (e.button === 0 || e.button === 1) {
          m.x0 = x;
          m.y0 = y;
          m.dragging = true;
          if (m.armed) m.op = e.button === 1 || e.shiftKey ? "sub" : "add";
        } else if (e.button === 2) this.cancelModal();
        return;
      }
      if (m.kind === "circle") {
        if (e.button === 0) {
          m.painting = e.shiftKey || e.ctrlKey ? "sub" : "add";
          this.circlePaint(x, y);
        } else if (e.button === 1) {
          m.painting = "sub";
          this.circlePaint(x, y);
        } else this.cancelModal();
        return;
      }
      if (m.kind === "loopcut") {
        if (e.button === 0) this.applyLoopCut(x, y);
        else this.cancelModal();
        return;
      }
      if (m.kind === "bisect") {
        if (e.button === 0) {
          m.x0 = x;
          m.y0 = y;
          m.dragging = true;
        } else this.cancelModal();
        return;
      }
    }
    if (e.button === 2 && e.shiftKey) {
      this.placeCursor(x, y);
      this.down = null;
      e.stopImmediatePropagation();
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    this.mouse.set(x, y);
    const m = this.modal;
    if (m?.kind === "transform") return this.updateTransform();
    if (m?.kind === "param") return this.updateParam();
    if (m?.kind === "circle") {
      this.drawCircle();
      if (m.painting) this.circlePaint(x, y);
      return;
    }
    if (m?.kind === "box" && m.dragging) return this.drawBox(m.x0, m.y0, x, y);
    if (m?.kind === "bisect" && m.dragging) return this.drawLine(m.x0!, m.y0!, x, y);
    const d = this.down;
    if (d && !d.moved && Math.hypot(x - d.x, y - d.y) > 4) {
      d.moved = true;
      // Left-drag on the canvas in edit mode starts a box select (tweak).
      if (d.button === 0 && !d.alt && this.overlay && !this.gizmo.dragging) {
        this.modal = { kind: "box", armed: false, op: d.shift ? "add" : d.ctrl ? "sub" : "set", x0: d.x, y0: d.y, dragging: true };
      }
    }
    if (this.modal?.kind === "box" && (this.modal as BoxModal).dragging) this.drawBox(this.modal.x0, this.modal.y0, x, y);
  };

  private onPointerUp = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const m = this.modal;
    if (m?.kind === "box" && m.dragging) {
      this.applyBox(m, x, y);
      return;
    }
    if (m?.kind === "circle" && m.painting) {
      m.painting = null;
      return;
    }
    if (m?.kind === "bisect" && m.dragging) {
      this.applyBisect(m.x0!, m.y0!, x, y);
      return;
    }
    const d = this.down;
    this.down = null;
    if (!d || d.moved || m) return;
    if (e.target !== this.renderer.domElement) return;
    if (d.button === 2 && this.overlay && !d.shift) {
      this.onContextMenu?.();
      return;
    }
    if (d.button !== 0 || this.gizmo.dragging) return;
    if (this.overlay) this.clickSelect(x, y, { shift: d.shift, ctrl: d.ctrl, alt: d.alt });
    else if (!(this.gizmo as unknown as { axis: string | null }).axis) this.objectClick(x, y, d.shift);
  };

  private onDoubleClick = (e: MouseEvent) => {
    if (this.overlay || this.modal) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ref = this.objectClick(e.clientX - r.left, e.clientY - r.top, false);
    if (ref?.meshPath) enterEditMode({ link: ref.link, role: ref.role, index: ref.index, meshPath: ref.meshPath });
  };

  private onWheel = (e: WheelEvent) => {
    const m = this.modal;
    if (m?.kind === "circle") {
      e.preventDefault();
      e.stopImmediatePropagation();
      m.radius = THREE.MathUtils.clamp(m.radius * (e.deltaY > 0 ? 0.9 : 1.1), 4, 400);
      this.drawCircle();
      return;
    }
    if (m?.kind === "transform" && s().proportional.enabled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const prop = s().proportional;
      const radius = THREE.MathUtils.clamp(prop.radius * (e.deltaY > 0 ? 1 / 1.15 : 1.15), 1e-5, 1e4);
      store.setState({ proportional: { ...prop, radius } });
      this.restartTransformSession();
      return;
    }
    if (m) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  // ------------------------------------------------------------ overlays

  private drawBox(x0: number, y0: number, x1: number, y1: number) {
    const st = this.boxDiv.style;
    st.display = "block";
    st.left = `${Math.min(x0, x1)}px`;
    st.top = `${Math.min(y0, y1)}px`;
    st.width = `${Math.abs(x1 - x0)}px`;
    st.height = `${Math.abs(y1 - y0)}px`;
  }

  private drawCircle() {
    const m = this.modal;
    if (m?.kind !== "circle") return;
    const st = this.circleDiv.style;
    st.display = "block";
    st.left = `${this.mouse.x - m.radius}px`;
    st.top = `${this.mouse.y - m.radius}px`;
    st.width = st.height = `${m.radius * 2}px`;
  }

  private drawLine(x0: number, y0: number, x1: number, y1: number) {
    this.lineSvg.style.display = "block";
    this.lineSvg.innerHTML = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" />`;
  }

  private clearOverlays() {
    this.boxDiv.style.display = "none";
    this.circleDiv.style.display = "none";
    this.lineSvg.style.display = "none";
    this.lineSvg.innerHTML = "";
  }

  // ------------------------------------------------------- selection tools

  startBoxSelect() {
    if (!this.overlay) return;
    this.modal = { kind: "box", armed: true, op: "add", x0: 0, y0: 0, dragging: false };
    store.setState({ modalHint: "框选: 左键拖动添加, Shift/中键拖动减选, 右键/Esc 取消" });
  }

  private applyBox(m: BoxModal, x1: number, y1: number) {
    const entry = currentEntry();
    this.modal = null;
    this.clearOverlays();
    store.setState({ modalHint: null });
    if (!entry || !this.overlay) return;
    const mode = s().meshStats?.mode ?? "vert";
    const ids = entry.editor.inRect(mode, this.mvp(), this.container.clientWidth, this.container.clientHeight, m.x0, m.y0, x1, y1);
    const visible = this.filterVisible(mode, ids);
    runCmd({ op: "select_elems", kind: mode, ids: visible, mode: m.op }, { label: "框选", noAdjust: true });
  }

  startCircleSelect() {
    const entry = currentEntry();
    if (!this.overlay || !entry) return;
    entry.editor.pushUndo("Circle Select");
    this.modal = { kind: "circle", radius: 30, painting: null };
    this.drawCircle();
    store.setState({ modalHint: "刷选: 左键添加, Shift+左键/中键减选, 滚轮调整半径, 右键/Esc/Enter 结束" });
  }

  private circlePaint(x: number, y: number) {
    const m = this.modal;
    const entry = currentEntry();
    if (m?.kind !== "circle" || !m.painting || !entry) return;
    const mode = s().meshStats?.mode ?? "vert";
    const ids = entry.editor.inCircle(mode, this.mvp(), this.container.clientWidth, this.container.clientHeight, x, y, m.radius);
    const vis = this.filterVisible(mode, ids);
    if (!vis.length) return;
    entry.editor.selectRaw(mode, Uint32Array.from(vis), m.painting);
    meshChanged();
  }

  // ------------------------------------------------------------ transform

  /** G / R / S in edit mode. `axis` (world) constrains, e.g. along an extrude normal. */
  startTransform(type: TransformType, opts?: { normal?: THREE.Vector3 }) {
    const entry = currentEntry();
    if (!entry || !this.overlay) return;
    const c = entry.editor.selectionCenter();
    if (!c) {
      s().setStatus("没有选中任何元素", "error");
      return;
    }
    const objMatrix = this.overlay.group.matrixWorld.clone();
    const pivot = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(objMatrix);
    const worldScale = new THREE.Vector3().setFromMatrixScale(objMatrix);
    const avgScale = (Math.abs(worldScale.x) + Math.abs(worldScale.y) + Math.abs(worldScale.z)) / 3 || 1;
    const prop = s().proportional;
    const propRadius = prop.enabled ? prop.radius / avgScale : 0;
    try {
      entry.editor.beginTransform(propRadius, prop.falloff, prop.connected);
    } catch (e) {
      s().setStatus(String(e), "error");
      return;
    }
    const normalAxis = opts?.normal ? opts.normal.clone().normalize() : null;
    this.modal = {
      kind: "transform",
      type,
      startX: this.mouse.x,
      startY: this.mouse.y,
      pivot,
      pivotScreen: this.project(pivot),
      axis: normalAxis,
      axisLabel: normalAxis ? "法线" : null,
      space: normalAxis ? "normal" : "global",
      planar: false,
      numeric: "",
      snap: false,
      objMatrix,
      objInv: objMatrix.clone().invert(),
      normalAxis,
      propRadius,
      lastValue: "",
    };
    this.updateTransform();
  }

  private restartTransformSession() {
    const m = this.modal;
    const entry = currentEntry();
    if (m?.kind !== "transform" || !entry) return;
    entry.editor.endTransform(false);
    const prop = s().proportional;
    const scale = new THREE.Vector3().setFromMatrixScale(m.objMatrix);
    const avg = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
    m.propRadius = prop.enabled ? prop.radius / avg : 0;
    entry.editor.beginTransform(m.propRadius, prop.falloff, prop.connected);
    this.updateTransform();
  }

  private localAxes(m: TransformModal): THREE.Vector3[] {
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    m.objMatrix.extractBasis(x, y, z);
    return [x.normalize(), y.normalize(), z.normalize()];
  }

  /** Handles X/Y/Z (and Shift+X/Y/Z) during a transform. */
  private setAxis(key: "x" | "y" | "z", planar: boolean) {
    const m = this.modal;
    if (m?.kind !== "transform") return;
    const idx = { x: 0, y: 1, z: 2 }[key];
    const label = key.toUpperCase();
    const global = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)][idx];
    if (m.axisLabel?.startsWith(label) && m.planar === planar) {
      if (m.space === "global") {
        m.space = "local";
        m.axis = this.localAxes(m)[idx];
        m.axisLabel = `${label} (局部)`;
      } else {
        m.axis = null;
        m.axisLabel = null;
        m.space = "global";
      }
    } else {
      m.axis = global;
      m.axisLabel = label;
      m.space = "global";
      m.planar = planar;
    }
    this.updateTransform();
  }

  private updateTransform() {
    const m = this.modal;
    const entry = currentEntry();
    if (m?.kind !== "transform" || !entry || !this.overlay) return;
    const W = new THREE.Matrix4();
    const p = m.pivot;
    const num = m.numeric !== "" && m.numeric !== "-" ? parseFloat(m.numeric) : NaN;
    const hasNum = !Number.isNaN(num);
    const viewDir = this.camera.getWorldDirection(new THREE.Vector3());
    let desc = "";
    if (m.type === "translate") {
      let delta = new THREE.Vector3();
      if (hasNum) {
        delta = (m.axis ?? new THREE.Vector3(1, 0, 0)).clone().multiplyScalar(num);
      } else {
        const r1 = this.rayAt(this.mouse.x, this.mouse.y);
        const r0 = this.rayAt(m.startX, m.startY);
        if (m.axis && !m.planar) {
          const a = m.axis;
          const seg0 = p.clone().addScaledVector(a, -1e4);
          const seg1 = p.clone().addScaledVector(a, 1e4);
          const q1 = new THREE.Vector3();
          const q0 = new THREE.Vector3();
          r1.distanceSqToSegment(seg0, seg1, undefined, q1);
          r0.distanceSqToSegment(seg0, seg1, undefined, q0);
          let t = q1.sub(q0).dot(a);
          if (Math.abs(a.dot(viewDir)) > 0.98) {
            // Axis points at the viewer: fall back to vertical mouse motion.
            t = -(this.mouse.y - m.startY) * this.pixelScale(p);
          }
          delta = a.clone().multiplyScalar(t);
        } else {
          const n = m.axis && m.planar ? m.axis : viewDir;
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
          const i1 = r1.intersectPlane(plane, new THREE.Vector3());
          const i0 = r0.intersectPlane(plane, new THREE.Vector3());
          if (i1 && i0) delta = i1.sub(i0);
        }
        if (m.snap) {
          const step = Math.pow(10, Math.floor(Math.log10(Math.max(this.pixelScale(p) * 20, 1e-6))));
          delta.set(Math.round(delta.x / step) * step, Math.round(delta.y / step) * step, Math.round(delta.z / step) * step);
        }
      }
      W.makeTranslation(delta.x, delta.y, delta.z);
      desc = `移动 Δ ${delta.x.toFixed(4)}, ${delta.y.toFixed(4)}, ${delta.z.toFixed(4)} (${delta.length().toFixed(4)} m)`;
    } else if (m.type === "rotate") {
      let angle: number;
      const axis = (m.axis ?? viewDir.clone().negate()).clone().normalize();
      if (hasNum) angle = THREE.MathUtils.degToRad(num);
      else {
        const ps = m.pivotScreen;
        const a0 = Math.atan2(-(m.startY - ps.y), m.startX - ps.x);
        const a1 = Math.atan2(-(this.mouse.y - ps.y), this.mouse.x - ps.x);
        angle = a1 - a0;
        const facing = axis.dot(viewDir.clone().negate());
        if (m.axis && facing < 0) angle = -angle;
        if (m.snap) angle = THREE.MathUtils.degToRad(Math.round(THREE.MathUtils.radToDeg(angle) / 5) * 5);
      }
      const R = new THREE.Matrix4().makeRotationAxis(axis, angle);
      W.makeTranslation(p.x, p.y, p.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      desc = `旋转 ${THREE.MathUtils.radToDeg(angle).toFixed(2)}°`;
    } else {
      let f: number;
      if (hasNum) f = num;
      else {
        const d0 = Math.max(4, Math.hypot(m.startX - m.pivotScreen.x, m.startY - m.pivotScreen.y));
        const d1 = Math.hypot(this.mouse.x - m.pivotScreen.x, this.mouse.y - m.pivotScreen.y);
        f = d1 / d0;
        if (m.snap) f = Math.round(f * 10) / 10;
      }
      const S = new THREE.Matrix4();
      if (m.axis) {
        const a = m.axis;
        const k = f - 1;
        // Along axis: I + k a aᵀ; planar (exclude axis): I + k (I - a aᵀ).
        const e = m.planar
          ? [1 + k * (1 - a.x * a.x), -k * a.x * a.y, -k * a.x * a.z, -k * a.y * a.x, 1 + k * (1 - a.y * a.y), -k * a.y * a.z, -k * a.z * a.x, -k * a.z * a.y, 1 + k * (1 - a.z * a.z)]
          : [1 + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z, k * a.y * a.x, 1 + k * a.y * a.y, k * a.y * a.z, k * a.z * a.x, k * a.z * a.y, 1 + k * a.z * a.z];
        S.set(e[0], e[1], e[2], 0, e[3], e[4], e[5], 0, e[6], e[7], e[8], 0, 0, 0, 0, 1);
      } else S.makeScale(f, f, f);
      W.makeTranslation(p.x, p.y, p.z).multiply(S).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      desc = `缩放 ${f.toFixed(4)}`;
    }
    const local = m.objInv.clone().multiply(W).multiply(m.objMatrix);
    entry.editor.updateTransform(Float64Array.from(local.elements));
    this.overlay.refreshPositions();
    const cons = m.axisLabel ? ` | 约束: ${m.planar ? "排除 " : ""}${m.axisLabel}` : "";
    const numTxt = m.numeric ? ` | 输入: ${m.numeric}` : "";
    const prop = m.propRadius > 0 ? ` | 衰减半径: ${s().proportional.radius.toPrecision(3)} (滚轮)` : "";
    store.setState({
      modalHint: `${desc}${cons}${numTxt}${prop}   — X/Y/Z 约束(Shift 排除), 数字输入, Ctrl 吸附, 左键/Enter 确认, 右键/Esc 取消`,
    });
  }

  // ----------------------------------------------------------- param drag

  /**
   * Runs `cmd` and then lets the mouse drive one numeric parameter (e.g.
   * inset thickness). The value can also be typed.
   */
  startParamDrag(cmd: Command, key: string, label: string, params: ParamSpec[], range: { min?: number; max?: number; initial?: number } = {}) {
    const entry = currentEntry();
    if (!entry || !this.overlay) return;
    const c = entry.editor.selectionCenter();
    if (!c) {
      s().setStatus("没有选中任何元素", "error");
      return;
    }
    const initial = range.initial ?? 0;
    const out = runCmd({ ...cmd, [key]: initial }, { label, params });
    if (!out) return;
    const pivot = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(this.overlay.group.matrixWorld);
    const ps = this.project(pivot);
    const scale = new THREE.Vector3().setFromMatrixScale(this.overlay.group.matrixWorld);
    const avg = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
    this.modal = {
      kind: "param",
      cmd: { ...cmd, [key]: initial },
      key,
      label,
      params,
      pivotScreen: ps,
      startDist: Math.hypot(this.mouse.x - ps.x, this.mouse.y - ps.y),
      unitsPerPx: this.pixelScale(pivot) / avg,
      initial,
      min: range.min ?? -Infinity,
      max: range.max ?? Infinity,
      numeric: "",
      value: initial,
    };
    this.updateParam();
  }

  private updateParam() {
    const m = this.modal;
    if (m?.kind !== "param") return;
    const num = m.numeric !== "" && m.numeric !== "-" ? parseFloat(m.numeric) : NaN;
    let v: number;
    if (!Number.isNaN(num)) v = num;
    else {
      const d = Math.hypot(this.mouse.x - m.pivotScreen.x, this.mouse.y - m.pivotScreen.y);
      v = m.initial + (d - m.startDist) * m.unitsPerPx;
    }
    v = THREE.MathUtils.clamp(v, m.min, m.max);
    if (v !== m.value) {
      m.value = v;
      adjustLast({ ...m.cmd, [m.key]: v });
    }
    store.setState({ modalHint: `${m.label}: ${m.key} = ${v.toFixed(5)}${m.numeric ? ` (输入 ${m.numeric})` : ""} — 左键/Enter 确认, 右键/Esc 取消` });
  }

  // -------------------------------------------------------------- loop cut

  startLoopCut() {
    if (!this.overlay) return;
    this.modal = { kind: "loopcut" };
    store.setState({ modalHint: "环切: 点击一条边插入循环边 (之后可在左下面板调整切割次数/位置), 右键/Esc 取消" });
  }

  private applyLoopCut(x: number, y: number) {
    this.modal = null;
    store.setState({ modalHint: null });
    const hit = this.pick(x, y, "edge");
    if (!hit) {
      s().setStatus("没有拾取到边", "error");
      return;
    }
    runCmd(
      { op: "loop_cut", edge: hit.id, cuts: 1, factor: 0.5 },
      {
        label: "环切",
        params: [
          { key: "cuts", label: "切割次数", type: "int", min: 1, max: 64, step: 1 },
          { key: "factor", label: "位置 (单次切割)", type: "number", min: 0, max: 1, step: 0.01 },
        ],
      },
    );
  }

  // ---------------------------------------------------------------- bisect

  startBisect() {
    if (!this.overlay) return;
    this.modal = { kind: "bisect" };
    store.setState({ modalHint: "切分: 在视图中拖动一条直线定义切割平面, 右键/Esc 取消" });
  }

  private applyBisect(x0: number, y0: number, x1: number, y1: number) {
    this.modal = null;
    this.clearOverlays();
    store.setState({ modalHint: null });
    const entry = currentEntry();
    if (!entry || !this.overlay || Math.hypot(x1 - x0, y1 - y0) < 4) return;
    const c = entry.editor.selectionCenter() ?? [0, 0, 0];
    const M = this.overlay.group.matrixWorld;
    const pivot = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(M);
    const viewDir = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, pivot);
    const p0 = this.rayAt(x0, y0).intersectPlane(plane, new THREE.Vector3());
    const p1 = this.rayAt(x1, y1).intersectPlane(plane, new THREE.Vector3());
    if (!p0 || !p1) return;
    const nWorld = new THREE.Vector3().subVectors(p1, p0).cross(viewDir).normalize();
    const inv = M.clone().invert();
    const co = p0.clone().applyMatrix4(inv);
    // Normals transform with the transpose of the linear part.
    const nLocal = nWorld.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(M).transpose()).normalize();
    runCmd(
      { op: "bisect", co: [co.x, co.y, co.z], no: [nLocal.x, nLocal.y, nLocal.z], clear_inner: false, clear_outer: false, fill: false },
      {
        label: "切分",
        params: [
          { key: "clear_inner", label: "清除内侧", type: "bool" },
          { key: "clear_outer", label: "清除外侧", type: "bool" },
          { key: "fill", label: "填充切口", type: "bool" },
        ],
      },
    );
  }

  // ----------------------------------------------------------- modal keys

  /** Returns true when the key was consumed by an active modal tool. */
  handleModalKey(e: KeyboardEvent): boolean {
    const m = this.modal;
    if (!m) return false;
    const k = e.key;
    if (k === "Escape") {
      this.cancelModal();
      return true;
    }
    if (m.kind === "transform" || m.kind === "param") {
      if (k === "Enter" || k === " ") {
        this.confirmModal();
        return true;
      }
      if (/^[0-9.]$/.test(k) || (k === "-" && m.numeric === "")) {
        m.numeric += k;
      } else if (k === "-" ) {
        m.numeric = m.numeric.startsWith("-") ? m.numeric.slice(1) : `-${m.numeric}`;
      } else if (k === "Backspace") {
        m.numeric = m.numeric.slice(0, -1);
      } else if (m.kind === "transform" && ["x", "y", "z", "X", "Y", "Z"].includes(k)) {
        this.setAxis(k.toLowerCase() as "x" | "y" | "z", e.shiftKey);
        return true;
      } else if (m.kind === "transform" && (k === "g" || k === "r" || k === "s")) {
        m.type = k === "g" ? "translate" : k === "r" ? "rotate" : "scale";
        m.startX = this.mouse.x;
        m.startY = this.mouse.y;
        m.numeric = "";
      } else if (m.kind === "transform" && k === "Control") {
        m.snap = true;
      } else {
        return true;
      }
      if (m.kind === "transform") this.updateTransform();
      else this.updateParam();
      return true;
    }
    if (m.kind === "circle" && (k === "Enter" || k === " ")) {
      this.cancelModal();
      return true;
    }
    if (m.kind === "circle" && (k === "+" || k === "=" || k === "-")) {
      m.radius = THREE.MathUtils.clamp(m.radius * (k === "-" ? 0.85 : 1.15), 4, 400);
      this.drawCircle();
      return true;
    }
    return true;
  }

  handleModalKeyUp(e: KeyboardEvent) {
    const m = this.modal;
    if (m?.kind === "transform" && e.key === "Control") {
      m.snap = false;
      this.updateTransform();
    }
  }

  confirmModal() {
    const m = this.modal;
    const entry = currentEntry();
    this.modal = null;
    this.clearOverlays();
    store.setState({ modalHint: null });
    if (m?.kind === "transform" && entry) {
      entry.editor.endTransform(true);
      store.setState({ lastOp: null });
      meshChanged();
    } else if (m?.kind === "param") {
      store.setState({ lastOp: { label: m.label, cmd: { ...m.cmd, [m.key]: m.value }, params: m.params } });
    }
  }

  cancelModal() {
    const m = this.modal;
    const entry = currentEntry();
    this.modal = null;
    this.clearOverlays();
    store.setState({ modalHint: null });
    if (m?.kind === "transform" && entry) {
      entry.editor.endTransform(false);
      meshChanged();
    } else if (m?.kind === "param") {
      undoMesh();
    } else if (m?.kind === "circle") {
      meshChanged();
    }
  }
}
