//! Topology-changing mesh operators (delete, dissolve, extrude, inset,
//! subdivide, merge, split, separate, bridge, loop cut, bisect, ...).
//!
//! Every public operator leaves the mesh compacted and the selection flushed.

use crate::triangulate::triangulate_polygon;
use crate::{Mesh, SelectMode};
use glam::{DMat4, DVec3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum OpError {
    #[error("nothing selected")]
    NothingSelected,
    #[error("{0}")]
    Invalid(String),
}

pub type OpResult<T = ()> = Result<T, OpError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteKind {
    Verts,
    Edges,
    Faces,
    OnlyEdgesFaces,
    OnlyFaces,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeKind {
    Center,
    Cursor,
    Collapse,
    First,
    Last,
}

/// Appends `other` translated by `offset`; returns the new vertex ids.
pub fn append(m: &mut Mesh, other: &Mesh, offset: DVec3) -> Vec<u32> {
    let mut vmap = vec![u32::MAX; other.verts.len()];
    let mut out = Vec::new();
    for (i, v) in other.verts.iter().enumerate() {
        if v.alive {
            vmap[i] = m.add_vert(v.co + offset);
            out.push(vmap[i]);
        }
    }
    for e in other.edges.iter().filter(|e| e.alive) {
        m.add_edge(vmap[e.v[0] as usize], vmap[e.v[1] as usize]);
    }
    for f in other.faces.iter().filter(|f| f.alive) {
        let vs: Vec<u32> = f.verts.iter().map(|&v| vmap[v as usize]).collect();
        m.add_face(&vs);
    }
    out
}

/// Triangulates every face (helper for tests and exporters).
pub fn triangulate_all(m: &mut Mesh) {
    for f in m.faces.iter_mut() {
        f.sel = f.alive;
    }
    let _ = m.triangulate_selected(); // empty mesh: nothing to do
    for f in m.faces.iter_mut() {
        f.sel = false;
    }
    m.flush_select();
}

struct FaceFlags {
    sel: bool,
    hide: bool,
    mat: u32,
}

impl Mesh {
    fn face_flags(&self, f: u32) -> FaceFlags {
        let face = &self.faces[f as usize];
        FaceFlags { sel: face.sel, hide: face.hide, mat: face.mat }
    }

    fn add_face_flags(&mut self, vs: &[u32], fl: &FaceFlags) -> Option<u32> {
        let nf = self.add_face_mat(vs, fl.mat)?;
        self.faces[nf as usize].sel = fl.sel;
        self.faces[nf as usize].hide = fl.hide;
        Some(nf)
    }

    /// Replaces face `f` with a new loop, keeping its flags.
    fn replace_face(&mut self, f: u32, vs: &[u32]) -> Option<u32> {
        let fl = self.face_flags(f);
        let old = self.faces[f as usize].verts.clone();
        self.kill_face(f);
        match self.add_face_flags(vs, &fl) {
            Some(nf) => Some(nf),
            None => {
                self.add_face_flags(&old, &fl);
                None
            }
        }
    }

    fn finish(&mut self) {
        self.compact();
        self.flush_select();
    }

    fn kill_faceless_edges(&mut self, edges: impl IntoIterator<Item = u32>) {
        for e in edges {
            if self.edges[e as usize].alive && self.edges[e as usize].faces.is_empty() {
                self.kill_edge(e);
            }
        }
    }

    fn kill_edgeless_verts(&mut self, verts: impl IntoIterator<Item = u32>) {
        for v in verts {
            if self.verts[v as usize].alive && self.verts[v as usize].edges.is_empty() {
                self.kill_vert(v);
            }
        }
    }

    /// Delete-faces semantics: removes selected faces, then selected edges
    /// and vertices that are no longer used.
    fn delete_selected_faces_context(&mut self, faces: &[u32], edges: &[u32], verts: &[u32]) {
        for &f in faces {
            self.kill_face(f);
        }
        self.kill_faceless_edges(edges.iter().copied());
        self.kill_edgeless_verts(verts.iter().copied());
    }

    // --------------------------------------------------------------- delete

    pub fn delete(&mut self, kind: DeleteKind) -> OpResult {
        let (sv, se, sf) = (self.selected_verts(), self.selected_edges(), self.selected_faces());
        if sv.is_empty() && se.is_empty() && sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        match kind {
            DeleteKind::Verts => sv.iter().for_each(|&v| self.kill_vert(v)),
            DeleteKind::Edges => {
                se.iter().for_each(|&e| self.kill_edge(e));
                self.kill_edgeless_verts(sv);
            }
            DeleteKind::Faces => self.delete_selected_faces_context(&sf, &se, &sv),
            DeleteKind::OnlyEdgesFaces => {
                se.iter().for_each(|&e| self.kill_edge(e));
                sf.iter().for_each(|&f| self.kill_face(f));
            }
            DeleteKind::OnlyFaces => sf.iter().for_each(|&f| self.kill_face(f)),
        }
        self.active = None;
        self.finish();
        Ok(())
    }

    // -------------------------------------------------------------- dissolve

    /// Merges a connected face region into one n-gon. Fails for regions with
    /// holes or non-manifold boundaries.
    fn merge_face_region(&mut self, region: &[u32]) -> Option<u32> {
        if region.len() < 2 {
            return region.first().copied();
        }
        let in_region: HashSet<u32> = region.iter().copied().collect();
        let mut next: HashMap<u32, u32> = HashMap::new();
        let mut region_edges = HashSet::new();
        let mut region_verts = HashSet::new();
        for &f in region {
            let face = &self.faces[f as usize];
            let n = face.verts.len();
            for i in 0..n {
                let e = face.edges[i];
                region_edges.insert(e);
                region_verts.insert(face.verts[i]);
                let cnt = self.edges[e as usize].faces.iter().filter(|g| in_region.contains(g)).count();
                if cnt == 1 {
                    let (a, b) = (face.verts[i], face.verts[(i + 1) % n]);
                    if next.insert(a, b).is_some() {
                        return None;
                    }
                }
            }
        }
        let start = *next.keys().next()?;
        let mut loop_ = vec![start];
        let mut cur = next[&start];
        while cur != start {
            loop_.push(cur);
            cur = *next.get(&cur)?;
            if loop_.len() > next.len() {
                return None;
            }
        }
        if loop_.len() != next.len() || loop_.len() < 3 {
            return None;
        }
        let sel = region.iter().any(|&f| self.faces[f as usize].sel);
        let mat = self.faces[region[0] as usize].mat;
        let saved: Vec<(Vec<u32>, FaceFlags)> =
            region.iter().map(|&f| (self.faces[f as usize].verts.clone(), self.face_flags(f))).collect();
        for &f in region {
            self.kill_face(f);
        }
        match self.add_face_mat(&loop_, mat) {
            Some(nf) => {
                self.faces[nf as usize].sel = sel;
                self.kill_faceless_edges(region_edges);
                self.kill_edgeless_verts(region_verts);
                Some(nf)
            }
            None => {
                for (vs, fl) in saved {
                    self.add_face_flags(&vs, &fl);
                }
                None
            }
        }
    }

    /// Removes a vertex that has exactly two edges, joining its neighbours.
    fn dissolve_valence2(&mut self, v: u32) -> bool {
        let vert = &self.verts[v as usize];
        if !vert.alive || vert.edges.len() != 2 {
            return false;
        }
        let a = self.other_vert(vert.edges[0], v);
        let b = self.other_vert(vert.edges[1], v);
        let wire = self.edges[vert.edges[0] as usize].faces.is_empty() && self.edges[vert.edges[1] as usize].faces.is_empty();
        let sel = self.edges[vert.edges[0] as usize].sel || self.edges[vert.edges[1] as usize].sel;
        for f in self.vert_faces(v) {
            let vs: Vec<u32> = self.faces[f as usize].verts.iter().copied().filter(|&x| x != v).collect();
            if vs.len() < 3 {
                self.kill_face(f);
            } else if self.replace_face(f, &vs).is_none() {
                self.kill_face(f);
            }
        }
        self.kill_vert(v);
        if wire && a != b {
            let e = self.add_edge(a, b);
            self.edges[e as usize].sel = sel;
        }
        true
    }

    fn face_regions(&self, faces: &[u32], connect: impl Fn(u32) -> bool) -> Vec<Vec<u32>> {
        let set: HashSet<u32> = faces.iter().copied().collect();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &f in faces {
            if !seen.insert(f) {
                continue;
            }
            let mut region = vec![];
            let mut q = VecDeque::from([f]);
            while let Some(x) = q.pop_front() {
                region.push(x);
                for &e in &self.faces[x as usize].edges {
                    if !connect(e) {
                        continue;
                    }
                    for &g in &self.edges[e as usize].faces {
                        if set.contains(&g) && seen.insert(g) {
                            q.push_back(g);
                        }
                    }
                }
            }
            out.push(region);
        }
        out
    }

    pub fn dissolve_faces(&mut self) -> OpResult<usize> {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let regions = self.face_regions(&sf, |_| true);
        let mut merged = 0;
        for r in regions {
            if r.len() > 1 && self.merge_face_region(&r).is_some() {
                merged += 1;
            }
        }
        self.finish();
        Ok(merged)
    }

    pub fn dissolve_edges(&mut self) -> OpResult<usize> {
        let se: HashSet<u32> = self.selected_edges().into_iter().collect();
        if se.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let mut touched_verts = HashSet::new();
        let mut faces = HashSet::new();
        for &e in &se {
            let ed = &self.edges[e as usize];
            if ed.faces.len() == 2 {
                faces.extend(ed.faces.iter().copied());
                touched_verts.extend(ed.v);
            }
        }
        let faces: Vec<u32> = faces.into_iter().collect();
        let regions = self.face_regions(&faces, |e| se.contains(&e) && self.edges[e as usize].faces.len() == 2);
        let mut merged = 0;
        for r in regions {
            if r.len() > 1 && self.merge_face_region(&r).is_some() {
                merged += 1;
            }
        }
        // Wire edges are removed outright.
        for &e in &se {
            if self.edges[e as usize].alive && self.edges[e as usize].faces.is_empty() {
                touched_verts.extend(self.edges[e as usize].v);
                self.kill_edge(e);
            }
        }
        for v in touched_verts {
            if self.verts[v as usize].alive && self.verts[v as usize].edges.len() == 2 {
                let fs = self.vert_faces(v);
                if !fs.is_empty() {
                    self.dissolve_valence2(v);
                }
            }
        }
        for v in 0..self.verts.len() as u32 {
            if self.verts[v as usize].alive && self.verts[v as usize].sel && self.verts[v as usize].edges.is_empty() {
                self.kill_vert(v);
            }
        }
        self.finish();
        Ok(merged)
    }

    pub fn dissolve_verts(&mut self) -> OpResult<usize> {
        let sv = self.selected_verts();
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let mut n = 0;
        for v in sv {
            if !self.verts[v as usize].alive {
                continue;
            }
            if self.verts[v as usize].edges.len() == 2 {
                if self.dissolve_valence2(v) {
                    n += 1;
                }
                continue;
            }
            let fan = self.vert_faces(v);
            if fan.is_empty() {
                self.kill_vert(v);
                n += 1;
                continue;
            }
            if self.merge_face_region(&fan).is_some() {
                n += 1;
                if self.verts[v as usize].alive && self.verts[v as usize].edges.len() == 2 {
                    self.dissolve_valence2(v);
                }
            }
        }
        self.finish();
        Ok(n)
    }

    /// Limited Dissolve: merges adjacent selected faces whose normals differ
    /// by less than `angle`, then removes redundant colinear boundary verts.
    pub fn dissolve_limited(&mut self, angle: f64) -> OpResult<usize> {
        let mut sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        sf.sort_unstable();
        let cos_t = angle.cos() - 1e-9;
        let normals: HashMap<u32, DVec3> = sf.iter().map(|&f| (f, self.face_normal(f))).collect();
        let set: HashSet<u32> = sf.iter().copied().collect();
        let mut seen = HashSet::new();
        let mut regions = Vec::new();
        for &f in &sf {
            if !seen.insert(f) {
                continue;
            }
            let mut region = vec![];
            let mut q = VecDeque::from([f]);
            while let Some(x) = q.pop_front() {
                region.push(x);
                for &e in &self.faces[x as usize].edges {
                    if self.edges[e as usize].faces.len() != 2 {
                        continue;
                    }
                    for &g in &self.edges[e as usize].faces {
                        if set.contains(&g) && !seen.contains(&g) && normals[&x].dot(normals[&g]) >= cos_t {
                            seen.insert(g);
                            q.push_back(g);
                        }
                    }
                }
            }
            regions.push(region);
        }
        let mut verts = HashSet::new();
        let mut merged = 0;
        for r in regions {
            for &f in &r {
                verts.extend(self.faces[f as usize].verts.iter().copied());
            }
            if r.len() > 1 && self.merge_face_region(&r).is_some() {
                merged += 1;
            }
        }
        for v in verts {
            let vert = &self.verts[v as usize];
            if !vert.alive || vert.edges.len() != 2 {
                continue;
            }
            let a = self.verts[self.other_vert(vert.edges[0], v) as usize].co;
            let b = self.verts[self.other_vert(vert.edges[1], v) as usize].co;
            let d1 = (vert.co - a).normalize_or_zero();
            let d2 = (b - vert.co).normalize_or_zero();
            if d1.dot(d2) >= cos_t {
                self.dissolve_valence2(v);
            }
        }
        self.finish();
        Ok(merged)
    }

    // ------------------------------------------------- duplicate/split/separate

    /// Copies selected geometry. Returns old->new vertex map. Originals are
    /// deselected and the copies selected.
    fn duplicate_raw(&mut self) -> HashMap<u32, u32> {
        let sv = self.selected_verts();
        let se = self.selected_edges();
        let sf = self.selected_faces();
        let mut vmap = HashMap::new();
        for &v in &sv {
            let nv = self.add_vert(self.verts[v as usize].co);
            vmap.insert(v, nv);
        }
        let mut new_edges = vec![];
        for &e in &se {
            let [a, b] = self.edges[e as usize].v;
            new_edges.push(self.add_edge(vmap[&a], vmap[&b]));
        }
        let mut new_faces = vec![];
        for &f in &sf {
            let vs: Vec<u32> = self.faces[f as usize].verts.iter().map(|v| vmap[v]).collect();
            if let Some(nf) = self.add_face_mat(&vs, self.faces[f as usize].mat) {
                new_faces.push(nf);
            }
        }
        for &v in &sv {
            self.verts[v as usize].sel = false;
        }
        for &e in &se {
            self.edges[e as usize].sel = false;
        }
        for &f in &sf {
            self.faces[f as usize].sel = false;
        }
        for &nv in vmap.values() {
            self.verts[nv as usize].sel = true;
        }
        for e in new_edges {
            self.edges[e as usize].sel = true;
        }
        for f in new_faces {
            self.faces[f as usize].sel = true;
        }
        vmap
    }

    /// Duplicate (Shift+D).
    pub fn duplicate(&mut self) -> OpResult {
        if self.selected_verts().is_empty() {
            return Err(OpError::NothingSelected);
        }
        self.duplicate_raw();
        self.active = None;
        self.finish();
        Ok(())
    }

    /// Split (Y): disconnects the selection from the rest of the mesh.
    pub fn split(&mut self) -> OpResult {
        let (sv, se, sf) = (self.selected_verts(), self.selected_edges(), self.selected_faces());
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        self.duplicate_raw();
        self.delete_selected_faces_context(&sf, &se, &sv);
        self.active = None;
        self.finish();
        Ok(())
    }

    /// Separate (P): removes the selection and returns it as a new mesh.
    pub fn separate(&mut self) -> OpResult<Mesh> {
        let (sv, se, sf) = (self.selected_verts(), self.selected_edges(), self.selected_faces());
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let mut out = Mesh { select_mode: self.select_mode, materials: self.materials.clone(), ..Default::default() };
        let mut vmap = HashMap::new();
        for &v in &sv {
            vmap.insert(v, out.add_vert(self.verts[v as usize].co));
        }
        for &e in &se {
            let [a, b] = self.edges[e as usize].v;
            out.add_edge(vmap[&a], vmap[&b]);
        }
        for &f in &sf {
            let vs: Vec<u32> = self.faces[f as usize].verts.iter().map(|v| vmap[v]).collect();
            out.add_face_mat(&vs, self.faces[f as usize].mat);
        }
        self.delete_selected_faces_context(&sf, &se, &sv);
        // Separated geometry that was only selected loosely (vertex mode)
        // still leaves the original vertex; remove selected wire-only leftovers.
        for &v in &sv {
            if self.verts[v as usize].alive && self.vert_faces(v).is_empty() {
                let edges = self.verts[v as usize].edges.clone();
                if edges.iter().all(|&e| self.edges[e as usize].sel) {
                    self.kill_vert(v);
                }
            }
        }
        self.active = None;
        self.finish();
        out.compact();
        Ok(out)
    }

    // --------------------------------------------------------------- extrude

    /// Extrudes a face region; returns old->new vertex map and the new faces.
    fn extrude_faces(&mut self, region: &[u32]) -> (HashMap<u32, u32>, Vec<u32>) {
        let in_region: HashSet<u32> = region.iter().copied().collect();
        let mut vmap: HashMap<u32, u32> = HashMap::new();
        let mut boundary: Vec<(u32, u32, u32)> = Vec::new();
        let mut region_edges = HashSet::new();
        let mut polys = Vec::new();
        for &f in region {
            let face = &self.faces[f as usize];
            let n = face.verts.len();
            for i in 0..n {
                let e = face.edges[i];
                region_edges.insert(e);
                let cnt = self.edges[e as usize].faces.iter().filter(|g| in_region.contains(g)).count();
                if cnt == 1 {
                    boundary.push((face.verts[i], face.verts[(i + 1) % n], face.mat));
                }
            }
            polys.push((face.verts.clone(), self.face_flags(f)));
        }
        for (vs, _) in &polys {
            for &v in vs {
                if !vmap.contains_key(&v) {
                    let nv = self.add_vert(self.verts[v as usize].co);
                    vmap.insert(v, nv);
                }
            }
        }
        for &f in region {
            self.kill_face(f);
        }
        let mut new_faces = Vec::new();
        for (vs, fl) in &polys {
            let mapped: Vec<u32> = vs.iter().map(|v| vmap[v]).collect();
            if let Some(nf) = self.add_face_flags(&mapped, fl) {
                new_faces.push(nf);
            }
        }
        for (a, b, mat) in boundary {
            self.add_face_mat(&[a, b, vmap[&b], vmap[&a]], mat);
        }
        self.kill_faceless_edges(region_edges);
        let old: Vec<u32> = vmap.keys().copied().collect();
        self.kill_edgeless_verts(old);
        (vmap, new_faces)
    }

    /// Extrude (E). Extrudes the selected face region, plus selected wire
    /// edges and loose vertices. Returns the average normal of extruded faces
    /// (zero when only edges/verts were extruded) for constrained grabbing.
    pub fn extrude(&mut self) -> OpResult<DVec3> {
        let sf = self.selected_faces();
        let se = self.selected_edges();
        let sv = self.selected_verts();
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let face_verts: HashSet<u32> =
            sf.iter().flat_map(|&f| self.faces[f as usize].verts.iter().copied()).collect();
        let face_edges: HashSet<u32> =
            sf.iter().flat_map(|&f| self.faces[f as usize].edges.iter().copied()).collect();
        let lone_edges: Vec<u32> = se.iter().copied().filter(|e| !face_edges.contains(e)).collect();
        let edge_verts: HashSet<u32> = lone_edges.iter().flat_map(|&e| self.edges[e as usize].v).collect();
        let lone_verts: Vec<u32> =
            sv.iter().copied().filter(|v| !face_verts.contains(v) && !edge_verts.contains(v)).collect();

        let normal: DVec3 = sf.iter().map(|&f| self.face_normal(f) * self.face_area(f)).sum::<DVec3>().normalize_or_zero();

        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for f in self.faces.iter_mut() {
            f.sel = false;
        }

        let mut new_sel_verts = Vec::new();
        if !sf.is_empty() {
            let (vmap, _) = self.extrude_faces(&sf);
            new_sel_verts.extend(vmap.values().copied());
        }
        let mut emap: HashMap<u32, u32> = HashMap::new();
        for &e in &lone_edges {
            let [a, b] = self.edges[e as usize].v;
            for x in [a, b] {
                if !emap.contains_key(&x) {
                    let nv = self.add_vert(self.verts[x as usize].co);
                    emap.insert(x, nv);
                }
            }
            let (na, nb) = (emap[&a], emap[&b]);
            let f0 = self.edges[e as usize].faces.first().copied();
            let quad = match f0 {
                Some(f) if self.face_has_directed(f, a, b) => [b, a, na, nb],
                _ => [a, b, nb, na],
            };
            let mat = f0.map_or(0, |f| self.faces[f as usize].mat);
            self.add_face_mat(&quad, mat);
        }
        new_sel_verts.extend(emap.values().copied());
        for &v in &lone_verts {
            let nv = self.add_vert(self.verts[v as usize].co);
            self.add_edge(v, nv);
            new_sel_verts.push(nv);
        }
        for v in new_sel_verts {
            self.verts[v as usize].sel = true;
        }
        self.active = None;
        let mode = self.select_mode;
        self.compact();
        self.flush_from_verts();
        if mode != SelectMode::Vert {
            self.flush_select();
        }
        Ok(normal)
    }

    /// Extrude Individual Faces (Alt+E): each face is extruded along its own
    /// normal by `offset`.
    pub fn extrude_individual(&mut self, offset: f64) -> OpResult {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let normals: Vec<DVec3> = sf.iter().map(|&f| self.face_normal(f)).collect();
        for (i, &f) in sf.iter().enumerate() {
            let (vmap, _) = self.extrude_faces(&[f]);
            for &nv in vmap.values() {
                self.verts[nv as usize].co += normals[i] * offset;
            }
        }
        self.finish();
        Ok(())
    }

    // ----------------------------------------------------------------- inset

    /// Inset Faces (I). With `individual` each face is inset separately.
    pub fn inset(&mut self, thickness: f64, depth: f64, individual: bool) -> OpResult {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let regions: Vec<Vec<u32>> =
            if individual { sf.iter().map(|&f| vec![f]).collect() } else { self.face_regions(&sf, |_| true) };
        for region in regions {
            let in_region: HashSet<u32> = region.iter().copied().collect();
            let mut out_edge: HashMap<u32, u32> = HashMap::new();
            let mut in_edge: HashMap<u32, u32> = HashMap::new();
            let mut vnormal: HashMap<u32, DVec3> = HashMap::new();
            for &f in &region {
                let nrm = self.face_normal(f);
                let face = &self.faces[f as usize];
                let n = face.verts.len();
                for i in 0..n {
                    *vnormal.entry(face.verts[i]).or_insert(DVec3::ZERO) += nrm;
                    let cnt = self.edges[face.edges[i] as usize].faces.iter().filter(|g| in_region.contains(g)).count();
                    if cnt == 1 {
                        let (a, b) = (face.verts[i], face.verts[(i + 1) % n]);
                        out_edge.insert(a, b);
                        in_edge.insert(b, a);
                    }
                }
            }
            let mut offset: HashMap<u32, DVec3> = HashMap::new();
            for (&v, nrm) in vnormal.iter_mut() {
                *nrm = nrm.normalize_or_zero();
                let (Some(&p), Some(&nx)) = (in_edge.get(&v), out_edge.get(&v)) else { continue };
                let co = self.verts[v as usize].co;
                let d1 = (co - self.verts[p as usize].co).normalize_or_zero();
                let d2 = (self.verts[nx as usize].co - co).normalize_or_zero();
                let in1 = nrm.cross(d1).normalize_or_zero();
                let in2 = nrm.cross(d2).normalize_or_zero();
                let bis = (in1 + in2).try_normalize().unwrap_or(in1);
                let scale = 1.0 / bis.dot(in1).max(0.2);
                offset.insert(v, bis * thickness * scale);
            }
            let (vmap, _) = self.extrude_faces(&region);
            for (old, new) in vmap {
                let off = offset.get(&old).copied().unwrap_or(DVec3::ZERO);
                self.verts[new as usize].co += off + vnormal[&old] * depth;
            }
        }
        self.finish();
        Ok(())
    }

    // ------------------------------------------------------------------ fill

    /// Make Edge/Face (F). With `triangulate` the new faces are triangulated
    /// (Alt+F "fill").
    pub fn fill(&mut self, triangulate: bool) -> OpResult<usize> {
        let sv = self.selected_verts();
        let se: Vec<u32> =
            self.selected_edges().into_iter().filter(|&e| self.edges[e as usize].faces.len() <= 1).collect();
        if sv.len() < 2 {
            return Err(OpError::Invalid("select at least 2 vertices".into()));
        }
        let mut created = Vec::new();
        if sv.len() == 2 && se.is_empty() {
            if self.find_edge(sv[0], sv[1]).is_some() {
                return Err(OpError::Invalid("edge already exists".into()));
            }
            let e = self.add_edge(sv[0], sv[1]);
            self.edges[e as usize].sel = true;
            self.finish();
            return Ok(1);
        }
        let chains = if se.is_empty() { vec![] } else { edge_chains(self, &se) };
        if chains.is_empty() {
            // Loose vertex selection: order around the centroid.
            let pts: Vec<DVec3> = sv.iter().map(|&v| self.verts[v as usize].co).collect();
            let order = order_points_planar(&pts);
            let loop_: Vec<u32> = order.iter().map(|&i| sv[i]).collect();
            if let Some(f) = self.add_face_oriented(&loop_) {
                created.push(f);
            }
        } else {
            for (loop_, _closed) in chains {
                if loop_.len() < 3 {
                    continue;
                }
                if let Some(f) = self.add_face_oriented(&loop_) {
                    created.push(f);
                }
            }
        }
        if created.is_empty() {
            return Err(OpError::Invalid("could not create a face".into()));
        }
        for &f in &created {
            self.faces[f as usize].sel = true;
        }
        if triangulate {
            for f in self.faces.iter_mut() {
                f.sel = false;
            }
            for &f in &created {
                self.faces[f as usize].sel = true;
            }
            self.triangulate_faces(&created);
        }
        let n = created.len();
        self.add_face_sel_flush();
        self.finish();
        Ok(n)
    }

    /// Adds a face whose winding (and material) agrees with existing
    /// neighbouring faces.
    fn add_face_oriented(&mut self, loop_: &[u32]) -> Option<u32> {
        let n = loop_.len();
        let mut votes = 0i32;
        let mut mat = None;
        for i in 0..n {
            let (a, b) = (loop_[i], loop_[(i + 1) % n]);
            if let Some(e) = self.find_edge(a, b) {
                for &f in &self.edges[e as usize].faces {
                    mat.get_or_insert(self.faces[f as usize].mat);
                    if self.face_has_directed(f, a, b) {
                        votes -= 1;
                    } else {
                        votes += 1;
                    }
                }
            }
        }
        let mat = mat.unwrap_or(0);
        if votes < 0 {
            let mut r = loop_.to_vec();
            r.reverse();
            self.add_face_mat(&r, mat)
        } else {
            self.add_face_mat(loop_, mat)
        }
    }

    // ----------------------------------------------------------------- merge

    /// Rebuilds the mesh merging vertices according to `map` (v -> target).
    pub(crate) fn weld(&mut self, map: &HashMap<u32, u32>) {
        let resolve = |v: u32| -> u32 {
            let mut x = v;
            let mut guard = 0;
            while let Some(&t) = map.get(&x) {
                if t == x || guard > 64 {
                    break;
                }
                x = t;
                guard += 1;
            }
            x
        };
        let faces: Vec<(Vec<u32>, FaceFlags)> = (0..self.faces.len() as u32)
            .filter(|&f| self.faces[f as usize].alive)
            .map(|f| (self.faces[f as usize].verts.iter().map(|&v| resolve(v)).collect(), self.face_flags(f)))
            .collect();
        let edges: Vec<(u32, u32, bool, bool)> = self
            .edges
            .iter()
            .filter(|e| e.alive)
            .map(|e| (resolve(e.v[0]), resolve(e.v[1]), e.sel, e.hide))
            .collect();
        for f in 0..self.faces.len() as u32 {
            self.kill_face(f);
        }
        for e in 0..self.edges.len() as u32 {
            self.kill_edge(e);
        }
        for (&v, _) in map.iter() {
            if resolve(v) != v {
                self.verts[v as usize].alive = false;
            }
        }
        for (a, b, sel, hide) in edges {
            if a != b {
                let e = self.add_edge(a, b);
                self.edges[e as usize].sel |= sel;
                self.edges[e as usize].hide = hide;
            }
        }
        for (mut vs, fl) in faces {
            vs.dedup();
            while vs.len() > 1 && vs.first() == vs.last() {
                vs.pop();
            }
            if vs.len() >= 3 {
                self.add_face_flags(&vs, &fl);
            }
        }
    }

    /// Merge (M).
    pub fn merge(&mut self, kind: MergeKind, cursor: DVec3) -> OpResult<usize> {
        let sv = self.selected_verts();
        if sv.len() < 2 {
            return Err(OpError::Invalid("select at least 2 vertices".into()));
        }
        let groups: Vec<(Vec<u32>, DVec3)> = match kind {
            MergeKind::Center => {
                let c = self.selection_center().unwrap();
                vec![(sv.clone(), c)]
            }
            MergeKind::Cursor => vec![(sv.clone(), cursor)],
            MergeKind::Collapse => self
                .selected_islands()
                .into_iter()
                .map(|isl| {
                    let c = isl.iter().map(|&v| self.verts[v as usize].co).sum::<DVec3>() / isl.len() as f64;
                    (isl, c)
                })
                .collect(),
            MergeKind::First | MergeKind::Last => {
                if self.select_mode != SelectMode::Vert {
                    return Err(OpError::Invalid("merge at first/last needs vertex select mode".into()));
                }
                let pick = if kind == MergeKind::Last { self.active } else { self.prev_active.or(self.active) };
                let Some(t) = pick else {
                    return Err(OpError::Invalid("no active vertex".into()));
                };
                vec![(sv.clone(), self.verts[t as usize].co)]
            }
        };
        let mut map = HashMap::new();
        let mut removed = 0;
        for (group, target) in groups {
            if group.len() < 2 {
                continue;
            }
            let keep = group[0];
            self.verts[keep as usize].co = target;
            for &v in &group[1..] {
                map.insert(v, keep);
                removed += 1;
            }
        }
        self.weld(&map);
        self.active = None;
        self.prev_active = None;
        self.finish();
        Ok(removed)
    }

    /// Merge by Distance (Alt+M / "Remove Doubles"). Returns removed count.
    pub fn remove_doubles(&mut self, dist: f64) -> OpResult<usize> {
        let sv = self.selected_verts();
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let pts: Vec<DVec3> = sv.iter().map(|&v| self.verts[v as usize].co).collect();
        let (_, remap) = crate::weld_positions(&pts, dist.max(1e-12));
        let mut first_of: HashMap<u32, u32> = HashMap::new();
        let mut map = HashMap::new();
        for (i, &cluster) in remap.iter().enumerate() {
            match first_of.get(&cluster) {
                Some(&keep) => {
                    map.insert(sv[i], keep);
                }
                None => {
                    first_of.insert(cluster, sv[i]);
                }
            }
        }
        let n = map.len();
        if n > 0 {
            self.weld(&map);
            self.active = None;
        }
        self.finish();
        Ok(n)
    }

    // ------------------------------------------------------ edge insertion

    /// Inserts vertices along edges. `ins[e]` lists new vertices ordered from
    /// `edges[e].v[0]` to `v[1]`. Faces are rebuilt; returns old->new face map.
    fn insert_verts_on_edges(&mut self, ins: &HashMap<u32, Vec<u32>>) -> HashMap<u32, u32> {
        let mut faces: HashSet<u32> = HashSet::new();
        for &e in ins.keys() {
            faces.extend(self.edges[e as usize].faces.iter().copied());
        }
        let mut faces: Vec<u32> = faces.into_iter().collect();
        faces.sort_unstable();
        let mut fmap = HashMap::new();
        let mut rebuilt = Vec::new();
        for &f in &faces {
            let face = &self.faces[f as usize];
            let n = face.verts.len();
            let mut vs = Vec::with_capacity(n * 2);
            for i in 0..n {
                let v = face.verts[i];
                vs.push(v);
                if let Some(list) = ins.get(&face.edges[i]) {
                    if self.edges[face.edges[i] as usize].v[0] == v {
                        vs.extend(list.iter().copied());
                    } else {
                        vs.extend(list.iter().rev().copied());
                    }
                }
            }
            rebuilt.push((f, vs, self.face_flags(f)));
        }
        for &f in &faces {
            self.kill_face(f);
        }
        for (&e, list) in ins {
            let ed = &self.edges[e as usize];
            let mut chain = vec![ed.v[0]];
            chain.extend(list.iter().copied());
            chain.push(ed.v[1]);
            let (sel, hide) = (ed.sel, ed.hide);
            self.kill_edge(e);
            for w in chain.windows(2) {
                let ne = self.add_edge(w[0], w[1]);
                self.edges[ne as usize].sel = sel;
                self.edges[ne as usize].hide = hide;
            }
        }
        for (f, vs, fl) in rebuilt {
            if let Some(nf) = self.add_face_flags(&vs, &fl) {
                fmap.insert(f, nf);
            }
        }
        fmap
    }

    /// Splits face `f` between two of its non-adjacent vertices.
    fn split_face(&mut self, f: u32, a: u32, b: u32) -> Option<(u32, u32)> {
        let vs = self.faces[f as usize].verts.clone();
        let n = vs.len();
        let ia = vs.iter().position(|&x| x == a)?;
        let ib = vs.iter().position(|&x| x == b)?;
        if (ia + 1) % n == ib || (ib + 1) % n == ia || ia == ib {
            return None;
        }
        let walk = |from: usize, to: usize| -> Vec<u32> {
            let mut out = vec![];
            let mut i = from;
            loop {
                out.push(vs[i]);
                if i == to {
                    break;
                }
                i = (i + 1) % n;
            }
            out
        };
        let l1 = walk(ia, ib);
        let l2 = walk(ib, ia);
        let fl = self.face_flags(f);
        self.kill_face(f);
        let f1 = self.add_face_flags(&l1, &fl)?;
        let f2 = self.add_face_flags(&l2, &fl)?;
        Some((f1, f2))
    }

    // ------------------------------------------------------------- subdivide

    /// Subdivide: splits selected edges at their midpoints; fully selected
    /// faces become grids (quads) or 4 triangles. Repeated `levels` times.
    pub fn subdivide(&mut self, levels: u32) -> OpResult {
        if self.selected_edges().is_empty() {
            return Err(OpError::NothingSelected);
        }
        for _ in 0..levels.max(1) {
            let se = self.selected_edges();
            let full: Vec<u32> = self.selected_faces();
            let corners: HashMap<u32, Vec<u32>> =
                full.iter().map(|&f| (f, self.faces[f as usize].verts.clone())).collect();
            let mut ins = HashMap::new();
            let mut mids = Vec::new();
            for &e in &se {
                let [a, b] = self.edges[e as usize].v;
                let m = self.add_vert((self.verts[a as usize].co + self.verts[b as usize].co) * 0.5);
                self.verts[m as usize].sel = true;
                ins.insert(e, vec![m]);
                mids.push(m);
            }
            let fmap = self.insert_verts_on_edges(&ins);
            for f in full {
                let Some(&nf) = fmap.get(&f) else { continue };
                let orig = &corners[&f];
                let loop_ = self.faces[nf as usize].verts.clone();
                if loop_.len() != orig.len() * 2 {
                    continue;
                }
                let n = orig.len();
                let fl = self.face_flags(nf);
                // loop_ = [v0, m0, v1, m1, ...]
                let v = |i: usize| loop_[(2 * i) % (2 * n)];
                let m = |i: usize| loop_[(2 * i + 1) % (2 * n)];
                self.kill_face(nf);
                if n == 3 {
                    for poly in [[v(0), m(0), m(2)], [m(0), v(1), m(1)], [m(2), m(1), v(2)], [m(0), m(1), m(2)]] {
                        self.add_face_flags(&poly, &fl);
                    }
                } else {
                    let c: DVec3 = orig.iter().map(|&x| self.verts[x as usize].co).sum::<DVec3>() / n as f64;
                    let cv = self.add_vert(c);
                    self.verts[cv as usize].sel = true;
                    for i in 0..n {
                        self.add_face_flags(&[v(i), m(i), cv, m(i + n - 1)], &fl);
                    }
                }
            }
            self.compact();
            self.flush_verts_to_mode();
        }
        self.finish();
        Ok(())
    }

    // ----------------------------------------------------------- triangulate

    fn triangulate_faces(&mut self, faces: &[u32]) -> Vec<u32> {
        let mut out = Vec::new();
        for &f in faces {
            let vs = self.faces[f as usize].verts.clone();
            if vs.len() <= 3 {
                out.push(f);
                continue;
            }
            let pts: Vec<DVec3> = vs.iter().map(|&v| self.verts[v as usize].co).collect();
            let tris = triangulate_polygon(&pts);
            let fl = self.face_flags(f);
            self.kill_face(f);
            for t in tris {
                if let Some(nf) = self.add_face_flags(&[vs[t[0]], vs[t[1]], vs[t[2]]], &fl) {
                    out.push(nf);
                }
            }
        }
        out
    }

    /// Triangulate Faces (Ctrl+T).
    pub fn triangulate_selected(&mut self) -> OpResult<usize> {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let n = self.triangulate_faces(&sf).len();
        self.finish();
        Ok(n)
    }

    /// Tris to Quads (Alt+J): joins pairs of adjacent selected triangles whose
    /// normals differ by less than `max_angle` into convex quads.
    pub fn tris_to_quads(&mut self, max_angle: f64) -> OpResult<usize> {
        let sf: HashSet<u32> =
            self.selected_faces().into_iter().filter(|&f| self.faces[f as usize].verts.len() == 3).collect();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let mut cands: Vec<(f64, u32, u32, [u32; 4], u32)> = Vec::new();
        for e in 0..self.edges.len() as u32 {
            let ed = &self.edges[e as usize];
            if !ed.alive || ed.faces.len() != 2 {
                continue;
            }
            let (f1, f2) = (ed.faces[0], ed.faces[1]);
            if !sf.contains(&f1) || !sf.contains(&f2) {
                continue;
            }
            let (n1, n2) = (self.face_normal(f1), self.face_normal(f2));
            let ang = n1.dot(n2).clamp(-1.0, 1.0).acos();
            if ang > max_angle {
                continue;
            }
            // Rotate f1 so that its shared edge is a->b.
            let t1 = &self.faces[f1 as usize].verts;
            let i = (0..3).find(|&i| {
                let (a, b) = (t1[i], t1[(i + 1) % 3]);
                (a == ed.v[0] && b == ed.v[1]) || (a == ed.v[1] && b == ed.v[0])
            });
            let Some(i) = i else { continue };
            let (a, b, c) = (t1[i], t1[(i + 1) % 3], t1[(i + 2) % 3]);
            let d = *self.faces[f2 as usize].verts.iter().find(|&&x| x != a && x != b).unwrap();
            if !self.face_has_directed(f2, b, a) {
                continue;
            }
            let quad = [a, d, b, c];
            let p: Vec<DVec3> = quad.iter().map(|&v| self.verts[v as usize].co).collect();
            if !is_convex_quad(&p) {
                continue;
            }
            // Prefer flat, square-ish quads.
            let mut shape = 0.0;
            for k in 0..4 {
                let u = (p[(k + 1) % 4] - p[k]).normalize_or_zero();
                let w = (p[(k + 3) % 4] - p[k]).normalize_or_zero();
                shape += u.dot(w).abs();
            }
            cands.push((ang + shape * 0.25, f1, f2, quad, e));
        }
        cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut used = HashSet::new();
        let mut n = 0;
        for (_, f1, f2, quad, shared) in cands {
            if used.contains(&f1) || used.contains(&f2) {
                continue;
            }
            used.insert(f1);
            used.insert(f2);
            let fl = self.face_flags(f1);
            self.kill_face(f1);
            self.kill_face(f2);
            if self.add_face_flags(&quad, &fl).is_some() {
                n += 1;
            }
            self.kill_faceless_edges([shared]);
        }
        self.finish();
        Ok(n)
    }

    /// Poke Faces: adds a center vertex to each selected face, fanning it.
    pub fn poke(&mut self) -> OpResult {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        for f in sf {
            let vs = self.faces[f as usize].verts.clone();
            let c = self.add_vert(self.face_center(f));
            self.verts[c as usize].sel = true;
            let fl = self.face_flags(f);
            self.kill_face(f);
            for i in 0..vs.len() {
                self.add_face_flags(&[vs[i], vs[(i + 1) % vs.len()], c], &fl);
            }
        }
        self.finish();
        Ok(())
    }

    // --------------------------------------------------------------- normals

    pub fn flip_normals(&mut self) -> OpResult {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        for f in sf {
            self.reverse_face(f);
        }
        self.finish();
        Ok(())
    }

    /// Recalculate Normals (Shift+N): makes winding consistent per connected
    /// part and points it outside (or inside).
    pub fn recalc_normals(&mut self, inside: bool) -> OpResult {
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let regions = self.face_regions(&sf, |_| true);
        for region in regions {
            let set: HashSet<u32> = region.iter().copied().collect();
            let mut done = HashSet::from([region[0]]);
            let mut q = VecDeque::from([region[0]]);
            while let Some(f) = q.pop_front() {
                let vs = self.faces[f as usize].verts.clone();
                let es = self.faces[f as usize].edges.clone();
                let n = vs.len();
                for i in 0..n {
                    let (a, b) = (vs[i], vs[(i + 1) % n]);
                    for g in self.edges[es[i] as usize].faces.clone() {
                        if g == f || !set.contains(&g) || done.contains(&g) {
                            continue;
                        }
                        if self.face_has_directed(g, a, b) {
                            self.reverse_face(g);
                        }
                        done.insert(g);
                        q.push_back(g);
                    }
                }
            }
            // Signed volume relative to the region centroid.
            let pts: Vec<DVec3> =
                region.iter().flat_map(|&f| self.faces[f as usize].verts.iter().map(|&v| self.verts[v as usize].co)).collect();
            let c = pts.iter().sum::<DVec3>() / pts.len().max(1) as f64;
            let mut vol = 0.0;
            for &f in &region {
                let vs = &self.faces[f as usize].verts;
                let p0 = self.verts[vs[0] as usize].co - c;
                for k in 1..vs.len() - 1 {
                    let p1 = self.verts[vs[k] as usize].co - c;
                    let p2 = self.verts[vs[k + 1] as usize].co - c;
                    vol += p0.dot(p1.cross(p2));
                }
            }
            if (vol < 0.0) != inside {
                for &f in &region {
                    self.reverse_face(f);
                }
            }
        }
        self.finish();
        Ok(())
    }

    // ------------------------------------------------------------ edge split

    /// Edge Split / Rip (V): disconnects faces along the selected edges.
    /// Afterwards one side's new vertices are selected so they can be moved.
    pub fn edge_split(&mut self) -> OpResult<usize> {
        let split: HashSet<u32> =
            self.selected_edges().into_iter().filter(|&e| self.edges[e as usize].faces.len() >= 2).collect();
        if split.is_empty() {
            return Err(OpError::Invalid("select interior edges to rip".into()));
        }
        let verts: HashSet<u32> = split.iter().flat_map(|&e| self.edges[e as usize].v).collect();
        let mut replace: HashMap<(u32, u32), u32> = HashMap::new(); // (face, old vert) -> new vert
        let mut new_verts = Vec::new();
        for &v in &verts {
            let fan = self.vert_faces(v);
            let mut parent: HashMap<u32, u32> = fan.iter().map(|&f| (f, f)).collect();
            fn find(p: &mut HashMap<u32, u32>, x: u32) -> u32 {
                let mut r = x;
                while p[&r] != r {
                    r = p[&r];
                }
                let mut c = x;
                while p[&c] != r {
                    let n = p[&c];
                    p.insert(c, r);
                    c = n;
                }
                r
            }
            for &e in &self.verts[v as usize].edges {
                if split.contains(&e) {
                    continue;
                }
                let fs = &self.edges[e as usize].faces;
                for w in fs.windows(2) {
                    let (ra, rb) = (find(&mut parent, w[0]), find(&mut parent, w[1]));
                    if ra != rb {
                        parent.insert(ra, rb);
                    }
                }
            }
            let mut groups: HashMap<u32, Vec<u32>> = HashMap::new();
            for &f in &fan {
                let r = find(&mut parent, f);
                groups.entry(r).or_default().push(f);
            }
            let mut groups: Vec<Vec<u32>> = groups.into_values().collect();
            groups.sort_by_key(|g| *g.iter().min().unwrap());
            for g in groups.iter().skip(1) {
                let nv = self.add_vert(self.verts[v as usize].co);
                new_verts.push(nv);
                for &f in g {
                    replace.insert((f, v), nv);
                }
            }
        }
        let faces: HashSet<u32> = replace.keys().map(|k| k.0).collect();
        for f in faces {
            let vs: Vec<u32> =
                self.faces[f as usize].verts.iter().map(|&v| *replace.get(&(f, v)).unwrap_or(&v)).collect();
            self.replace_face(f, &vs);
        }
        self.kill_faceless_edges(split.iter().copied());
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for &v in &new_verts {
            self.verts[v as usize].sel = true;
        }
        let n = new_verts.len();
        self.active = None;
        self.compact();
        self.flush_verts_to_mode();
        Ok(n)
    }

    // ---------------------------------------------------------------- bridge

    /// Bridge Edge Loops: connects two selected edge loops (or the borders of
    /// two selected face regions, which are removed) with quads.
    pub fn bridge_edge_loops(&mut self) -> OpResult<usize> {
        let sf = self.selected_faces();
        let edges: Vec<u32> = if !sf.is_empty() {
            let set: HashSet<u32> = sf.iter().copied().collect();
            let border: Vec<u32> = (0..self.edges.len() as u32)
                .filter(|&e| {
                    let ed = &self.edges[e as usize];
                    ed.alive && ed.faces.iter().filter(|f| set.contains(f)).count() == 1
                })
                .collect();
            for &f in &sf {
                self.kill_face(f);
            }
            let interior: Vec<u32> = self.selected_edges().into_iter().filter(|e| !border.contains(e)).collect();
            self.kill_faceless_edges(interior);
            let sv = self.selected_verts();
            for &v in &sv {
                if self.verts[v as usize].alive && self.verts[v as usize].edges.is_empty() {
                    self.kill_vert(v);
                }
            }
            border
        } else {
            self.selected_edges()
        };
        let chains = edge_chains(self, &edges);
        if chains.len() != 2 {
            self.finish();
            return Err(OpError::Invalid(format!("need exactly 2 edge loops, found {}", chains.len())));
        }
        let (a, ca) = chains[0].clone();
        let (mut b, cb) = chains[1].clone();
        if a.len() != b.len() || ca != cb {
            self.finish();
            return Err(OpError::Invalid("edge loops must have the same number of vertices".into()));
        }
        let n = a.len();
        let co = |m: &Mesh, v: u32| m.verts[v as usize].co;
        let cost = |m: &Mesh, b: &[u32]| -> f64 { (0..n).map(|i| co(m, a[i]).distance(co(m, b[i]))).sum() };
        let mut best = (f64::INFINITY, b.clone());
        let mut candidates = vec![b.clone()];
        let mut rev = b.clone();
        rev.reverse();
        candidates.push(rev);
        for cand in candidates {
            let shifts = if ca { n } else { 1 };
            for s in 0..shifts {
                let mut c = cand.clone();
                c.rotate_left(s);
                let k = cost(self, &c);
                if k < best.0 {
                    best = (k, c);
                }
            }
        }
        b = best.1;
        // Orientation: the quad's edge a[i]->a[i+1] must run opposite to any
        // existing face on that edge.
        let mut flip = false;
        let mut mat = 0;
        if let Some(e) = self.find_edge(a[0], a[1]) {
            if let Some(&f) = self.edges[e as usize].faces.first() {
                flip = self.face_has_directed(f, a[0], a[1]);
                mat = self.faces[f as usize].mat;
            }
        }
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        let segs = if ca { n } else { n - 1 };
        let mut created = 0;
        for i in 0..segs {
            let j = (i + 1) % n;
            let mut quad = vec![a[i], a[j], b[j], b[i]];
            if flip {
                quad.reverse();
            }
            if let Some(f) = self.add_face_mat(&quad, mat) {
                self.faces[f as usize].sel = true;
                created += 1;
            }
        }
        self.add_face_sel_flush();
        self.finish();
        Ok(created)
    }

    // -------------------------------------------------------------- loop cut

    /// Loop Cut (Ctrl+R): inserts `cuts` edge loops across the edge ring of
    /// edge `e`. With one cut, `factor` (0..1) positions it along the ring.
    pub fn loop_cut(&mut self, e: u32, cuts: u32, factor: f64) -> OpResult<usize> {
        if e as usize >= self.edges.len() || !self.edges[e as usize].alive {
            return Err(OpError::Invalid("no edge".into()));
        }
        let cuts = cuts.max(1) as usize;
        let (ring_edges, ring_faces) = self.edge_ring(e);
        if ring_faces.is_empty() {
            return Err(OpError::Invalid("edge is not part of a quad ring".into()));
        }
        // Orient every ring edge consistently: walk the ring and record, per
        // edge, which endpoint is on the "start" side.
        let mut start_of: HashMap<u32, u32> = HashMap::new();
        start_of.insert(e, self.edges[e as usize].v[0]);
        let mut changed = true;
        while changed {
            changed = false;
            for &f in &ring_faces {
                let face = &self.faces[f as usize];
                for i in 0..4 {
                    let ea = face.edges[i];
                    let eb = face.edges[(i + 2) % 4];
                    if let (Some(&s), false) = (start_of.get(&ea), start_of.contains_key(&eb)) {
                        if !ring_edges.contains(&eb) {
                            continue;
                        }
                        // In a quad v0 v1 v2 v3, edge i is (vi, vi+1) and the
                        // opposite edge (vi+2, vi+3) runs backwards; the vertex
                        // across from vi is vi+3.
                        let vi = face.verts[i];
                        let opp_start =
                            if s == vi { face.verts[(i + 3) % 4] } else { face.verts[(i + 2) % 4] };
                        start_of.insert(eb, opp_start);
                        changed = true;
                    }
                }
            }
        }
        let ts: Vec<f64> = if cuts == 1 {
            vec![factor.clamp(0.0, 1.0)]
        } else {
            (1..=cuts).map(|k| k as f64 / (cuts + 1) as f64).collect()
        };
        let mut ins: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut new_verts = vec![];
        for &re in &ring_edges {
            let Some(&s) = start_of.get(&re) else { continue };
            let [v0, v1] = self.edges[re as usize].v;
            let (p_start, p_end) = if s == v0 {
                (self.verts[v0 as usize].co, self.verts[v1 as usize].co)
            } else {
                (self.verts[v1 as usize].co, self.verts[v0 as usize].co)
            };
            let mut list: Vec<u32> = ts.iter().map(|&t| self.add_vert(p_start.lerp(p_end, t))).collect();
            new_verts.extend(list.iter().copied());
            // `ins` lists vertices from edge.v[0] to v[1].
            if s != v0 {
                list.reverse();
            }
            ins.insert(re, list);
        }
        let ring_set: HashSet<u32> = ring_faces.iter().copied().collect();
        // Remember for each ring face which vertices to connect after insertion.
        let mut connects: Vec<(u32, Vec<(u32, u32)>)> = Vec::new();
        for &f in &ring_faces {
            let face = &self.faces[f as usize];
            let pair: Vec<u32> = face.edges.iter().copied().filter(|x| ins.contains_key(x)).collect();
            if pair.len() != 2 {
                continue;
            }
            let ordered = |m: &Mesh, ed: u32| -> Vec<u32> {
                let l = ins[&ed].clone();
                let s = start_of[&ed];
                if s == m.edges[ed as usize].v[0] {
                    l
                } else {
                    l.into_iter().rev().collect()
                }
            };
            let la = ordered(self, pair[0]);
            let lb = ordered(self, pair[1]);
            connects.push((f, la.into_iter().zip(lb).collect()));
        }
        let fmap = self.insert_verts_on_edges(&ins);
        for (f, pairs) in connects {
            let Some(&mut_f) = fmap.get(&f) else { continue };
            let mut cur = vec![mut_f];
            for (a, b) in pairs {
                // Find the current piece that contains both vertices.
                let Some(pos) = cur.iter().position(|&g| {
                    let vs = &self.faces[g as usize].verts;
                    self.faces[g as usize].alive && vs.contains(&a) && vs.contains(&b)
                }) else {
                    continue;
                };
                let g = cur.remove(pos);
                if let Some((f1, f2)) = self.split_face(g, a, b) {
                    cur.push(f1);
                    cur.push(f2);
                } else {
                    cur.push(g);
                }
            }
        }
        let _ = ring_set;
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for f in self.faces.iter_mut() {
            f.sel = false;
        }
        for &v in &new_verts {
            self.verts[v as usize].sel = true;
        }
        self.active = None;
        self.compact();
        self.flush_from_verts();
        if self.select_mode == SelectMode::Face {
            self.select_mode = SelectMode::Edge;
        }
        self.flush_select();
        Ok(new_verts.len())
    }

    /// Connect Vertex Path (J): splits faces between selected vertices.
    pub fn connect_verts(&mut self) -> OpResult<usize> {
        let sv: HashSet<u32> = self.selected_verts().into_iter().collect();
        if sv.len() < 2 {
            return Err(OpError::Invalid("select at least 2 vertices".into()));
        }
        let faces: HashSet<u32> = sv.iter().flat_map(|&v| self.vert_faces(v)).collect();
        let mut faces: Vec<u32> = faces.into_iter().collect();
        faces.sort_unstable();
        let mut made = 0;
        for f in faces {
            let vs = self.faces[f as usize].verts.clone();
            let n = vs.len();
            let picks: Vec<usize> = (0..n).filter(|&i| sv.contains(&vs[i])).collect();
            if picks.len() < 2 {
                continue;
            }
            let k = picks.len();
            let mut pieces: Vec<Vec<u32>> = Vec::new();
            let mut inner = Vec::new();
            for j in 0..k {
                let (s, t) = (picks[j], picks[(j + 1) % k]);
                inner.push(vs[s]);
                let mut piece = vec![];
                let mut i = s;
                loop {
                    piece.push(vs[i]);
                    if i == t {
                        break;
                    }
                    i = (i + 1) % n;
                }
                if piece.len() >= 3 {
                    pieces.push(piece);
                }
            }
            if k == 2 {
                if pieces.len() != 2 {
                    continue;
                }
            } else if inner.len() >= 3 {
                pieces.push(inner);
            }
            if pieces.len() < 2 {
                continue;
            }
            let fl = self.face_flags(f);
            self.kill_face(f);
            for p in pieces {
                self.add_face_flags(&p, &fl);
            }
            made += 1;
        }
        self.finish();
        Ok(made)
    }

    // ---------------------------------------------------------------- bisect

    /// Bisect: cuts selected faces with a plane, optionally deleting a side
    /// and filling the cut.
    pub fn bisect(&mut self, co: DVec3, no: DVec3, clear_inner: bool, clear_outer: bool, fill: bool) -> OpResult<usize> {
        let no = no.normalize_or_zero();
        if no == DVec3::ZERO {
            return Err(OpError::Invalid("invalid plane normal".into()));
        }
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        let size = self.bounds().map(|(a, b)| (b - a).length()).unwrap_or(1.0);
        let eps = 1e-7 * size.max(1e-9);
        let dist = |m: &Mesh, v: u32| (m.verts[v as usize].co - co).dot(no);
        let face_set: HashSet<u32> = sf.iter().copied().collect();
        let mut ins: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut on_plane: HashSet<u32> = HashSet::new();
        let cand_edges: HashSet<u32> = sf.iter().flat_map(|&f| self.faces[f as usize].edges.clone()).collect();
        for &e in &cand_edges {
            let [a, b] = self.edges[e as usize].v;
            let (da, db) = (dist(self, a), dist(self, b));
            if da.abs() <= eps {
                on_plane.insert(a);
            }
            if db.abs() <= eps {
                on_plane.insert(b);
            }
            if (da > eps && db < -eps) || (da < -eps && db > eps) {
                let t = da / (da - db);
                let p = self.verts[a as usize].co.lerp(self.verts[b as usize].co, t);
                let nv = self.add_vert(p);
                on_plane.insert(nv);
                ins.insert(e, vec![nv]);
            }
        }
        let fmap = self.insert_verts_on_edges(&ins);
        let faces: Vec<u32> = sf.iter().map(|f| *fmap.get(f).unwrap_or(f)).collect();
        let mut cut_edges = Vec::new();
        for f in faces {
            if !self.faces[f as usize].alive {
                continue;
            }
            let vs = self.faces[f as usize].verts.clone();
            let pts: Vec<u32> = vs.iter().copied().filter(|v| on_plane.contains(v)).collect();
            if pts.len() == 2 {
                if let Some(e) = self.find_edge(pts[0], pts[1]) {
                    cut_edges.push(e);
                    continue;
                }
                if self.split_face(f, pts[0], pts[1]).is_some() {
                    if let Some(e) = self.find_edge(pts[0], pts[1]) {
                        cut_edges.push(e);
                    }
                }
            }
        }
        let _ = face_set;
        if clear_inner || clear_outer {
            for v in 0..self.verts.len() as u32 {
                if !self.verts[v as usize].alive || !self.verts[v as usize].sel {
                    continue;
                }
                let d = dist(self, v);
                if (clear_inner && d < -eps) || (clear_outer && d > eps) {
                    self.kill_vert(v);
                }
            }
        }
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for f in self.faces.iter_mut() {
            f.sel = false;
        }
        let live_cut: Vec<u32> = cut_edges.iter().copied().filter(|&e| self.edges[e as usize].alive).collect();
        for &e in &live_cut {
            self.edges[e as usize].sel = true;
            let [a, b] = self.edges[e as usize].v;
            self.verts[a as usize].sel = true;
            self.verts[b as usize].sel = true;
        }
        if fill && (clear_inner || clear_outer) {
            let border: Vec<u32> = live_cut.iter().copied().filter(|&e| self.edges[e as usize].faces.len() == 1).collect();
            for (loop_, closed) in edge_chains(self, &border) {
                if closed && loop_.len() >= 3 {
                    if let Some(f) = self.add_face_oriented(&loop_) {
                        self.faces[f as usize].sel = true;
                    }
                }
            }
        }
        if self.select_mode == SelectMode::Face {
            self.select_mode = SelectMode::Edge;
        }
        self.active = None;
        self.compact();
        match self.select_mode {
            SelectMode::Vert => self.flush_from_verts(),
            _ => self.flush_from_edges(),
        }
        Ok(live_cut.len())
    }

    // ------------------------------------------------------------- geometric

    /// Smooth Vertices: moves selected vertices toward their neighbours' average.
    pub fn smooth(&mut self, factor: f64, iterations: u32) -> OpResult {
        let sv = self.selected_verts();
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        for _ in 0..iterations.max(1) {
            let new: Vec<DVec3> = sv
                .iter()
                .map(|&v| {
                    let es = &self.verts[v as usize].edges;
                    let co = self.verts[v as usize].co;
                    if es.is_empty() {
                        return co;
                    }
                    let avg = es.iter().map(|&e| self.verts[self.other_vert(e, v) as usize].co).sum::<DVec3>()
                        / es.len() as f64;
                    co.lerp(avg, factor)
                })
                .collect();
            for (i, &v) in sv.iter().enumerate() {
                self.verts[v as usize].co = new[i];
            }
        }
        Ok(())
    }

    /// Applies a matrix to the selected vertices.
    pub fn transform_selected(&mut self, m: DMat4) -> OpResult {
        let sv = self.selected_verts();
        if sv.is_empty() {
            return Err(OpError::NothingSelected);
        }
        for v in sv {
            let co = self.verts[v as usize].co;
            self.verts[v as usize].co = m.transform_point3(co);
        }
        // A mirroring transform flips the winding of fully transformed faces.
        if m.determinant() < 0.0 {
            for f in self.selected_faces() {
                self.reverse_face(f);
            }
        }
        Ok(())
    }

    /// Mirror the selection across `axis` (0=X,1=Y,2=Z) through `pivot`.
    pub fn mirror(&mut self, axis: usize, pivot: DVec3) -> OpResult {
        let mut s = DVec3::ONE;
        s[axis.min(2)] = -1.0;
        let m = DMat4::from_translation(pivot) * DMat4::from_scale(s) * DMat4::from_translation(-pivot);
        self.transform_selected(m)
    }

    /// Adds `other` into this mesh (Shift+A), selecting only the new geometry.
    pub fn add_mesh(&mut self, other: &Mesh, offset: DVec3) {
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for f in self.faces.iter_mut() {
            f.sel = false;
        }
        let new = append(self, other, offset);
        for v in new {
            self.verts[v as usize].sel = true;
        }
        self.active = None;
        self.flush_verts_to_mode();
    }
}

/// Splits a set of edges into ordered vertex chains. Returns (verts, closed).
pub(crate) fn edge_chains(m: &Mesh, edges: &[u32]) -> Vec<(Vec<u32>, bool)> {
    let set: HashSet<u32> = edges.iter().copied().collect();
    let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
    for &e in edges {
        let [a, b] = m.edges[e as usize].v;
        adj.entry(a).or_default().push(e);
        adj.entry(b).or_default().push(e);
    }
    let mut used: HashSet<u32> = HashSet::new();
    let mut out = Vec::new();
    // Open chains first (start at endpoints), then closed loops.
    let mut starts: Vec<u32> = adj.iter().filter(|(_, es)| es.len() == 1).map(|(&v, _)| v).collect();
    starts.sort_unstable();
    let mut rest: Vec<u32> = adj.keys().copied().collect();
    rest.sort_unstable();
    for (phase, list) in [starts, rest].into_iter().enumerate() {
        for s in list {
            let Some(&e0) = adj[&s].iter().find(|e| !used.contains(e)) else { continue };
            let mut chain = vec![s];
            let mut cur_v = s;
            let mut cur_e = e0;
            let mut closed = false;
            loop {
                used.insert(cur_e);
                let nv = m.other_vert(cur_e, cur_v);
                if nv == s {
                    closed = true;
                    break;
                }
                chain.push(nv);
                cur_v = nv;
                match adj[&nv].iter().find(|e| !used.contains(e) && set.contains(e)) {
                    Some(&ne) if adj[&nv].len() == 2 => cur_e = ne,
                    _ => break,
                }
            }
            let _ = phase;
            out.push((chain, closed));
        }
    }
    out
}

/// Orders points around their centroid in their best-fit plane.
fn order_points_planar(pts: &[DVec3]) -> Vec<usize> {
    let c = pts.iter().sum::<DVec3>() / pts.len() as f64;
    let mut nrm = DVec3::ZERO;
    for i in 0..pts.len() {
        for j in 0..pts.len() {
            let n = (pts[i] - c).cross(pts[j] - c);
            if n.length() > nrm.length() {
                nrm = n;
            }
        }
    }
    let nrm = nrm.normalize_or(DVec3::Z);
    let u = (pts[0] - c).reject_from(nrm).normalize_or(nrm.any_orthonormal_vector());
    let w = nrm.cross(u);
    let mut idx: Vec<usize> = (0..pts.len()).collect();
    idx.sort_by(|&a, &b| {
        let pa = pts[a] - c;
        let pb = pts[b] - c;
        let ta = pa.dot(w).atan2(pa.dot(u));
        let tb = pb.dot(w).atan2(pb.dot(u));
        ta.partial_cmp(&tb).unwrap()
    });
    idx
}

fn is_convex_quad(p: &[DVec3]) -> bool {
    let n = crate::newell(p.iter().copied());
    let mut sign = 0.0;
    for k in 0..4 {
        let a = p[(k + 1) % 4] - p[k];
        let b = p[(k + 2) % 4] - p[(k + 1) % 4];
        let s = a.cross(b).dot(n);
        if s.abs() < 1e-12 {
            return false;
        }
        if sign == 0.0 {
            sign = s.signum();
        } else if s.signum() != sign {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives;
    use crate::select::{SelectAction, SelectOp};
    use crate::test_util::*;
    use crate::ElemKind;

    fn face_mode(m: &mut Mesh, faces: &[u32]) {
        m.set_select_mode(SelectMode::Face);
        m.select_elems(ElemKind::Face, faces, SelectOp::Set);
    }

    fn closed(m: &Mesh) -> bool {
        m.edges.iter().all(|e| e.faces.len() == 2)
    }

    #[test]
    fn delete_variants() {
        let mut m = cube();
        face_mode(&mut m, &[0]);
        m.delete(DeleteKind::Faces).unwrap();
        assert_eq!(m.live_counts(), (8, 12, 5));
        m.validate().unwrap();

        let mut m = cube();
        m.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        m.delete(DeleteKind::Verts).unwrap();
        assert_eq!(m.live_counts(), (7, 9, 3));

        let mut m = cube();
        m.set_select_mode(SelectMode::Edge);
        m.select_elems(ElemKind::Edge, &[0], SelectOp::Set);
        m.delete(DeleteKind::Edges).unwrap();
        assert_eq!(m.live_counts(), (8, 11, 4));

        let mut m = cube();
        m.select_all(SelectAction::Select);
        m.delete(DeleteKind::OnlyFaces).unwrap();
        assert_eq!(m.live_counts(), (8, 12, 0));
    }

    #[test]
    fn extrude_face_of_cube() {
        let mut m = cube();
        face_mode(&mut m, &[1]); // +Z
        let n = m.extrude().unwrap();
        assert!((n - DVec3::Z).length() < 1e-9);
        assert_eq!(m.live_counts(), (12, 20, 10));
        assert!(closed(&m));
        m.validate().unwrap();
        assert_eq!(m.selected_counts(), (4, 4, 1));
        // Consistent winding: every edge used once in each direction.
        for e in &m.edges {
            let [a, b] = e.v;
            let fw = e.faces.iter().filter(|&&f| m.face_has_directed(f, a, b)).count();
            assert_eq!(fw, 1);
        }
    }

    #[test]
    fn extrude_region_and_edges_and_verts() {
        let mut g = grid(2);
        face_mode(&mut g, &[0, 1]);
        g.extrude().unwrap();
        // 6 new verts, top 2 faces + 6 side faces
        assert_eq!(g.live_counts().2, 4 + 6);
        g.validate().unwrap();

        let mut c = primitives::circle(8, 1.0, false);
        c.select_all(SelectAction::Select);
        c.extrude().unwrap();
        assert_eq!(c.live_counts(), (16, 24, 8));

        let mut m = Mesh::new();
        m.add_vert(DVec3::ZERO);
        m.select_all(SelectAction::Select);
        m.extrude().unwrap();
        assert_eq!(m.live_counts(), (2, 1, 0));
    }

    #[test]
    fn extrude_individual_faces() {
        let mut m = cube();
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        m.extrude_individual(0.1).unwrap();
        assert_eq!(m.live_counts().2, 6 + 6 * 4);
        m.validate().unwrap();
    }

    #[test]
    fn inset_region_and_individual() {
        let mut m = cube();
        face_mode(&mut m, &[1]);
        m.inset(0.1, 0.0, false).unwrap();
        assert_eq!(m.live_counts(), (12, 20, 10));
        let sel = m.selected_faces();
        assert_eq!(sel.len(), 1);
        assert!((m.face_area(sel[0]) - 0.64).abs() < 1e-9);
        m.validate().unwrap();

        let mut g = grid(2);
        g.set_select_mode(SelectMode::Face);
        g.select_all(SelectAction::Select);
        g.inset(0.05, 0.0, true).unwrap();
        assert_eq!(g.live_counts().2, 4 * 5);
    }

    #[test]
    fn dissolve_ops() {
        let mut g = grid(3);
        g.set_select_mode(SelectMode::Face);
        g.select_all(SelectAction::Select);
        assert_eq!(g.dissolve_faces().unwrap(), 1);
        assert_eq!(g.live_counts().2, 1);
        g.validate().unwrap();

        let mut g = grid(2);
        let center = 4;
        g.select_elems(ElemKind::Vert, &[center], SelectOp::Set);
        g.dissolve_verts().unwrap();
        assert_eq!(g.live_counts(), (8, 8, 1));

        let mut g = grid(2);
        g.set_select_mode(SelectMode::Edge);
        let e = g.find_edge(1, 4).unwrap();
        g.select_elems(ElemKind::Edge, &[e], SelectOp::Set);
        g.dissolve_edges().unwrap();
        assert_eq!(g.live_counts().2, 3);
        g.validate().unwrap();
    }

    #[test]
    fn limited_dissolve_triangulated_cube() {
        let mut m = cube();
        triangulate_all(&mut m);
        assert_eq!(m.live_counts().2, 12);
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        m.dissolve_limited(5f64.to_radians()).unwrap();
        assert_eq!(m.live_counts(), (8, 12, 6));
    }

    #[test]
    fn duplicate_split_separate() {
        let mut m = cube();
        face_mode(&mut m, &[1]);
        m.duplicate().unwrap();
        assert_eq!(m.live_counts(), (12, 16, 7));

        let mut m = cube();
        face_mode(&mut m, &[1]);
        m.split().unwrap();
        assert_eq!(m.live_counts(), (12, 16, 6));
        assert_eq!(m.selected_counts(), (4, 4, 1));

        let mut m = cube();
        face_mode(&mut m, &[1]);
        let part = m.separate().unwrap();
        assert_eq!(part.live_counts(), (4, 4, 1));
        assert_eq!(m.live_counts(), (8, 12, 5));
        m.validate().unwrap();
        part.validate().unwrap();
    }

    #[test]
    fn separate_whole_island() {
        let mut m = cube();
        append(&mut m, &primitives::cube(1.0), DVec3::X * 3.0);
        m.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        m.select_linked();
        let part = m.separate().unwrap();
        assert_eq!(part.live_counts(), (8, 12, 6));
        assert_eq!(m.live_counts(), (8, 12, 6));
    }

    #[test]
    fn merge_and_doubles() {
        let mut g = grid(1);
        g.select_all(SelectAction::Select);
        g.merge(MergeKind::Center, DVec3::ZERO).unwrap();
        assert_eq!(g.live_counts(), (1, 0, 0));

        let mut g = grid(2);
        g.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        g.select_elems(ElemKind::Vert, &[1], SelectOp::Add);
        g.merge(MergeKind::Last, DVec3::ZERO).unwrap();
        assert_eq!(g.live_counts().0, 8);
        assert_eq!(g.live_counts().2, 4);
        g.validate().unwrap();

        // Unwelded STL-style triangles become connected.
        let mut m = Mesh::new();
        for p in [DVec3::ZERO, DVec3::X, DVec3::Y, DVec3::X, DVec3::new(1.0, 1.0, 0.0), DVec3::Y] {
            m.add_vert(p);
        }
        m.add_face(&[0, 1, 2]);
        m.add_face(&[3, 4, 5]);
        m.select_all(SelectAction::Select);
        assert_eq!(m.remove_doubles(1e-6).unwrap(), 2);
        assert_eq!(m.live_counts(), (4, 5, 2));
    }

    #[test]
    fn subdivide_quads_and_tris() {
        let mut m = cube();
        m.select_all(SelectAction::Select);
        m.subdivide(1).unwrap();
        assert_eq!(m.live_counts(), (26, 48, 24));
        assert!(closed(&m));
        m.validate().unwrap();

        let mut t = Mesh::new();
        for p in [DVec3::ZERO, DVec3::X, DVec3::Y] {
            t.add_vert(p);
        }
        t.add_face(&[0, 1, 2]);
        t.select_all(SelectAction::Select);
        t.subdivide(2).unwrap();
        assert_eq!(t.live_counts().2, 16);

        // Partial: a single edge of a quad.
        let mut g = grid(1);
        g.set_select_mode(SelectMode::Edge);
        g.select_elems(ElemKind::Edge, &[0], SelectOp::Set);
        g.subdivide(1).unwrap();
        assert_eq!(g.live_counts(), (5, 5, 1));
        assert_eq!(g.faces[0].verts.len(), 5);
    }

    #[test]
    fn triangulate_and_back() {
        let mut m = cube();
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        m.triangulate_selected().unwrap();
        assert_eq!(m.live_counts(), (8, 18, 12));
        m.select_all(SelectAction::Select);
        assert_eq!(m.tris_to_quads(40f64.to_radians()).unwrap(), 6);
        assert_eq!(m.live_counts(), (8, 12, 6));
    }

    #[test]
    fn normals_recalc() {
        let mut m = cube();
        m.reverse_face(0);
        m.reverse_face(3);
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        m.recalc_normals(false).unwrap();
        for f in 0..6 {
            assert!(m.face_normal(f).dot(m.face_center(f)) > 0.0);
        }
        m.select_all(SelectAction::Select);
        m.flip_normals().unwrap();
        assert!(m.face_normal(0).dot(m.face_center(0)) < 0.0);
    }

    #[test]
    fn rip_edges() {
        let mut g = grid(4);
        g.set_select_mode(SelectMode::Edge);
        let es: Vec<u32> = [(5, 6), (6, 7), (7, 8)].iter().map(|&(a, b)| g.find_edge(a, b).unwrap()).collect();
        g.select_elems(ElemKind::Edge, &es, SelectOp::Set);
        // Vertex 5 is on the border so the rip opens there; 8 is the far end.
        assert_eq!(g.edge_split().unwrap(), 3);
        assert_eq!(g.live_counts().0, 28);
        g.validate().unwrap();
    }

    #[test]
    fn bridge_two_circles() {
        let mut m = primitives::circle(8, 1.0, false);
        append(&mut m, &primitives::circle(8, 1.0, false), DVec3::Z);
        m.set_select_mode(SelectMode::Edge);
        m.select_all(SelectAction::Select);
        assert_eq!(m.bridge_edge_loops().unwrap(), 8);
        assert_eq!(m.live_counts(), (16, 24, 8));
        m.validate().unwrap();
    }

    #[test]
    fn bridge_two_faces_makes_tube() {
        let mut m = cube();
        append(&mut m, &primitives::cube(1.0), DVec3::X * 3.0);
        face_mode(&mut m, &[5, 10]); // +X of the first cube, -X of the second
        assert_eq!(m.bridge_edge_loops().unwrap(), 4);
        assert_eq!(m.live_counts().2, 14);
        assert!(closed(&m));
        m.validate().unwrap();
    }

    #[test]
    fn loop_cut_cube() {
        let mut m = cube();
        let e = m.find_edge(0, 1).unwrap();
        assert_eq!(m.loop_cut(e, 1, 0.5).unwrap(), 4);
        assert_eq!(m.live_counts(), (12, 20, 10));
        assert!(closed(&m));
        m.validate().unwrap();
        let e = m.find_edge(0, 4).unwrap();
        m.loop_cut(e, 3, 0.5).unwrap();
        assert!(closed(&m));
        m.validate().unwrap();
    }

    #[test]
    fn connect_and_poke() {
        let mut g = grid(1);
        g.select_elems(ElemKind::Vert, &[0, 3], SelectOp::Set);
        assert_eq!(g.connect_verts().unwrap(), 1);
        assert_eq!(g.live_counts(), (4, 5, 2));

        let mut c = cube();
        face_mode(&mut c, &[0]);
        c.poke().unwrap();
        assert_eq!(c.live_counts(), (9, 16, 9));
    }

    #[test]
    fn bisect_cube() {
        let mut m = cube();
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        let n = m.bisect(DVec3::ZERO, DVec3::Z, false, false, false).unwrap();
        assert_eq!(n, 4);
        assert_eq!(m.live_counts(), (12, 20, 10));
        m.validate().unwrap();

        let mut m = cube();
        m.set_select_mode(SelectMode::Face);
        m.select_all(SelectAction::Select);
        m.bisect(DVec3::ZERO, DVec3::Z, true, false, true).unwrap();
        assert_eq!(m.live_counts(), (8, 12, 6));
        assert!(closed(&m));
    }

    #[test]
    fn fill_hole() {
        let mut m = cube();
        face_mode(&mut m, &[1]);
        m.delete(DeleteKind::OnlyFaces).unwrap();
        m.set_select_mode(SelectMode::Edge);
        let border: Vec<u32> = (0..m.edges.len() as u32).filter(|&e| m.edges[e as usize].faces.len() == 1).collect();
        m.select_elems(ElemKind::Edge, &border, SelectOp::Set);
        assert_eq!(m.fill(false).unwrap(), 1);
        assert!(closed(&m));
        for f in 0..m.faces.len() as u32 {
            assert!(m.face_normal(f).dot(m.face_center(f)) > 0.0);
        }
        // Two loose verts -> edge.
        let mut v = Mesh::new();
        v.add_vert(DVec3::ZERO);
        v.add_vert(DVec3::X);
        v.select_all(SelectAction::Select);
        v.fill(false).unwrap();
        assert_eq!(v.live_counts(), (2, 1, 0));
    }

    #[test]
    fn transform_and_mirror() {
        let mut m = cube();
        m.select_all(SelectAction::Select);
        m.transform_selected(DMat4::from_translation(DVec3::X)).unwrap();
        assert!((m.selection_center().unwrap() - DVec3::X).length() < 1e-9);
        m.mirror(0, DVec3::ZERO).unwrap();
        for f in 0..6 {
            let c = m.face_center(f) - DVec3::new(-1.0, 0.0, 0.0);
            assert!(m.face_normal(f).dot(c) > 0.0);
        }
    }
}
