//! Mesh file formats: STL (binary/ASCII) and OBJ read/write, Collada write.
//! Collada is read on the frontend (three.js ColladaLoader) and handed over
//! as triangles via [`Mesh::from_triangles`].

use crate::triangulate::triangulate_polygon;
use crate::Mesh;
use glam::DVec3;
use std::fmt::Write as _;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IoError {
    #[error("invalid {0} data: {1}")]
    Parse(&'static str, String),
}

/// Reads STL (binary or ASCII), welding identical vertices.
pub fn read_stl(bytes: &[u8]) -> Result<Mesh, IoError> {
    let is_binary = if bytes.len() >= 84 {
        let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        84 + n * 50 == bytes.len()
    } else {
        false
    };
    let mut pos: Vec<f32> = Vec::new();
    if is_binary {
        let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        pos.reserve(n * 9);
        for t in 0..n {
            let base = 84 + t * 50 + 12;
            for k in 0..9 {
                let o = base + k * 4;
                pos.push(f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]));
            }
        }
    } else {
        let text = std::str::from_utf8(bytes).map_err(|_| IoError::Parse("STL", "not binary and not UTF-8".into()))?;
        if !text.trim_start().starts_with("solid") {
            return Err(IoError::Parse("STL", "unrecognized header".into()));
        }
        for line in text.lines() {
            let mut it = line.split_whitespace();
            if it.next() == Some("vertex") {
                for _ in 0..3 {
                    let v: f32 = it
                        .next()
                        .and_then(|s| s.parse().ok())
                        .ok_or_else(|| IoError::Parse("STL", format!("bad vertex line: {line}")))?;
                    pos.push(v);
                }
            }
        }
    }
    if pos.len() % 9 != 0 {
        return Err(IoError::Parse("STL", "truncated triangle".into()));
    }
    Ok(Mesh::from_triangles(&pos, None, 0.0))
}

fn triangles(m: &Mesh) -> Vec<[DVec3; 3]> {
    let mut out = Vec::new();
    for f in m.faces.iter().filter(|f| f.alive) {
        let pts: Vec<DVec3> = f.verts.iter().map(|&v| m.verts[v as usize].co).collect();
        for t in triangulate_polygon(&pts) {
            out.push([pts[t[0]], pts[t[1]], pts[t[2]]]);
        }
    }
    out
}

/// Writes binary STL.
pub fn write_stl(m: &Mesh, name: &str) -> Vec<u8> {
    let tris = triangles(m);
    let mut out = Vec::with_capacity(84 + tris.len() * 50);
    let mut header = [0u8; 80];
    let h = format!("urdf-studio {name}");
    let hb = h.as_bytes();
    header[..hb.len().min(80)].copy_from_slice(&hb[..hb.len().min(80)]);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in tris {
        let n = (t[1] - t[0]).cross(t[2] - t[0]).normalize_or_zero();
        for p in [n, t[0], t[1], t[2]] {
            for c in [p.x, p.y, p.z] {
                out.extend_from_slice(&(c as f32).to_le_bytes());
            }
        }
        out.extend_from_slice(&[0, 0]);
    }
    out
}

/// Reads Wavefront OBJ (positions, faces, lines; groups are merged).
pub fn read_obj(text: &str) -> Result<Mesh, IoError> {
    let mut pos = Vec::new();
    let mut polys: Vec<Vec<u32>> = Vec::new();
    let mut lines: Vec<(u32, u32)> = Vec::new();
    let idx = |tok: &str, n: usize| -> Result<u32, IoError> {
        let first = tok.split('/').next().unwrap_or("");
        let i: i64 = first.parse().map_err(|_| IoError::Parse("OBJ", format!("bad index '{tok}'")))?;
        let r = if i < 0 { n as i64 + i } else { i - 1 };
        if r < 0 || r as usize >= n {
            return Err(IoError::Parse("OBJ", format!("index out of range '{tok}'")));
        }
        Ok(r as u32)
    };
    for line in text.lines() {
        let line = line.trim();
        let mut it = line.split_whitespace();
        match it.next() {
            Some("v") => {
                let c: Vec<f64> = it.take(3).filter_map(|s| s.parse().ok()).collect();
                if c.len() != 3 {
                    return Err(IoError::Parse("OBJ", format!("bad vertex: {line}")));
                }
                pos.push(DVec3::new(c[0], c[1], c[2]));
            }
            Some("f") => {
                let n = pos.len();
                polys.push(it.map(|t| idx(t, n)).collect::<Result<_, _>>()?);
            }
            Some("l") => {
                let n = pos.len();
                let vs: Vec<u32> = it.map(|t| idx(t, n)).collect::<Result<_, _>>()?;
                for w in vs.windows(2) {
                    lines.push((w[0], w[1]));
                }
            }
            _ => {}
        }
    }
    let mut m = Mesh::from_polys(&pos, &polys);
    for (a, b) in lines {
        if a != b {
            m.add_edge(a, b);
        }
    }
    Ok(m)
}

pub fn write_obj(m: &Mesh, name: &str) -> String {
    let mut s = format!("# urdf-studio\no {name}\n");
    let mut map = vec![0u32; m.verts.len()];
    let mut k = 1;
    for (i, v) in m.verts.iter().enumerate() {
        if v.alive {
            let _ = writeln!(s, "v {} {} {}", v.co.x, v.co.y, v.co.z);
            map[i] = k;
            k += 1;
        }
    }
    for f in m.faces.iter().filter(|f| f.alive) {
        s.push('f');
        for &v in &f.verts {
            let _ = write!(s, " {}", map[v as usize]);
        }
        s.push('\n');
    }
    for e in m.edges.iter().filter(|e| e.alive && e.faces.is_empty()) {
        let _ = writeln!(s, "l {} {}", map[e.v[0] as usize], map[e.v[1] as usize]);
    }
    s
}

/// Writes a minimal Collada 1.4.1 document (Z-up, meters, polylist).
pub fn write_dae(m: &Mesh, name: &str) -> String {
    let id: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let mut map = vec![0u32; m.verts.len()];
    let mut positions = String::new();
    let mut k = 0;
    for (i, v) in m.verts.iter().enumerate() {
        if v.alive {
            let _ = write!(positions, "{} {} {} ", v.co.x, v.co.y, v.co.z);
            map[i] = k;
            k += 1;
        }
    }
    let faces: Vec<_> = m.faces.iter().filter(|f| f.alive).collect();
    let mut normals = String::new();
    let mut vcount = String::new();
    let mut p = String::new();
    for (fi, f) in faces.iter().enumerate() {
        let n = crate::newell(f.verts.iter().map(|&v| m.verts[v as usize].co));
        let _ = write!(normals, "{} {} {} ", n.x, n.y, n.z);
        let _ = write!(vcount, "{} ", f.verts.len());
        for &v in &f.verts {
            let _ = write!(p, "{} {} ", map[v as usize], fi);
        }
    }
    format!(
        r##"<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>urdf-studio</authoring_tool></contributor>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_geometries>
    <geometry id="{id}-mesh" name="{id}">
      <mesh>
        <source id="{id}-positions">
          <float_array id="{id}-positions-array" count="{pc}">{positions}</float_array>
          <technique_common>
            <accessor source="#{id}-positions-array" count="{vc}" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="{id}-normals">
          <float_array id="{id}-normals-array" count="{nc}">{normals}</float_array>
          <technique_common>
            <accessor source="#{id}-normals-array" count="{fc}" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="{id}-vertices">
          <input semantic="POSITION" source="#{id}-positions"/>
        </vertices>
        <polylist count="{fc}">
          <input semantic="VERTEX" source="#{id}-vertices" offset="0"/>
          <input semantic="NORMAL" source="#{id}-normals" offset="1"/>
          <vcount>{vcount}</vcount>
          <p>{p}</p>
        </polylist>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="{id}" name="{id}" type="NODE">
        <instance_geometry url="#{id}-mesh" name="{id}"/>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>
"##,
        pc = k * 3,
        vc = k,
        nc = faces.len() * 3,
        fc = faces.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives;

    #[test]
    fn stl_roundtrip() {
        let m = primitives::cube(1.0);
        let bytes = write_stl(&m, "cube");
        let r = read_stl(&bytes).unwrap();
        assert_eq!(r.live_counts(), (8, 18, 12));
        let ascii = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
        assert_eq!(read_stl(ascii.as_bytes()).unwrap().live_counts(), (3, 3, 1));
    }

    #[test]
    fn obj_roundtrip() {
        let m = primitives::cube(1.0);
        let s = write_obj(&m, "cube");
        let r = read_obj(&s).unwrap();
        assert_eq!(r.live_counts(), (8, 12, 6));
        let r = read_obj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 -1\n").unwrap();
        assert_eq!(r.live_counts(), (3, 3, 1));
    }

    #[test]
    fn dae_writes() {
        let s = write_dae(&primitives::cube(1.0), "my cube");
        assert!(s.contains("<polylist count=\"6\">"));
        assert!(s.contains("Z_UP"));
    }
}
