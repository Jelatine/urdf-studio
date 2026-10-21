//! GPU-ready buffers for displaying a mesh and its selection state.

use crate::triangulate::triangulate_polygon;
use crate::Mesh;
use glam::DVec3;

#[derive(Default, Clone)]
pub struct RenderBuffers {
    /// Flat-shaded triangles: 9 floats per triangle.
    pub tri_pos: Vec<f32>,
    pub tri_nrm: Vec<f32>,
    /// Source face of each triangle.
    pub tri_face: Vec<u32>,
    /// Line segments: 6 floats per visible edge.
    pub edge_pos: Vec<f32>,
    pub edge_ids: Vec<u32>,
    /// Points: 3 floats per visible vertex.
    pub vert_pos: Vec<f32>,
    pub vert_ids: Vec<u32>,
    /// Face centers (3 floats per visible face) for face-dot display.
    pub face_center: Vec<f32>,
    pub face_ids: Vec<u32>,
}

fn push3(buf: &mut Vec<f32>, p: DVec3) {
    buf.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
}

impl Mesh {
    /// Builds display buffers. Hidden elements are skipped unless
    /// `include_hidden` (used for object mode).
    pub fn render_buffers(&self, include_hidden: bool) -> RenderBuffers {
        let mut b = RenderBuffers::default();
        for (fi, f) in self.faces.iter().enumerate() {
            if !f.alive || (f.hide && !include_hidden) {
                continue;
            }
            let pts: Vec<DVec3> = f.verts.iter().map(|&v| self.verts[v as usize].co).collect();
            let n = self.face_normal(fi as u32);
            for t in triangulate_polygon(&pts) {
                for &k in &t {
                    push3(&mut b.tri_pos, pts[k]);
                    push3(&mut b.tri_nrm, n);
                }
                b.tri_face.push(fi as u32);
            }
            push3(&mut b.face_center, self.face_center(fi as u32));
            b.face_ids.push(fi as u32);
        }
        for (ei, e) in self.edges.iter().enumerate() {
            if !e.alive || (e.hide && !include_hidden) {
                continue;
            }
            push3(&mut b.edge_pos, self.verts[e.v[0] as usize].co);
            push3(&mut b.edge_pos, self.verts[e.v[1] as usize].co);
            b.edge_ids.push(ei as u32);
        }
        for (vi, v) in self.verts.iter().enumerate() {
            if !v.alive || (v.hide && !include_hidden) {
                continue;
            }
            push3(&mut b.vert_pos, v.co);
            b.vert_ids.push(vi as u32);
        }
        b
    }

    /// Flat triangle positions of all live faces (object-mode display).
    pub fn triangle_positions(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for f in self.faces.iter().filter(|f| f.alive) {
            let pts: Vec<DVec3> = f.verts.iter().map(|&v| self.verts[v as usize].co).collect();
            for t in triangulate_polygon(&pts) {
                for &k in &t {
                    push3(&mut out, pts[k]);
                }
            }
        }
        out
    }

    /// Per-vertex position update without topology changes (used while
    /// dragging): returns positions in the same layout as `render_buffers`.
    pub fn positions_for(&self, b: &RenderBuffers) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let mut tri = Vec::with_capacity(b.tri_pos.len());
        let mut nrm = Vec::with_capacity(b.tri_nrm.len());
        let mut last_face = u32::MAX;
        for &f in &b.tri_face {
            if f == last_face {
                continue;
            }
            last_face = f;
            let face = &self.faces[f as usize];
            let pts: Vec<DVec3> = face.verts.iter().map(|&v| self.verts[v as usize].co).collect();
            let n = self.face_normal(f);
            for t in triangulate_polygon(&pts) {
                for &k in &t {
                    push3(&mut tri, pts[k]);
                    push3(&mut nrm, n);
                }
            }
        }
        let mut edges = Vec::with_capacity(b.edge_pos.len());
        for &e in &b.edge_ids {
            let ed = &self.edges[e as usize];
            push3(&mut edges, self.verts[ed.v[0] as usize].co);
            push3(&mut edges, self.verts[ed.v[1] as usize].co);
        }
        let mut verts = Vec::with_capacity(b.vert_pos.len());
        for &v in &b.vert_ids {
            push3(&mut verts, self.verts[v as usize].co);
        }
        (tri, nrm, edges, verts)
    }
}
