//! Screen-space picking helpers. `mvp` maps mesh-local coordinates to clip
//! space (column-major, as in three.js `Matrix4.elements`). Screen
//! coordinates are in pixels with the origin at the top-left.

use crate::Mesh;
use glam::{DMat4, DVec2, DVec3};

pub struct Projector {
    m: DMat4,
    w: f64,
    h: f64,
}

impl Projector {
    pub fn new(mvp: &[f64], w: f64, h: f64) -> Self {
        let mut arr = [0.0; 16];
        arr.copy_from_slice(&mvp[..16]);
        Self { m: DMat4::from_cols_array(&arr), w, h }
    }

    /// Returns screen position and NDC depth; `None` when behind the camera.
    pub fn project(&self, p: DVec3) -> Option<(DVec2, f64)> {
        let c = self.m * p.extend(1.0);
        if c.w <= 1e-9 {
            return None;
        }
        let ndc = c.truncate() / c.w;
        Some((DVec2::new((ndc.x * 0.5 + 0.5) * self.w, (1.0 - (ndc.y * 0.5 + 0.5)) * self.h), ndc.z))
    }
}

fn seg_dist(p: DVec2, a: DVec2, b: DVec2) -> f64 {
    let ab = b - a;
    let t = if ab.length_squared() < 1e-12 { 0.0 } else { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
    p.distance(a + ab * t)
}

impl Mesh {
    fn visible_vert(&self, v: usize) -> bool {
        self.verts[v].alive && !self.verts[v].hide
    }

    /// Vertices whose projection lies inside the rectangle.
    pub fn verts_in_rect(&self, pr: &Projector, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u32> {
        let (lo, hi) = (DVec2::new(x0.min(x1), y0.min(y1)), DVec2::new(x0.max(x1), y0.max(y1)));
        (0..self.verts.len())
            .filter(|&v| self.visible_vert(v))
            .filter(|&v| {
                pr.project(self.verts[v].co)
                    .map(|(s, _)| s.x >= lo.x && s.x <= hi.x && s.y >= lo.y && s.y <= hi.y)
                    .unwrap_or(false)
            })
            .map(|v| v as u32)
            .collect()
    }

    pub fn verts_in_circle(&self, pr: &Projector, cx: f64, cy: f64, r: f64) -> Vec<u32> {
        let c = DVec2::new(cx, cy);
        (0..self.verts.len())
            .filter(|&v| self.visible_vert(v))
            .filter(|&v| pr.project(self.verts[v].co).map(|(s, _)| s.distance(c) <= r).unwrap_or(false))
            .map(|v| v as u32)
            .collect()
    }

    /// Edges with both endpoints inside the rectangle.
    pub fn edges_in_rect(&self, pr: &Projector, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u32> {
        let inside: std::collections::HashSet<u32> = self.verts_in_rect(pr, x0, y0, x1, y1).into_iter().collect();
        (0..self.edges.len() as u32)
            .filter(|&e| {
                let ed = &self.edges[e as usize];
                ed.alive && !ed.hide && inside.contains(&ed.v[0]) && inside.contains(&ed.v[1])
            })
            .collect()
    }

    /// Edges whose screen segment passes within the circle.
    pub fn edges_in_circle(&self, pr: &Projector, cx: f64, cy: f64, r: f64) -> Vec<u32> {
        let c = DVec2::new(cx, cy);
        (0..self.edges.len() as u32)
            .filter(|&e| {
                let ed = &self.edges[e as usize];
                if !ed.alive || ed.hide {
                    return false;
                }
                match (pr.project(self.verts[ed.v[0] as usize].co), pr.project(self.verts[ed.v[1] as usize].co)) {
                    (Some((a, _)), Some((b, _))) => seg_dist(c, a, b) <= r,
                    _ => false,
                }
            })
            .collect()
    }

    /// Faces whose center projects inside the rectangle.
    pub fn faces_in_rect(&self, pr: &Projector, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u32> {
        let (lo, hi) = (DVec2::new(x0.min(x1), y0.min(y1)), DVec2::new(x0.max(x1), y0.max(y1)));
        (0..self.faces.len() as u32)
            .filter(|&f| self.faces[f as usize].alive && !self.faces[f as usize].hide)
            .filter(|&f| {
                pr.project(self.face_center(f))
                    .map(|(s, _)| s.x >= lo.x && s.x <= hi.x && s.y >= lo.y && s.y <= hi.y)
                    .unwrap_or(false)
            })
            .collect()
    }

    pub fn faces_in_circle(&self, pr: &Projector, cx: f64, cy: f64, r: f64) -> Vec<u32> {
        let c = DVec2::new(cx, cy);
        (0..self.faces.len() as u32)
            .filter(|&f| self.faces[f as usize].alive && !self.faces[f as usize].hide)
            .filter(|&f| pr.project(self.face_center(f)).map(|(s, _)| s.distance(c) <= r).unwrap_or(false))
            .collect()
    }

    /// Vertices within `radius` pixels of the cursor, nearest first.
    pub fn nearest_verts(&self, pr: &Projector, mx: f64, my: f64, radius: f64, max: usize) -> Vec<u32> {
        let m = DVec2::new(mx, my);
        let mut hits: Vec<(f64, f64, u32)> = (0..self.verts.len())
            .filter(|&v| self.visible_vert(v))
            .filter_map(|v| {
                let (s, z) = pr.project(self.verts[v].co)?;
                let d = s.distance(m);
                (d <= radius).then_some((d, z, v as u32))
            })
            .collect();
        hits.sort_by(|a, b| (a.0, a.1).partial_cmp(&(b.0, b.1)).unwrap());
        hits.into_iter().take(max).map(|h| h.2).collect()
    }

    /// Edges within `radius` pixels of the cursor, nearest first. Also returns
    /// the parametric position of the closest point along each edge.
    pub fn nearest_edges(&self, pr: &Projector, mx: f64, my: f64, radius: f64, max: usize) -> Vec<(u32, f64)> {
        let m = DVec2::new(mx, my);
        let mut hits: Vec<(f64, u32, f64)> = Vec::new();
        for (ei, e) in self.edges.iter().enumerate() {
            if !e.alive || e.hide {
                continue;
            }
            let (Some((a, _)), Some((b, _))) =
                (pr.project(self.verts[e.v[0] as usize].co), pr.project(self.verts[e.v[1] as usize].co))
            else {
                continue;
            };
            let d = seg_dist(m, a, b);
            if d <= radius {
                let ab = b - a;
                let t = if ab.length_squared() < 1e-12 { 0.0 } else { ((m - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
                hits.push((d, ei as u32, t));
            }
        }
        hits.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        hits.into_iter().take(max).map(|h| (h.1, h.2)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives;

    #[test]
    fn identity_projection() {
        let m = primitives::grid(2, 2, 1.0);
        let pr = Projector::new(&DMat4::IDENTITY.to_cols_array(), 100.0, 100.0);
        // Grid spans [-0.5,0.5] -> pixels [25,75].
        assert_eq!(m.verts_in_rect(&pr, 0.0, 0.0, 100.0, 100.0).len(), 9);
        assert_eq!(m.verts_in_rect(&pr, 40.0, 40.0, 60.0, 60.0), vec![4]);
        assert_eq!(m.nearest_verts(&pr, 51.0, 49.0, 5.0, 4), vec![4]);
        assert_eq!(m.faces_in_rect(&pr, 0.0, 0.0, 50.0, 50.0).len(), 1);
        assert!(!m.nearest_edges(&pr, 50.0, 37.5, 2.0, 4).is_empty());
    }
}
