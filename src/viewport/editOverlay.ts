// Edit-mode display of a mesh: faces, edges, vertices and face dots with
// selection colors, driven by the WASM MeshEditor buffers.

import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { MeshEditor } from "../wasm";

const FACE = new THREE.Color(0.62, 0.64, 0.68);
const FACE_SEL = new THREE.Color(1.0, 0.62, 0.25);
const EDGE = new THREE.Color(0.05, 0.05, 0.06);
const EDGE_SEL = new THREE.Color(1.0, 0.55, 0.1);
const VERT = new THREE.Color(0.05, 0.05, 0.06);
const VERT_SEL = new THREE.Color(1.0, 0.5, 0.0);
const ACTIVE = new THREE.Color(1.0, 1.0, 1.0);

export class EditOverlay {
  readonly group = new THREE.Group();
  readonly faces: THREE.Mesh;
  readonly edges: THREE.LineSegments;
  readonly verts: THREE.Points;
  readonly faceDots: THREE.Points;
  triFaces: Uint32Array = new Uint32Array();
  vertIds: Uint32Array = new Uint32Array();
  edgeIds: Uint32Array = new Uint32Array();
  faceIds: Uint32Array = new Uint32Array();
  private faceMat: THREE.MeshStandardMaterial;
  private mode: "vert" | "edge" | "face" = "vert";

  constructor(readonly editor: MeshEditor) {
    this.group.name = "edit-overlay";
    this.faceMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0,
      roughness: 0.8,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.faces = new THREE.Mesh(new THREE.BufferGeometry(), this.faceMat);
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    this.verts = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ vertexColors: true, size: 6, sizeAttenuation: false }),
    );
    this.faceDots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ vertexColors: true, size: 5, sizeAttenuation: false }),
    );
    this.edges.renderOrder = 20;
    this.verts.renderOrder = 21;
    this.faceDots.renderOrder = 21;
    this.faces.renderOrder = 19;
    for (const o of [this.faces, this.edges, this.verts, this.faceDots]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
  }

  dispose() {
    for (const o of [this.faces, this.edges, this.verts, this.faceDots]) {
      const g = o.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void };
      if ((g as { boundsTree?: unknown }).boundsTree) disposeBoundsTree.call(g);
      g.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }

  setXray(xray: boolean) {
    this.faceMat.transparent = xray;
    this.faceMat.opacity = xray ? 0.25 : 1;
    this.faceMat.depthWrite = !xray;
    for (const o of [this.edges, this.verts, this.faceDots]) {
      (o.material as THREE.Material).depthTest = !xray;
    }
    this.faceMat.needsUpdate = true;
  }

  /** Full rebuild after topology or selection-mode changes. */
  rebuild(mode: "vert" | "edge" | "face") {
    this.mode = mode;
    const ed = this.editor;
    ed.rebuild(false);
    this.triFaces = ed.triFaces();
    this.vertIds = ed.vertIds();
    this.edgeIds = ed.edgeIds();
    this.faceIds = ed.faceIds();
    const set = (geo: THREE.BufferGeometry, name: string, arr: Float32Array, size: number) => {
      geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
    };
    const fg = this.faces.geometry;
    if ((fg as { boundsTree?: unknown }).boundsTree) disposeBoundsTree.call(fg);
    set(fg, "position", ed.triPositions(), 3);
    set(fg, "normal", ed.triNormals(), 3);
    set(fg, "color", new Float32Array(this.triFaces.length * 9), 3);
    set(this.edges.geometry, "position", ed.edgePositions(), 3);
    set(this.edges.geometry, "color", new Float32Array(this.edgeIds.length * 6), 3);
    set(this.verts.geometry, "position", ed.vertPositions(), 3);
    set(this.verts.geometry, "color", new Float32Array(this.vertIds.length * 3), 3);
    set(this.faceDots.geometry, "position", ed.faceCenters(), 3);
    set(this.faceDots.geometry, "color", new Float32Array(this.faceIds.length * 3), 3);
    for (const o of [this.faces, this.edges, this.verts, this.faceDots]) {
      o.geometry.computeBoundingSphere();
    }
    if (this.triFaces.length) computeBoundsTree.call(fg, { indirect: true });
    this.verts.visible = mode === "vert";
    this.faceDots.visible = mode === "face";
    this.updateSelection();
  }

  /** Updates positions in place during interactive transforms. */
  refreshPositions() {
    const ed = this.editor;
    ed.refreshPositions();
    const upd = (geo: THREE.BufferGeometry, name: string, arr: Float32Array) => {
      const a = geo.getAttribute(name) as THREE.BufferAttribute;
      if (a.array.length !== arr.length) {
        geo.setAttribute(name, new THREE.BufferAttribute(arr, 3));
      } else {
        (a.array as Float32Array).set(arr);
        a.needsUpdate = true;
      }
    };
    upd(this.faces.geometry, "position", ed.triPositions());
    upd(this.faces.geometry, "normal", ed.triNormals());
    upd(this.edges.geometry, "position", ed.edgePositions());
    upd(this.verts.geometry, "position", ed.vertPositions());
    upd(this.faceDots.geometry, "position", ed.faceCenters());
    this.faces.geometry.computeBoundingSphere();
  }

  /** The BVH is only rebuilt on demand (picking) after position changes. */
  ensureBvh() {
    const fg = this.faces.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (!this.triFaces.length) return;
    if (fg.boundsTree) disposeBoundsTree.call(fg);
    computeBoundsTree.call(fg, { indirect: true });
  }

  updateSelection() {
    const ed = this.editor;
    const active = Number(ed.active());
    const triSel = ed.triSelection();
    const fc = this.faces.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let t = 0; t < triSel.length; t++) {
      const c = triSel[t] ? FACE_SEL : FACE;
      for (let k = 0; k < 3; k++) fc.setXYZ(t * 3 + k, c.r, c.g, c.b);
    }
    fc.needsUpdate = true;
    const edgeSel = ed.edgeSelection();
    const ec = this.edges.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < edgeSel.length; i++) {
      const isActive = this.mode === "edge" && this.edgeIds[i] === active;
      const c = isActive ? ACTIVE : edgeSel[i] ? EDGE_SEL : EDGE;
      ec.setXYZ(i * 2, c.r, c.g, c.b);
      ec.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    }
    ec.needsUpdate = true;
    const vertSel = ed.vertSelection();
    const vc = this.verts.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < vertSel.length; i++) {
      const isActive = this.mode === "vert" && this.vertIds[i] === active;
      const c = isActive ? ACTIVE : vertSel[i] ? VERT_SEL : VERT;
      vc.setXYZ(i, c.r, c.g, c.b);
    }
    vc.needsUpdate = true;
    const faceSel = ed.faceSelection();
    const dc = this.faceDots.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < faceSel.length; i++) {
      const isActive = this.faceIds[i] === active;
      const c = isActive ? ACTIVE : faceSel[i] ? VERT_SEL : VERT;
      dc.setXYZ(i, c.r, c.g, c.b);
    }
    dc.needsUpdate = true;
  }
}
