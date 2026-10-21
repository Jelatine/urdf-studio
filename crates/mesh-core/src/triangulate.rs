//! Polygon triangulation (ear clipping in the polygon's best-fit plane).

use glam::{DVec2, DVec3};

/// Triangulates a simple polygon given as an ordered 3D loop. Returns index
/// triples into `pts` with the same winding as the input.
pub fn triangulate_polygon(pts: &[DVec3]) -> Vec<[usize; 3]> {
    let n = pts.len();
    if n < 3 {
        return vec![];
    }
    if n == 3 {
        return vec![[0, 1, 2]];
    }
    let normal = crate::newell(pts.iter().copied());
    let normal = if normal == DVec3::ZERO { DVec3::Z } else { normal };
    let u = normal.any_orthonormal_vector();
    let v = normal.cross(u);
    let p2: Vec<DVec2> = pts.iter().map(|p| DVec2::new(p.dot(u), p.dot(v))).collect();

    if n == 4 {
        // Pick the valid split with the shorter diagonal ("beauty").
        let a = [[0, 1, 2], [0, 2, 3]];
        let b = [[0, 1, 3], [1, 2, 3]];
        let ok = |tris: &[[usize; 3]; 2]| tris.iter().all(|t| area2(p2[t[0]], p2[t[1]], p2[t[2]]) > 0.0);
        let da = pts[0].distance_squared(pts[2]);
        let db = pts[1].distance_squared(pts[3]);
        return match (ok(&a), ok(&b)) {
            (true, true) if db < da => b.to_vec(),
            (true, _) => a.to_vec(),
            (false, true) => b.to_vec(),
            _ => a.to_vec(),
        };
    }

    let mut idx: Vec<usize> = (0..n).collect();
    let mut out = Vec::with_capacity(n - 2);
    let mut guard = 0;
    while idx.len() > 3 && guard < n * n {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let (ia, ib, ic) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (a, b, c) = (p2[ia], p2[ib], p2[ic]);
            if area2(a, b, c) <= 1e-14 {
                continue;
            }
            let contains = idx.iter().any(|&j| {
                j != ia && j != ib && j != ic && point_in_tri(p2[j], a, b, c)
            });
            if contains {
                continue;
            }
            out.push([ia, ib, ic]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            // Degenerate input: fall back to a fan on what is left.
            for k in 1..idx.len() - 1 {
                out.push([idx[0], idx[k], idx[k + 1]]);
            }
            return out;
        }
    }
    if idx.len() == 3 {
        out.push([idx[0], idx[1], idx[2]]);
    }
    out
}

fn area2(a: DVec2, b: DVec2, c: DVec2) -> f64 {
    (b - a).perp_dot(c - a)
}

fn point_in_tri(p: DVec2, a: DVec2, b: DVec2, c: DVec2) -> bool {
    let d1 = area2(a, b, p);
    let d2 = area2(b, c, p);
    let d3 = area2(c, a, p);
    d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concave_l_shape() {
        let pts: Vec<DVec3> = [(0., 0.), (2., 0.), (2., 1.), (1., 1.), (1., 2.), (0., 2.)]
            .iter()
            .map(|&(x, y)| DVec3::new(x, y, 0.0))
            .collect();
        let tris = triangulate_polygon(&pts);
        assert_eq!(tris.len(), 4);
        let area: f64 = tris
            .iter()
            .map(|t| (pts[t[1]] - pts[t[0]]).cross(pts[t[2]] - pts[t[0]]).z * 0.5)
            .sum();
        assert!((area - 3.0).abs() < 1e-9);
    }

    #[test]
    fn concave_quad() {
        let pts: Vec<DVec3> =
            [(0., 0.), (2., 0.), (0.5, 0.5), (0., 2.)].iter().map(|&(x, y)| DVec3::new(x, y, 0.0)).collect();
        let tris = triangulate_polygon(&pts);
        for t in tris {
            assert!((pts[t[1]] - pts[t[0]]).cross(pts[t[2]] - pts[t[0]]).z > 0.0);
        }
    }
}
