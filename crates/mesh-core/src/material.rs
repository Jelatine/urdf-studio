//! Material slots: per-face flat colors (like Blender's material slots).

use crate::ops::{OpError, OpResult};
use crate::{Mesh, MeshMaterial, DEFAULT_COLOR};
use std::collections::HashMap;

impl Mesh {
    /// Adds a slot and returns its index. A mesh without slots first gets a
    /// "default" slot (colored `base`, e.g. the color it was displayed with)
    /// so that its existing faces keep a color of their own.
    pub fn add_material(&mut self, name: &str, color: [f32; 4], base: Option<[f32; 4]>) -> u32 {
        if self.materials.is_empty() {
            self.materials.push(MeshMaterial { name: "default".into(), color: base.unwrap_or(DEFAULT_COLOR) });
        }
        self.materials.push(MeshMaterial { name: name.to_string(), color });
        (self.materials.len() - 1) as u32
    }

    pub fn set_material(&mut self, index: u32, name: &str, color: [f32; 4]) -> OpResult {
        let m = self.materials.get_mut(index as usize).ok_or_else(|| OpError::Invalid("no such material".into()))?;
        m.name = name.to_string();
        m.color = color;
        Ok(())
    }

    /// Removes a slot; its faces move to the first remaining slot.
    pub fn remove_material(&mut self, index: u32) -> OpResult {
        if index as usize >= self.materials.len() {
            return Err(OpError::Invalid("no such material".into()));
        }
        self.materials.remove(index as usize);
        for f in self.faces.iter_mut() {
            if f.mat == index {
                f.mat = 0;
            } else if f.mat > index {
                f.mat -= 1;
            }
        }
        Ok(())
    }

    /// Assigns slot `index` to the selected faces; returns how many changed.
    pub fn assign_material(&mut self, index: u32) -> OpResult<usize> {
        if index as usize >= self.materials.len() {
            return Err(OpError::Invalid("no such material".into()));
        }
        let sf = self.selected_faces();
        if sf.is_empty() {
            return Err(OpError::NothingSelected);
        }
        for &f in &sf {
            self.faces[f as usize].mat = index;
        }
        Ok(sf.len())
    }

    /// Selects (or deselects) the visible faces using slot `index`.
    pub fn select_material(&mut self, index: u32, deselect: bool) -> usize {
        let fallback = self.materials.len() as u32;
        let ids: Vec<u32> = (0..self.faces.len() as u32)
            .filter(|&f| {
                let face = &self.faces[f as usize];
                face.alive && !face.hide && (face.mat == index || (face.mat >= fallback && index == 0))
            })
            .collect();
        let op = if deselect { crate::select::SelectOp::Sub } else { crate::select::SelectOp::Add };
        self.select_elems(crate::ElemKind::Face, &ids, op);
        ids.len()
    }

    /// Slots for export: the materials plus a "default" slot when some
    /// faces reference none, and each face's slot in that list.
    pub fn export_slots(&self) -> (Vec<MeshMaterial>, Vec<u32>) {
        let mut slots = self.materials.clone();
        let n = slots.len() as u32;
        let mut need_default = false;
        let face_slot: Vec<u32> = self
            .faces
            .iter()
            .map(|f| {
                if f.mat < n {
                    f.mat
                } else {
                    need_default = true;
                    n
                }
            })
            .collect();
        if need_default && !slots.is_empty() {
            slots.push(MeshMaterial { name: "default".into(), color: DEFAULT_COLOR });
        }
        // Unique identifiers without whitespace (OBJ/DAE names).
        let mut seen: HashMap<String, usize> = HashMap::new();
        for s in slots.iter_mut() {
            let mut base: String =
                s.name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
            if base.is_empty() {
                base = "material".into();
            }
            let k = seen.entry(base.clone()).or_insert(0);
            s.name = if *k == 0 { base } else { format!("{base}_{k}") };
            *k += 1;
        }
        (slots, face_slot)
    }
}

/// Builds slots from per-element colors (quantized to 8 bits); returns the
/// slots and each element's slot. `None` colors share a "default" slot.
pub fn slots_from_colors(colors: &[Option<[f32; 4]>]) -> (Vec<MeshMaterial>, Vec<u32>) {
    let mut slots: Vec<MeshMaterial> = Vec::new();
    let mut index: HashMap<Option<[u8; 4]>, u32> = HashMap::new();
    let q = |c: f32| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
    let ids = colors
        .iter()
        .map(|c| {
            let key = c.map(|c| [q(c[0]), q(c[1]), q(c[2]), q(c[3])]);
            *index.entry(key).or_insert_with(|| {
                let (name, color) = match key {
                    Some(k) => (
                        format!("color_{:02x}{:02x}{:02x}", k[0], k[1], k[2]),
                        [k[0] as f32 / 255.0, k[1] as f32 / 255.0, k[2] as f32 / 255.0, k[3] as f32 / 255.0],
                    ),
                    None => ("default".to_string(), DEFAULT_COLOR),
                };
                slots.push(MeshMaterial { name, color });
                (slots.len() - 1) as u32
            })
        })
        .collect();
    (slots, ids)
}

#[cfg(test)]
mod tests {
    use crate::primitives;
    use crate::select::SelectOp;
    use crate::ElemKind;

    #[test]
    fn slots_assign_remove() {
        let mut m = primitives::cube(1.0);
        let red = m.add_material("red", [1.0, 0.0, 0.0, 1.0], None);
        assert_eq!(red, 1);
        assert_eq!(m.materials[0].name, "default");
        m.select_elems(ElemKind::Face, &[2], SelectOp::Set);
        assert_eq!(m.assign_material(red).unwrap(), 1);
        m.compact();
        assert_eq!(m.faces.iter().filter(|f| f.mat == 1).count(), 1);
        m.select_elems(ElemKind::Face, &[], SelectOp::Set);
        assert_eq!(m.select_material(1, false), 1);
        m.remove_material(0).unwrap();
        assert_eq!(m.faces.iter().filter(|f| f.mat == 0).count(), 6);
        assert_eq!(m.materials.len(), 1);
    }

    #[test]
    fn extrude_inherits_material() {
        let mut m = primitives::cube(1.0);
        let red = m.add_material("red", [1.0, 0.0, 0.0, 1.0], None);
        m.set_select_mode(crate::SelectMode::Face);
        m.select_elems(ElemKind::Face, &[1], SelectOp::Set);
        m.assign_material(red).unwrap();
        m.extrude().unwrap();
        assert_eq!(m.faces.iter().filter(|f| f.mat == red).count(), 5);
    }

    #[test]
    fn color_slots() {
        let (slots, ids) = super::slots_from_colors(&[Some([1.0, 0.0, 0.0, 1.0]), None, Some([1.0, 0.0, 0.0, 1.0])]);
        assert_eq!(slots.len(), 2);
        assert_eq!(ids, vec![0, 1, 0]);
        assert_eq!(slots[0].name, "color_ff0000");
    }
}
