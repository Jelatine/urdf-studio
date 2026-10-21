//! A BMesh-style polygon mesh kernel.
//!
//! Vertices, edges and faces are stored in flat vectors addressed by `u32`
//! indices. Destructive operators mark elements dead and finish with
//! [`Mesh::compact`], so outside of an operator every index is dense and valid.
//! Faces are n-gons (ordered vertex loops); non-manifold geometry is allowed.

pub mod command;
pub mod editor;
pub mod io;
pub mod ops;
pub mod pick;
pub mod primitives;
pub mod render;
pub mod select;
pub mod triangulate;

use glam::DVec3;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use editor::Editor;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectMode {
    #[default]
    Vert,
    Edge,
    Face,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElemKind {
    Vert,
    Edge,
    Face,
}

impl From<SelectMode> for ElemKind {
    fn from(m: SelectMode) -> Self {
        match m {
            SelectMode::Vert => ElemKind::Vert,
            SelectMode::Edge => ElemKind::Edge,
            SelectMode::Face => ElemKind::Face,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Vert {
    pub co: DVec3,
    pub sel: bool,
    pub hide: bool,
    pub alive: bool,
    pub edges: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Edge {
    pub v: [u32; 2],
    pub sel: bool,
    pub hide: bool,
    pub alive: bool,
    pub faces: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Face {
    pub verts: Vec<u32>,
    pub edges: Vec<u32>,
    pub sel: bool,
    pub hide: bool,
    pub alive: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub verts: Vec<Vert>,
    pub edges: Vec<Edge>,
    pub faces: Vec<Face>,
    edge_map: HashMap<(u32, u32), u32>,
    pub select_mode: SelectMode,
    /// Active element (index in the current select mode), used by
    /// shortest-path selection and "merge at first/last".
    pub active: Option<u32>,
    /// Previously active element, i.e. the one picked before `active`.
    pub prev_active: Option<u32>,
}

#[inline]
fn ekey(a: u32, b: u32) -> (u32, u32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

impl Mesh {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a mesh from positions and polygons. Invalid polygons are skipped.
    pub fn from_polys(positions: &[DVec3], polys: &[Vec<u32>]) -> Self {
        let mut m = Mesh::new();
        for p in positions {
            m.add_vert(*p);
        }
        for poly in polys {
            m.add_face(poly);
        }
        m
    }

    /// Builds a mesh from a triangle soup, welding vertices whose positions
    /// are closer than `weld_eps` (exact match when `weld_eps <= 0`).
    pub fn from_triangles(positions: &[f32], indices: Option<&[u32]>, weld_eps: f64) -> Self {
        let n = positions.len() / 3;
        let raw: Vec<DVec3> = (0..n)
            .map(|i| {
                DVec3::new(
                    positions[i * 3] as f64,
                    positions[i * 3 + 1] as f64,
                    positions[i * 3 + 2] as f64,
                )
            })
            .collect();
        let (pos, remap) = weld_positions(&raw, weld_eps);
        let tris: Vec<Vec<u32>> = match indices {
            Some(idx) => idx
                .chunks_exact(3)
                .map(|t| vec![remap[t[0] as usize], remap[t[1] as usize], remap[t[2] as usize]])
                .collect(),
            None => (0..n / 3)
                .map(|t| vec![remap[t * 3], remap[t * 3 + 1], remap[t * 3 + 2]])
                .collect(),
        };
        let mut m = Mesh::from_polys(&pos, &tris);
        // Drop vertices that only belonged to degenerate triangles.
        for v in 0..m.verts.len() {
            if m.verts[v].edges.is_empty() {
                m.verts[v].alive = false;
            }
        }
        m.compact();
        m
    }

    pub fn add_vert(&mut self, co: DVec3) -> u32 {
        self.verts.push(Vert { co, sel: false, hide: false, alive: true, edges: Vec::new() });
        (self.verts.len() - 1) as u32
    }

    pub fn find_edge(&self, a: u32, b: u32) -> Option<u32> {
        self.edge_map.get(&ekey(a, b)).copied()
    }

    /// Returns the edge between `a` and `b`, creating it when missing.
    pub fn add_edge(&mut self, a: u32, b: u32) -> u32 {
        debug_assert!(a != b);
        if let Some(e) = self.find_edge(a, b) {
            return e;
        }
        let e = self.edges.len() as u32;
        self.edges.push(Edge { v: [a, b], sel: false, hide: false, alive: true, faces: Vec::new() });
        self.edge_map.insert(ekey(a, b), e);
        self.verts[a as usize].edges.push(e);
        self.verts[b as usize].edges.push(e);
        e
    }

    /// Adds a polygon. Consecutive duplicates are removed; returns `None` for
    /// degenerate loops, loops that revisit a vertex, or exact duplicates of
    /// an existing face.
    pub fn add_face(&mut self, vs: &[u32]) -> Option<u32> {
        let mut loop_: Vec<u32> = Vec::with_capacity(vs.len());
        for &v in vs {
            if loop_.last() != Some(&v) {
                loop_.push(v);
            }
        }
        while loop_.len() > 1 && loop_.first() == loop_.last() {
            loop_.pop();
        }
        if loop_.len() < 3 {
            return None;
        }
        {
            let mut sorted = loop_.clone();
            sorted.sort_unstable();
            if sorted.windows(2).any(|w| w[0] == w[1]) {
                return None;
            }
            if sorted.iter().any(|&v| v as usize >= self.verts.len() || !self.verts[v as usize].alive) {
                return None;
            }
            if let Some(e) = self.find_edge(loop_[0], loop_[1]) {
                for &f in &self.edges[e as usize].faces {
                    let mut other = self.faces[f as usize].verts.clone();
                    other.sort_unstable();
                    if other == sorted {
                        return None;
                    }
                }
            }
        }
        let f = self.faces.len() as u32;
        let n = loop_.len();
        let mut edges = Vec::with_capacity(n);
        for i in 0..n {
            let e = self.add_edge(loop_[i], loop_[(i + 1) % n]);
            self.edges[e as usize].faces.push(f);
            edges.push(e);
        }
        self.faces.push(Face { verts: loop_, edges, sel: false, hide: false, alive: true });
        Some(f)
    }

    pub fn kill_face(&mut self, f: u32) {
        if !self.faces[f as usize].alive {
            return;
        }
        self.faces[f as usize].alive = false;
        let edges = std::mem::take(&mut self.faces[f as usize].edges);
        for e in &edges {
            self.edges[*e as usize].faces.retain(|&x| x != f);
        }
        self.faces[f as usize].edges = edges;
    }

    pub fn kill_edge(&mut self, e: u32) {
        if !self.edges[e as usize].alive {
            return;
        }
        let faces = self.edges[e as usize].faces.clone();
        for f in faces {
            self.kill_face(f);
        }
        let [a, b] = self.edges[e as usize].v;
        self.edges[e as usize].alive = false;
        self.edge_map.remove(&ekey(a, b));
        self.verts[a as usize].edges.retain(|&x| x != e);
        self.verts[b as usize].edges.retain(|&x| x != e);
    }

    pub fn kill_vert(&mut self, v: u32) {
        if !self.verts[v as usize].alive {
            return;
        }
        let edges = self.verts[v as usize].edges.clone();
        for e in edges {
            self.kill_edge(e);
        }
        self.verts[v as usize].alive = false;
    }

    /// Removes dead elements and renumbers everything densely.
    pub fn compact(&mut self) {
        let mut m = Mesh { select_mode: self.select_mode, ..Default::default() };
        let mut vmap = vec![u32::MAX; self.verts.len()];
        for (i, v) in self.verts.iter().enumerate() {
            if v.alive {
                let nv = m.add_vert(v.co);
                m.verts[nv as usize].sel = v.sel;
                m.verts[nv as usize].hide = v.hide;
                vmap[i] = nv;
            }
        }
        let mut emap = vec![u32::MAX; self.edges.len()];
        for (i, e) in self.edges.iter().enumerate() {
            if e.alive && vmap[e.v[0] as usize] != u32::MAX && vmap[e.v[1] as usize] != u32::MAX {
                let ne = m.add_edge(vmap[e.v[0] as usize], vmap[e.v[1] as usize]);
                m.edges[ne as usize].sel = e.sel;
                m.edges[ne as usize].hide = e.hide;
                emap[i] = ne;
            }
        }
        let mut fmap = vec![u32::MAX; self.faces.len()];
        for (i, f) in self.faces.iter().enumerate() {
            if !f.alive {
                continue;
            }
            let vs: Vec<u32> = f.verts.iter().map(|&v| vmap[v as usize]).collect();
            if vs.iter().any(|&v| v == u32::MAX) {
                continue;
            }
            if let Some(nf) = m.add_face(&vs) {
                m.faces[nf as usize].sel = f.sel;
                m.faces[nf as usize].hide = f.hide;
                fmap[i] = nf;
            }
        }
        let map_active = |a: Option<u32>| -> Option<u32> {
            let a = a? as usize;
            let map = match self.select_mode {
                SelectMode::Vert => &vmap,
                SelectMode::Edge => &emap,
                SelectMode::Face => &fmap,
            };
            map.get(a).copied().filter(|&x| x != u32::MAX)
        };
        m.active = map_active(self.active);
        m.prev_active = map_active(self.prev_active);
        *self = m;
    }

    pub fn other_vert(&self, e: u32, v: u32) -> u32 {
        let ed = &self.edges[e as usize];
        if ed.v[0] == v {
            ed.v[1]
        } else {
            ed.v[0]
        }
    }

    /// Faces around a vertex (deduplicated).
    pub fn vert_faces(&self, v: u32) -> Vec<u32> {
        let mut out = Vec::new();
        for &e in &self.verts[v as usize].edges {
            for &f in &self.edges[e as usize].faces {
                if !out.contains(&f) {
                    out.push(f);
                }
            }
        }
        out
    }

    /// Faces sharing an edge with `f`.
    pub fn face_neighbors(&self, f: u32) -> Vec<u32> {
        let mut out = Vec::new();
        for &e in &self.faces[f as usize].edges {
            for &g in &self.edges[e as usize].faces {
                if g != f && !out.contains(&g) {
                    out.push(g);
                }
            }
        }
        out
    }

    /// Newell normal of a face (normalized; zero for degenerate faces).
    pub fn face_normal(&self, f: u32) -> DVec3 {
        let vs = &self.faces[f as usize].verts;
        newell(vs.iter().map(|&v| self.verts[v as usize].co))
    }

    pub fn face_center(&self, f: u32) -> DVec3 {
        let vs = &self.faces[f as usize].verts;
        vs.iter().map(|&v| self.verts[v as usize].co).sum::<DVec3>() / vs.len() as f64
    }

    pub fn face_area(&self, f: u32) -> f64 {
        let vs = &self.faces[f as usize].verts;
        let mut acc = DVec3::ZERO;
        let n = vs.len();
        for i in 0..n {
            acc += self.verts[vs[i] as usize].co.cross(self.verts[vs[(i + 1) % n] as usize].co);
        }
        acc.length() * 0.5
    }

    pub fn face_perimeter(&self, f: u32) -> f64 {
        self.faces[f as usize].edges.iter().map(|&e| self.edge_length(e)).sum()
    }

    pub fn edge_length(&self, e: u32) -> f64 {
        let [a, b] = self.edges[e as usize].v;
        self.verts[a as usize].co.distance(self.verts[b as usize].co)
    }

    pub fn vert_normal(&self, v: u32) -> DVec3 {
        let n: DVec3 = self.vert_faces(v).iter().map(|&f| self.face_normal(f)).sum();
        n.normalize_or_zero()
    }

    /// Whether `a -> b` appears as a directed edge in face `f`.
    pub fn face_has_directed(&self, f: u32, a: u32, b: u32) -> bool {
        let vs = &self.faces[f as usize].verts;
        let n = vs.len();
        (0..n).any(|i| vs[i] == a && vs[(i + 1) % n] == b)
    }

    pub fn live_counts(&self) -> (usize, usize, usize) {
        (
            self.verts.iter().filter(|v| v.alive).count(),
            self.edges.iter().filter(|e| e.alive).count(),
            self.faces.iter().filter(|f| f.alive).count(),
        )
    }

    pub fn selected_counts(&self) -> (usize, usize, usize) {
        (
            self.verts.iter().filter(|v| v.alive && v.sel).count(),
            self.edges.iter().filter(|e| e.alive && e.sel).count(),
            self.faces.iter().filter(|f| f.alive && f.sel).count(),
        )
    }

    pub fn selected_verts(&self) -> Vec<u32> {
        (0..self.verts.len() as u32).filter(|&v| self.verts[v as usize].alive && self.verts[v as usize].sel).collect()
    }

    pub fn selected_edges(&self) -> Vec<u32> {
        (0..self.edges.len() as u32).filter(|&e| self.edges[e as usize].alive && self.edges[e as usize].sel).collect()
    }

    pub fn selected_faces(&self) -> Vec<u32> {
        (0..self.faces.len() as u32).filter(|&f| self.faces[f as usize].alive && self.faces[f as usize].sel).collect()
    }

    /// Reverses the winding of face `f`.
    pub fn reverse_face(&mut self, f: u32) {
        let face = &mut self.faces[f as usize];
        face.verts.reverse();
        // edges[i] connects verts[i]..verts[i+1]; after reversing the vertex
        // loop, rebuild the edge list to keep that invariant.
        let n = face.verts.len();
        let vs = face.verts.clone();
        let mut edges = Vec::with_capacity(n);
        for i in 0..n {
            edges.push(self.edge_map[&ekey(vs[i], vs[(i + 1) % n])]);
        }
        self.faces[f as usize].edges = edges;
    }

    /// Euler characteristic V - E + F of the live mesh.
    pub fn euler(&self) -> i64 {
        let (v, e, f) = self.live_counts();
        v as i64 - e as i64 + f as i64
    }

    /// Bounding box of all live vertices.
    pub fn bounds(&self) -> Option<(DVec3, DVec3)> {
        let mut it = self.verts.iter().filter(|v| v.alive).map(|v| v.co);
        let first = it.next()?;
        Some(it.fold((first, first), |(lo, hi), p| (lo.min(p), hi.max(p))))
    }

    /// Asserts internal consistency (used by tests).
    pub fn validate(&self) -> Result<(), String> {
        for (fi, f) in self.faces.iter().enumerate() {
            if !f.alive {
                continue;
            }
            let n = f.verts.len();
            if n < 3 || f.edges.len() != n {
                return Err(format!("face {fi} has bad loop"));
            }
            for i in 0..n {
                let e = f.edges[i];
                let ed = &self.edges[e as usize];
                if !ed.alive || ekey(ed.v[0], ed.v[1]) != ekey(f.verts[i], f.verts[(i + 1) % n]) {
                    return Err(format!("face {fi} edge {i} mismatch"));
                }
                if !ed.faces.contains(&(fi as u32)) {
                    return Err(format!("edge {e} missing face {fi}"));
                }
            }
        }
        for (ei, e) in self.edges.iter().enumerate() {
            if !e.alive {
                continue;
            }
            for v in e.v {
                if !self.verts[v as usize].alive || !self.verts[v as usize].edges.contains(&(ei as u32)) {
                    return Err(format!("edge {ei} vert link broken"));
                }
            }
            if self.edge_map.get(&ekey(e.v[0], e.v[1])) != Some(&(ei as u32)) {
                return Err(format!("edge {ei} not in map"));
            }
            for &f in &e.faces {
                if !self.faces[f as usize].alive {
                    return Err(format!("edge {ei} links dead face {f}"));
                }
            }
        }
        Ok(())
    }
}

/// Newell's method; robust for non-planar and concave polygons.
pub fn newell(pts: impl Iterator<Item = DVec3> + Clone) -> DVec3 {
    let v: Vec<DVec3> = pts.collect();
    let n = v.len();
    let mut nrm = DVec3::ZERO;
    for i in 0..n {
        let a = v[i];
        let b = v[(i + 1) % n];
        nrm.x += (a.y - b.y) * (a.z + b.z);
        nrm.y += (a.z - b.z) * (a.x + b.x);
        nrm.z += (a.x - b.x) * (a.y + b.y);
    }
    nrm.normalize_or_zero()
}

/// Welds positions within `eps` using a spatial hash. Returns unique
/// positions and an index remap.
pub fn weld_positions(pts: &[DVec3], eps: f64) -> (Vec<DVec3>, Vec<u32>) {
    let mut out: Vec<DVec3> = Vec::new();
    let mut remap = Vec::with_capacity(pts.len());
    if eps <= 0.0 {
        let mut map: HashMap<[u64; 3], u32> = HashMap::new();
        for p in pts {
            let key = [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()];
            let id = *map.entry(key).or_insert_with(|| {
                out.push(*p);
                (out.len() - 1) as u32
            });
            remap.push(id);
        }
        return (out, remap);
    }
    let cell = eps * 2.0;
    let key = |p: DVec3| -> (i64, i64, i64) {
        ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64, (p.z / cell).floor() as i64)
    };
    let mut grid: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
    for p in pts {
        let k = key(*p);
        let mut found = None;
        'search: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = grid.get(&(k.0 + dx, k.1 + dy, k.2 + dz)) {
                        for &id in list {
                            if out[id as usize].distance(*p) <= eps {
                                found = Some(id);
                                break 'search;
                            }
                        }
                    }
                }
            }
        }
        let id = found.unwrap_or_else(|| {
            out.push(*p);
            let id = (out.len() - 1) as u32;
            grid.entry(k).or_default().push(id);
            id
        });
        remap.push(id);
    }
    (out, remap)
}

#[cfg(test)]
pub(crate) mod test_util {
    use super::*;
    pub fn cube() -> Mesh {
        primitives::cube(1.0)
    }
    pub fn grid(n: usize) -> Mesh {
        primitives::grid(n, n, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cube_topology() {
        let m = test_util::cube();
        assert_eq!(m.live_counts(), (8, 12, 6));
        assert_eq!(m.euler(), 2);
        m.validate().unwrap();
    }

    #[test]
    fn from_triangles_welds() {
        // Two triangles sharing an edge but with duplicated vertices.
        let pos = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0.];
        let m = Mesh::from_triangles(&pos, None, 0.0);
        assert_eq!(m.live_counts(), (4, 5, 2));
    }

    #[test]
    fn kill_and_compact() {
        let mut m = test_util::cube();
        m.kill_vert(0);
        m.compact();
        assert_eq!(m.live_counts(), (7, 9, 3));
        m.validate().unwrap();
    }

    #[test]
    fn reject_duplicate_face() {
        let mut m = Mesh::new();
        for p in [DVec3::ZERO, DVec3::X, DVec3::Y] {
            m.add_vert(p);
        }
        assert!(m.add_face(&[0, 1, 2]).is_some());
        assert!(m.add_face(&[2, 1, 0]).is_none());
        assert!(m.add_face(&[0, 1, 1]).is_none());
    }
}
