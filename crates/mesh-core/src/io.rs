//! Mesh file formats: STL (binary/ASCII) and OBJ read/write, Collada write.
//! Collada is read on the frontend (three.js ColladaLoader) and handed over
//! as triangles via [`Mesh::from_triangles`].
//!
//! Material slots are kept as far as each format allows: OBJ uses a `.mtl`
//! companion file, Collada gets one effect/material per slot, and binary STL
//! stores a 15-bit color per triangle (VisCAM/SolidView convention; the
//! Materialise variant with a `COLOR=` header is read too).

use crate::material::slots_from_colors;
use crate::triangulate::triangulate_polygon;
use crate::{Mesh, MeshMaterial, DEFAULT_COLOR};
use glam::DVec3;
use std::collections::HashMap;
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
    let mut colors: Vec<Option<[f32; 4]>> = Vec::new();
    if is_binary {
        let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
        pos.reserve(n * 9);
        let header = &bytes[..80];
        // Materialise: "COLOR=" + default RGBA in the header, bit 15 clear
        // means the facet has its own color (red in the low bits).
        let magics = header.windows(6).position(|w| w == b"COLOR=");
        let c5 = |v: u16| ((v & 31) as f32) / 31.0;
        for t in 0..n {
            let base = 84 + t * 50 + 12;
            for k in 0..9 {
                let o = base + k * 4;
                pos.push(f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]));
            }
            let a = u16::from_le_bytes([bytes[base + 36], bytes[base + 37]]);
            colors.push(match magics {
                Some(_) if a & 0x8000 == 0 => Some([c5(a), c5(a >> 5), c5(a >> 10), 1.0]),
                Some(p) if p + 10 <= 80 => {
                    let d = &header[p + 6..p + 10];
                    Some([d[0] as f32 / 255.0, d[1] as f32 / 255.0, d[2] as f32 / 255.0, d[3] as f32 / 255.0])
                }
                Some(_) => None,
                None if a & 0x8000 != 0 => Some([c5(a >> 10), c5(a >> 5), c5(a), 1.0]),
                None => None,
            });
        }
        if colors.iter().all(|c| c.is_none()) {
            colors.clear();
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
    if colors.is_empty() {
        return Ok(Mesh::from_triangles(&pos, None, 0.0, None));
    }
    let (slots, ids) = slots_from_colors(&colors);
    let mut m = Mesh::from_triangles(&pos, None, 0.0, Some(&ids));
    m.materials = slots;
    Ok(m)
}

fn triangles(m: &Mesh) -> Vec<([DVec3; 3], [f32; 4])> {
    let mut out = Vec::new();
    for f in m.faces.iter().filter(|f| f.alive) {
        let pts: Vec<DVec3> = f.verts.iter().map(|&v| m.verts[v as usize].co).collect();
        let color = m.material_color(f.mat);
        for t in triangulate_polygon(&pts) {
            out.push(([pts[t[0]], pts[t[1]], pts[t[2]]], color));
        }
    }
    out
}

/// Writes binary STL (with per-triangle colors when the mesh has materials).
pub fn write_stl(m: &Mesh, name: &str) -> Vec<u8> {
    let tris = triangles(m);
    let colored = !m.materials.is_empty();
    let c5 = |c: f32| ((c.clamp(0.0, 1.0) * 31.0).round() as u16) & 31;
    let mut out = Vec::with_capacity(84 + tris.len() * 50);
    let mut header = [0u8; 80];
    let h = format!("urdf-studio {name}");
    let hb = h.as_bytes();
    header[..hb.len().min(80)].copy_from_slice(&hb[..hb.len().min(80)]);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for (t, color) in tris {
        let n = (t[1] - t[0]).cross(t[2] - t[0]).normalize_or_zero();
        for p in [n, t[0], t[1], t[2]] {
            for c in [p.x, p.y, p.z] {
                out.extend_from_slice(&(c as f32).to_le_bytes());
            }
        }
        let attr: u16 = if colored { 0x8000 | c5(color[0]) << 10 | c5(color[1]) << 5 | c5(color[2]) } else { 0 };
        out.extend_from_slice(&attr.to_le_bytes());
    }
    out
}

/// `mtllib` file names referenced by an OBJ file.
pub fn obj_mtllibs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("mtllib") {
            if rest.starts_with(char::is_whitespace) && !rest.trim().is_empty() {
                out.push(rest.trim().to_string());
            }
        }
    }
    out
}

/// Reads a Wavefront MTL file: material name -> diffuse color (Kd, d/Tr).
pub fn read_mtl(text: &str) -> Vec<MeshMaterial> {
    let mut out: Vec<MeshMaterial> = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let key = it.next();
        let nums: Vec<f32> = it.clone().filter_map(|s| s.parse().ok()).collect();
        match key {
            Some("newmtl") => {
                let name = line.trim()["newmtl".len()..].trim().to_string();
                out.push(MeshMaterial { name, color: DEFAULT_COLOR });
            }
            Some("Kd") if nums.len() >= 3 => {
                if let Some(m) = out.last_mut() {
                    m.color[..3].copy_from_slice(&nums[..3]);
                }
            }
            Some("d") if !nums.is_empty() => {
                if let Some(m) = out.last_mut() {
                    m.color[3] = nums[0].clamp(0.0, 1.0);
                }
            }
            Some("Tr") if !nums.is_empty() => {
                if let Some(m) = out.last_mut() {
                    m.color[3] = (1.0 - nums[0]).clamp(0.0, 1.0);
                }
            }
            _ => {}
        }
    }
    out
}

/// Reads Wavefront OBJ (positions, faces, lines; groups are merged).
/// `usemtl` materials take their colors from `mtl` (the `mtllib` contents)
/// when given; without any `usemtl`, vertex colors (`v x y z r g b`) are
/// turned into material slots.
pub fn read_obj(text: &str, mtl: Option<&str>) -> Result<Mesh, IoError> {
    let library = mtl.map(read_mtl).unwrap_or_default();
    let mut pos = Vec::new();
    let mut vcol: Vec<Option<[f32; 3]>> = Vec::new();
    let mut polys: Vec<Vec<u32>> = Vec::new();
    let mut poly_mat: Vec<Option<u32>> = Vec::new();
    let mut materials: Vec<MeshMaterial> = Vec::new();
    let mut by_name: HashMap<String, u32> = HashMap::new();
    let mut current: Option<u32> = None;
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
                let c: Vec<f64> = it.filter_map(|s| s.parse().ok()).collect();
                if c.len() < 3 {
                    return Err(IoError::Parse("OBJ", format!("bad vertex: {line}")));
                }
                pos.push(DVec3::new(c[0], c[1], c[2]));
                vcol.push((c.len() >= 6).then(|| [c[3] as f32, c[4] as f32, c[5] as f32]));
            }
            Some("f") => {
                let n = pos.len();
                polys.push(it.map(|t| idx(t, n)).collect::<Result<_, _>>()?);
                poly_mat.push(current);
            }
            Some("usemtl") => {
                let name = line["usemtl".len()..].trim().to_string();
                let next = materials.len() as u32;
                let id = *by_name.entry(name.clone()).or_insert_with(|| {
                    let color = library.iter().find(|m| m.name == name).map_or(DEFAULT_COLOR, |m| m.color);
                    materials.push(MeshMaterial { name, color });
                    next
                });
                current = Some(id);
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
    let mats: Option<Vec<u32>> = if !materials.is_empty() {
        let default = materials.len() as u32;
        if poly_mat.iter().any(|m| m.is_none()) {
            materials.push(MeshMaterial { name: "default".into(), color: DEFAULT_COLOR });
        }
        Some(poly_mat.iter().map(|m| m.unwrap_or(default)).collect())
    } else if vcol.iter().any(|c| c.is_some()) {
        // Average vertex color per face.
        let colors: Vec<Option<[f32; 4]>> = polys
            .iter()
            .map(|p| {
                let cs: Vec<[f32; 3]> = p.iter().filter_map(|&v| vcol[v as usize]).collect();
                (!cs.is_empty()).then(|| {
                    let k = cs.len() as f32;
                    let s = cs.iter().fold([0.0; 3], |a, c| [a[0] + c[0], a[1] + c[1], a[2] + c[2]]);
                    [s[0] / k, s[1] / k, s[2] / k, 1.0]
                })
            })
            .collect();
        let (slots, ids) = slots_from_colors(&colors);
        materials = slots;
        Some(ids)
    } else {
        None
    };
    let mut m = Mesh::new();
    for p in &pos {
        m.add_vert(*p);
    }
    for (i, poly) in polys.iter().enumerate() {
        m.add_face_mat(poly, mats.as_ref().map_or(0, |ids| ids[i]));
    }
    m.materials = materials;
    for (a, b) in lines {
        if a != b {
            m.add_edge(a, b);
        }
    }
    Ok(m)
}

/// Writes OBJ. With materials and `mtllib` (file name of the companion
/// written by [`write_mtl`]), faces are grouped by `usemtl`.
pub fn write_obj(m: &Mesh, name: &str, mtllib: Option<&str>) -> String {
    let mut s = String::from("# urdf-studio\n");
    let slots = mtllib.filter(|_| !m.materials.is_empty()).map(|lib| {
        let _ = writeln!(s, "mtllib {lib}");
        m.export_slots()
    });
    let _ = writeln!(s, "o {name}");
    let mut map = vec![0u32; m.verts.len()];
    let mut k = 1;
    for (i, v) in m.verts.iter().enumerate() {
        if v.alive {
            let _ = writeln!(s, "v {} {} {}", v.co.x, v.co.y, v.co.z);
            map[i] = k;
            k += 1;
        }
    }
    let write_face = |s: &mut String, f: &crate::Face| {
        s.push('f');
        for &v in &f.verts {
            let _ = write!(s, " {}", map[v as usize]);
        }
        s.push('\n');
    };
    match &slots {
        Some((mats, face_slot)) => {
            for (k, mat) in mats.iter().enumerate() {
                let faces: Vec<&crate::Face> =
                    m.faces.iter().enumerate().filter(|(i, f)| f.alive && face_slot[*i] == k as u32).map(|(_, f)| f).collect();
                if faces.is_empty() {
                    continue;
                }
                let _ = writeln!(s, "usemtl {}", mat.name);
                for f in faces {
                    write_face(&mut s, f);
                }
            }
        }
        None => {
            for f in m.faces.iter().filter(|f| f.alive) {
                write_face(&mut s, f);
            }
        }
    }
    for e in m.edges.iter().filter(|e| e.alive && e.faces.is_empty()) {
        let _ = writeln!(s, "l {} {}", map[e.v[0] as usize], map[e.v[1] as usize]);
    }
    s
}

/// Writes the `.mtl` companion of [`write_obj`] (`None` without materials).
pub fn write_mtl(m: &Mesh) -> Option<String> {
    if m.materials.is_empty() {
        return None;
    }
    let mut s = String::from("# urdf-studio\n");
    for mat in m.export_slots().0 {
        let [r, g, b, a] = mat.color;
        let _ = writeln!(s, "\nnewmtl {}\nKa 0 0 0\nKd {r} {g} {b}\nKs 0 0 0\nd {a}\nillum 1", mat.name);
    }
    Some(s)
}

/// Writes a minimal Collada 1.4.1 document (Z-up, meters, one polylist per
/// material slot).
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
    let (slots, face_slot) = m.export_slots();
    let faces: Vec<(usize, &crate::Face)> = m.faces.iter().enumerate().filter(|(_, f)| f.alive).collect();
    let mut normals = String::new();
    for (_, f) in &faces {
        let n = crate::newell(f.verts.iter().map(|&v| m.verts[v as usize].co));
        let _ = write!(normals, "{} {} {} ", n.x, n.y, n.z);
    }
    // One polylist per slot (a single one without materials).
    let groups: Vec<Option<usize>> = if slots.is_empty() { vec![None] } else { (0..slots.len()).map(Some).collect() };
    let mut polylists = String::new();
    for g in groups {
        let mut count = 0;
        let mut vcount = String::new();
        let mut p = String::new();
        for (ni, (fi, f)) in faces.iter().enumerate() {
            if g.is_some_and(|k| face_slot[*fi] as usize != k) {
                continue;
            }
            count += 1;
            let _ = write!(vcount, "{} ", f.verts.len());
            for &v in &f.verts {
                let _ = write!(p, "{} {} ", map[v as usize], ni);
            }
        }
        if count == 0 {
            continue;
        }
        let material = g.map(|k| format!(" material=\"{}\"", slots[k].name)).unwrap_or_default();
        let _ = write!(
            polylists,
            r##"
        <polylist count="{count}"{material}>
          <input semantic="VERTEX" source="#{id}-vertices" offset="0"/>
          <input semantic="NORMAL" source="#{id}-normals" offset="1"/>
          <vcount>{vcount}</vcount>
          <p>{p}</p>
        </polylist>"##
        );
    }
    let mut effects = String::new();
    let mut materials = String::new();
    let mut binds = String::new();
    for s in &slots {
        let [r, g, b, a] = s.color;
        let n = &s.name;
        // Only translucent slots get transparency (A_ONE: opacity = alpha).
        let alpha = if a < 1.0 {
            format!(
                r##"
            <transparent opaque="A_ONE"><color>1 1 1 {a}</color></transparent>
            <transparency><float sid="transparency">1</float></transparency>"##
            )
        } else {
            String::new()
        };
        let _ = write!(
            effects,
            r##"
    <effect id="{n}-effect">
      <profile_COMMON>
        <technique sid="common">
          <lambert>
            <diffuse><color sid="diffuse">{r} {g} {b} 1</color></diffuse>{alpha}
          </lambert>
        </technique>
      </profile_COMMON>
    </effect>"##
        );
        let _ = write!(
            materials,
            r##"
    <material id="{n}-material" name="{n}">
      <instance_effect url="#{n}-effect"/>
    </material>"##
        );
        let _ = write!(binds, r##"
              <instance_material symbol="{n}" target="#{n}-material"/>"##);
    }
    let libraries = if slots.is_empty() {
        String::new()
    } else {
        format!("\n  <library_effects>{effects}\n  </library_effects>\n  <library_materials>{materials}\n  </library_materials>")
    };
    let instance = if slots.is_empty() {
        format!(r##"<instance_geometry url="#{id}-mesh" name="{id}"/>"##)
    } else {
        format!(
            r##"<instance_geometry url="#{id}-mesh" name="{id}">
          <bind_material>
            <technique_common>{binds}
            </technique_common>
          </bind_material>
        </instance_geometry>"##
        )
    };
    format!(
        r##"<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>urdf-studio</authoring_tool></contributor>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>{libraries}
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
        </vertices>{polylists}
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="{id}" name="{id}" type="NODE">
        {instance}
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
        let s = write_obj(&m, "cube", None);
        let r = read_obj(&s, None).unwrap();
        assert_eq!(r.live_counts(), (8, 12, 6));
        let r = read_obj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1 2/2/2 -1\n", None).unwrap();
        assert_eq!(r.live_counts(), (3, 3, 1));
    }

    fn two_colored_cube() -> Mesh {
        let mut m = primitives::cube(1.0);
        let red = m.add_material("red paint", [1.0, 0.0, 0.0, 1.0], None);
        m.faces[0].sel = true;
        m.assign_material(red).unwrap();
        m.faces[0].sel = false;
        m
    }

    fn mat_counts(m: &Mesh) -> Vec<(String, [u8; 3], usize)> {
        let q = |c: f32| (c * 31.0).round() as u8;
        let mut out: Vec<_> = m
            .materials
            .iter()
            .enumerate()
            .map(|(i, mt)| {
                let n = m.faces.iter().filter(|f| f.alive && f.mat == i as u32).count();
                (mt.name.clone(), [q(mt.color[0]), q(mt.color[1]), q(mt.color[2])], n)
            })
            .collect();
        out.sort_by_key(|x| x.2);
        out
    }

    #[test]
    fn obj_materials_roundtrip() {
        let m = two_colored_cube();
        let obj = write_obj(&m, "cube", Some("cube.mtl"));
        assert_eq!(obj_mtllibs(&obj), vec!["cube.mtl"]);
        let mtl = write_mtl(&m).unwrap();
        let r = read_obj(&obj, Some(&mtl)).unwrap();
        let c = mat_counts(&r);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0], ("red_paint".into(), [31, 0, 0], 1));
        assert_eq!(c[1].2, 5);
        // Without the .mtl the slots survive with default colors.
        assert_eq!(read_obj(&obj, None).unwrap().materials.len(), 2);
        // Vertex colors.
        let r = read_obj("v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 1 0 0\nf 1 2 3\n", None).unwrap();
        assert_eq!(r.materials[0].name, "color_ff0000");
    }

    #[test]
    fn stl_colors_roundtrip() {
        let m = two_colored_cube();
        let r = read_stl(&write_stl(&m, "cube")).unwrap();
        assert_eq!(r.live_counts(), (8, 18, 12));
        let c = mat_counts(&r);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].1, c[0].2), ([31, 0, 0], 2));
        assert_eq!(c[1].2, 10);
        // Uncolored files stay without materials.
        assert!(read_stl(&write_stl(&primitives::cube(1.0), "c")).unwrap().materials.is_empty());
    }

    #[test]
    fn dae_writes() {
        let s = write_dae(&primitives::cube(1.0), "my cube");
        assert!(s.contains("<polylist count=\"6\">"));
        assert!(s.contains("Z_UP"));
        let s = write_dae(&two_colored_cube(), "cube");
        assert!(s.contains("<polylist count=\"1\" material=\"red_paint\">"));
        assert!(s.contains("<polylist count=\"5\" material=\"default\">"));
        assert!(s.contains(r##"<instance_material symbol="red_paint" target="#red_paint-material"/>"##));
    }
}
