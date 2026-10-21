//! Selection model and selection operators, following Blender's semantics:
//! the element type of the current [`SelectMode`] is authoritative and the
//! other element types are derived by "flushing".

use crate::{ElemKind, Mesh, SelectMode};
use glam::DVec3;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectOp {
    /// Replace the selection.
    Set,
    Add,
    Sub,
    Toggle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectAction {
    Select,
    Deselect,
    Invert,
    Toggle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimilarType {
    /// Face / vertex normal direction (threshold: radians).
    Normal,
    /// Face area (threshold: relative difference).
    Area,
    /// Face perimeter (threshold: relative difference).
    Perimeter,
    /// Number of polygon sides.
    Sides,
    /// Same plane: normal angle and plane offset (threshold: radians; offset uses 1e-3 * size).
    Coplanar,
    /// Edge length (threshold: relative difference).
    Length,
    /// Edge direction (threshold: radians).
    Direction,
    /// Number of faces using an edge.
    FaceCount,
    /// Number of edges using a vertex.
    EdgeCount,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Compare {
    Equal,
    Greater,
    Less,
    NotEqual,
}

#[derive(Clone, Copy, PartialEq)]
struct HeapItem(f64, u32);
impl Eq for HeapItem {}
impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal)
    }
}

impl Mesh {
    // ---------------------------------------------------------------- flush

    pub fn flush_from_verts(&mut self) {
        for v in self.verts.iter_mut() {
            if v.hide || !v.alive {
                v.sel = false;
            }
        }
        for i in 0..self.edges.len() {
            let e = &self.edges[i];
            let s = e.alive && !e.hide && self.verts[e.v[0] as usize].sel && self.verts[e.v[1] as usize].sel;
            self.edges[i].sel = s;
        }
        for i in 0..self.faces.len() {
            let f = &self.faces[i];
            let s = f.alive && !f.hide && f.verts.iter().all(|&v| self.verts[v as usize].sel);
            self.faces[i].sel = s;
        }
    }

    pub fn flush_from_edges(&mut self) {
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for i in 0..self.edges.len() {
            let e = &mut self.edges[i];
            if e.hide || !e.alive {
                e.sel = false;
            }
            if e.sel {
                let [a, b] = e.v;
                self.verts[a as usize].sel = true;
                self.verts[b as usize].sel = true;
            }
        }
        for i in 0..self.faces.len() {
            let f = &self.faces[i];
            let s = f.alive && !f.hide && f.edges.iter().all(|&e| self.edges[e as usize].sel);
            self.faces[i].sel = s;
        }
    }

    pub fn flush_from_faces(&mut self) {
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for i in 0..self.faces.len() {
            let f = &mut self.faces[i];
            if f.hide || !f.alive {
                f.sel = false;
            }
            if f.sel {
                for k in 0..self.faces[i].verts.len() {
                    let v = self.faces[i].verts[k];
                    let e = self.faces[i].edges[k];
                    self.verts[v as usize].sel = true;
                    self.edges[e as usize].sel = true;
                }
            }
        }
    }

    /// Re-derives secondary selection from the current select mode.
    pub fn flush_select(&mut self) {
        match self.select_mode {
            SelectMode::Vert => self.flush_from_verts(),
            SelectMode::Edge => self.flush_from_edges(),
            SelectMode::Face => self.flush_from_faces(),
        }
    }

    fn flush_kind(&mut self, k: ElemKind) {
        match k {
            ElemKind::Vert => self.flush_from_verts(),
            ElemKind::Edge => self.flush_from_edges(),
            ElemKind::Face => self.flush_from_faces(),
        }
    }

    /// Applies a vertex-level selection and converts it to the current mode
    /// (faces/edges become selected when all their vertices are).
    pub(crate) fn flush_verts_to_mode(&mut self) {
        self.flush_from_verts();
        match self.select_mode {
            SelectMode::Vert => {}
            SelectMode::Edge => self.flush_from_edges(),
            SelectMode::Face => self.flush_from_faces(),
        }
    }

    pub fn set_select_mode(&mut self, mode: SelectMode) {
        if mode == self.select_mode {
            return;
        }
        let from = self.select_mode;
        if from == SelectMode::Vert {
            self.flush_from_verts();
        }
        self.select_mode = mode;
        self.active = None;
        self.prev_active = None;
        self.flush_select();
    }

    fn clear_sel(&mut self) {
        for v in self.verts.iter_mut() {
            v.sel = false;
        }
        for e in self.edges.iter_mut() {
            e.sel = false;
        }
        for f in self.faces.iter_mut() {
            f.sel = false;
        }
    }

    fn elem_count(&self, k: ElemKind) -> usize {
        match k {
            ElemKind::Vert => self.verts.len(),
            ElemKind::Edge => self.edges.len(),
            ElemKind::Face => self.faces.len(),
        }
    }

    fn elem_visible(&self, k: ElemKind, i: u32) -> bool {
        match k {
            ElemKind::Vert => self.verts[i as usize].alive && !self.verts[i as usize].hide,
            ElemKind::Edge => self.edges[i as usize].alive && !self.edges[i as usize].hide,
            ElemKind::Face => self.faces[i as usize].alive && !self.faces[i as usize].hide,
        }
    }

    pub fn elem_sel(&self, k: ElemKind, i: u32) -> bool {
        match k {
            ElemKind::Vert => self.verts[i as usize].sel,
            ElemKind::Edge => self.edges[i as usize].sel,
            ElemKind::Face => self.faces[i as usize].sel,
        }
    }

    fn set_elem_sel(&mut self, k: ElemKind, i: u32, s: bool) {
        match k {
            ElemKind::Vert => self.verts[i as usize].sel = s,
            ElemKind::Edge => self.edges[i as usize].sel = s,
            ElemKind::Face => self.faces[i as usize].sel = s,
        }
    }

    // ------------------------------------------------------------ basic ops

    pub fn select_all(&mut self, action: SelectAction) {
        let k: ElemKind = self.select_mode.into();
        let n = self.elem_count(k) as u32;
        let any = (0..n).any(|i| self.elem_visible(k, i) && self.elem_sel(k, i));
        let action = match action {
            SelectAction::Toggle if any => SelectAction::Deselect,
            SelectAction::Toggle => SelectAction::Select,
            a => a,
        };
        for i in 0..n {
            if !self.elem_visible(k, i) {
                continue;
            }
            let s = match action {
                SelectAction::Select => true,
                SelectAction::Deselect => false,
                SelectAction::Invert => !self.elem_sel(k, i),
                SelectAction::Toggle => unreachable!(),
            };
            self.set_elem_sel(k, i, s);
        }
        if action == SelectAction::Deselect {
            self.clear_sel();
            self.active = None;
        }
        self.flush_kind(k);
    }

    /// Selects/deselects specific elements (e.g. from a click or box select).
    pub fn select_elems(&mut self, k: ElemKind, ids: &[u32], op: SelectOp) {
        if op == SelectOp::Set {
            self.clear_sel();
        }
        let n = self.elem_count(k) as u32;
        let mut last = None;
        for &i in ids {
            if i >= n || !self.elem_visible(k, i) {
                continue;
            }
            let s = match op {
                SelectOp::Set | SelectOp::Add => true,
                SelectOp::Sub => false,
                SelectOp::Toggle => !self.elem_sel(k, i),
            };
            self.set_elem_sel(k, i, s);
            if s {
                last = Some(i);
            }
        }
        // Deselecting a vertex/edge must also deselect what depends on it,
        // otherwise a face-to-vertex flush would reselect it.
        self.flush_kind(k);
        if k == ElemKind::from(self.select_mode) {
            if let Some(l) = last {
                if self.active != Some(l) {
                    self.prev_active = self.active;
                }
                self.active = Some(l);
            }
        } else {
            self.flush_select();
        }
    }

    // --------------------------------------------------------- connectivity

    /// Connected vertex components reachable from `seeds` through visible edges.
    fn vert_component(&self, seeds: &[u32]) -> Vec<bool> {
        let mut seen = vec![false; self.verts.len()];
        let mut q: VecDeque<u32> = VecDeque::new();
        for &s in seeds {
            if !seen[s as usize] {
                seen[s as usize] = true;
                q.push_back(s);
            }
        }
        while let Some(v) = q.pop_front() {
            for &e in &self.verts[v as usize].edges {
                if self.edges[e as usize].hide {
                    continue;
                }
                let o = self.other_vert(e, v);
                if !seen[o as usize] && !self.verts[o as usize].hide {
                    seen[o as usize] = true;
                    q.push_back(o);
                }
            }
        }
        seen
    }

    /// Select Linked (Ctrl+L): grows the selection to whole connected parts.
    pub fn select_linked(&mut self) {
        let seeds = self.selected_verts();
        let comp = self.vert_component(&seeds);
        for (i, v) in self.verts.iter_mut().enumerate() {
            if comp[i] {
                v.sel = true;
            }
        }
        self.flush_verts_to_mode();
    }

    /// Select Linked Pick (L / Shift+L): selects or deselects the part
    /// containing element `idx`.
    pub fn select_linked_pick(&mut self, k: ElemKind, idx: u32, deselect: bool) {
        let seeds: Vec<u32> = match k {
            ElemKind::Vert => vec![idx],
            ElemKind::Edge => self.edges[idx as usize].v.to_vec(),
            ElemKind::Face => self.faces[idx as usize].verts.clone(),
        };
        let comp = self.vert_component(&seeds);
        if deselect {
            for i in 0..self.verts.len() {
                if comp[i] {
                    self.verts[i].sel = false;
                }
            }
            for e in self.edges.iter_mut() {
                if comp[e.v[0] as usize] {
                    e.sel = false;
                }
            }
            for f in self.faces.iter_mut() {
                if comp[f.verts[0] as usize] {
                    f.sel = false;
                }
            }
            self.flush_select();
        } else {
            for i in 0..self.verts.len() {
                if comp[i] {
                    self.verts[i].sel = true;
                }
            }
            self.flush_verts_to_mode();
        }
    }

    /// Selects faces connected to the selected faces whose normals differ by
    /// at most `max_angle` radians. With `relative_to_seed`, every candidate
    /// is compared with the normal of the seed face that reached it
    /// (coplanar region); otherwise adjacent faces are compared pairwise
    /// (Blender's "Select Linked Flat Faces").
    pub fn select_linked_flat(&mut self, max_angle: f64, relative_to_seed: bool) -> usize {
        let cos_t = max_angle.clamp(0.0, std::f64::consts::PI).cos() - 1e-9;
        let normals: Vec<DVec3> = (0..self.faces.len() as u32).map(|f| self.face_normal(f)).collect();
        let seeds = self.selected_faces();
        let mut sel = vec![false; self.faces.len()];
        for &s in &seeds {
            sel[s as usize] = true;
        }
        let mut reached = vec![false; self.faces.len()];
        for &seed in &seeds {
            if relative_to_seed {
                reached.iter_mut().for_each(|r| *r = false);
            }
            if reached[seed as usize] {
                continue;
            }
            let seed_n = normals[seed as usize];
            let mut q = VecDeque::from([seed]);
            reached[seed as usize] = true;
            while let Some(f) = q.pop_front() {
                let ref_n = if relative_to_seed { seed_n } else { normals[f as usize] };
                for &e in &self.faces[f as usize].edges {
                    if self.edges[e as usize].hide {
                        continue;
                    }
                    for &g in &self.edges[e as usize].faces {
                        if reached[g as usize] || self.faces[g as usize].hide {
                            continue;
                        }
                        if ref_n.dot(normals[g as usize]) >= cos_t {
                            reached[g as usize] = true;
                            sel[g as usize] = true;
                            q.push_back(g);
                        }
                    }
                }
            }
        }
        let mut count = 0;
        for f in 0..self.faces.len() {
            if sel[f] {
                count += 1;
                self.faces[f].sel = true;
                for k in 0..self.faces[f].verts.len() {
                    let v = self.faces[f].verts[k];
                    let e = self.faces[f].edges[k];
                    self.verts[v as usize].sel = true;
                    self.edges[e as usize].sel = true;
                }
            }
        }
        if self.select_mode == SelectMode::Vert {
            self.flush_from_verts();
        } else {
            self.flush_select();
        }
        count
    }

    /// Select More (Ctrl+Numpad+), stepping across faces.
    pub fn select_more(&mut self) {
        let mut add = vec![false; self.verts.len()];
        for v in self.selected_verts() {
            for f in self.vert_faces(v) {
                if self.faces[f as usize].hide {
                    continue;
                }
                for &w in &self.faces[f as usize].verts {
                    add[w as usize] = true;
                }
            }
            for &e in &self.verts[v as usize].edges {
                if self.edges[e as usize].faces.is_empty() && !self.edges[e as usize].hide {
                    add[self.other_vert(e, v) as usize] = true;
                }
            }
        }
        for (i, v) in self.verts.iter_mut().enumerate() {
            if add[i] && !v.hide {
                v.sel = true;
            }
        }
        self.flush_verts_to_mode();
    }

    /// Select Less (Ctrl+Numpad-).
    pub fn select_less(&mut self) {
        let mut drop = vec![false; self.verts.len()];
        for v in self.selected_verts() {
            let mut boundary = false;
            for f in self.vert_faces(v) {
                if self.faces[f as usize].hide {
                    continue;
                }
                if self.faces[f as usize].verts.iter().any(|&w| !self.verts[w as usize].sel) {
                    boundary = true;
                    break;
                }
            }
            if !boundary {
                for &e in &self.verts[v as usize].edges {
                    if !self.verts[self.other_vert(e, v) as usize].sel {
                        boundary = true;
                    }
                }
            }
            drop[v as usize] = boundary;
        }
        for (i, v) in self.verts.iter_mut().enumerate() {
            if drop[i] {
                v.sel = false;
            }
        }
        self.flush_verts_to_mode();
    }

    /// Select Similar (Shift+G). Returns the number of elements newly selected.
    pub fn select_similar(&mut self, ty: SimilarType, threshold: f64) -> usize {
        let k: ElemKind = self.select_mode.into();
        let n = self.elem_count(k) as u32;
        let refs: Vec<u32> = (0..n).filter(|&i| self.elem_visible(k, i) && self.elem_sel(k, i)).collect();
        if refs.is_empty() {
            return 0;
        }
        let size = self.bounds().map(|(a, b)| (b - a).length()).unwrap_or(1.0).max(1e-9);
        let rel = |a: f64, b: f64| (a - b).abs() <= threshold * a.abs().max(b.abs()).max(1e-12);
        let ang = |a: DVec3, b: DVec3| a.dot(b).clamp(-1.0, 1.0).acos() <= threshold + 1e-9;
        let edge_dir = |m: &Mesh, e: u32| {
            let [a, b] = m.edges[e as usize].v;
            (m.verts[b as usize].co - m.verts[a as usize].co).normalize_or_zero()
        };
        let matches = |m: &Mesh, i: u32, r: u32| -> bool {
            match (k, ty) {
                (ElemKind::Face, SimilarType::Normal) => ang(m.face_normal(i), m.face_normal(r)),
                (ElemKind::Face, SimilarType::Area) => rel(m.face_area(i), m.face_area(r)),
                (ElemKind::Face, SimilarType::Perimeter) => rel(m.face_perimeter(i), m.face_perimeter(r)),
                (ElemKind::Face, SimilarType::Sides) => {
                    m.faces[i as usize].verts.len() == m.faces[r as usize].verts.len()
                }
                (ElemKind::Face, SimilarType::Coplanar) => {
                    let nr = m.face_normal(r);
                    let d = (m.face_center(i) - m.face_center(r)).dot(nr).abs();
                    ang(m.face_normal(i), nr) && d <= 1e-3 * size
                }
                (ElemKind::Edge, SimilarType::Length) => rel(m.edge_length(i), m.edge_length(r)),
                (ElemKind::Edge, SimilarType::Direction) => {
                    let (a, b) = (edge_dir(m, i), edge_dir(m, r));
                    ang(a, b) || ang(a, -b)
                }
                (ElemKind::Edge, SimilarType::FaceCount) => {
                    m.edges[i as usize].faces.len() == m.edges[r as usize].faces.len()
                }
                (ElemKind::Vert, SimilarType::Normal) => ang(m.vert_normal(i), m.vert_normal(r)),
                (ElemKind::Vert, SimilarType::EdgeCount) => {
                    m.verts[i as usize].edges.len() == m.verts[r as usize].edges.len()
                }
                (ElemKind::Vert, SimilarType::FaceCount) => m.vert_faces(i).len() == m.vert_faces(r).len(),
                _ => false,
            }
        };
        let mut hits = Vec::new();
        for i in 0..n {
            if !self.elem_visible(k, i) || self.elem_sel(k, i) {
                continue;
            }
            if refs.iter().any(|&r| matches(self, i, r)) {
                hits.push(i);
            }
        }
        let count = hits.len();
        for i in hits {
            self.set_elem_sel(k, i, true);
        }
        self.flush_kind(k);
        count
    }

    // ------------------------------------------------------- loops & rings

    fn edges_share_face(&self, a: u32, b: u32) -> bool {
        self.edges[a as usize].faces.iter().any(|f| self.edges[b as usize].faces.contains(f))
    }

    fn next_loop_edge(&self, e: u32, v: u32) -> Option<u32> {
        let ve: Vec<u32> =
            self.verts[v as usize].edges.iter().copied().filter(|&x| !self.edges[x as usize].hide).collect();
        let nf = self.edges[e as usize].faces.len();
        if nf == 1 {
            let others: Vec<u32> =
                ve.iter().copied().filter(|&x| x != e && self.edges[x as usize].faces.len() == 1).collect();
            return if others.len() == 1 { Some(others[0]) } else { None };
        }
        if nf == 0 {
            let others: Vec<u32> = ve.iter().copied().filter(|&x| x != e).collect();
            return if others.len() == 1 && self.edges[others[0] as usize].faces.is_empty() {
                Some(others[0])
            } else {
                None
            };
        }
        if ve.len() != 4 || nf != 2 {
            return None;
        }
        let cands: Vec<u32> = ve.iter().copied().filter(|&x| x != e && !self.edges_share_face(x, e)).collect();
        if cands.len() == 1 {
            Some(cands[0])
        } else {
            None
        }
    }

    /// Edge loop through `e` (walks both directions).
    pub fn edge_loop(&self, e: u32) -> Vec<u32> {
        let mut out = vec![e];
        let mut seen: HashSet<u32> = HashSet::from([e]);
        for start_v in self.edges[e as usize].v {
            let mut cur = e;
            let mut v = start_v;
            while let Some(nx) = self.next_loop_edge(cur, v) {
                if !seen.insert(nx) {
                    break;
                }
                out.push(nx);
                v = self.other_vert(nx, v);
                cur = nx;
            }
        }
        out
    }

    /// Edge ring through `e` plus the quads traversed.
    pub fn edge_ring(&self, e: u32) -> (Vec<u32>, Vec<u32>) {
        let mut edges = vec![e];
        let mut faces = Vec::new();
        let mut seen_e: HashSet<u32> = HashSet::from([e]);
        let mut seen_f: HashSet<u32> = HashSet::new();
        let start_faces = self.edges[e as usize].faces.clone();
        for sf in start_faces.into_iter().take(2) {
            let mut cur_e = e;
            let mut f = sf;
            loop {
                let face = &self.faces[f as usize];
                if face.hide || face.verts.len() != 4 || !seen_f.insert(f) {
                    break;
                }
                faces.push(f);
                let i = match face.edges.iter().position(|&x| x == cur_e) {
                    Some(i) => i,
                    None => break,
                };
                let opp = face.edges[(i + 2) % 4];
                if !seen_e.insert(opp) {
                    break;
                }
                edges.push(opp);
                let next_f = self.edges[opp as usize].faces.iter().copied().find(|&g| g != f);
                match next_f {
                    Some(g) if self.edges[opp as usize].faces.len() == 2 => {
                        cur_e = opp;
                        f = g;
                    }
                    _ => break,
                }
            }
        }
        (edges, faces)
    }

    /// Loop select (Alt+click) or ring select (Ctrl+Alt+click) from edge `e`.
    /// In face mode both select the face loop crossing `e`.
    pub fn select_loop(&mut self, e: u32, ring: bool, op: SelectOp) {
        let face_mode = self.select_mode == SelectMode::Face;
        let (edges, faces) = if ring || face_mode { self.edge_ring(e) } else { (self.edge_loop(e), vec![]) };
        let target_sel = match op {
            SelectOp::Sub => false,
            SelectOp::Toggle => !(if face_mode {
                faces.first().map(|&f| self.faces[f as usize].sel).unwrap_or(false)
            } else {
                self.edges[e as usize].sel
            }),
            _ => true,
        };
        if op == SelectOp::Set {
            self.clear_sel();
        }
        if face_mode {
            for f in faces {
                self.faces[f as usize].sel = target_sel;
            }
            self.flush_from_faces();
            return;
        }
        for &x in &edges {
            self.edges[x as usize].sel = target_sel;
        }
        match self.select_mode {
            SelectMode::Edge => self.flush_from_edges(),
            _ => {
                if target_sel {
                    for &x in &edges {
                        let [a, b] = self.edges[x as usize].v;
                        self.verts[a as usize].sel = true;
                        self.verts[b as usize].sel = true;
                    }
                } else {
                    for &x in &edges {
                        let [a, b] = self.edges[x as usize].v;
                        self.verts[a as usize].sel = false;
                        self.verts[b as usize].sel = false;
                    }
                }
                self.flush_from_verts();
            }
        }
    }

    // -------------------------------------------------------- shortest path

    fn dijkstra_verts(&self, from: &[u32], to: &[u32]) -> Option<Vec<u32>> {
        let n = self.verts.len();
        let mut dist = vec![f64::INFINITY; n];
        let mut prev = vec![u32::MAX; n];
        let mut heap = BinaryHeap::new();
        for &s in from {
            dist[s as usize] = 0.0;
            heap.push(HeapItem(0.0, s));
        }
        let targets: HashSet<u32> = to.iter().copied().collect();
        while let Some(HeapItem(d, v)) = heap.pop() {
            if d > dist[v as usize] {
                continue;
            }
            if targets.contains(&v) {
                let mut path = vec![v];
                let mut c = v;
                while prev[c as usize] != u32::MAX {
                    c = prev[c as usize];
                    path.push(c);
                }
                path.reverse();
                return Some(path);
            }
            for &e in &self.verts[v as usize].edges {
                if self.edges[e as usize].hide {
                    continue;
                }
                let o = self.other_vert(e, v);
                let nd = d + self.edge_length(e);
                if nd < dist[o as usize] {
                    dist[o as usize] = nd;
                    prev[o as usize] = v;
                    heap.push(HeapItem(nd, o));
                }
            }
        }
        None
    }

    fn dijkstra_faces(&self, from: u32, to: u32) -> Option<Vec<u32>> {
        let n = self.faces.len();
        let centers: Vec<DVec3> = (0..n as u32).map(|f| self.face_center(f)).collect();
        let mut dist = vec![f64::INFINITY; n];
        let mut prev = vec![u32::MAX; n];
        let mut heap = BinaryHeap::from([HeapItem(0.0, from)]);
        dist[from as usize] = 0.0;
        while let Some(HeapItem(d, f)) = heap.pop() {
            if d > dist[f as usize] {
                continue;
            }
            if f == to {
                let mut path = vec![f];
                let mut c = f;
                while prev[c as usize] != u32::MAX {
                    c = prev[c as usize];
                    path.push(c);
                }
                return Some(path);
            }
            for g in self.face_neighbors(f) {
                if self.faces[g as usize].hide {
                    continue;
                }
                let nd = d + centers[f as usize].distance(centers[g as usize]);
                if nd < dist[g as usize] {
                    dist[g as usize] = nd;
                    prev[g as usize] = f;
                    heap.push(HeapItem(nd, g));
                }
            }
        }
        None
    }

    /// Pick Shortest Path (Ctrl+click): selects the path from the active
    /// element to `target`. Returns false when no path exists.
    pub fn select_shortest_path(&mut self, target: u32) -> bool {
        let Some(src) = self.active else {
            self.select_elems(self.select_mode.into(), &[target], SelectOp::Add);
            return true;
        };
        match self.select_mode {
            SelectMode::Vert => {
                let Some(path) = self.dijkstra_verts(&[src], &[target]) else { return false };
                for v in path {
                    self.verts[v as usize].sel = true;
                }
                self.flush_from_verts();
            }
            SelectMode::Edge => {
                let from = self.edges[src as usize].v;
                let to = self.edges[target as usize].v;
                let Some(path) = self.dijkstra_verts(&from, &to) else { return false };
                for w in path.windows(2) {
                    if let Some(e) = self.find_edge(w[0], w[1]) {
                        self.edges[e as usize].sel = true;
                    }
                }
                self.edges[src as usize].sel = true;
                self.edges[target as usize].sel = true;
                self.flush_from_edges();
            }
            SelectMode::Face => {
                let Some(path) = self.dijkstra_faces(src, target) else { return false };
                for f in path {
                    self.faces[f as usize].sel = true;
                }
                self.flush_from_faces();
            }
        }
        self.prev_active = Some(src);
        self.active = Some(target);
        true
    }

    // ------------------------------------------------------- trait selects

    fn ensure_not_face_mode(&mut self) {
        if self.select_mode == SelectMode::Face {
            self.set_select_mode(SelectMode::Edge);
        }
    }

    fn select_edges_add(&mut self, edges: &[u32]) {
        for &e in edges {
            self.edges[e as usize].sel = true;
            let [a, b] = self.edges[e as usize].v;
            self.verts[a as usize].sel = true;
            self.verts[b as usize].sel = true;
        }
        match self.select_mode {
            SelectMode::Edge => self.flush_from_edges(),
            _ => self.flush_from_verts(),
        }
    }

    /// Selects wire, boundary and non-manifold edges plus loose vertices.
    pub fn select_non_manifold(&mut self) -> usize {
        self.ensure_not_face_mode();
        let edges: Vec<u32> = (0..self.edges.len() as u32)
            .filter(|&e| {
                let ed = &self.edges[e as usize];
                ed.alive && !ed.hide && ed.faces.len() != 2
            })
            .collect();
        let mut n = edges.len();
        for v in self.verts.iter_mut() {
            if v.alive && !v.hide && v.edges.is_empty() {
                v.sel = true;
                n += 1;
            }
        }
        self.select_edges_add(&edges);
        n
    }

    /// Selects edges whose adjacent faces meet at more than `angle` radians.
    pub fn select_sharp_edges(&mut self, angle: f64) -> usize {
        self.ensure_not_face_mode();
        let edges: Vec<u32> = (0..self.edges.len() as u32)
            .filter(|&e| {
                let ed = &self.edges[e as usize];
                if !ed.alive || ed.hide || ed.faces.len() != 2 {
                    return false;
                }
                let a = self.face_normal(ed.faces[0]);
                let b = self.face_normal(ed.faces[1]);
                a.dot(b).clamp(-1.0, 1.0).acos() > angle
            })
            .collect();
        self.select_edges_add(&edges);
        edges.len()
    }

    /// Selects vertices without edges and edges without faces.
    pub fn select_loose(&mut self) -> usize {
        self.ensure_not_face_mode();
        let edges: Vec<u32> = (0..self.edges.len() as u32)
            .filter(|&e| self.edges[e as usize].alive && !self.edges[e as usize].hide && self.edges[e as usize].faces.is_empty())
            .collect();
        let mut n = edges.len();
        for v in self.verts.iter_mut() {
            if v.alive && !v.hide && v.edges.is_empty() {
                v.sel = true;
                n += 1;
            }
        }
        self.select_edges_add(&edges);
        n
    }

    pub fn select_faces_by_sides(&mut self, sides: usize, cmp: Compare) -> usize {
        let mut n = 0;
        for f in self.faces.iter_mut() {
            if !f.alive || f.hide {
                continue;
            }
            let c = f.verts.len();
            let ok = match cmp {
                Compare::Equal => c == sides,
                Compare::Greater => c > sides,
                Compare::Less => c < sides,
                Compare::NotEqual => c != sides,
            };
            if ok {
                f.sel = true;
                n += 1;
            }
        }
        self.add_face_sel_flush();
        n
    }

    /// After setting face flags additively, propagate to verts/edges and the mode.
    pub(crate) fn add_face_sel_flush(&mut self) {
        for f in 0..self.faces.len() {
            if self.faces[f].sel && self.faces[f].alive {
                for k in 0..self.faces[f].verts.len() {
                    let v = self.faces[f].verts[k];
                    let e = self.faces[f].edges[k];
                    self.verts[v as usize].sel = true;
                    self.edges[e as usize].sel = true;
                }
            }
        }
        if self.select_mode == SelectMode::Vert {
            self.flush_from_verts();
        } else {
            self.flush_select();
        }
    }

    /// Randomly selects `ratio` of the visible elements in the current mode.
    pub fn select_random(&mut self, ratio: f64, seed: u64) -> usize {
        let k: ElemKind = self.select_mode.into();
        let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) | 1;
        let mut n = 0;
        for i in 0..self.elem_count(k) as u32 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let r = (state >> 11) as f64 / (1u64 << 53) as f64;
            if self.elem_visible(k, i) && r < ratio {
                self.set_elem_sel(k, i, true);
                n += 1;
            }
        }
        self.flush_kind(k);
        n
    }

    /// Select Boundary Loop: replaces a face selection with its outline edges.
    pub fn select_boundary_loop(&mut self) -> usize {
        let mut edges = Vec::new();
        for e in 0..self.edges.len() as u32 {
            let ed = &self.edges[e as usize];
            if !ed.alive {
                continue;
            }
            let nsel = ed.faces.iter().filter(|&&f| self.faces[f as usize].sel).count();
            if nsel == 1 {
                edges.push(e);
            }
        }
        self.clear_sel();
        self.select_mode = SelectMode::Edge;
        self.active = None;
        for &e in &edges {
            self.edges[e as usize].sel = true;
        }
        self.flush_from_edges();
        edges.len()
    }

    /// Select Loop Inner-Region: selects the faces enclosed by selected edges
    /// (the smaller region when the loop splits the mesh in two).
    pub fn select_loop_inner_region(&mut self) -> usize {
        let border: HashSet<u32> = self.selected_edges().into_iter().collect();
        if border.is_empty() {
            return 0;
        }
        let mut region = vec![u32::MAX; self.faces.len()];
        let mut regions: Vec<Vec<u32>> = Vec::new();
        for start in 0..self.faces.len() as u32 {
            if region[start as usize] != u32::MAX || !self.faces[start as usize].alive || self.faces[start as usize].hide {
                continue;
            }
            let id = regions.len() as u32;
            let mut members = vec![];
            let mut q = VecDeque::from([start]);
            region[start as usize] = id;
            while let Some(f) = q.pop_front() {
                members.push(f);
                for &e in &self.faces[f as usize].edges {
                    if border.contains(&e) {
                        continue;
                    }
                    for &g in &self.edges[e as usize].faces {
                        if region[g as usize] == u32::MAX && !self.faces[g as usize].hide {
                            region[g as usize] = id;
                            q.push_back(g);
                        }
                    }
                }
            }
            regions.push(members);
        }
        // Only regions touching the border are candidates.
        let touching: Vec<&Vec<u32>> = regions
            .iter()
            .filter(|r| r.iter().any(|&f| self.faces[f as usize].edges.iter().any(|e| border.contains(e))))
            .collect();
        let Some(best) = touching.iter().min_by_key(|r| r.len()) else { return 0 };
        let best: Vec<u32> = best.to_vec();
        self.clear_sel();
        self.select_mode = SelectMode::Face;
        self.active = None;
        for &f in &best {
            self.faces[f as usize].sel = true;
        }
        self.flush_from_faces();
        best.len()
    }

    // ---------------------------------------------------------- hide/reveal

    /// Hide (H) selected, or unselected with `unselected` (Shift+H).
    pub fn hide(&mut self, unselected: bool) {
        let k: ElemKind = self.select_mode.into();
        let targets: Vec<u32> = (0..self.elem_count(k) as u32)
            .filter(|&i| self.elem_visible(k, i) && self.elem_sel(k, i) != unselected)
            .collect();
        match k {
            ElemKind::Vert => {
                for &v in &targets {
                    self.verts[v as usize].hide = true;
                }
                for i in 0..self.edges.len() {
                    let [a, b] = self.edges[i].v;
                    if self.verts[a as usize].hide || self.verts[b as usize].hide {
                        self.edges[i].hide = true;
                    }
                }
                for i in 0..self.faces.len() {
                    if self.faces[i].verts.iter().any(|&v| self.verts[v as usize].hide) {
                        self.faces[i].hide = true;
                    }
                }
            }
            ElemKind::Edge => {
                for &e in &targets {
                    self.edges[e as usize].hide = true;
                }
                for i in 0..self.faces.len() {
                    if self.faces[i].edges.iter().any(|&e| self.edges[e as usize].hide) {
                        self.faces[i].hide = true;
                    }
                }
                for i in 0..self.verts.len() {
                    let v = &self.verts[i];
                    if !v.edges.is_empty() && v.edges.iter().all(|&e| self.edges[e as usize].hide) {
                        self.verts[i].hide = true;
                    }
                }
            }
            ElemKind::Face => {
                for &f in &targets {
                    self.faces[f as usize].hide = true;
                }
                for i in 0..self.edges.len() {
                    let e = &self.edges[i];
                    if !e.faces.is_empty() && e.faces.iter().all(|&f| self.faces[f as usize].hide) {
                        self.edges[i].hide = true;
                    }
                }
                for i in 0..self.verts.len() {
                    let v = &self.verts[i];
                    if !v.edges.is_empty() && v.edges.iter().all(|&e| self.edges[e as usize].hide) {
                        self.verts[i].hide = true;
                    }
                }
            }
        }
        self.active = None;
        self.flush_select();
    }

    /// Reveal (Alt+H): unhides everything; revealed elements become selected
    /// when `select` is set.
    pub fn reveal(&mut self, select: bool) {
        for v in self.verts.iter_mut() {
            if v.hide {
                v.hide = false;
                v.sel = select;
            }
        }
        for e in self.edges.iter_mut() {
            if e.hide {
                e.hide = false;
                e.sel = select;
            }
        }
        for f in self.faces.iter_mut() {
            if f.hide {
                f.hide = false;
                f.sel = select;
            }
        }
        self.flush_select();
    }

    /// Selection histogram for the UI.
    pub fn selection_center(&self) -> Option<DVec3> {
        let sel = self.selected_verts();
        if sel.is_empty() {
            return None;
        }
        Some(sel.iter().map(|&v| self.verts[v as usize].co).sum::<DVec3>() / sel.len() as f64)
    }

    /// Groups of selected vertices connected via selected edges.
    pub fn selected_islands(&self) -> Vec<Vec<u32>> {
        let mut seen: HashMap<u32, ()> = HashMap::new();
        let mut out = Vec::new();
        for v in self.selected_verts() {
            if seen.contains_key(&v) {
                continue;
            }
            let mut island = vec![];
            let mut q = VecDeque::from([v]);
            seen.insert(v, ());
            while let Some(x) = q.pop_front() {
                island.push(x);
                for &e in &self.verts[x as usize].edges {
                    if !self.edges[e as usize].sel {
                        continue;
                    }
                    let o = self.other_vert(e, x);
                    if !seen.contains_key(&o) {
                        seen.insert(o, ());
                        q.push_back(o);
                    }
                }
            }
            out.push(island);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives;
    use crate::test_util::*;

    #[test]
    fn select_all_and_invert() {
        let mut m = cube();
        m.select_all(SelectAction::Select);
        assert_eq!(m.selected_counts(), (8, 12, 6));
        m.select_all(SelectAction::Toggle);
        assert_eq!(m.selected_counts(), (0, 0, 0));
        m.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        m.select_all(SelectAction::Invert);
        assert_eq!(m.selected_counts().0, 7);
    }

    #[test]
    fn mode_switch_flush() {
        let mut m = cube();
        m.set_select_mode(SelectMode::Face);
        m.select_elems(ElemKind::Face, &[0], SelectOp::Set);
        assert_eq!(m.selected_counts(), (4, 4, 1));
        m.set_select_mode(SelectMode::Vert);
        assert_eq!(m.selected_counts(), (4, 4, 1));
        // Deselect one vertex of the face -> face deselected.
        m.select_elems(ElemKind::Vert, &[m.faces[0].verts[0]], SelectOp::Sub);
        assert_eq!(m.selected_counts(), (3, 2, 0));
    }

    #[test]
    fn linked_selects_island_only() {
        let mut m = cube();
        let other = primitives::cube(1.0);
        crate::ops::append(&mut m, &other, glam::DVec3::new(3.0, 0.0, 0.0));
        m.select_all(SelectAction::Deselect);
        m.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        m.select_linked();
        assert_eq!(m.selected_counts(), (8, 12, 6));
        m.select_linked_pick(ElemKind::Vert, 9, false);
        assert_eq!(m.selected_counts().0, 16);
        m.select_linked_pick(ElemKind::Vert, 0, true);
        assert_eq!(m.selected_counts().0, 8);
    }

    #[test]
    fn linked_flat_faces() {
        // A grid is entirely flat; a cube is not.
        let mut g = grid(4);
        g.set_select_mode(SelectMode::Face);
        g.select_elems(ElemKind::Face, &[0], SelectOp::Set);
        assert_eq!(g.select_linked_flat(1f64.to_radians(), false), 16);

        let mut c = cube();
        c.set_select_mode(SelectMode::Face);
        c.select_elems(ElemKind::Face, &[0], SelectOp::Set);
        c.select_linked_flat(1f64.to_radians(), false);
        assert_eq!(c.selected_counts().2, 1);
        c.select_linked_flat(91f64.to_radians(), false);
        assert_eq!(c.selected_counts().2, 6);
    }

    #[test]
    fn linked_flat_on_triangulated_cylinder() {
        let mut m = primitives::cylinder(16, 1.0, 1.0);
        crate::ops::triangulate_all(&mut m);
        m.set_select_mode(SelectMode::Face);
        // Find a cap triangle (normal ~ +Z).
        let cap = (0..m.faces.len() as u32).find(|&f| m.face_normal(f).z > 0.99).unwrap();
        m.select_elems(ElemKind::Face, &[cap], SelectOp::Set);
        m.select_linked_flat(5f64.to_radians(), false);
        assert_eq!(m.selected_counts().2, 14); // 16-gon -> 14 triangles
        // Side faces differ by 22.5 deg between neighbours.
        let side = (0..m.faces.len() as u32).find(|&f| m.face_normal(f).z.abs() < 0.01).unwrap();
        m.select_elems(ElemKind::Face, &[side], SelectOp::Set);
        m.select_linked_flat(30f64.to_radians(), false);
        assert_eq!(m.selected_counts().2, 32);
        m.select_elems(ElemKind::Face, &[side], SelectOp::Set);
        m.select_linked_flat(30f64.to_radians(), true);
        assert!(m.selected_counts().2 < 32);
    }

    #[test]
    fn more_less() {
        let mut g = grid(4);
        let center = 12; // vertex (2,2) of 5x5
        g.select_elems(ElemKind::Vert, &[center], SelectOp::Set);
        g.select_more();
        assert_eq!(g.selected_counts().0, 9);
        g.select_less();
        assert_eq!(g.selected_counts().0, 1);
    }

    #[test]
    fn loops_and_rings() {
        let g = grid(4);
        let e = g.find_edge(6, 7).unwrap(); // horizontal interior edge on row 1
        assert_eq!(g.edge_loop(e).len(), 4);
        assert_eq!(g.edge_ring(e).0.len(), 5);
        let c = cube();
        let e = c.find_edge(0, 1).unwrap();
        assert_eq!(c.edge_loop(e).len(), 1); // cube corners have valence 3
        assert_eq!(c.edge_ring(e).0.len(), 4);
    }

    #[test]
    fn shortest_path_verts() {
        let mut g = grid(4);
        g.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        assert!(g.select_shortest_path(4));
        assert_eq!(g.selected_counts().0, 5);
    }

    #[test]
    fn hide_reveal() {
        let mut c = cube();
        c.set_select_mode(SelectMode::Face);
        c.select_elems(ElemKind::Face, &[0], SelectOp::Set);
        c.hide(false);
        assert_eq!(c.faces.iter().filter(|f| f.hide).count(), 1);
        c.select_all(SelectAction::Select);
        assert_eq!(c.selected_counts().2, 5);
        c.reveal(true);
        assert!(c.faces[0].sel && !c.faces[0].hide);
    }

    #[test]
    fn similar_and_non_manifold() {
        let mut g = grid(3);
        assert_eq!(g.select_non_manifold(), 12);
        let mut c = cube();
        c.set_select_mode(SelectMode::Face);
        c.select_elems(ElemKind::Face, &[0], SelectOp::Set);
        assert_eq!(c.select_similar(SimilarType::Area, 0.01), 5);
        assert_eq!(c.select_boundary_loop(), 0);
    }

    #[test]
    fn inner_region() {
        let mut g = grid(4);
        g.set_select_mode(SelectMode::Face);
        g.select_elems(ElemKind::Face, &[5], SelectOp::Set);
        g.select_boundary_loop();
        assert_eq!(g.selected_counts().1, 4);
        assert_eq!(g.select_loop_inner_region(), 1);
    }
}
