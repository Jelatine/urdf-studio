//! URDF data model, parser and writer.
//!
//! Unknown elements (e.g. `<gazebo>`, `<transmission>`, or vendor tags inside
//! links/joints) are kept verbatim in `extras` and written back on save.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UrdfError {
    #[error("XML error: {0}")]
    Xml(#[from] roxmltree::Error),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pose {
    pub xyz: [f64; 3],
    pub rpy: [f64; 3],
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Material {
    pub name: String,
    pub color: Option<[f64; 4]>,
    pub texture: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Inertia {
    pub ixx: f64,
    pub ixy: f64,
    pub ixz: f64,
    pub iyy: f64,
    pub iyz: f64,
    pub izz: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Inertial {
    pub origin: Pose,
    pub mass: f64,
    pub inertia: Inertia,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Geometry {
    Box { size: [f64; 3] },
    Cylinder { radius: f64, length: f64 },
    Sphere { radius: f64 },
    Mesh { filename: String, scale: Option<[f64; 3]> },
}

impl Default for Geometry {
    fn default() -> Self {
        Geometry::Box { size: [0.1, 0.1, 0.1] }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Visual {
    pub name: Option<String>,
    pub origin: Pose,
    pub geometry: Geometry,
    pub material: Option<Material>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Collision {
    pub name: Option<String>,
    pub origin: Pose,
    pub geometry: Geometry,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub name: String,
    pub inertial: Option<Inertial>,
    pub visuals: Vec<Visual>,
    pub collisions: Vec<Collision>,
    pub extras: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JointType {
    Revolute,
    Continuous,
    Prismatic,
    #[default]
    Fixed,
    Floating,
    Planar,
}

impl JointType {
    pub fn as_str(self) -> &'static str {
        match self {
            JointType::Revolute => "revolute",
            JointType::Continuous => "continuous",
            JointType::Prismatic => "prismatic",
            JointType::Fixed => "fixed",
            JointType::Floating => "floating",
            JointType::Planar => "planar",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "revolute" => JointType::Revolute,
            "continuous" => JointType::Continuous,
            "prismatic" => JointType::Prismatic,
            "fixed" => JointType::Fixed,
            "floating" => JointType::Floating,
            "planar" => JointType::Planar,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Limit {
    pub lower: f64,
    pub upper: f64,
    pub effort: f64,
    pub velocity: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Dynamics {
    pub damping: f64,
    pub friction: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mimic {
    pub joint: String,
    pub multiplier: f64,
    pub offset: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SafetyController {
    pub soft_lower_limit: f64,
    pub soft_upper_limit: f64,
    pub k_position: f64,
    pub k_velocity: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Calibration {
    pub rising: Option<f64>,
    pub falling: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Joint {
    pub name: String,
    pub joint_type: JointType,
    pub origin: Pose,
    pub parent: String,
    pub child: String,
    pub axis: [f64; 3],
    pub limit: Option<Limit>,
    pub dynamics: Option<Dynamics>,
    pub mimic: Option<Mimic>,
    pub safety_controller: Option<SafetyController>,
    pub calibration: Option<Calibration>,
    pub extras: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Robot {
    pub name: String,
    pub materials: Vec<Material>,
    pub links: Vec<Link>,
    pub joints: Vec<Joint>,
    /// Unrecognized top-level elements, verbatim.
    pub extras: Vec<String>,
}

// ------------------------------------------------------------------ parsing

fn floats<const N: usize>(s: Option<&str>, default: [f64; N]) -> Result<[f64; N], UrdfError> {
    let Some(s) = s else { return Ok(default) };
    let v: Vec<f64> = s
        .split_whitespace()
        .map(|t| t.parse::<f64>().map_err(|_| UrdfError::Invalid(format!("bad number '{t}' in '{s}'"))))
        .collect::<Result<_, _>>()?;
    if v.len() != N {
        return Err(UrdfError::Invalid(format!("expected {N} numbers, got '{s}'")));
    }
    let mut out = [0.0; N];
    out.copy_from_slice(&v);
    Ok(out)
}

fn num(n: roxmltree::Node, attr: &str, default: f64) -> Result<f64, UrdfError> {
    match n.attribute(attr) {
        None => Ok(default),
        Some(s) => s.trim().parse().map_err(|_| UrdfError::Invalid(format!("bad number '{s}' for {attr}"))),
    }
}

fn child<'a, 'i>(n: roxmltree::Node<'a, 'i>, tag: &str) -> Option<roxmltree::Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == tag)
}

fn pose(n: Option<roxmltree::Node>) -> Result<Pose, UrdfError> {
    let Some(n) = n else { return Ok(Pose::default()) };
    Ok(Pose { xyz: floats(n.attribute("xyz"), [0.0; 3])?, rpy: floats(n.attribute("rpy"), [0.0; 3])? })
}

fn material(n: roxmltree::Node) -> Result<Material, UrdfError> {
    Ok(Material {
        name: n.attribute("name").unwrap_or("").to_string(),
        color: match child(n, "color") {
            Some(c) => Some(floats(c.attribute("rgba"), [1.0; 4])?),
            None => None,
        },
        texture: child(n, "texture").and_then(|t| t.attribute("filename")).map(String::from),
    })
}

fn geometry(n: Option<roxmltree::Node>) -> Result<Geometry, UrdfError> {
    let Some(n) = n else { return Err(UrdfError::Invalid("missing <geometry>".into())) };
    let Some(g) = n.children().find(|c| c.is_element()) else {
        return Err(UrdfError::Invalid("empty <geometry>".into()));
    };
    Ok(match g.tag_name().name() {
        "box" => Geometry::Box { size: floats(g.attribute("size"), [1.0; 3])? },
        "cylinder" => Geometry::Cylinder { radius: num(g, "radius", 0.0)?, length: num(g, "length", 0.0)? },
        "sphere" => Geometry::Sphere { radius: num(g, "radius", 0.0)? },
        "mesh" => Geometry::Mesh {
            filename: g.attribute("filename").unwrap_or("").to_string(),
            scale: match g.attribute("scale") {
                Some(s) => Some(floats(Some(s), [1.0; 3])?),
                None => None,
            },
        },
        other => return Err(UrdfError::Invalid(format!("unsupported geometry <{other}>"))),
    })
}

fn raw<'a>(text: &'a str, n: roxmltree::Node) -> String {
    text[n.range()].to_string()
}

pub fn parse_urdf(text: &str) -> Result<Robot, UrdfError> {
    let doc = roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    )?;
    let root = doc.root_element();
    if root.tag_name().name() != "robot" {
        return Err(UrdfError::Invalid("root element must be <robot>".into()));
    }
    let mut robot = Robot { name: root.attribute("name").unwrap_or("robot").to_string(), ..Default::default() };
    for n in root.children().filter(|c| c.is_element()) {
        match n.tag_name().name() {
            "material" => robot.materials.push(material(n)?),
            "link" => {
                let mut link = Link { name: n.attribute("name").unwrap_or("").to_string(), ..Default::default() };
                for c in n.children().filter(|c| c.is_element()) {
                    match c.tag_name().name() {
                        "inertial" => {
                            let i = child(c, "inertia");
                            link.inertial = Some(Inertial {
                                origin: pose(child(c, "origin"))?,
                                mass: child(c, "mass").map(|m| num(m, "value", 0.0)).transpose()?.unwrap_or(0.0),
                                inertia: match i {
                                    Some(i) => Inertia {
                                        ixx: num(i, "ixx", 0.0)?,
                                        ixy: num(i, "ixy", 0.0)?,
                                        ixz: num(i, "ixz", 0.0)?,
                                        iyy: num(i, "iyy", 0.0)?,
                                        iyz: num(i, "iyz", 0.0)?,
                                        izz: num(i, "izz", 0.0)?,
                                    },
                                    None => Inertia::default(),
                                },
                            });
                        }
                        "visual" => link.visuals.push(Visual {
                            name: c.attribute("name").map(String::from),
                            origin: pose(child(c, "origin"))?,
                            geometry: geometry(child(c, "geometry"))?,
                            material: child(c, "material").map(material).transpose()?,
                        }),
                        "collision" => link.collisions.push(Collision {
                            name: c.attribute("name").map(String::from),
                            origin: pose(child(c, "origin"))?,
                            geometry: geometry(child(c, "geometry"))?,
                        }),
                        _ => link.extras.push(raw(text, c)),
                    }
                }
                robot.links.push(link);
            }
            "joint" => {
                let ty = n.attribute("type").unwrap_or("fixed");
                let jt = JointType::parse(ty).ok_or_else(|| UrdfError::Invalid(format!("unknown joint type '{ty}'")))?;
                let mut j = Joint {
                    name: n.attribute("name").unwrap_or("").to_string(),
                    joint_type: jt,
                    axis: [1.0, 0.0, 0.0],
                    ..Default::default()
                };
                for c in n.children().filter(|c| c.is_element()) {
                    match c.tag_name().name() {
                        "origin" => j.origin = pose(Some(c))?,
                        "parent" => j.parent = c.attribute("link").unwrap_or("").to_string(),
                        "child" => j.child = c.attribute("link").unwrap_or("").to_string(),
                        "axis" => j.axis = floats(c.attribute("xyz"), [1.0, 0.0, 0.0])?,
                        "limit" => {
                            j.limit = Some(Limit {
                                lower: num(c, "lower", 0.0)?,
                                upper: num(c, "upper", 0.0)?,
                                effort: num(c, "effort", 0.0)?,
                                velocity: num(c, "velocity", 0.0)?,
                            })
                        }
                        "dynamics" => {
                            j.dynamics =
                                Some(Dynamics { damping: num(c, "damping", 0.0)?, friction: num(c, "friction", 0.0)? })
                        }
                        "mimic" => {
                            j.mimic = Some(Mimic {
                                joint: c.attribute("joint").unwrap_or("").to_string(),
                                multiplier: num(c, "multiplier", 1.0)?,
                                offset: num(c, "offset", 0.0)?,
                            })
                        }
                        "safety_controller" => {
                            j.safety_controller = Some(SafetyController {
                                soft_lower_limit: num(c, "soft_lower_limit", 0.0)?,
                                soft_upper_limit: num(c, "soft_upper_limit", 0.0)?,
                                k_position: num(c, "k_position", 0.0)?,
                                k_velocity: num(c, "k_velocity", 0.0)?,
                            })
                        }
                        "calibration" => {
                            j.calibration = Some(Calibration {
                                rising: c.attribute("rising").and_then(|s| s.parse().ok()),
                                falling: c.attribute("falling").and_then(|s| s.parse().ok()),
                            })
                        }
                        _ => j.extras.push(raw(text, c)),
                    }
                }
                robot.joints.push(j);
            }
            _ => robot.extras.push(raw(text, n)),
        }
    }
    Ok(robot)
}

// ------------------------------------------------------------------ writing

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Formats a float compactly (no trailing zeros, no "-0").
pub fn fmt_num(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    let s = format!("{:.9}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

fn nums(v: &[f64]) -> String {
    v.iter().map(|x| fmt_num(*x)).collect::<Vec<_>>().join(" ")
}

fn write_pose(out: &mut String, ind: &str, p: &Pose, always: bool) {
    if !always && *p == Pose::default() {
        return;
    }
    let _ = writeln!(out, "{ind}<origin xyz=\"{}\" rpy=\"{}\"/>", nums(&p.xyz), nums(&p.rpy));
}

fn write_material(out: &mut String, ind: &str, m: &Material) {
    if m.color.is_none() && m.texture.is_none() {
        let _ = writeln!(out, "{ind}<material name=\"{}\"/>", esc(&m.name));
        return;
    }
    let _ = writeln!(out, "{ind}<material name=\"{}\">", esc(&m.name));
    if let Some(c) = m.color {
        let _ = writeln!(out, "{ind}  <color rgba=\"{}\"/>", nums(&c));
    }
    if let Some(t) = &m.texture {
        let _ = writeln!(out, "{ind}  <texture filename=\"{}\"/>", esc(t));
    }
    let _ = writeln!(out, "{ind}</material>");
}

fn write_geometry(out: &mut String, ind: &str, g: &Geometry) {
    let _ = writeln!(out, "{ind}<geometry>");
    let _ = match g {
        Geometry::Box { size } => writeln!(out, "{ind}  <box size=\"{}\"/>", nums(size)),
        Geometry::Cylinder { radius, length } => {
            writeln!(out, "{ind}  <cylinder radius=\"{}\" length=\"{}\"/>", fmt_num(*radius), fmt_num(*length))
        }
        Geometry::Sphere { radius } => writeln!(out, "{ind}  <sphere radius=\"{}\"/>", fmt_num(*radius)),
        Geometry::Mesh { filename, scale } => match scale {
            Some(s) => writeln!(out, "{ind}  <mesh filename=\"{}\" scale=\"{}\"/>", esc(filename), nums(s)),
            None => writeln!(out, "{ind}  <mesh filename=\"{}\"/>", esc(filename)),
        },
    };
    let _ = writeln!(out, "{ind}</geometry>");
}

fn write_extras(out: &mut String, ind: &str, extras: &[String]) {
    for e in extras {
        let _ = writeln!(out, "{ind}{}", e.trim());
    }
}

pub fn write_urdf(r: &Robot) -> String {
    let mut o = String::new();
    let _ = writeln!(o, "<?xml version=\"1.0\" encoding=\"utf-8\"?>");
    let _ = writeln!(o, "<!-- Saved by urdf-studio -->");
    let _ = writeln!(o, "<robot name=\"{}\">", esc(&r.name));
    for m in &r.materials {
        write_material(&mut o, "  ", m);
    }
    for l in &r.links {
        let empty = l.inertial.is_none() && l.visuals.is_empty() && l.collisions.is_empty() && l.extras.is_empty();
        if empty {
            let _ = writeln!(o, "  <link name=\"{}\"/>", esc(&l.name));
            continue;
        }
        let _ = writeln!(o, "  <link name=\"{}\">", esc(&l.name));
        if let Some(i) = &l.inertial {
            let _ = writeln!(o, "    <inertial>");
            write_pose(&mut o, "      ", &i.origin, false);
            let _ = writeln!(o, "      <mass value=\"{}\"/>", fmt_num(i.mass));
            let t = &i.inertia;
            let _ = writeln!(
                o,
                "      <inertia ixx=\"{}\" ixy=\"{}\" ixz=\"{}\" iyy=\"{}\" iyz=\"{}\" izz=\"{}\"/>",
                fmt_num(t.ixx),
                fmt_num(t.ixy),
                fmt_num(t.ixz),
                fmt_num(t.iyy),
                fmt_num(t.iyz),
                fmt_num(t.izz)
            );
            let _ = writeln!(o, "    </inertial>");
        }
        for v in &l.visuals {
            match &v.name {
                Some(n) => {
                    let _ = writeln!(o, "    <visual name=\"{}\">", esc(n));
                }
                None => {
                    let _ = writeln!(o, "    <visual>");
                }
            }
            write_pose(&mut o, "      ", &v.origin, false);
            write_geometry(&mut o, "      ", &v.geometry);
            if let Some(m) = &v.material {
                write_material(&mut o, "      ", m);
            }
            let _ = writeln!(o, "    </visual>");
        }
        for c in &l.collisions {
            match &c.name {
                Some(n) => {
                    let _ = writeln!(o, "    <collision name=\"{}\">", esc(n));
                }
                None => {
                    let _ = writeln!(o, "    <collision>");
                }
            }
            write_pose(&mut o, "      ", &c.origin, false);
            write_geometry(&mut o, "      ", &c.geometry);
            let _ = writeln!(o, "    </collision>");
        }
        write_extras(&mut o, "    ", &l.extras);
        let _ = writeln!(o, "  </link>");
    }
    for j in &r.joints {
        let _ = writeln!(o, "  <joint name=\"{}\" type=\"{}\">", esc(&j.name), j.joint_type.as_str());
        write_pose(&mut o, "    ", &j.origin, true);
        let _ = writeln!(o, "    <parent link=\"{}\"/>", esc(&j.parent));
        let _ = writeln!(o, "    <child link=\"{}\"/>", esc(&j.child));
        if !matches!(j.joint_type, JointType::Fixed | JointType::Floating) {
            let _ = writeln!(o, "    <axis xyz=\"{}\"/>", nums(&j.axis));
        }
        if let Some(l) = &j.limit {
            let _ = writeln!(
                o,
                "    <limit lower=\"{}\" upper=\"{}\" effort=\"{}\" velocity=\"{}\"/>",
                fmt_num(l.lower),
                fmt_num(l.upper),
                fmt_num(l.effort),
                fmt_num(l.velocity)
            );
        }
        if let Some(d) = &j.dynamics {
            let _ = writeln!(o, "    <dynamics damping=\"{}\" friction=\"{}\"/>", fmt_num(d.damping), fmt_num(d.friction));
        }
        if let Some(m) = &j.mimic {
            let _ = writeln!(
                o,
                "    <mimic joint=\"{}\" multiplier=\"{}\" offset=\"{}\"/>",
                esc(&m.joint),
                fmt_num(m.multiplier),
                fmt_num(m.offset)
            );
        }
        if let Some(s) = &j.safety_controller {
            let _ = writeln!(
                o,
                "    <safety_controller soft_lower_limit=\"{}\" soft_upper_limit=\"{}\" k_position=\"{}\" k_velocity=\"{}\"/>",
                fmt_num(s.soft_lower_limit),
                fmt_num(s.soft_upper_limit),
                fmt_num(s.k_position),
                fmt_num(s.k_velocity)
            );
        }
        if let Some(c) = &j.calibration {
            let mut attrs = String::new();
            if let Some(r) = c.rising {
                let _ = write!(attrs, " rising=\"{}\"", fmt_num(r));
            }
            if let Some(f) = c.falling {
                let _ = write!(attrs, " falling=\"{}\"", fmt_num(f));
            }
            let _ = writeln!(o, "    <calibration{attrs}/>");
        }
        write_extras(&mut o, "    ", &j.extras);
        let _ = writeln!(o, "  </joint>");
    }
    write_extras(&mut o, "  ", &r.extras);
    let _ = writeln!(o, "</robot>");
    o
}

// --------------------------------------------------------------- validation

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    pub level: IssueLevel,
    pub message: String,
    /// Link or joint name the issue refers to.
    pub target: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueLevel {
    Error,
    Warning,
}

impl Robot {
    /// Links that are never a joint child.
    pub fn root_links(&self) -> Vec<&str> {
        let children: HashSet<&str> = self.joints.iter().map(|j| j.child.as_str()).collect();
        self.links.iter().map(|l| l.name.as_str()).filter(|n| !children.contains(n)).collect()
    }

    pub fn validate(&self) -> Vec<Issue> {
        let mut out = Vec::new();
        let err = |m: String, t: &str| Issue { level: IssueLevel::Error, message: m, target: Some(t.to_string()) };
        let warn = |m: String, t: &str| Issue { level: IssueLevel::Warning, message: m, target: Some(t.to_string()) };
        let mut names = HashSet::new();
        for l in &self.links {
            if l.name.is_empty() {
                out.push(err("link without a name".into(), ""));
            } else if !names.insert(l.name.as_str()) {
                out.push(err(format!("duplicate link name '{}'", l.name), &l.name));
            }
            if let Some(i) = &l.inertial {
                if i.mass <= 0.0 {
                    out.push(warn(format!("link '{}' has non-positive mass", l.name), &l.name));
                }
                let t = &i.inertia;
                if t.ixx <= 0.0 || t.iyy <= 0.0 || t.izz <= 0.0 {
                    out.push(warn(format!("link '{}' has non-positive principal inertia", l.name), &l.name));
                } else if t.ixx + t.iyy < t.izz || t.iyy + t.izz < t.ixx || t.ixx + t.izz < t.iyy {
                    out.push(warn(format!("link '{}' violates the inertia triangle inequality", l.name), &l.name));
                }
            }
        }
        let mut jnames = HashSet::new();
        let mut parent_of: HashMap<&str, &str> = HashMap::new();
        for j in &self.joints {
            if !jnames.insert(j.name.as_str()) {
                out.push(err(format!("duplicate joint name '{}'", j.name), &j.name));
            }
            if !names.contains(j.parent.as_str()) {
                out.push(err(format!("joint '{}' parent link '{}' not found", j.name, j.parent), &j.name));
            }
            if !names.contains(j.child.as_str()) {
                out.push(err(format!("joint '{}' child link '{}' not found", j.name, j.child), &j.name));
            }
            if parent_of.insert(j.child.as_str(), j.parent.as_str()).is_some() {
                out.push(err(format!("link '{}' has more than one parent joint", j.child), &j.name));
            }
            if matches!(j.joint_type, JointType::Revolute | JointType::Prismatic) {
                match &j.limit {
                    None => out.push(err(format!("joint '{}' requires <limit>", j.name), &j.name)),
                    Some(l) if l.lower > l.upper => {
                        out.push(err(format!("joint '{}' has lower > upper limit", j.name), &j.name))
                    }
                    _ => {}
                }
            }
            let a = j.axis;
            if !matches!(j.joint_type, JointType::Fixed | JointType::Floating) && (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) < 1e-12 {
                out.push(err(format!("joint '{}' has a zero axis", j.name), &j.name));
            }
            if let Some(m) = &j.mimic {
                if !self.joints.iter().any(|o| o.name == m.joint) {
                    out.push(err(format!("joint '{}' mimics unknown joint '{}'", j.name, m.joint), &j.name));
                }
            }
        }
        let roots = self.root_links();
        if self.links.is_empty() {
            out.push(Issue { level: IssueLevel::Error, message: "robot has no links".into(), target: None });
        } else if roots.len() != 1 {
            out.push(Issue {
                level: IssueLevel::Error,
                message: format!("expected exactly one root link, found {}: {}", roots.len(), roots.join(", ")),
                target: None,
            });
        }
        // Cycle detection.
        for l in &self.links {
            let mut seen = HashSet::new();
            let mut cur = l.name.as_str();
            while let Some(&p) = parent_of.get(cur) {
                if !seen.insert(cur) {
                    out.push(err(format!("kinematic loop through link '{}'", l.name), &l.name));
                    break;
                }
                cur = p;
            }
        }
        out
    }

    /// All mesh filenames referenced by visuals and collisions (deduplicated).
    pub fn mesh_filenames(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for l in &self.links {
            let geoms = l.visuals.iter().map(|v| &v.geometry).chain(l.collisions.iter().map(|c| &c.geometry));
            for g in geoms {
                if let Geometry::Mesh { filename, .. } = g {
                    if !out.contains(filename) {
                        out.push(filename.clone());
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<robot name="arm">
  <material name="blue"><color rgba="0 0 0.8 1"/></material>
  <link name="base">
    <inertial><origin xyz="0 0 0.05"/><mass value="1.5"/><inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/></inertial>
    <visual><geometry><mesh filename="package://arm/meshes/base.stl" scale="0.001 0.001 0.001"/></geometry><material name="blue"/></visual>
    <collision><geometry><cylinder radius="0.1" length="0.05"/></geometry></collision>
  </link>
  <link name="l1"/>
  <joint name="j1" type="revolute">
    <origin xyz="0 0 0.1" rpy="0 0 1.5707963"/>
    <parent link="base"/><child link="l1"/>
    <axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="1"/>
    <dynamics damping="0.1"/>
    <custom_tag foo="bar"/>
  </joint>
  <gazebo reference="l1"><material>Gazebo/Red</material></gazebo>
</robot>"#;

    #[test]
    fn parse_sample() {
        let r = parse_urdf(SAMPLE).unwrap();
        assert_eq!(r.name, "arm");
        assert_eq!(r.links.len(), 2);
        assert_eq!(r.joints[0].joint_type, JointType::Revolute);
        assert_eq!(r.joints[0].extras.len(), 1);
        assert_eq!(r.extras.len(), 1);
        assert_eq!(r.mesh_filenames(), vec!["package://arm/meshes/base.stl"]);
        assert!(r.validate().is_empty(), "{:?}", r.validate());
        assert_eq!(r.root_links(), vec!["base"]);
    }

    #[test]
    fn roundtrip() {
        let r = parse_urdf(SAMPLE).unwrap();
        let s = write_urdf(&r);
        let r2 = parse_urdf(&s).unwrap();
        assert_eq!(r, r2);
        assert!(s.contains("<gazebo reference=\"l1\">"));
        // JSON roundtrip (used by the frontend bridge).
        let j = serde_json::to_string(&r).unwrap();
        let r3: Robot = serde_json::from_str(&j).unwrap();
        assert_eq!(r, r3);
    }

    #[test]
    fn validation_catches_errors() {
        let mut r = parse_urdf(SAMPLE).unwrap();
        r.joints[0].child = "missing".into();
        r.joints[0].limit = None;
        let issues = r.validate();
        assert!(issues.iter().any(|i| i.message.contains("not found")));
        assert!(issues.iter().any(|i| i.message.contains("requires <limit>")));
        assert!(issues.iter().any(|i| i.message.contains("root link")));
    }

    #[test]
    fn number_formatting() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(-0.0), "0");
        assert_eq!(fmt_num(0.001), "0.001");
        assert_eq!(fmt_num(-1.5707963), "-1.5707963");
    }
}
