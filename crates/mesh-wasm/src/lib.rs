//! WebAssembly bindings: the mesh editor kernel, URDF parse/write and
//! project packaging, exposed to the TypeScript frontend.

use mesh_core::command::Command;
use mesh_core::editor::{Editor, Falloff};
use mesh_core::fit::FitOptions;
use mesh_core::pick::Projector;
use mesh_core::render::RenderBuffers;
use mesh_core::{io, Mesh, SelectMode};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(js_err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    verts: usize,
    edges: usize,
    faces: usize,
    sel_verts: usize,
    sel_edges: usize,
    sel_faces: usize,
    mode: SelectMode,
    can_undo: bool,
    can_redo: bool,
    version: u64,
    dirty: bool,
}

/// A mesh being edited, with its own undo history.
#[wasm_bindgen]
pub struct MeshEditor {
    ed: Editor,
    buf: RenderBuffers,
}

#[wasm_bindgen]
impl MeshEditor {
    fn wrap(mesh: Mesh) -> MeshEditor {
        let mut m = MeshEditor { ed: Editor::new(mesh), buf: RenderBuffers::default() };
        m.rebuild(false);
        m
    }

    #[wasm_bindgen(js_name = fromStl)]
    pub fn from_stl(bytes: &[u8]) -> Result<MeshEditor, JsError> {
        Ok(Self::wrap(io::read_stl(bytes).map_err(js_err)?))
    }

    /// `mtl`: contents of the file named by `mtllib` (see `objMtllibs`).
    #[wasm_bindgen(js_name = fromObj)]
    pub fn from_obj(text: &str, mtl: Option<String>) -> Result<MeshEditor, JsError> {
        Ok(Self::wrap(io::read_obj(text, mtl.as_deref()).map_err(js_err)?))
    }

    /// Triangle soup (optionally indexed); coincident vertices are welded.
    /// `tri_mats` gives each triangle's slot in `materials`
    /// (`[{name, color: [r, g, b, a]}]`, sRGB).
    #[wasm_bindgen(js_name = fromTriangles)]
    pub fn from_triangles(
        positions: &[f32],
        indices: Option<Vec<u32>>,
        weld_eps: f64,
        tri_mats: Option<Vec<u32>>,
        materials: JsValue,
    ) -> Result<MeshEditor, JsError> {
        let mut m = Mesh::from_triangles(positions, indices.as_deref(), weld_eps, tri_mats.as_deref());
        if !materials.is_undefined() && !materials.is_null() {
            m.materials = serde_wasm_bindgen::from_value(materials).map_err(js_err)?;
        }
        Ok(Self::wrap(m))
    }

    #[wasm_bindgen(js_name = empty)]
    pub fn empty() -> MeshEditor {
        Self::wrap(Mesh::new())
    }

    #[wasm_bindgen(js_name = clone)]
    pub fn clone_editor(&self) -> MeshEditor {
        Self::wrap(self.ed.mesh.clone())
    }

    // ---------------------------------------------------------------- export

    #[wasm_bindgen(js_name = toStl)]
    pub fn to_stl(&self, name: &str) -> Vec<u8> {
        io::write_stl(&self.ed.mesh, name)
    }

    /// `mtllib`: file name of the `.mtl` written from `toMtl` (if any).
    #[wasm_bindgen(js_name = toObj)]
    pub fn to_obj(&self, name: &str, mtllib: Option<String>) -> String {
        io::write_obj(&self.ed.mesh, name, mtllib.as_deref())
    }

    /// The OBJ material library, or undefined when the mesh has no materials.
    #[wasm_bindgen(js_name = toMtl)]
    pub fn to_mtl(&self) -> Option<String> {
        io::write_mtl(&self.ed.mesh)
    }

    #[wasm_bindgen(js_name = toDae)]
    pub fn to_dae(&self, name: &str) -> String {
        io::write_dae(&self.ed.mesh, name)
    }

    // ------------------------------------------------------------- materials

    /// Material slots: `[{name, color: [r, g, b, a]}]` (sRGB).
    pub fn materials(&self) -> Result<JsValue, JsError> {
        to_js(&self.ed.mesh.materials)
    }

    /// Slot of each triangle of `objectTriPositions`.
    #[wasm_bindgen(js_name = objectTriMaterials)]
    pub fn object_tri_materials(&self) -> Vec<u32> {
        self.ed.mesh.triangle_materials()
    }

    /// Slot of each triangle of the edit-mode buffers (`triPositions`).
    #[wasm_bindgen(js_name = triMaterials)]
    pub fn tri_materials(&self) -> Vec<u32> {
        self.buf.tri_face.iter().map(|&f| self.ed.mesh.faces[f as usize].mat).collect()
    }

    // ------------------------------------------------------------------ info

    pub fn stats(&self) -> Result<JsValue, JsError> {
        let m = &self.ed.mesh;
        let (v, e, f) = m.live_counts();
        let (sv, se, sf) = m.selected_counts();
        to_js(&Stats {
            verts: v,
            edges: e,
            faces: f,
            sel_verts: sv,
            sel_edges: se,
            sel_faces: sf,
            mode: m.select_mode,
            can_undo: self.ed.can_undo(),
            can_redo: self.ed.can_redo(),
            version: self.ed.version,
            dirty: self.ed.dirty,
        })
    }

    #[wasm_bindgen(js_name = setDirty)]
    pub fn set_dirty(&mut self, dirty: bool) {
        self.ed.dirty = dirty;
    }

    /// Ids of the undo steps (oldest first); ids stay the same when a step
    /// is undone and redone.
    #[wasm_bindgen(js_name = undoIds)]
    pub fn undo_ids(&self) -> Vec<f64> {
        self.ed.undo_ids().into_iter().map(|i| i as f64).collect()
    }

    #[wasm_bindgen(js_name = undoLabel)]
    pub fn undo_label(&self) -> Option<String> {
        self.ed.undo_label().map(str::to_string)
    }

    /// Id of the next redo step, or -1.
    #[wasm_bindgen(js_name = redoId)]
    pub fn redo_id(&self) -> f64 {
        self.ed.redo_id().map_or(-1.0, |i| i as f64)
    }

    #[wasm_bindgen(js_name = clearRedo)]
    pub fn clear_redo(&mut self) {
        self.ed.clear_redo();
    }

    #[wasm_bindgen(js_name = clearHistory)]
    pub fn clear_history(&mut self) {
        self.ed.clear_history();
    }

    pub fn version(&self) -> f64 {
        self.ed.version as f64
    }

    /// Changes only when geometry or visibility changes.
    #[wasm_bindgen(js_name = geomVersion)]
    pub fn geom_version(&self) -> f64 {
        self.ed.geom_version as f64
    }

    #[wasm_bindgen(js_name = pushUndo)]
    pub fn push_undo(&mut self, label: &str) {
        self.ed.push_undo_step(label);
    }

    /// Selection change without an undo step (use after `pushUndo`).
    #[wasm_bindgen(js_name = selectRaw)]
    pub fn select_raw(&mut self, kind: &str, ids: &[u32], op: &str) {
        let kind = match kind {
            "vert" => mesh_core::ElemKind::Vert,
            "edge" => mesh_core::ElemKind::Edge,
            _ => mesh_core::ElemKind::Face,
        };
        let op = match op {
            "add" => mesh_core::select::SelectOp::Add,
            "sub" => mesh_core::select::SelectOp::Sub,
            "toggle" => mesh_core::select::SelectOp::Toggle,
            _ => mesh_core::select::SelectOp::Set,
        };
        self.ed.mesh.select_elems(kind, ids, op);
        self.ed.version += 1;
    }

    #[wasm_bindgen(js_name = selectionCenter)]
    pub fn selection_center(&self) -> Option<Vec<f64>> {
        self.ed.mesh.selection_center().map(|c| c.to_array().to_vec())
    }

    /// Average normal of the selection (faces, else vertices).
    #[wasm_bindgen(js_name = selectionNormal)]
    pub fn selection_normal(&self) -> Option<Vec<f64>> {
        let m = &self.ed.mesh;
        let faces = m.selected_faces();
        let n: glam::DVec3 = if !faces.is_empty() {
            faces.iter().map(|&f| m.face_normal(f)).sum()
        } else {
            m.selected_verts().iter().map(|&v| m.vert_normal(v)).sum()
        };
        let n = n.normalize_or_zero();
        (n != glam::DVec3::ZERO).then(|| n.to_array().to_vec())
    }

    /// Bounding box as [minx,miny,minz,maxx,maxy,maxz].
    pub fn bounds(&self) -> Option<Vec<f64>> {
        self.ed.mesh.bounds().map(|(a, b)| vec![a.x, a.y, a.z, b.x, b.y, b.z])
    }

    #[wasm_bindgen(js_name = selectedBounds)]
    pub fn selected_bounds(&self) -> Option<Vec<f64>> {
        let m = &self.ed.mesh;
        let sv = m.selected_verts();
        let first = m.verts[*sv.first()? as usize].co;
        let (lo, hi) = sv.iter().fold((first, first), |(lo, hi), &v| (lo.min(m.verts[v as usize].co), hi.max(m.verts[v as usize].co)));
        Some(vec![lo.x, lo.y, lo.z, hi.x, hi.y, hi.z])
    }

    #[wasm_bindgen(js_name = vertPosition)]
    pub fn vert_position(&self, v: u32) -> Vec<f64> {
        self.ed.mesh.verts[v as usize].co.to_array().to_vec()
    }

    #[wasm_bindgen(js_name = edgeVerts)]
    pub fn edge_verts(&self, e: u32) -> Vec<u32> {
        self.ed.mesh.edges[e as usize].v.to_vec()
    }

    // ---------------------------------------------------------------- render

    /// Recomputes display buffers. Call after any command.
    pub fn rebuild(&mut self, include_hidden: bool) {
        self.buf = self.ed.mesh.render_buffers(include_hidden);
    }

    /// Refreshes positions only (topology unchanged, e.g. while dragging).
    #[wasm_bindgen(js_name = refreshPositions)]
    pub fn refresh_positions(&mut self) {
        let (t, n, e, v) = self.ed.mesh.positions_for(&self.buf);
        self.buf.tri_pos = t;
        self.buf.tri_nrm = n;
        self.buf.edge_pos = e;
        self.buf.vert_pos = v;
        let centers: Vec<f32> = self
            .buf
            .face_ids
            .iter()
            .flat_map(|&f| {
                let c = self.ed.mesh.face_center(f);
                [c.x as f32, c.y as f32, c.z as f32]
            })
            .collect();
        self.buf.face_center = centers;
    }

    /// All faces as flat triangles, independent of the edit-mode buffers.
    #[wasm_bindgen(js_name = objectTriPositions)]
    pub fn object_tri_positions(&self) -> Vec<f32> {
        self.ed.mesh.triangle_positions()
    }

    #[wasm_bindgen(js_name = triPositions)]
    pub fn tri_positions(&self) -> Vec<f32> {
        self.buf.tri_pos.clone()
    }
    #[wasm_bindgen(js_name = triNormals)]
    pub fn tri_normals(&self) -> Vec<f32> {
        self.buf.tri_nrm.clone()
    }
    #[wasm_bindgen(js_name = triFaces)]
    pub fn tri_faces(&self) -> Vec<u32> {
        self.buf.tri_face.clone()
    }
    #[wasm_bindgen(js_name = edgePositions)]
    pub fn edge_positions(&self) -> Vec<f32> {
        self.buf.edge_pos.clone()
    }
    #[wasm_bindgen(js_name = edgeIds)]
    pub fn edge_ids(&self) -> Vec<u32> {
        self.buf.edge_ids.clone()
    }
    #[wasm_bindgen(js_name = vertPositions)]
    pub fn vert_positions(&self) -> Vec<f32> {
        self.buf.vert_pos.clone()
    }
    #[wasm_bindgen(js_name = vertIds)]
    pub fn vert_ids(&self) -> Vec<u32> {
        self.buf.vert_ids.clone()
    }
    #[wasm_bindgen(js_name = faceCenters)]
    pub fn face_centers(&self) -> Vec<f32> {
        self.buf.face_center.clone()
    }
    #[wasm_bindgen(js_name = faceIds)]
    pub fn face_ids(&self) -> Vec<u32> {
        self.buf.face_ids.clone()
    }

    /// Selection flags aligned with the render buffers:
    /// per displayed vertex, per displayed edge, per triangle.
    #[wasm_bindgen(js_name = vertSelection)]
    pub fn vert_selection(&self) -> Vec<u8> {
        self.buf.vert_ids.iter().map(|&v| self.ed.mesh.verts[v as usize].sel as u8).collect()
    }
    #[wasm_bindgen(js_name = edgeSelection)]
    pub fn edge_selection(&self) -> Vec<u8> {
        self.buf.edge_ids.iter().map(|&e| self.ed.mesh.edges[e as usize].sel as u8).collect()
    }
    #[wasm_bindgen(js_name = triSelection)]
    pub fn tri_selection(&self) -> Vec<u8> {
        self.buf.tri_face.iter().map(|&f| self.ed.mesh.faces[f as usize].sel as u8).collect()
    }
    #[wasm_bindgen(js_name = faceSelection)]
    pub fn face_selection(&self) -> Vec<u8> {
        self.buf.face_ids.iter().map(|&f| self.ed.mesh.faces[f as usize].sel as u8).collect()
    }
    /// Active element id in the current mode, or -1.
    pub fn active(&self) -> i64 {
        self.ed.mesh.active.map(|a| a as i64).unwrap_or(-1)
    }

    // --------------------------------------------------------------- picking

    #[wasm_bindgen(js_name = pickVerts)]
    pub fn pick_verts(&self, mvp: &[f64], w: f64, h: f64, x: f64, y: f64, radius: f64, max: usize) -> Vec<u32> {
        self.ed.mesh.nearest_verts(&Projector::new(mvp, w, h), x, y, radius, max)
    }

    /// Returns flattened pairs [edgeId, t, edgeId, t, ...].
    #[wasm_bindgen(js_name = pickEdges)]
    pub fn pick_edges(&self, mvp: &[f64], w: f64, h: f64, x: f64, y: f64, radius: f64, max: usize) -> Vec<f64> {
        self.ed
            .mesh
            .nearest_edges(&Projector::new(mvp, w, h), x, y, radius, max)
            .into_iter()
            .flat_map(|(e, t)| [e as f64, t])
            .collect()
    }

    /// Elements of `kind` ("vert" | "edge" | "face") inside a screen rectangle.
    #[wasm_bindgen(js_name = inRect)]
    pub fn in_rect(&self, kind: &str, mvp: &[f64], w: f64, h: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u32> {
        let pr = Projector::new(mvp, w, h);
        let m = &self.ed.mesh;
        match kind {
            "vert" => m.verts_in_rect(&pr, x0, y0, x1, y1),
            "edge" => m.edges_in_rect(&pr, x0, y0, x1, y1),
            _ => m.faces_in_rect(&pr, x0, y0, x1, y1),
        }
    }

    #[wasm_bindgen(js_name = inCircle)]
    pub fn in_circle(&self, kind: &str, mvp: &[f64], w: f64, h: f64, x: f64, y: f64, r: f64) -> Vec<u32> {
        let pr = Projector::new(mvp, w, h);
        let m = &self.ed.mesh;
        match kind {
            "vert" => m.verts_in_circle(&pr, x, y, r),
            "edge" => m.edges_in_circle(&pr, x, y, r),
            _ => m.faces_in_circle(&pr, x, y, r),
        }
    }

    // -------------------------------------------------------------- commands

    /// Runs a command (see `mesh_core::command::Command`) given as a JS
    /// object like `{op: "extrude"}`. Returns `{normal?, count?}`.
    pub fn run(&mut self, cmd: JsValue) -> Result<JsValue, JsError> {
        let cmd: Command = serde_wasm_bindgen::from_value(cmd).map_err(js_err)?;
        let out = self.ed.execute(&cmd).map_err(js_err)?;
        to_js(&out)
    }

    /// Re-runs the last command with new parameters.
    pub fn adjust(&mut self, cmd: JsValue) -> Result<JsValue, JsError> {
        let cmd: Command = serde_wasm_bindgen::from_value(cmd).map_err(js_err)?;
        let out = self.ed.adjust(&cmd).map_err(js_err)?;
        to_js(&out)
    }

    /// Separate (P): removes the selection and returns it as a new editor.
    pub fn separate(&mut self) -> Result<MeshEditor, JsError> {
        let part = self.ed.apply("Separate", |m| m.separate()).map_err(js_err)?;
        Ok(Self::wrap(part))
    }

    /// Fits box/cylinder/sphere shapes to the selection (or the whole mesh);
    /// see `mesh_core::fit::FitOptions`. Read-only.
    #[wasm_bindgen(js_name = fitPrimitives)]
    pub fn fit_primitives(&self, opts: JsValue) -> Result<JsValue, JsError> {
        let opts: FitOptions = serde_wasm_bindgen::from_value(opts).map_err(js_err)?;
        to_js(&self.ed.mesh.fit_primitives(&opts).map_err(js_err)?)
    }

    pub fn undo(&mut self) -> Option<String> {
        self.ed.undo()
    }

    pub fn redo(&mut self) -> Option<String> {
        self.ed.redo()
    }

    // ------------------------------------------------------------- transform

    #[wasm_bindgen(js_name = beginTransform)]
    pub fn begin_transform(&mut self, prop_radius: f64, falloff: &str, connected_only: bool) -> Result<usize, JsError> {
        let f = match falloff {
            "sphere" => Falloff::Sphere,
            "root" => Falloff::Root,
            "sharp" => Falloff::Sharp,
            "linear" => Falloff::Linear,
            "constant" => Falloff::Constant,
            _ => Falloff::Smooth,
        };
        self.ed.begin_transform(prop_radius, f, connected_only).map_err(js_err)
    }

    /// `matrix` is a column-major 4x4 relative to the transform start.
    #[wasm_bindgen(js_name = updateTransform)]
    pub fn update_transform(&mut self, matrix: &[f64]) {
        let mut a = [0.0; 16];
        a.copy_from_slice(&matrix[..16]);
        self.ed.update_transform(glam::DMat4::from_cols_array(&a));
    }

    #[wasm_bindgen(js_name = endTransform)]
    pub fn end_transform(&mut self, commit: bool) {
        self.ed.end_transform(commit);
    }

    #[wasm_bindgen(js_name = inTransform)]
    pub fn in_transform(&self) -> bool {
        self.ed.in_transform()
    }
}

// --------------------------------------------------------------------- URDF

#[wasm_bindgen(js_name = parseUrdf)]
pub fn parse_urdf(text: &str) -> Result<JsValue, JsError> {
    to_js(&urdf_core::parse_urdf(text).map_err(js_err)?)
}

#[wasm_bindgen(js_name = writeUrdf)]
pub fn write_urdf(robot: JsValue) -> Result<String, JsError> {
    let r: urdf_core::Robot = serde_wasm_bindgen::from_value(robot).map_err(js_err)?;
    Ok(urdf_core::write_urdf(&r))
}

#[wasm_bindgen(js_name = validateUrdf)]
pub fn validate_urdf(robot: JsValue) -> Result<JsValue, JsError> {
    let r: urdf_core::Robot = serde_wasm_bindgen::from_value(robot).map_err(js_err)?;
    to_js(&r.validate())
}

// ------------------------------------------------------------------ project

/// Reads a zip archive; returns `[{path, data: Uint8Array}]`.
#[wasm_bindgen(js_name = readZip)]
pub fn read_zip(bytes: &[u8]) -> Result<js_sys::Array, JsError> {
    let files = project_core::read_zip(bytes).map_err(js_err)?;
    let out = js_sys::Array::new();
    for (path, data) in files {
        let o = js_sys::Object::new();
        js_sys::Reflect::set(&o, &"path".into(), &path.into()).map_err(|_| JsError::new("reflect"))?;
        js_sys::Reflect::set(&o, &"data".into(), &js_sys::Uint8Array::from(&data[..]).into())
            .map_err(|_| JsError::new("reflect"))?;
        out.push(&o);
    }
    Ok(out)
}

/// Writes a zip archive from parallel arrays of paths and byte arrays.
#[wasm_bindgen(js_name = writeZip)]
pub fn write_zip(paths: Vec<String>, datas: js_sys::Array) -> Result<Vec<u8>, JsError> {
    let mut files = project_core::Files::new();
    for (i, p) in paths.into_iter().enumerate() {
        let d = js_sys::Uint8Array::new(&datas.get(i as u32)).to_vec();
        files.insert(p, d);
    }
    project_core::write_zip(&files).map_err(js_err)
}

#[wasm_bindgen(js_name = urdfCandidates)]
pub fn urdf_candidates(paths: Vec<String>) -> Vec<String> {
    project_core::urdf_candidates(paths.iter())
}

#[wasm_bindgen(js_name = resolveMesh)]
pub fn resolve_mesh(urdf_path: &str, filename: &str, paths: Vec<String>) -> Option<String> {
    project_core::resolve_mesh(urdf_path, filename, &paths)
}

#[wasm_bindgen(js_name = objMtllibs)]
pub fn obj_mtllibs(text: &str) -> Vec<String> {
    io::obj_mtllibs(text)
}

#[wasm_bindgen(js_name = siblingReference)]
pub fn sibling_reference(reference: &str, new_basename: &str) -> String {
    project_core::sibling_reference(reference, new_basename)
}
