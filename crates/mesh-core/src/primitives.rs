//! Primitive mesh generators (all centered at the origin, outward winding).

use crate::Mesh;
use glam::DVec3;
use std::f64::consts::TAU;

fn build_outward(pos: Vec<DVec3>, mut polys: Vec<Vec<u32>>) -> Mesh {
    for p in polys.iter_mut() {
        let n = crate::newell(p.iter().map(|&i| pos[i as usize]));
        let c: DVec3 = p.iter().map(|&i| pos[i as usize]).sum::<DVec3>() / p.len() as f64;
        if n.dot(c) < 0.0 {
            p.reverse();
        }
    }
    Mesh::from_polys(&pos, &polys)
}

pub fn cube(size: f64) -> Mesh {
    let h = size * 0.5;
    let pos: Vec<DVec3> = (0..8)
        .map(|i| {
            DVec3::new(
                if i & 1 != 0 { h } else { -h },
                if i & 2 != 0 { h } else { -h },
                if i & 4 != 0 { h } else { -h },
            )
        })
        .collect();
    let polys = vec![
        vec![0, 2, 3, 1],
        vec![4, 5, 7, 6],
        vec![0, 1, 5, 4],
        vec![2, 6, 7, 3],
        vec![0, 4, 6, 2],
        vec![1, 3, 7, 5],
    ];
    Mesh::from_polys(&pos, &polys)
}

/// An `nx` x `ny` quad grid in the XY plane facing +Z.
pub fn grid(nx: usize, ny: usize, size: f64) -> Mesh {
    let nx = nx.max(1);
    let ny = ny.max(1);
    let mut pos = Vec::new();
    for j in 0..=ny {
        for i in 0..=nx {
            pos.push(DVec3::new(
                (i as f64 / nx as f64 - 0.5) * size,
                (j as f64 / ny as f64 - 0.5) * size,
                0.0,
            ));
        }
    }
    let idx = |i: usize, j: usize| (j * (nx + 1) + i) as u32;
    let mut polys = Vec::new();
    for j in 0..ny {
        for i in 0..nx {
            polys.push(vec![idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)]);
        }
    }
    Mesh::from_polys(&pos, &polys)
}

pub fn plane(size: f64) -> Mesh {
    grid(1, 1, size)
}

/// Truncated cone along Z. `r_top == 0` produces a pointed cone.
pub fn cone(segments: usize, r_bottom: f64, r_top: f64, depth: f64, caps: bool) -> Mesh {
    let n = segments.max(3);
    let hz = depth * 0.5;
    let mut pos = Vec::new();
    for i in 0..n {
        let a = TAU * i as f64 / n as f64;
        pos.push(DVec3::new(a.cos() * r_bottom, a.sin() * r_bottom, -hz));
    }
    let mut polys = Vec::new();
    if r_top <= 1e-12 {
        let apex = pos.len() as u32;
        pos.push(DVec3::new(0.0, 0.0, hz));
        for i in 0..n {
            polys.push(vec![i as u32, ((i + 1) % n) as u32, apex]);
        }
    } else {
        for i in 0..n {
            let a = TAU * i as f64 / n as f64;
            pos.push(DVec3::new(a.cos() * r_top, a.sin() * r_top, hz));
        }
        for i in 0..n {
            let j = (i + 1) % n;
            polys.push(vec![i as u32, j as u32, (n + j) as u32, (n + i) as u32]);
        }
        if caps {
            polys.push((n..2 * n).map(|i| i as u32).collect());
        }
    }
    if caps {
        polys.push((0..n).rev().map(|i| i as u32).collect());
    }
    build_outward(pos, polys)
}

pub fn cylinder(segments: usize, radius: f64, depth: f64) -> Mesh {
    cone(segments, radius, radius, depth, true)
}

pub fn uv_sphere(segments: usize, rings: usize, radius: f64) -> Mesh {
    let segs = segments.max(3);
    let rings = rings.max(2);
    let mut pos = vec![DVec3::new(0.0, 0.0, radius)];
    for r in 1..rings {
        let phi = std::f64::consts::PI * r as f64 / rings as f64;
        for s in 0..segs {
            let th = TAU * s as f64 / segs as f64;
            pos.push(DVec3::new(phi.sin() * th.cos(), phi.sin() * th.sin(), phi.cos()) * radius);
        }
    }
    let bottom = pos.len() as u32;
    pos.push(DVec3::new(0.0, 0.0, -radius));
    let ring = |r: usize, s: usize| (1 + (r - 1) * segs + s % segs) as u32;
    let mut polys = Vec::new();
    for s in 0..segs {
        polys.push(vec![0, ring(1, s), ring(1, s + 1)]);
        polys.push(vec![bottom, ring(rings - 1, s + 1), ring(rings - 1, s)]);
    }
    for r in 1..rings - 1 {
        for s in 0..segs {
            polys.push(vec![ring(r, s), ring(r + 1, s), ring(r + 1, s + 1), ring(r, s + 1)]);
        }
    }
    build_outward(pos, polys)
}

/// A circle in the XY plane, optionally filled with a single n-gon.
pub fn circle(segments: usize, radius: f64, fill: bool) -> Mesh {
    let n = segments.max(3);
    let pos: Vec<DVec3> = (0..n)
        .map(|i| {
            let a = TAU * i as f64 / n as f64;
            DVec3::new(a.cos() * radius, a.sin() * radius, 0.0)
        })
        .collect();
    let mut m = Mesh::new();
    for p in &pos {
        m.add_vert(*p);
    }
    if fill {
        m.add_face(&(0..n as u32).collect::<Vec<_>>());
    } else {
        for i in 0..n {
            m.add_edge(i as u32, ((i + 1) % n) as u32);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitives_are_closed() {
        for m in [cube(1.0), cylinder(8, 1.0, 2.0), uv_sphere(8, 6, 1.0), cone(6, 1.0, 0.0, 1.0, true)] {
            m.validate().unwrap();
            assert_eq!(m.euler(), 2);
            assert!(m.edges.iter().all(|e| e.faces.len() == 2));
        }
    }

    #[test]
    fn outward_normals() {
        let m = uv_sphere(12, 8, 1.0);
        for f in 0..m.faces.len() as u32 {
            assert!(m.face_normal(f).dot(m.face_center(f)) > 0.0);
        }
    }
}
