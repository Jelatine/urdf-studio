//! Serializable operator commands. The UI sends these by name with
//! parameters, which keeps the WASM boundary small and makes every operator
//! re-runnable with new parameters ("Adjust Last Operation").

use crate::editor::Editor;
use crate::fit::{FitAxis, FitMode, FitOptions, FitShape};
use crate::ops::{DeleteKind, MergeKind, OpResult};
use crate::select::{Compare, SelectAction, SelectOp, SimilarType};
use crate::{primitives, ElemKind, Mesh, SelectMode};
use glam::{DMat4, DVec3};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Primitive {
    Cube,
    Plane,
    Grid,
    Circle,
    Cylinder,
    Cone,
    UvSphere,
}

fn d1() -> f64 {
    1.0
}
fn d_seg() -> u32 {
    16
}
fn d_rings() -> u32 {
    8
}
fn d_scale() -> [f64; 3] {
    [1.0; 3]
}

/// Angles are in degrees.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Command {
    // ---- selection
    SetSelectMode { mode: SelectMode },
    SelectAll { action: SelectAction },
    SelectElems { kind: ElemKind, ids: Vec<u32>, mode: SelectOp },
    SelectLinked,
    SelectLinkedPick { kind: ElemKind, index: u32, deselect: bool },
    SelectLinkedFlat { angle: f64, #[serde(default)] relative_to_seed: bool },
    SelectMore,
    SelectLess,
    SelectSimilar { similar: SimilarType, threshold: f64 },
    SelectLoop { edge: u32, ring: bool, mode: SelectOp },
    SelectShortestPath { target: u32 },
    SelectNonManifold,
    SelectSharpEdges { angle: f64 },
    SelectLoose,
    SelectBySides { sides: usize, compare: Compare },
    SelectRandom { ratio: f64, seed: u64 },
    SelectBoundaryLoop,
    SelectInnerRegion,
    Hide { unselected: bool },
    Reveal { select: bool },
    // ---- editing
    Delete { kind: DeleteKind },
    DissolveVerts,
    DissolveEdges,
    DissolveFaces,
    DissolveLimited { angle: f64 },
    Duplicate,
    Split,
    Extrude,
    ExtrudeIndividual { offset: f64 },
    Inset { thickness: f64, depth: f64, individual: bool },
    Fill { triangulate: bool },
    Merge { kind: MergeKind, #[serde(default)] cursor: [f64; 3] },
    RemoveDoubles { distance: f64 },
    Subdivide { levels: u32 },
    Triangulate,
    TrisToQuads { angle: f64 },
    Poke,
    FlipNormals,
    RecalcNormals { inside: bool },
    Rip,
    Bridge,
    LoopCut { edge: u32, cuts: u32, factor: f64 },
    Connect,
    Bisect { co: [f64; 3], no: [f64; 3], clear_inner: bool, clear_outer: bool, fill: bool },
    Smooth { factor: f64, iterations: u32 },
    Mirror { axis: usize, #[serde(default)] pivot: Option<[f64; 3]> },
    Transform { matrix: [f64; 16] },
    SetMedian { position: [f64; 3] },
    AddPrimitive {
        shape: Primitive,
        #[serde(default = "d1")]
        size: f64,
        #[serde(default = "d_seg")]
        segments: u32,
        #[serde(default = "d_rings")]
        rings: u32,
        #[serde(default)]
        offset: [f64; 3],
    },
    /// Replaces the selection by fitted box/cylinder/sphere meshes.
    FitPrimitive {
        #[serde(default)]
        shape: FitShape,
        #[serde(default)]
        mode: FitMode,
        #[serde(default)]
        axis: FitAxis,
        #[serde(default)]
        aligned: bool,
        #[serde(default)]
        per_island: bool,
        #[serde(default = "d_seg")]
        segments: u32,
        #[serde(default = "d_rings")]
        rings: u32,
        #[serde(default)]
        keep_original: bool,
        /// Display scale of the mesh, so shapes fit what the user sees.
        #[serde(default = "d_scale")]
        scale: [f64; 3],
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CmdOutput {
    /// Suggested constraint axis (e.g. extrude normal) for a follow-up grab.
    pub normal: Option<[f64; 3]>,
    /// Number of affected elements, when meaningful.
    pub count: Option<usize>,
}

impl CmdOutput {
    fn count(n: usize) -> Self {
        Self { count: Some(n), ..Default::default() }
    }
}

impl Command {
    /// Selection commands don't modify geometry (the file isn't dirtied).
    pub fn is_selection(&self) -> bool {
        use Command::*;
        matches!(
            self,
            SetSelectMode { .. }
                | SelectAll { .. }
                | SelectElems { .. }
                | SelectLinked
                | SelectLinkedPick { .. }
                | SelectLinkedFlat { .. }
                | SelectMore
                | SelectLess
                | SelectSimilar { .. }
                | SelectLoop { .. }
                | SelectShortestPath { .. }
                | SelectNonManifold
                | SelectSharpEdges { .. }
                | SelectLoose
                | SelectBySides { .. }
                | SelectRandom { .. }
                | SelectBoundaryLoop
                | SelectInnerRegion
                | Hide { .. }
                | Reveal { .. }
        )
    }

    pub fn label(&self) -> String {
        let s = serde_json_like_name(self);
        let mut out = String::new();
        for (i, w) in s.split('_').enumerate() {
            if i > 0 {
                out.push(' ');
            }
            let mut c = w.chars();
            if let Some(f) = c.next() {
                out.extend(f.to_uppercase());
                out.push_str(c.as_str());
            }
        }
        out
    }

    pub fn execute(&self, m: &mut Mesh) -> OpResult<CmdOutput> {
        use Command::*;
        let rad = |deg: f64| deg.to_radians();
        Ok(match self {
            SetSelectMode { mode } => {
                m.set_select_mode(*mode);
                CmdOutput::default()
            }
            SelectAll { action } => {
                m.select_all(*action);
                CmdOutput::default()
            }
            SelectElems { kind, ids, mode } => {
                m.select_elems(*kind, ids, *mode);
                CmdOutput::default()
            }
            SelectLinked => {
                m.select_linked();
                CmdOutput::default()
            }
            SelectLinkedPick { kind, index, deselect } => {
                m.select_linked_pick(*kind, *index, *deselect);
                CmdOutput::default()
            }
            SelectLinkedFlat { angle, relative_to_seed } => {
                CmdOutput::count(m.select_linked_flat(rad(*angle), *relative_to_seed))
            }
            SelectMore => {
                m.select_more();
                CmdOutput::default()
            }
            SelectLess => {
                m.select_less();
                CmdOutput::default()
            }
            SelectSimilar { similar, threshold } => {
                let th = match similar {
                    SimilarType::Normal | SimilarType::Direction | SimilarType::Coplanar => rad(*threshold),
                    _ => *threshold,
                };
                CmdOutput::count(m.select_similar(*similar, th))
            }
            SelectLoop { edge, ring, mode } => {
                m.select_loop(*edge, *ring, *mode);
                CmdOutput::default()
            }
            SelectShortestPath { target } => {
                m.select_shortest_path(*target);
                CmdOutput::default()
            }
            SelectNonManifold => CmdOutput::count(m.select_non_manifold()),
            SelectSharpEdges { angle } => CmdOutput::count(m.select_sharp_edges(rad(*angle))),
            SelectLoose => CmdOutput::count(m.select_loose()),
            SelectBySides { sides, compare } => CmdOutput::count(m.select_faces_by_sides(*sides, *compare)),
            SelectRandom { ratio, seed } => CmdOutput::count(m.select_random(*ratio, *seed)),
            SelectBoundaryLoop => CmdOutput::count(m.select_boundary_loop()),
            SelectInnerRegion => CmdOutput::count(m.select_loop_inner_region()),
            Hide { unselected } => {
                m.hide(*unselected);
                CmdOutput::default()
            }
            Reveal { select } => {
                m.reveal(*select);
                CmdOutput::default()
            }
            Delete { kind } => {
                m.delete(*kind)?;
                CmdOutput::default()
            }
            DissolveVerts => CmdOutput::count(m.dissolve_verts()?),
            DissolveEdges => CmdOutput::count(m.dissolve_edges()?),
            DissolveFaces => CmdOutput::count(m.dissolve_faces()?),
            DissolveLimited { angle } => CmdOutput::count(m.dissolve_limited(rad(*angle))?),
            Duplicate => {
                m.duplicate()?;
                CmdOutput::default()
            }
            Split => {
                m.split()?;
                CmdOutput::default()
            }
            Extrude => {
                let n = m.extrude()?;
                CmdOutput { normal: (n != DVec3::ZERO).then(|| n.to_array()), count: None }
            }
            ExtrudeIndividual { offset } => {
                m.extrude_individual(*offset)?;
                CmdOutput::default()
            }
            Inset { thickness, depth, individual } => {
                m.inset(*thickness, *depth, *individual)?;
                CmdOutput::default()
            }
            Fill { triangulate } => CmdOutput::count(m.fill(*triangulate)?),
            Merge { kind, cursor } => CmdOutput::count(m.merge(*kind, DVec3::from_array(*cursor))?),
            RemoveDoubles { distance } => CmdOutput::count(m.remove_doubles(*distance)?),
            Subdivide { levels } => {
                m.subdivide(*levels)?;
                CmdOutput::default()
            }
            Triangulate => CmdOutput::count(m.triangulate_selected()?),
            TrisToQuads { angle } => CmdOutput::count(m.tris_to_quads(rad(*angle))?),
            Poke => {
                m.poke()?;
                CmdOutput::default()
            }
            FlipNormals => {
                m.flip_normals()?;
                CmdOutput::default()
            }
            RecalcNormals { inside } => {
                m.recalc_normals(*inside)?;
                CmdOutput::default()
            }
            Rip => CmdOutput::count(m.edge_split()?),
            Bridge => CmdOutput::count(m.bridge_edge_loops()?),
            LoopCut { edge, cuts, factor } => CmdOutput::count(m.loop_cut(*edge, *cuts, *factor)?),
            Connect => CmdOutput::count(m.connect_verts()?),
            Bisect { co, no, clear_inner, clear_outer, fill } => CmdOutput::count(m.bisect(
                DVec3::from_array(*co),
                DVec3::from_array(*no),
                *clear_inner,
                *clear_outer,
                *fill,
            )?),
            Smooth { factor, iterations } => {
                m.smooth(*factor, *iterations)?;
                CmdOutput::default()
            }
            Mirror { axis, pivot } => {
                let p = pivot.map(DVec3::from_array).or_else(|| m.selection_center()).unwrap_or(DVec3::ZERO);
                m.mirror(*axis, p)?;
                CmdOutput::default()
            }
            Transform { matrix } => {
                m.transform_selected(DMat4::from_cols_array(matrix))?;
                CmdOutput::default()
            }
            SetMedian { position } => {
                let c = m.selection_center().ok_or(crate::ops::OpError::NothingSelected)?;
                m.transform_selected(DMat4::from_translation(DVec3::from_array(*position) - c))?;
                CmdOutput::default()
            }
            AddPrimitive { shape, size, segments, rings, offset } => {
                let s = *size;
                let seg = (*segments).max(3) as usize;
                let prim = match shape {
                    Primitive::Cube => primitives::cube(s),
                    Primitive::Plane => primitives::plane(s),
                    Primitive::Grid => primitives::grid(seg, seg, s),
                    Primitive::Circle => primitives::circle(seg, s * 0.5, true),
                    Primitive::Cylinder => primitives::cylinder(seg, s * 0.5, s),
                    Primitive::Cone => primitives::cone(seg, s * 0.5, 0.0, s, true),
                    Primitive::UvSphere => primitives::uv_sphere(seg, (*rings).max(2) as usize, s * 0.5),
                };
                m.add_mesh(&prim, DVec3::from_array(*offset));
                CmdOutput::default()
            }
            FitPrimitive { shape, mode, axis, aligned, per_island, segments, rings, keep_original, scale } => {
                let o = FitOptions {
                    shape: *shape,
                    mode: *mode,
                    axis: *axis,
                    aligned: *aligned,
                    per_island: *per_island,
                    all: false,
                    scale: *scale,
                };
                CmdOutput::count(m.fit_replace(&o, *segments, *rings, *keep_original)?)
            }
        })
    }
}

fn serde_json_like_name(c: &Command) -> String {
    // Debug output starts with the variant name in CamelCase.
    let dbg = format!("{c:?}");
    let name: String = dbg.chars().take_while(|ch| ch.is_alphanumeric()).collect();
    let mut out = String::new();
    for (i, ch) in name.chars().enumerate() {
        if ch.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(ch.to_lowercase());
    }
    out
}

impl Editor {
    /// Executes a command with undo support.
    pub fn execute(&mut self, cmd: &Command) -> OpResult<CmdOutput> {
        if cmd.is_selection() {
            self.push_undo("Select");
            let out = cmd.execute(&mut self.mesh);
            self.version += 1;
            if matches!(cmd, Command::Hide { .. } | Command::Reveal { .. }) {
                self.geom_version += 1;
            }
            out
        } else {
            self.apply(&cmd.label(), |m| cmd.execute(m))
        }
    }

    /// Re-runs the last command with new parameters.
    pub fn adjust(&mut self, cmd: &Command) -> OpResult<CmdOutput> {
        self.redo_last(|m| cmd.execute(m))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_dispatch() {
        let mut ed = Editor::new(primitives::cube(1.0));
        let cmds = [
            r#"{"op":"set_select_mode","mode":"face"}"#,
            r#"{"op":"select_elems","kind":"face","ids":[1],"mode":"set"}"#,
            r#"{"op":"extrude"}"#,
        ];
        let mut last = CmdOutput::default();
        for c in cmds {
            let cmd: Command = serde_json_parse(c);
            last = ed.execute(&cmd).unwrap();
        }
        assert_eq!(last.normal, Some([0.0, 0.0, 1.0]));
        assert_eq!(ed.mesh.live_counts().2, 10);
        let flat: Command = serde_json_parse(r#"{"op":"select_linked_flat","angle":1}"#);
        assert!(flat.is_selection());
        assert_eq!(Command::DissolveLimited { angle: 1.0 }.label(), "Dissolve Limited");
        let fit: Command = serde_json_parse(r#"{"op":"fit_primitive","shape":"sphere","mode":"least_squares"}"#);
        assert!(matches!(fit, Command::FitPrimitive { segments: 16, scale: [1.0, 1.0, 1.0], .. }));
    }

    #[test]
    fn adjust_select_linked_flat() {
        let mut m = primitives::cylinder(16, 1.0, 1.0);
        crate::ops::triangulate_all(&mut m);
        let side = (0..m.faces.len() as u32).find(|&f| m.face_normal(f).z.abs() < 0.01).unwrap();
        let mut ed = Editor::new(m);
        ed.execute(&Command::SetSelectMode { mode: SelectMode::Face }).unwrap();
        ed.execute(&Command::SelectElems { kind: ElemKind::Face, ids: vec![side], mode: SelectOp::Set }).unwrap();
        ed.execute(&Command::SelectLinkedFlat { angle: 1.0, relative_to_seed: false }).unwrap();
        assert_eq!(ed.mesh.selected_counts().2, 2); // the two triangles of one side quad
        ed.adjust(&Command::SelectLinkedFlat { angle: 30.0, relative_to_seed: false }).unwrap();
        assert_eq!(ed.mesh.selected_counts().2, 32);
    }

    fn serde_json_parse(s: &str) -> Command {
        serde_json::from_str(s).unwrap()
    }
}
