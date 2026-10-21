//! Edit session around a [`Mesh`]: undo/redo history and interactive
//! (modal) transforms with proportional editing.

use crate::ops::{OpError, OpResult};
use crate::Mesh;
use glam::{DMat4, DVec3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Falloff {
    #[default]
    Smooth,
    Sphere,
    Root,
    Sharp,
    Linear,
    Constant,
}

impl Falloff {
    /// `t` is 1 at the selection and 0 at the radius.
    pub fn weight(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Falloff::Smooth => t * t * (3.0 - 2.0 * t),
            Falloff::Sphere => (2.0 * t - t * t).sqrt(),
            Falloff::Root => t.sqrt(),
            Falloff::Sharp => t * t,
            Falloff::Linear => t,
            Falloff::Constant => 1.0,
        }
    }
}

struct Snapshot {
    mesh: Mesh,
    label: String,
}

struct TransformSession {
    affected: Vec<(u32, DVec3, f64)>,
    last: DMat4,
}

pub struct Editor {
    pub mesh: Mesh,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    /// Upper bound on stored elements across all undo snapshots.
    pub undo_budget: usize,
    pub max_undo: usize,
    transform: Option<TransformSession>,
    /// Incremented on any change, including selection.
    pub version: u64,
    /// Incremented when geometry or visibility changes (not on pure selection).
    pub geom_version: u64,
    /// Whether the mesh differs from what was loaded/saved.
    pub dirty: bool,
}

fn mesh_size(m: &Mesh) -> usize {
    m.verts.len() + m.edges.len() + m.faces.len()
}

impl Editor {
    pub fn new(mesh: Mesh) -> Self {
        Self {
            mesh,
            undo: Vec::new(),
            redo: Vec::new(),
            undo_budget: 12_000_000,
            max_undo: 64,
            transform: None,
            version: 0,
            geom_version: 0,
            dirty: false,
        }
    }

    pub fn push_undo(&mut self, label: &str) {
        self.undo.push(Snapshot { mesh: self.mesh.clone(), label: label.to_string() });
        self.redo.clear();
        let mut total: usize = self.undo.iter().map(|s| mesh_size(&s.mesh)).sum();
        while self.undo.len() > self.max_undo || (total > self.undo_budget && self.undo.len() > 1) {
            total -= mesh_size(&self.undo[0].mesh);
            self.undo.remove(0);
        }
    }

    fn touched(&mut self) {
        self.version += 1;
        self.geom_version += 1;
        self.dirty = true;
    }

    /// Records an undo step without changing anything (e.g. before a
    /// multi-step interactive selection like circle select).
    pub fn push_undo_step(&mut self, label: &str) {
        self.push_undo(label);
    }

    /// Runs an operator with undo support; on error the mesh is restored.
    pub fn apply<T>(&mut self, label: &str, f: impl FnOnce(&mut Mesh) -> OpResult<T>) -> OpResult<T> {
        let backup = self.mesh.clone();
        match f(&mut self.mesh) {
            Ok(v) => {
                self.undo.push(Snapshot { mesh: backup, label: label.to_string() });
                self.redo.clear();
                let keep = self.max_undo;
                if self.undo.len() > keep {
                    self.undo.remove(0);
                }
                self.touched();
                Ok(v)
            }
            Err(e) => {
                self.mesh = backup;
                Err(e)
            }
        }
    }

    /// Selection-only change: recorded for undo but does not mark dirty.
    pub fn apply_select<T>(&mut self, f: impl FnOnce(&mut Mesh) -> T) -> T {
        self.push_undo("Select");
        let r = f(&mut self.mesh);
        self.version += 1;
        r
    }

    /// Re-runs the most recent operator with new parameters (the "Adjust
    /// Last Operation" panel): restores the pre-op state and applies `f`.
    pub fn redo_last<T>(&mut self, f: impl FnOnce(&mut Mesh) -> OpResult<T>) -> OpResult<T> {
        let Some(prev) = self.undo.last() else {
            return Err(OpError::Invalid("nothing to adjust".into()));
        };
        let label = prev.label.clone();
        let mut candidate = prev.mesh.clone();
        let r = f(&mut candidate)?;
        self.mesh = candidate;
        self.redo.clear();
        let _ = label;
        self.touched();
        Ok(r)
    }

    pub fn undo(&mut self) -> Option<String> {
        let s = self.undo.pop()?;
        let cur = std::mem::replace(&mut self.mesh, s.mesh);
        self.redo.push(Snapshot { mesh: cur, label: s.label.clone() });
        self.touched();
        Some(s.label)
    }

    pub fn redo(&mut self) -> Option<String> {
        let s = self.redo.pop()?;
        let cur = std::mem::replace(&mut self.mesh, s.mesh);
        self.undo.push(Snapshot { mesh: cur, label: s.label.clone() });
        self.touched();
        Some(s.label)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear_history(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    // ------------------------------------------------------------ transform

    /// Starts an interactive transform of the selection. With
    /// `prop_radius > 0`, unselected vertices within that distance follow
    /// with a falloff weight (proportional editing, O).
    pub fn begin_transform(&mut self, prop_radius: f64, falloff: Falloff, connected_only: bool) -> OpResult<usize> {
        let sel = self.mesh.selected_verts();
        if sel.is_empty() {
            return Err(OpError::NothingSelected);
        }
        self.push_undo("Transform");
        let mut affected: Vec<(u32, DVec3, f64)> =
            sel.iter().map(|&v| (v, self.mesh.verts[v as usize].co, 1.0)).collect();
        if prop_radius > 0.0 {
            let dist = if connected_only {
                self.geodesic_distances(&sel, prop_radius)
            } else {
                self.euclidean_distances(&sel, prop_radius)
            };
            for (v, d) in dist {
                if self.mesh.verts[v as usize].sel || self.mesh.verts[v as usize].hide {
                    continue;
                }
                let w = falloff.weight(1.0 - d / prop_radius);
                if w > 0.0 {
                    affected.push((v, self.mesh.verts[v as usize].co, w));
                }
            }
        }
        let n = affected.len();
        self.transform = Some(TransformSession { affected, last: DMat4::IDENTITY });
        Ok(n)
    }

    fn euclidean_distances(&self, sel: &[u32], r: f64) -> HashMap<u32, f64> {
        let cell = r.max(1e-9);
        let key = |p: DVec3| ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64, (p.z / cell).floor() as i64);
        let mut grid: HashMap<(i64, i64, i64), Vec<DVec3>> = HashMap::new();
        for &v in sel {
            let p = self.mesh.verts[v as usize].co;
            grid.entry(key(p)).or_default().push(p);
        }
        let mut out = HashMap::new();
        for (i, v) in self.mesh.verts.iter().enumerate() {
            if !v.alive || v.sel {
                continue;
            }
            let k = key(v.co);
            let mut best = f64::INFINITY;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(list) = grid.get(&(k.0 + dx, k.1 + dy, k.2 + dz)) {
                            for p in list {
                                best = best.min(p.distance(v.co));
                            }
                        }
                    }
                }
            }
            if best < r {
                out.insert(i as u32, best);
            }
        }
        out
    }

    fn geodesic_distances(&self, sel: &[u32], r: f64) -> HashMap<u32, f64> {
        use std::collections::BinaryHeap;
        #[derive(PartialEq)]
        struct It(f64, u32);
        impl Eq for It {}
        impl PartialOrd for It {
            fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Ord for It {
            fn cmp(&self, o: &Self) -> std::cmp::Ordering {
                o.0.partial_cmp(&self.0).unwrap_or(std::cmp::Ordering::Equal)
            }
        }
        let mut dist: HashMap<u32, f64> = sel.iter().map(|&v| (v, 0.0)).collect();
        let mut heap: BinaryHeap<It> = sel.iter().map(|&v| It(0.0, v)).collect();
        while let Some(It(d, v)) = heap.pop() {
            if d > *dist.get(&v).unwrap_or(&f64::INFINITY) {
                continue;
            }
            for &e in &self.mesh.verts[v as usize].edges {
                let o = self.mesh.other_vert(e, v);
                let nd = d + self.mesh.edge_length(e);
                if nd < r && nd < *dist.get(&o).unwrap_or(&f64::INFINITY) {
                    dist.insert(o, nd);
                    heap.push(It(nd, o));
                }
            }
        }
        dist
    }

    /// Sets the current transform (relative to the start of the session).
    pub fn update_transform(&mut self, m: DMat4) {
        let Some(t) = &mut self.transform else { return };
        for &(v, orig, w) in &t.affected {
            let full = m.transform_point3(orig);
            self.mesh.verts[v as usize].co = orig.lerp(full, w);
        }
        t.last = m;
        self.version += 1;
        self.geom_version += 1;
    }

    /// Finishes the transform; `commit = false` restores the original positions.
    pub fn end_transform(&mut self, commit: bool) {
        let Some(t) = self.transform.take() else { return };
        if commit {
            if t.last.determinant() < 0.0 {
                for f in self.mesh.selected_faces() {
                    self.mesh.reverse_face(f);
                }
            }
            self.touched();
        } else {
            for &(v, orig, _) in &t.affected {
                self.mesh.verts[v as usize].co = orig;
            }
            self.undo.pop();
            self.version += 1;
            self.geom_version += 1;
        }
    }

    pub fn in_transform(&self) -> bool {
        self.transform.is_some()
    }

    /// Ids of vertices moving in the current transform session.
    pub fn transform_vert_ids(&self) -> Vec<u32> {
        self.transform.as_ref().map(|t| t.affected.iter().map(|a| a.0).collect()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::DeleteKind;
    use crate::primitives;
    use crate::select::{SelectAction, SelectOp};
    use crate::ElemKind;

    #[test]
    fn undo_redo_roundtrip() {
        let mut ed = Editor::new(primitives::cube(1.0));
        ed.mesh.select_elems(ElemKind::Vert, &[0], SelectOp::Set);
        ed.apply("Delete", |m| m.delete(DeleteKind::Verts)).unwrap();
        assert_eq!(ed.mesh.live_counts().0, 7);
        assert_eq!(ed.undo().as_deref(), Some("Delete"));
        assert_eq!(ed.mesh.live_counts().0, 8);
        ed.redo();
        assert_eq!(ed.mesh.live_counts().0, 7);
        // Failing operators leave no history.
        ed.mesh.select_all(SelectAction::Deselect);
        assert!(ed.apply("Delete", |m| m.delete(DeleteKind::Verts)).is_err());
        ed.undo();
        assert_eq!(ed.mesh.live_counts().0, 8);
    }

    #[test]
    fn transform_cancel_and_proportional() {
        let mut ed = Editor::new(primitives::grid(4, 4, 4.0));
        ed.mesh.select_elems(ElemKind::Vert, &[12], SelectOp::Set);
        let n = ed.begin_transform(1.5, Falloff::Linear, false).unwrap();
        assert!(n > 1);
        ed.update_transform(DMat4::from_translation(DVec3::Z));
        assert!((ed.mesh.verts[12].co.z - 1.0).abs() < 1e-9);
        let neighbour = ed.mesh.verts[13].co.z;
        assert!(neighbour > 0.0 && neighbour < 1.0);
        ed.end_transform(false);
        assert_eq!(ed.mesh.verts[12].co.z, 0.0);
        assert!(!ed.can_undo());
        ed.begin_transform(0.0, Falloff::Smooth, false).unwrap();
        ed.update_transform(DMat4::from_translation(DVec3::Z));
        ed.end_transform(true);
        assert_eq!(ed.mesh.verts[13].co.z, 0.0);
        assert!(ed.can_undo());
    }

    #[test]
    fn adjust_last() {
        let mut ed = Editor::new(primitives::cube(1.0));
        ed.mesh.set_select_mode(crate::SelectMode::Face);
        ed.mesh.select_elems(ElemKind::Face, &[1], SelectOp::Set);
        ed.apply("Inset", |m| m.inset(0.1, 0.0, false)).unwrap();
        ed.redo_last(|m| m.inset(0.2, 0.0, false)).unwrap();
        let f = ed.mesh.selected_faces()[0];
        assert!((ed.mesh.face_area(f) - 0.36).abs() < 1e-9);
        ed.undo();
        assert_eq!(ed.mesh.live_counts().2, 6);
    }
}
