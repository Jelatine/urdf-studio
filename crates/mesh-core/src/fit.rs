//! Fits primitive shapes (box / cylinder / sphere) to the selection or the
//! whole mesh, e.g. to replace a detailed mesh by simple URDF collision
//! geometry.
//!
//! "Enclose" fits contain every vertex (minimum volume over a set of
//! candidate orientations); "least squares" fits cylinders and spheres to the
//! surface instead. Boxes are always enclosing.

use crate::ops::{append, DeleteKind, OpError, OpResult};
use crate::{primitives, Mesh};
use glam::{DMat3, DQuat, DVec2, DVec3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitShape {
    /// Tries all shapes and keeps the best (smallest volume when enclosing,
    /// lowest RMS deviation for least squares).
    #[default]
    Auto,
    Box,
    Cylinder,
    Sphere,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitMode {
    #[default]
    Enclose,
    LeastSquares,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitAxis {
    #[default]
    Auto,
    X,
    Y,
    Z,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FitOptions {
    pub shape: FitShape,
    pub mode: FitMode,
    /// Cylinder axis.
    pub axis: FitAxis,
    /// Box aligned with the mesh axes instead of minimum-volume orientation.
    pub aligned: bool,
    /// Fit each connected part separately.
    pub per_island: bool,
    /// Fit the whole (visible) mesh instead of the selection.
    pub all: bool,
    /// Per-axis scale applied to the vertices first (the URDF mesh scale).
    pub scale: [f64; 3],
}

impl Default for FitOptions {
    fn default() -> Self {
        Self {
            shape: FitShape::Auto,
            mode: FitMode::Enclose,
            axis: FitAxis::Auto,
            aligned: false,
            per_island: false,
            all: false,
            scale: [1.0; 3],
        }
    }
}

/// Same JSON shape as URDF geometry (`{type: "box", size}` …).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FitGeometry {
    Box { size: [f64; 3] },
    Cylinder { radius: f64, length: f64 },
    Sphere { radius: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FitResult {
    pub geometry: FitGeometry,
    /// Shape center in (scaled) mesh coordinates.
    pub center: [f64; 3],
    /// Orientation quaternion `[x, y, z, w]`; cylinders run along local Z.
    pub rotation: [f64; 4],
    pub volume: f64,
    /// RMS / maximum distance of the vertices to the shape's surface.
    pub rms: f64,
    pub max_dev: f64,
    pub points: usize,
}

/// Fitting input: points plus the faces among them (unit normal, area,
/// vertex indices into `pts`).
struct Sample {
    pts: Vec<DVec3>,
    faces: Vec<(DVec3, f64, Vec<usize>)>,
}

impl Mesh {
    pub fn fit_primitives(&self, o: &FitOptions) -> OpResult<Vec<FitResult>> {
        let mask: Vec<bool> = self.verts.iter().map(|v| v.alive && !v.hide && (o.all || v.sel)).collect();
        if !mask.iter().any(|&b| b) {
            return Err(OpError::NothingSelected);
        }
        let groups = if o.per_island {
            self.components(&mask)
        } else {
            vec![(0..self.verts.len() as u32).filter(|&v| mask[v as usize]).collect()]
        };
        let scale = DVec3::from_array(o.scale);
        Ok(groups.iter().map(|g| fit_sample(&self.sample(g, o.all, scale), o)).collect())
    }

    /// Replaces the selection by meshes of the fitted shapes, which end up
    /// selected. Returns the number of shapes.
    pub fn fit_replace(&mut self, o: &FitOptions, segments: u32, rings: u32, keep_original: bool) -> OpResult<usize> {
        let fits = self.fit_primitives(&FitOptions { all: false, ..o.clone() })?;
        if !keep_original {
            // Faces only when there are any, so that the surrounding faces
            // sharing boundary vertices survive.
            let kind = if self.selected_faces().is_empty() { DeleteKind::Verts } else { DeleteKind::Faces };
            self.delete(kind)?;
        }
        // Shapes are fitted in scaled space; undo the scale so they look
        // exact once the mesh is displayed with it.
        let scale = DVec3::from_array(o.scale);
        let inv = DVec3::select(scale.cmpeq(DVec3::ZERO), DVec3::ONE, DVec3::ONE / scale);
        let mut all = Mesh::new();
        for r in &fits {
            let mut prim = primitive_mesh(&r.geometry, segments.max(3) as usize, rings.max(2) as usize);
            let rot = DQuat::from_array(r.rotation);
            let center = DVec3::from_array(r.center);
            for v in prim.verts.iter_mut() {
                v.co = (rot * v.co + center) * inv;
            }
            append(&mut all, &prim, DVec3::ZERO);
        }
        if inv.x * inv.y * inv.z < 0.0 {
            for f in 0..all.faces.len() as u32 {
                all.reverse_face(f);
            }
        }
        self.add_mesh(&all, DVec3::ZERO);
        Ok(fits.len())
    }

    /// Connected components of the `mask` vertices, following edges inside it.
    fn components(&self, mask: &[bool]) -> Vec<Vec<u32>> {
        let mut seen = vec![false; self.verts.len()];
        let mut out = Vec::new();
        for start in 0..self.verts.len() {
            if !mask[start] || seen[start] {
                continue;
            }
            let mut comp = Vec::new();
            let mut q = VecDeque::from([start as u32]);
            seen[start] = true;
            while let Some(v) = q.pop_front() {
                comp.push(v);
                for &e in &self.verts[v as usize].edges {
                    let o = self.other_vert(e, v) as usize;
                    if mask[o] && !seen[o] {
                        seen[o] = true;
                        q.push_back(o as u32);
                    }
                }
            }
            out.push(comp);
        }
        out
    }

    fn sample(&self, verts: &[u32], all: bool, scale: DVec3) -> Sample {
        let index: HashMap<u32, usize> = verts.iter().enumerate().map(|(i, &v)| (v, i)).collect();
        let pts: Vec<DVec3> = verts.iter().map(|&v| self.verts[v as usize].co * scale).collect();
        let mut faces = Vec::new();
        for f in &self.faces {
            if !f.alive || f.hide || !(all || f.sel) {
                continue;
            }
            let Some(ids) = f.verts.iter().map(|v| index.get(v).copied()).collect::<Option<Vec<usize>>>() else {
                continue;
            };
            // Normals and areas are taken after scaling (non-uniform scale bends normals).
            let mut acc = DVec3::ZERO;
            for i in 0..ids.len() {
                acc += pts[ids[i]].cross(pts[ids[(i + 1) % ids.len()]]);
            }
            let area = acc.length() * 0.5;
            if area > 0.0 {
                faces.push((acc / (2.0 * area), area, ids));
            }
        }
        Sample { pts, faces }
    }
}

fn fit_sample(s: &Sample, o: &FitOptions) -> FitResult {
    let lsq = o.mode == FitMode::LeastSquares;
    let mut cands = Vec::new();
    if matches!(o.shape, FitShape::Auto | FitShape::Box) {
        cands.push(fit_box(s, o.aligned));
    }
    if matches!(o.shape, FitShape::Auto | FitShape::Cylinder) {
        cands.push(fit_cylinder(s, lsq, o.axis));
    }
    if matches!(o.shape, FitShape::Auto | FitShape::Sphere) {
        cands.push(fit_sphere(s, lsq));
    }
    let key = |r: &FitResult| if lsq { r.rms } else { r.volume };
    cands.into_iter().min_by(|a, b| key(a).total_cmp(&key(b))).unwrap()
}

/// Fills in the deviation statistics of a fitted shape.
fn finish(s: &Sample, geometry: FitGeometry, center: DVec3, rot: DMat3) -> FitResult {
    let inv = rot.transpose();
    let mut sum = 0.0;
    let mut max: f64 = 0.0;
    // Face centers count too: otherwise e.g. a sphere through a cube's
    // corners would look like a perfect fit.
    let centers = s.faces.iter().map(|(_, _, ids)| ids.iter().map(|&i| s.pts[i]).sum::<DVec3>() / ids.len() as f64);
    let samples: Vec<DVec3> = s.pts.iter().copied().chain(centers).collect();
    for &p in &samples {
        let q = inv * (p - center);
        let d = match geometry {
            FitGeometry::Box { size } => sdf_box(q, DVec3::from_array(size) * 0.5),
            FitGeometry::Cylinder { radius, length } => sdf_box2(DVec2::new(q.truncate().length(), q.z.abs()), DVec2::new(radius, length * 0.5)),
            FitGeometry::Sphere { radius } => q.length() - radius,
        }
        .abs();
        sum += d * d;
        max = max.max(d);
    }
    let volume = match geometry {
        FitGeometry::Box { size } => size[0] * size[1] * size[2],
        FitGeometry::Cylinder { radius, length } => PI * radius * radius * length,
        FitGeometry::Sphere { radius } => 4.0 / 3.0 * PI * radius.powi(3),
    };
    FitResult {
        geometry,
        center: center.to_array(),
        rotation: DQuat::from_mat3(&rot).normalize().to_array(),
        volume,
        rms: (sum / samples.len().max(1) as f64).sqrt(),
        max_dev: max,
        points: s.pts.len(),
    }
}

fn sdf_box(q: DVec3, h: DVec3) -> f64 {
    let d = q.abs() - h;
    d.max(DVec3::ZERO).length() + d.max_element().min(0.0)
}

fn sdf_box2(q: DVec2, h: DVec2) -> f64 {
    let d = q.abs() - h;
    d.max(DVec2::ZERO).length() + d.max_element().min(0.0)
}

/// Mesh of a fitted shape at the origin (cylinders along Z).
fn primitive_mesh(g: &FitGeometry, segments: usize, rings: usize) -> Mesh {
    match *g {
        FitGeometry::Box { size } => {
            let mut m = primitives::cube(1.0);
            for v in m.verts.iter_mut() {
                v.co *= DVec3::from_array(size);
            }
            m
        }
        FitGeometry::Cylinder { radius, length } => primitives::cylinder(segments, radius, length),
        FitGeometry::Sphere { radius } => primitives::uv_sphere(segments, rings, radius),
    }
}

// --------------------------------------------------------------------- box

fn fit_box(s: &Sample, aligned: bool) -> FitResult {
    let frames: Vec<DMat3> = if aligned {
        vec![DMat3::IDENTITY]
    } else {
        let (_, pca) = eigen_sym(covariance(&s.pts));
        let mut ups = vec![pca.x_axis, pca.y_axis, pca.z_axis];
        ups.extend(dominant_normals(s, 3));
        let mut frames = vec![pca];
        frames.extend(dedupe_axes(ups).into_iter().map(|u| min_area_frame(&s.pts, u)));
        frames
    };
    let (rot, lo, hi) = frames
        .into_iter()
        .map(|r| {
            let (lo, hi) = extents(&s.pts, &r);
            (r, lo, hi)
        })
        .min_by(|a, b| {
            let va = (a.2 - a.1).to_array().iter().product::<f64>();
            let vb = (b.2 - b.1).to_array().iter().product::<f64>();
            va.total_cmp(&vb)
        })
        .unwrap();
    let center = rot * ((lo + hi) * 0.5);
    let (rot, size) = canonical_frame(rot, hi - lo);
    finish(s, FitGeometry::Box { size: size.to_array() }, center, rot)
}

/// Point extents in the frame `r` (columns are the axes).
fn extents(pts: &[DVec3], r: &DMat3) -> (DVec3, DVec3) {
    let inv = r.transpose();
    pts.iter().fold((DVec3::splat(f64::MAX), DVec3::splat(f64::MIN)), |(lo, hi), &p| {
        let q = inv * p;
        (lo.min(q), hi.max(q))
    })
}

/// Among the 24 axis relabelings of a box frame, picks the one closest to
/// identity so the resulting rpy stays small and readable.
fn canonical_frame(r: DMat3, size: DVec3) -> (DMat3, DVec3) {
    const PERMS: [[usize; 3]; 6] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let cols = [r.x_axis, r.y_axis, r.z_axis];
    let mut best = (f64::MIN, r, size);
    for p in PERMS {
        for signs in 0..8 {
            let sg = |i: usize| if signs & (1 << i) != 0 { -1.0 } else { 1.0 };
            let m = DMat3::from_cols(cols[p[0]] * sg(0), cols[p[1]] * sg(1), cols[p[2]] * sg(2));
            if m.determinant() <= 0.0 {
                continue;
            }
            let trace = m.x_axis.x + m.y_axis.y + m.z_axis.z;
            if trace > best.0 + 1e-12 {
                let sz = size.to_array();
                best = (trace, m, DVec3::new(sz[p[0]], sz[p[1]], sz[p[2]]));
            }
        }
    }
    (best.1, best.2)
}

/// Frame with `up` as Z and the minimum-area bounding rectangle of the
/// projected points giving X and Y.
fn min_area_frame(pts: &[DVec3], up: DVec3) -> DMat3 {
    let up = up.normalize();
    let (e1, e2) = up.any_orthonormal_pair();
    let p2: Vec<DVec2> = pts.iter().map(|p| DVec2::new(p.dot(e1), p.dot(e2))).collect();
    let d = min_area_rect_dir(&convex_hull_2d(p2));
    let x = e1 * d.x + e2 * d.y;
    DMat3::from_cols(x, up.cross(x), up)
}

/// Andrew's monotone chain; counter-clockwise, without collinear points.
fn convex_hull_2d(mut p: Vec<DVec2>) -> Vec<DVec2> {
    p.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let cross = |o: DVec2, a: DVec2, b: DVec2| (a - o).perp_dot(b - o);
    let mut h: Vec<DVec2> = Vec::with_capacity(p.len() * 2);
    for pass in 0..2 {
        let start = h.len();
        let iter: Box<dyn Iterator<Item = &DVec2>> = if pass == 0 { Box::new(p.iter()) } else { Box::new(p.iter().rev()) };
        for &q in iter {
            while h.len() >= start + 2 && cross(h[h.len() - 2], h[h.len() - 1], q) <= 0.0 {
                h.pop();
            }
            h.push(q);
        }
        h.pop();
    }
    h
}

/// Direction of one side of the minimum-area enclosing rectangle of a convex
/// CCW polygon (rotating calipers).
fn min_area_rect_dir(h: &[DVec2]) -> DVec2 {
    let n = h.len();
    if n < 2 {
        return DVec2::X;
    }
    if n == 2 {
        return (h[1] - h[0]).normalize_or(DVec2::X);
    }
    let (mut r, mut t, mut l) = (1, 0, 0);
    let mut best = (f64::MAX, DVec2::X);
    for i in 0..n {
        let d = (h[(i + 1) % n] - h[i]).normalize();
        let nn = d.perp(); // inward for a CCW polygon
        while h[(r + 1) % n].dot(d) > h[r % n].dot(d) {
            r += 1;
        }
        if i == 0 {
            t = r;
        }
        while h[(t + 1) % n].dot(nn) > h[t % n].dot(nn) {
            t += 1;
        }
        if i == 0 {
            l = t;
        }
        while h[(l + 1) % n].dot(d) < h[l % n].dot(d) {
            l += 1;
        }
        let area = (h[r % n] - h[l % n]).dot(d) * (h[t % n] - h[i]).dot(nn);
        if area < best.0 {
            best = (area, d);
        }
    }
    best.1
}

// ---------------------------------------------------------------- cylinder

fn fit_cylinder(s: &Sample, lsq: bool, axis: FitAxis) -> FitResult {
    let axes = match axis {
        FitAxis::X => vec![DVec3::X],
        FitAxis::Y => vec![DVec3::Y],
        FitAxis::Z => vec![DVec3::Z],
        FitAxis::Auto => {
            // Side normals are perpendicular to the axis, so the axis is the
            // least-variance direction of the normals; caps or partial
            // selections can break that, so PCA axes and dominant normals
            // are tried too.
            let mut m = DMat3::ZERO;
            for (n, a, _) in &s.faces {
                m += outer(*n, *n) * *a;
            }
            let (_, nv) = eigen_sym(m);
            let (_, pca) = eigen_sym(covariance(&s.pts));
            let mut c = Vec::new();
            if !s.faces.is_empty() {
                c.extend([nv.x_axis, nv.y_axis, nv.z_axis]);
            }
            c.extend([pca.x_axis, pca.y_axis, pca.z_axis]);
            c.extend(dominant_normals(s, 3));
            dedupe_axes(c)
        }
    };
    axes.into_iter()
        .map(|u| cylinder_about(s, u, lsq))
        .min_by(|a, b| if lsq { a.rms.total_cmp(&b.rms) } else { a.volume.total_cmp(&b.volume) })
        .unwrap()
}

fn cylinder_about(s: &Sample, u: DVec3, lsq: bool) -> FitResult {
    let u = canonical_dir(u.normalize());
    let (e1, e2) = u.any_orthonormal_pair();
    let p2: Vec<DVec2> = s.pts.iter().map(|p| DVec2::new(p.dot(e1), p.dot(e2))).collect();
    let circle = if lsq {
        // Fit only the side wall when faces tell us which vertices are on it.
        let mut side = vec![false; s.pts.len()];
        for (n, _, ids) in &s.faces {
            if n.dot(u).abs() < 0.5 {
                ids.iter().for_each(|&i| side[i] = true);
            }
        }
        let wall: Vec<DVec2> = p2.iter().zip(&side).filter(|(_, &b)| b).map(|(p, _)| *p).collect();
        circle_lsq(if wall.len() >= 3 { &wall } else { &p2 })
    } else {
        None
    };
    let (c, r) = circle.unwrap_or_else(|| min_circle(&p2));
    let (h0, h1) = s.pts.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.dot(u)), b.max(p.dot(u))));
    let center = e1 * c.x + e2 * c.y + u * ((h0 + h1) * 0.5);
    let rot = DMat3::from_quat(DQuat::from_rotation_arc(DVec3::Z, u));
    finish(s, FitGeometry::Cylinder { radius: r, length: h1 - h0 }, center, rot)
}

/// Picks the sign of an axis so it points "up" (keeps rotations small).
fn canonical_dir(u: DVec3) -> DVec3 {
    let k = if u.z.abs() > 1e-9 { u.z } else if u.y.abs() > 1e-9 { u.y } else { u.x };
    if k < 0.0 {
        -u
    } else {
        u
    }
}

/// Kåsa algebraic circle fit: x² + y² = 2a·x + 2b·y + c.
fn circle_lsq(p: &[DVec2]) -> Option<(DVec2, f64)> {
    let m = p.iter().fold(DVec2::ZERO, |a, &q| a + q) / p.len() as f64;
    let mut ata = DMat3::ZERO;
    let mut atb = DVec3::ZERO;
    for &q in p {
        let q = q - m; // centered for conditioning
        let row = DVec3::new(2.0 * q.x, 2.0 * q.y, 1.0);
        ata += outer(row, row);
        atb += row * q.length_squared();
    }
    let x = solve3(ata, atb)?;
    let c = DVec2::new(x.x, x.y);
    let r2 = x.z + c.length_squared();
    (r2 > 0.0).then(|| (c + m, r2.sqrt()))
}

// ------------------------------------------------------------------ sphere

fn fit_sphere(s: &Sample, lsq: bool) -> FitResult {
    let fit = if lsq { sphere_lsq(&s.pts) } else { None };
    let (c, r) = fit.unwrap_or_else(|| min_sphere(&s.pts));
    finish(s, FitGeometry::Sphere { radius: r }, c, DMat3::IDENTITY)
}

/// Algebraic sphere fit: |p|² = 2c·p + k.
fn sphere_lsq(p: &[DVec3]) -> Option<(DVec3, f64)> {
    if p.len() < 4 {
        return None;
    }
    let m = p.iter().sum::<DVec3>() / p.len() as f64;
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [0.0f64; 4];
    for &q in p {
        let q = q - m;
        let row = [2.0 * q.x, 2.0 * q.y, 2.0 * q.z, 1.0];
        for i in 0..4 {
            for j in 0..4 {
                ata[i][j] += row[i] * row[j];
            }
            atb[i] += row[i] * q.length_squared();
        }
    }
    let x = solve4(ata, atb)?;
    let c = DVec3::new(x[0], x[1], x[2]);
    let r2 = x[3] + c.length_squared();
    (r2 > 0.0).then(|| (c + m, r2.sqrt()))
}

// ------------------------------------------- minimum enclosing ball (Welzl)

/// Deterministic shuffle so the incremental algorithms run in expected
/// linear time.
fn shuffled<T: Copy>(p: &[T]) -> Vec<T> {
    let mut v = p.to_vec();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    for i in (1..v.len()).rev() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        v.swap(i, (seed >> 33) as usize % (i + 1));
    }
    v
}

fn min_circle(p: &[DVec2]) -> (DVec2, f64) {
    let p = shuffled(p);
    let tol = 1e-9 * p.iter().fold(0.0f64, |a, q| a.max(q.abs().max_element())) + 1e-15;
    let out = |c: (DVec2, f64), q: DVec2| q.distance(c.0) > c.1 + tol;
    let mut c = (p[0], 0.0);
    for i in 1..p.len() {
        if !out(c, p[i]) {
            continue;
        }
        c = (p[i], 0.0);
        for j in 0..i {
            if !out(c, p[j]) {
                continue;
            }
            c = ((p[i] + p[j]) * 0.5, p[i].distance(p[j]) * 0.5);
            for k in 0..j {
                if out(c, p[k]) {
                    c = circle3(p[i], p[j], p[k]);
                }
            }
        }
    }
    c
}

fn circle3(a: DVec2, b: DVec2, c: DVec2) -> (DVec2, f64) {
    let (ab, ac) = (b - a, c - a);
    let d = 2.0 * ab.perp_dot(ac);
    if d.abs() < 1e-300 {
        // Collinear: the farthest pair spans the circle.
        let pairs = [(a, b), (a, c), (b, c)];
        let (x, y) = pairs.into_iter().max_by(|p, q| p.0.distance(p.1).total_cmp(&q.0.distance(q.1))).unwrap();
        return ((x + y) * 0.5, x.distance(y) * 0.5);
    }
    let o = DVec2::new(ac.y * ab.length_squared() - ab.y * ac.length_squared(), ab.x * ac.length_squared() - ac.x * ab.length_squared()) / d;
    (a + o, o.length())
}

fn min_sphere(p: &[DVec3]) -> (DVec3, f64) {
    let p = shuffled(p);
    let tol = 1e-9 * p.iter().fold(0.0f64, |a, q| a.max(q.abs().max_element())) + 1e-15;
    let out = |c: (DVec3, f64), q: DVec3| q.distance(c.0) > c.1 + tol;
    let mut c = (p[0], 0.0);
    for i in 1..p.len() {
        if !out(c, p[i]) {
            continue;
        }
        c = (p[i], 0.0);
        for j in 0..i {
            if !out(c, p[j]) {
                continue;
            }
            c = ((p[i] + p[j]) * 0.5, p[i].distance(p[j]) * 0.5);
            for k in 0..j {
                if !out(c, p[k]) {
                    continue;
                }
                c = sphere3(p[i], p[j], p[k]);
                for l in 0..k {
                    if out(c, p[l]) {
                        c = sphere4(p[i], p[j], p[k], p[l]);
                    }
                }
            }
        }
    }
    c
}

/// Smallest sphere through three points (their circumcircle).
fn sphere3(a: DVec3, b: DVec3, c: DVec3) -> (DVec3, f64) {
    let (ab, ac) = (b - a, c - a);
    let n = ab.cross(ac);
    let d = 2.0 * n.length_squared();
    if d < 1e-300 {
        let pairs = [(a, b), (a, c), (b, c)];
        let (x, y) = pairs.into_iter().max_by(|p, q| p.0.distance(p.1).total_cmp(&q.0.distance(q.1))).unwrap();
        return ((x + y) * 0.5, x.distance(y) * 0.5);
    }
    let o = (n.cross(ab) * ac.length_squared() + ac.cross(n) * ab.length_squared()) / d;
    (a + o, o.length())
}

fn sphere4(a: DVec3, b: DVec3, c: DVec3, d: DVec3) -> (DVec3, f64) {
    let m = DMat3::from_cols(b - a, c - a, d - a).transpose();
    let rhs = DVec3::new((b - a).length_squared(), (c - a).length_squared(), (d - a).length_squared()) * 0.5;
    if let Some(o) = solve3(m, rhs) {
        return (a + o, o.length());
    }
    // Coplanar: the smallest of the three-point spheres containing all four.
    let pts = [a, b, c, d];
    [(a, b, c), (a, b, d), (a, c, d), (b, c, d)]
        .into_iter()
        .map(|(x, y, z)| sphere3(x, y, z))
        .filter(|s| pts.iter().all(|p| p.distance(s.0) <= s.1 * (1.0 + 1e-9) + 1e-15))
        .min_by(|x, y| x.1.total_cmp(&y.1))
        .unwrap_or_else(|| sphere3(a, b, c))
}

// ----------------------------------------------------------- linear algebra

fn outer(a: DVec3, b: DVec3) -> DMat3 {
    DMat3::from_cols(a * b.x, a * b.y, a * b.z)
}

fn covariance(p: &[DVec3]) -> DMat3 {
    let m = p.iter().sum::<DVec3>() / p.len().max(1) as f64;
    p.iter().fold(DMat3::ZERO, |acc, &q| acc + outer(q - m, q - m))
}

/// Eigen-decomposition of a symmetric 3x3 matrix (cyclic Jacobi).
/// Returns ascending eigenvalues and the eigenvectors as columns.
fn eigen_sym(m: DMat3) -> ([f64; 3], DMat3) {
    let mut a = m.to_cols_array_2d(); // a[col][row]; symmetric so either works
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..50 {
        let off = a[0][1].powi(2) + a[0][2].powi(2) + a[1][2].powi(2);
        let scale = a[0][0].powi(2) + a[1][1].powi(2) + a[2][2].powi(2);
        if off <= 1e-30 * scale.max(1e-300) {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-300 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let (akp, akq) = (a[k][p], a[k][q]);
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (a[p][k], a[q][k]);
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for row in v.iter_mut() {
                let (vp, vq) = (row[p], row[q]);
                row[p] = c * vp - s * vq;
                row[q] = s * vp + c * vq;
            }
        }
    }
    let mut idx = [0, 1, 2];
    idx.sort_by(|&i, &j| a[i][i].total_cmp(&a[j][j]));
    let col = |i: usize| DVec3::new(v[0][i], v[1][i], v[2][i]).normalize();
    let (x, y) = (col(idx[0]), col(idx[1]));
    (
        [a[idx[0]][idx[0]], a[idx[1]][idx[1]], a[idx[2]][idx[2]]],
        DMat3::from_cols(x, y, x.cross(y)),
    )
}

fn solve3(m: DMat3, b: DVec3) -> Option<DVec3> {
    let det = m.determinant();
    let scale = m.x_axis.length() * m.y_axis.length() * m.z_axis.length();
    (det.abs() > 1e-12 * scale && scale > 0.0).then(|| m.inverse() * b)
}

/// Gaussian elimination with partial pivoting.
fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> Option<[f64; 4]> {
    let norm = a.iter().flatten().fold(0.0f64, |m, x| m.max(x.abs()));
    for c in 0..4 {
        let p = (c..4).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs()))?;
        if a[p][c].abs() <= 1e-12 * norm {
            return None;
        }
        a.swap(c, p);
        b.swap(c, p);
        for r in c + 1..4 {
            let f = a[r][c] / a[c][c];
            for k in c..4 {
                a[r][k] -= f * a[c][k];
            }
            b[r] -= f * b[c];
        }
    }
    let mut x = [0.0; 4];
    for r in (0..4).rev() {
        x[r] = (b[r] - (r + 1..4).map(|k| a[r][k] * x[k]).sum::<f64>()) / a[r][r];
    }
    Some(x)
}

/// Area-weighted normal directions covering the most surface (sign-agnostic).
fn dominant_normals(s: &Sample, k: usize) -> Vec<DVec3> {
    const COS: f64 = 0.996; // ~5°
    let mut clusters: Vec<(DVec3, f64)> = Vec::new();
    for (n, a, _) in &s.faces {
        if let Some((c, w)) = clusters.iter_mut().find(|(c, _)| c.normalize().dot(*n).abs() > COS) {
            *c += if c.dot(*n) < 0.0 { -*n } else { *n } * *a;
            *w += a;
        } else if clusters.len() < 256 {
            clusters.push((*n * *a, *a));
        }
    }
    clusters.sort_by(|a, b| b.1.total_cmp(&a.1));
    clusters.into_iter().take(k).map(|(c, _)| c.normalize()).collect()
}

fn dedupe_axes(axes: Vec<DVec3>) -> Vec<DVec3> {
    let mut out: Vec<DVec3> = Vec::new();
    for a in axes {
        let a = a.normalize_or_zero();
        if a != DVec3::ZERO && !out.iter().any(|b| b.dot(a).abs() > 0.9999) {
            out.push(a);
        }
    }
    if out.is_empty() {
        out.push(DVec3::Z);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives;
    use crate::select::SelectAction;
    use glam::DMat4;

    fn rotated(mut m: Mesh, offset: DVec3) -> Mesh {
        let r = DQuat::from_euler(glam::EulerRot::ZYX, 0.4, -0.7, 1.1);
        m.select_all(SelectAction::Select);
        m.transform_selected(DMat4::from_rotation_translation(r, offset)).unwrap();
        m
    }

    fn fit(m: &Mesh, shape: FitShape, mode: FitMode) -> FitResult {
        let o = FitOptions { shape, mode, all: true, ..Default::default() };
        m.fit_primitives(&o).unwrap().remove(0)
    }

    fn close(a: f64, b: f64, eps: f64) {
        assert!((a - b).abs() < eps, "{a} != {b}");
    }

    #[test]
    fn box_of_rotated_cube() {
        let m = rotated(primitives::cube(1.0), DVec3::new(1.0, 2.0, 3.0));
        let r = fit(&m, FitShape::Box, FitMode::Enclose);
        let FitGeometry::Box { size } = r.geometry else { panic!() };
        for s in size {
            close(s, 1.0, 1e-9);
        }
        close(r.max_dev, 0.0, 1e-9);
        for (c, e) in r.center.iter().zip([1.0, 2.0, 3.0]) {
            close(*c, e, 1e-9);
        }
    }

    #[test]
    fn aligned_box_is_aabb() {
        let mut m = primitives::cube(1.0);
        m.select_all(SelectAction::Select);
        m.transform_selected(DMat4::from_scale(DVec3::new(1.0, 2.0, 3.0))).unwrap();
        let o = FitOptions { shape: FitShape::Box, all: true, aligned: true, ..Default::default() };
        let r = m.fit_primitives(&o).unwrap().remove(0);
        assert_eq!(r.geometry, FitGeometry::Box { size: [1.0, 2.0, 3.0] });
        assert_eq!(r.rotation, [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn cylinder_of_rotated_cylinder() {
        let m = rotated(primitives::cylinder(64, 0.3, 2.0), DVec3::ZERO);
        for mode in [FitMode::Enclose, FitMode::LeastSquares] {
            let r = fit(&m, FitShape::Cylinder, mode);
            let FitGeometry::Cylinder { radius, length } = r.geometry else { panic!() };
            close(radius, 0.3, 1e-3);
            close(length, 2.0, 1e-9);
        }
    }

    #[test]
    fn sphere_of_uv_sphere() {
        let m = rotated(primitives::uv_sphere(32, 16, 0.5), DVec3::X);
        let r = fit(&m, FitShape::Sphere, FitMode::Enclose);
        let FitGeometry::Sphere { radius } = r.geometry else { panic!() };
        close(radius, 0.5, 1e-9);
        close(r.center[0], 1.0, 1e-9);
        let r = fit(&m, FitShape::Sphere, FitMode::LeastSquares);
        let FitGeometry::Sphere { radius } = r.geometry else { panic!() };
        close(radius, 0.5, 1e-9);
    }

    #[test]
    fn auto_picks_matching_shape() {
        let kind = |r: &FitResult| std::mem::discriminant(&r.geometry);
        let cube = rotated(primitives::cube(1.0), DVec3::ZERO);
        let cyl = rotated(primitives::cylinder(48, 0.5, 1.0), DVec3::ZERO);
        let sph = primitives::uv_sphere(32, 16, 0.5);
        for (m, expect) in [
            (cube, FitGeometry::Box { size: [0.0; 3] }),
            (cyl, FitGeometry::Cylinder { radius: 0.0, length: 0.0 }),
            (sph, FitGeometry::Sphere { radius: 0.0 }),
        ] {
            for mode in [FitMode::Enclose, FitMode::LeastSquares] {
                assert_eq!(kind(&fit(&m, FitShape::Auto, mode)), std::mem::discriminant(&expect), "{mode:?}");
            }
        }
    }

    #[test]
    fn lsq_cylinder_ignores_caps() {
        // Cylinder with poked caps (center vertices) — LSQ fits the wall only.
        let mut m = primitives::cylinder(32, 1.0, 1.0);
        let o = FitOptions { shape: FitShape::Cylinder, mode: FitMode::LeastSquares, axis: FitAxis::Z, all: true, ..Default::default() };
        m.select_all(SelectAction::Select);
        m.poke().unwrap();
        let r = m.fit_primitives(&o).unwrap().remove(0);
        let FitGeometry::Cylinder { radius, .. } = r.geometry else { panic!() };
        // Poke also adds side-face centers (slightly inside the circle).
        assert!(radius > 0.98 && radius <= 1.0 + 1e-9, "{radius}");
    }

    #[test]
    fn selection_islands_and_scale() {
        let mut m = primitives::cube(1.0);
        let other = primitives::cube(1.0);
        m.add_mesh(&other, DVec3::new(3.0, 0.0, 0.0));
        m.select_all(SelectAction::Select);
        let o = FitOptions { shape: FitShape::Box, per_island: true, scale: [2.0, 1.0, 1.0], ..Default::default() };
        let rs = m.fit_primitives(&o).unwrap();
        assert_eq!(rs.len(), 2);
        let FitGeometry::Box { size } = rs[1].geometry else { panic!() };
        close(size[0], 2.0, 1e-9);
        close(rs[1].center[0], 6.0, 1e-9);
        m.select_all(SelectAction::Deselect);
        assert_eq!(m.fit_primitives(&o), Err(OpError::NothingSelected));
    }

    #[test]
    fn replace_selection_with_shape() {
        // A cylinder (with caps) next to a cube; replace only the cylinder.
        let mut m = rotated(primitives::cylinder(24, 0.3, 1.0), DVec3::ZERO);
        m.select_all(SelectAction::Deselect);
        m.add_mesh(&primitives::cube(0.5), DVec3::new(2.0, 0.0, 0.0));
        m.select_all(SelectAction::Invert);
        let o = FitOptions { shape: FitShape::Cylinder, scale: [1.0, 1.0, 2.0], ..Default::default() };
        assert_eq!(m.fit_replace(&o, 32, 8, false).unwrap(), 1);
        m.validate().unwrap();
        // cube (8 verts) + new 32-segment cylinder (64 verts), new part selected
        assert_eq!(m.live_counts().0, 8 + 64);
        assert_eq!(m.selected_counts().0, 64);
        // Refitting the generated mesh gives the same cylinder back.
        let again = m.fit_primitives(&o).unwrap().remove(0);
        let FitGeometry::Cylinder { radius, .. } = again.geometry else { panic!() };
        let first = rotated(primitives::cylinder(24, 0.3, 1.0), DVec3::ZERO).fit_primitives(&FitOptions { all: true, ..o.clone() }).unwrap().remove(0);
        let FitGeometry::Cylinder { radius: r0, .. } = first.geometry else { panic!() };
        close(radius, r0, 1e-6);
        // Keeping the original adds instead.
        let n = m.live_counts().0;
        m.fit_replace(&FitOptions { shape: FitShape::Box, ..Default::default() }, 32, 8, true).unwrap();
        assert_eq!(m.live_counts().0, n + 8);
    }

    #[test]
    fn calipers_match_brute_force() {
        let pts: Vec<DVec2> = shuffled(&(0..60).map(|i| {
            let a = i as f64 * 2.399;
            DVec2::new(a.cos() * (1.0 + 0.5 * (i % 7) as f64), a.sin() * (0.4 + 0.1 * (i % 5) as f64))
        }).collect::<Vec<_>>());
        let h = convex_hull_2d(pts);
        let area = |d: DVec2| {
            let n = d.perp();
            let (a0, a1) = h.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.dot(d)), hi.max(p.dot(d))));
            let (b0, b1) = h.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p.dot(n)), hi.max(p.dot(n))));
            (a1 - a0) * (b1 - b0)
        };
        let brute = (0..h.len()).map(|i| area((h[(i + 1) % h.len()] - h[i]).normalize())).fold(f64::MAX, f64::min);
        close(area(min_area_rect_dir(&h)), brute, 1e-9);
    }

    #[test]
    fn eigen_decomposition() {
        let r = DMat3::from_quat(DQuat::from_euler(glam::EulerRot::XYZ, 0.3, 0.5, -0.2));
        let m = r * DMat3::from_diagonal(DVec3::new(3.0, 1.0, 2.0)) * r.transpose();
        let (vals, vecs) = eigen_sym(m);
        close(vals[0], 1.0, 1e-9);
        close(vals[2], 3.0, 1e-9);
        close(vecs.x_axis.dot(r.y_axis).abs(), 1.0, 1e-9);
    }
}
