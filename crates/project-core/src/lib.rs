//! Project packaging for URDF files and their meshes.
//!
//! A project is a set of files addressed by "virtual paths" (relative,
//! forward-slash separated). It can come from a zip archive (fully in memory)
//! or from a folder on disk (native only, read lazily).

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Files = BTreeMap<String, Vec<u8>>;

/// Normalizes a path: forward slashes, no `.` segments, `..` resolved.
pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

pub fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

pub fn join(dir: &str, rel: &str) -> String {
    if dir.is_empty() {
        normalize(rel)
    } else {
        normalize(&format!("{dir}/{rel}"))
    }
}

fn is_junk(path: &str) -> bool {
    path.starts_with("__MACOSX/") || path.split('/').any(|s| s == ".DS_Store" || s.starts_with("._"))
}

/// Reads every file of a zip archive.
pub fn read_zip(bytes: &[u8]) -> Result<Files, ProjectError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut files = Files::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.is_dir() {
            continue;
        }
        let name = normalize(f.name());
        if name.is_empty() || is_junk(&name) {
            continue;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        files.insert(name, buf);
    }
    Ok(files)
}

/// Writes files into a deflate-compressed zip archive.
pub fn write_zip<'a>(files: impl IntoIterator<Item = (&'a String, &'a Vec<u8>)>) -> Result<Vec<u8>, ProjectError> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (path, data) in files {
        w.start_file(path.as_str(), opts)?;
        w.write_all(data)?;
    }
    Ok(w.finish()?.into_inner())
}

/// URDF files in a project, best candidate first (shallow paths and files
/// inside a `urdf/` folder are preferred).
pub fn urdf_candidates<'a>(paths: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut c: Vec<String> = paths.into_iter().filter(|p| p.to_ascii_lowercase().ends_with(".urdf")).cloned().collect();
    c.sort_by_key(|p| {
        let depth = p.matches('/').count() as i32;
        let in_urdf_dir = p.split('/').any(|s| s == "urdf");
        (if in_urdf_dir { 0 } else { 1 }, depth, p.clone())
    });
    c
}

/// Resolves a URDF mesh reference to a project path.
///
/// Supports `package://pkg/rel`, `file://abs`, absolute and relative paths.
/// Falls back to the longest matching path suffix among `paths`, so archives
/// that do not mirror the original ROS workspace layout still resolve.
pub fn resolve_mesh(urdf_path: &str, filename: &str, paths: &[String]) -> Option<String> {
    let exists = |p: &str| paths.iter().any(|x| x == p);
    let suffix_match = |rel: &str| -> Option<String> {
        let rel = normalize(rel);
        let segs: Vec<&str> = rel.split('/').collect();
        // Try progressively shorter suffixes of the reference.
        for start in 0..segs.len() {
            let suffix = segs[start..].join("/");
            let mut hits: Vec<&String> =
                paths.iter().filter(|p| *p == &suffix || p.ends_with(&format!("/{suffix}"))).collect();
            if !hits.is_empty() {
                hits.sort_by_key(|p| p.len());
                return Some(hits[0].clone());
            }
        }
        None
    };
    if let Some(rest) = filename.strip_prefix("package://") {
        let rest = normalize(rest);
        let (pkg, rel) = rest.split_once('/').unwrap_or((rest.as_str(), ""));
        // A folder named after the package, anywhere in the project.
        let mut hits: Vec<&String> = paths
            .iter()
            .filter(|p| p.as_str() == format!("{pkg}/{rel}") || p.ends_with(&format!("/{pkg}/{rel}")))
            .collect();
        hits.sort_by_key(|p| p.len());
        if let Some(h) = hits.first() {
            return Some((*h).clone());
        }
        // The project root might be the package itself.
        if exists(rel) {
            return Some(rel.to_string());
        }
        let urdf_dir = dirname(urdf_path);
        let pkg_root = dirname(urdf_dir);
        let cand = join(pkg_root, rel);
        if exists(&cand) {
            return Some(cand);
        }
        return suffix_match(&rest);
    }
    let path = filename.strip_prefix("file://").unwrap_or(filename);
    if path.starts_with('/') || path.contains(":\\") || path.contains(":/") {
        return suffix_match(path);
    }
    let cand = join(dirname(urdf_path), path);
    if exists(&cand) {
        return Some(cand);
    }
    suffix_match(path)
}

/// Builds a reference string for a new file next to an existing reference,
/// keeping the same style (package://, relative, ...).
pub fn sibling_reference(reference: &str, new_basename: &str) -> String {
    match reference.rfind('/') {
        Some(i) => format!("{}/{}", &reference[..i], new_basename),
        None => new_basename.to_string(),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub mod native {
    //! Folder-based projects on disk.
    use super::*;
    use std::path::{Path, PathBuf};

    const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "build", "devel", "install", "log", "__pycache__"];
    const KEEP_EXT: &[&str] = &[
        "stl", "dae", "obj", "urdf", "xacro", "xml", "png", "jpg", "jpeg", "tga", "bmp", "mtl", "yaml", "launch",
    ];

    /// Finds the folder to treat as the project root for a URDF on disk:
    /// the parent of the enclosing ROS package (so `package://` references
    /// to sibling packages resolve), otherwise the URDF's parent's parent.
    pub fn project_root(urdf: &Path) -> PathBuf {
        let mut dir = urdf.parent();
        for _ in 0..5 {
            let Some(d) = dir else { break };
            if d.join("package.xml").exists() {
                return d.parent().unwrap_or(d).to_path_buf();
            }
            dir = d.parent();
        }
        let p = urdf.parent().unwrap_or(Path::new("."));
        p.parent().unwrap_or(p).to_path_buf()
    }

    /// Lists project-relevant files under `root` (bounded walk).
    pub fn list_files(root: &Path, max_files: usize, max_depth: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let p = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if p.is_dir() {
                    if depth < max_depth && !SKIP_DIRS.contains(&name.as_str()) {
                        stack.push((p, depth + 1));
                    }
                    continue;
                }
                let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if !KEEP_EXT.contains(&ext.as_str()) {
                    continue;
                }
                if let Ok(rel) = p.strip_prefix(root) {
                    out.push(normalize(&rel.to_string_lossy()));
                    if out.len() >= max_files {
                        return out;
                    }
                }
            }
        }
        out.sort();
        out
    }

    pub fn vpath_to_abs(root: &Path, vpath: &str) -> Result<PathBuf, ProjectError> {
        let n = normalize(vpath);
        if n.is_empty() || n.split('/').any(|s| s == "..") {
            return Err(ProjectError::Invalid(format!("invalid project path '{vpath}'")));
        }
        Ok(root.join(n))
    }

    /// Recursively reads every file under `root` into memory.
    pub fn read_tree(root: &Path) -> Result<Files, ProjectError> {
        let mut files = Files::new();
        for rel in list_files(root, 100_000, 32) {
            files.insert(rel.clone(), std::fs::read(root.join(&rel))?);
        }
        Ok(files)
    }

    pub fn write_tree(root: &Path, files: &Files) -> Result<(), ProjectError> {
        for (rel, data) in files {
            let p = vpath_to_abs(root, rel)?;
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(p, data)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn normalize_paths() {
        assert_eq!(normalize("a/./b/../c\\d"), "a/c/d");
        assert_eq!(join("pkg/urdf", "../meshes/x.stl"), "pkg/meshes/x.stl");
    }

    #[test]
    fn resolve_variants() {
        let p = paths(&["arm/urdf/arm.urdf", "arm/meshes/base.stl", "arm/package.xml", "other/meshes/base.stl"]);
        assert_eq!(resolve_mesh("arm/urdf/arm.urdf", "package://arm/meshes/base.stl", &p).as_deref(), Some("arm/meshes/base.stl"));
        assert_eq!(resolve_mesh("arm/urdf/arm.urdf", "../meshes/base.stl", &p).as_deref(), Some("arm/meshes/base.stl"));
        // Zip that contains only the package contents.
        let flat = paths(&["urdf/arm.urdf", "meshes/base.stl"]);
        assert_eq!(resolve_mesh("urdf/arm.urdf", "package://arm/meshes/base.stl", &flat).as_deref(), Some("meshes/base.stl"));
        assert_eq!(resolve_mesh("urdf/arm.urdf", "file:///home/u/ws/src/arm/meshes/base.stl", &flat).as_deref(), Some("meshes/base.stl"));
        assert_eq!(resolve_mesh("urdf/arm.urdf", "package://arm/meshes/missing.stl", &flat), None);
    }

    #[test]
    fn zip_roundtrip() {
        let mut files = Files::new();
        files.insert("robot/urdf/r.urdf".into(), b"<robot/>".to_vec());
        files.insert("robot/meshes/a.stl".into(), vec![1, 2, 3]);
        files.insert("__MACOSX/robot/._a.stl".into(), vec![0]);
        let bytes = write_zip(&files).unwrap();
        let back = read_zip(&bytes).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back["robot/meshes/a.stl"], vec![1, 2, 3]);
        assert_eq!(urdf_candidates(back.keys()), vec!["robot/urdf/r.urdf".to_string()]);
    }

    #[test]
    fn sibling_refs() {
        assert_eq!(sibling_reference("package://arm/meshes/base.stl", "base_part1.stl"), "package://arm/meshes/base_part1.stl");
        assert_eq!(sibling_reference("base.stl", "b.stl"), "b.stl");
    }
}
