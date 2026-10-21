//! Tauri backend: opens URDF projects (a `.urdf` inside a folder, or a zip
//! archive), serves file bytes to the frontend, and saves edited projects
//! back in place, as a folder, or as a zip archive.

use project_core::{native, Files};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

enum Source {
    /// Every file loaded in memory (zip archives).
    Memory(Files),
    /// Files read lazily from a folder on disk.
    Folder(PathBuf),
}

#[derive(Default)]
struct Project {
    source: Option<Source>,
    /// Absolute path that was opened (zip or urdf file).
    origin: Option<PathBuf>,
    urdf_path: String,
    /// Bytes uploaded by the frontend for the next save (edited meshes).
    staged: Files,
}

type AppState = Mutex<Project>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    kind: &'static str,
    origin: String,
    urdf_path: String,
    urdf_text: String,
    candidates: Vec<String>,
    files: Vec<String>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Project {
    fn read(&self, vpath: &str) -> Result<Vec<u8>, String> {
        if let Some(b) = self.staged.get(vpath) {
            return Ok(b.clone());
        }
        match &self.source {
            Some(Source::Memory(files)) => files.get(vpath).cloned().ok_or_else(|| format!("file not found: {vpath}")),
            Some(Source::Folder(root)) => {
                std::fs::read(native::vpath_to_abs(root, vpath).map_err(err)?).map_err(|e| format!("{vpath}: {e}"))
            }
            None => Err("no project open".into()),
        }
    }

    fn list(&self) -> Vec<String> {
        match &self.source {
            Some(Source::Memory(files)) => files.keys().cloned().collect(),
            Some(Source::Folder(root)) => native::list_files(root, 50_000, 12),
            None => vec![],
        }
    }
}

fn open_impl(p: &mut Project, path: &Path) -> Result<OpenResult, String> {
    let is_zip = path.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false);
    let (source, urdf_path, kind) = if is_zip {
        let bytes = std::fs::read(path).map_err(err)?;
        let files = project_core::read_zip(&bytes).map_err(err)?;
        let cands = project_core::urdf_candidates(files.keys());
        let first = cands.first().cloned().ok_or("the archive does not contain a .urdf file")?;
        (Source::Memory(files), first, "zip")
    } else {
        let root = native::project_root(path);
        let rel = path.strip_prefix(&root).map_err(err)?;
        (Source::Folder(root), project_core::normalize(&rel.to_string_lossy()), "folder")
    };
    *p = Project { source: Some(source), origin: Some(path.to_path_buf()), urdf_path, staged: Files::new() };
    let files = p.list();
    let candidates = project_core::urdf_candidates(files.iter());
    let urdf_text = String::from_utf8(p.read(&p.urdf_path)?).map_err(err)?;
    Ok(OpenResult {
        kind,
        origin: path.to_string_lossy().to_string(),
        urdf_path: p.urdf_path.clone(),
        urdf_text,
        candidates,
        files,
    })
}

#[tauri::command]
fn open_project(state: State<AppState>, path: String) -> Result<OpenResult, String> {
    let mut p = state.lock().map_err(err)?;
    open_impl(&mut p, Path::new(&path))
}

/// Switches to another URDF inside the open project; returns its text.
#[tauri::command]
fn select_urdf(state: State<AppState>, path: String) -> Result<String, String> {
    let mut p = state.lock().map_err(err)?;
    let text = String::from_utf8(p.read(&path)?).map_err(err)?;
    p.urdf_path = path;
    Ok(text)
}

#[tauri::command]
fn read_project_file(state: State<AppState>, path: String) -> Result<Response, String> {
    let p = state.lock().map_err(err)?;
    Ok(Response::new(p.read(&path)?))
}

/// Stages raw bytes for the next save. Body: file bytes; header `x-path`.
#[tauri::command]
fn stage_file(state: State<AppState>, request: Request) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|s| project_core::normalize(&percent_decode(s)))
        .ok_or("missing x-path header")?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    state.lock().map_err(err)?.staged.insert(path, data.clone());
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs {
    urdf_text: String,
    /// "inplace" | "zip" | "folder"
    mode: String,
    /// Output path for "zip" (file) and "folder" (directory).
    target: Option<String>,
    /// Project files referenced by the robot (needed when exporting a folder project).
    include: Vec<String>,
    /// Files to drop from the output.
    #[serde(default)]
    remove: Vec<String>,
}

/// Collects the files that make up the saved project.
fn collect_output(p: &Project, args: &SaveArgs) -> Result<Files, String> {
    let mut out = Files::new();
    match &p.source {
        Some(Source::Memory(files)) => out.extend(files.iter().map(|(k, v)| (k.clone(), v.clone()))),
        Some(Source::Folder(root)) => {
            let mut wanted: Vec<String> = args.include.clone();
            // Keep package manifests so the export stays a valid ROS package.
            for f in native::list_files(root, 50_000, 12) {
                if f.ends_with("package.xml") || f.ends_with("CMakeLists.txt") {
                    wanted.push(f);
                }
            }
            for f in wanted {
                if p.staged.contains_key(&f) {
                    continue;
                }
                if let Ok(abs) = native::vpath_to_abs(root, &f) {
                    if let Ok(bytes) = std::fs::read(abs) {
                        out.insert(f, bytes);
                    }
                }
            }
        }
        None => return Err("no project open".into()),
    }
    for (k, v) in &p.staged {
        out.insert(k.clone(), v.clone());
    }
    out.insert(p.urdf_path.clone(), args.urdf_text.as_bytes().to_vec());
    for r in &args.remove {
        out.remove(r);
    }
    Ok(out)
}

fn save_impl(p: &mut Project, args: SaveArgs) -> Result<String, String> {
    let saved_to = match args.mode.as_str() {
        "zip" => {
            let target = PathBuf::from(args.target.as_deref().ok_or("missing target")?);
            let files = collect_output(p, &args)?;
            std::fs::write(&target, project_core::write_zip(&files).map_err(err)?).map_err(err)?;
            target
        }
        "folder" => {
            let target = PathBuf::from(args.target.as_deref().ok_or("missing target")?);
            let files = collect_output(p, &args)?;
            native::write_tree(&target, &files).map_err(err)?;
            target.join(&p.urdf_path)
        }
        "inplace" => match &p.source {
            Some(Source::Folder(root)) => {
                let mut files = p.staged.clone();
                files.insert(p.urdf_path.clone(), args.urdf_text.as_bytes().to_vec());
                native::write_tree(root, &files).map_err(err)?;
                for r in &args.remove {
                    if let Ok(abs) = native::vpath_to_abs(root, r) {
                        let _ = std::fs::remove_file(abs);
                    }
                }
                root.join(&p.urdf_path)
            }
            Some(Source::Memory(_)) => {
                let origin = p.origin.clone().ok_or("unknown archive location")?;
                let files = collect_output(p, &args)?;
                std::fs::write(&origin, project_core::write_zip(&files).map_err(err)?).map_err(err)?;
                origin
            }
            None => return Err("no project open".into()),
        },
        m => return Err(format!("unknown save mode '{m}'")),
    };
    // Fold the saved state into the in-memory project.
    if let Some(Source::Memory(files)) = &mut p.source {
        for (k, v) in std::mem::take(&mut p.staged) {
            files.insert(k, v);
        }
        files.insert(p.urdf_path.clone(), args.urdf_text.into_bytes());
        for r in &args.remove {
            files.remove(r);
        }
    } else {
        p.staged.clear();
    }
    Ok(saved_to.to_string_lossy().to_string())
}

#[tauri::command]
fn save_project(state: State<AppState>, args: SaveArgs) -> Result<String, String> {
    let mut p = state.lock().map_err(err)?;
    save_impl(&mut p, args)
}

/// Starts a new, empty project held in memory.
#[tauri::command]
fn new_project(state: State<AppState>, urdf_text: String) -> Result<(), String> {
    let mut p = state.lock().map_err(err)?;
    let mut files = Files::new();
    files.insert("robot/urdf/robot.urdf".into(), urdf_text.into_bytes());
    *p = Project {
        source: Some(Source::Memory(files)),
        origin: None,
        urdf_path: "robot/urdf/robot.urdf".into(),
        staged: Files::new(),
    };
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            select_urdf,
            read_project_file,
            stage_file,
            save_project,
            new_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, data: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }

    const URDF: &str = r#"<robot name="r"><link name="a"><visual><geometry><mesh filename="package://pkg/meshes/a.stl"/></geometry></visual></link></robot>"#;

    #[test]
    fn folder_open_edit_save_zip_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("ws");
        write(&ws, "pkg/package.xml", b"<package/>");
        write(&ws, "pkg/urdf/r.urdf", URDF.as_bytes());
        write(&ws, "pkg/meshes/a.stl", b"old");
        let mut p = Project::default();
        let r = open_impl(&mut p, &ws.join("pkg/urdf/r.urdf")).unwrap();
        assert_eq!(r.urdf_path, "pkg/urdf/r.urdf");
        assert!(r.files.contains(&"pkg/meshes/a.stl".to_string()));
        assert_eq!(p.read("pkg/meshes/a.stl").unwrap(), b"old");

        p.staged.insert("pkg/meshes/a.stl".into(), b"new".to_vec());
        let zip_path = dir.path().join("out.zip");
        save_impl(
            &mut p,
            SaveArgs {
                urdf_text: URDF.into(),
                mode: "zip".into(),
                target: Some(zip_path.to_string_lossy().into()),
                include: vec!["pkg/meshes/a.stl".into()],
                remove: vec![],
            },
        )
        .unwrap();
        let mut q = Project::default();
        let r = open_impl(&mut q, &zip_path).unwrap();
        assert_eq!(r.kind, "zip");
        assert_eq!(r.urdf_path, "pkg/urdf/r.urdf");
        assert_eq!(q.read("pkg/meshes/a.stl").unwrap(), b"new");
        assert!(r.files.contains(&"pkg/package.xml".to_string()));
        // Folder source is untouched by a zip export.
        assert_eq!(std::fs::read(ws.join("pkg/meshes/a.stl")).unwrap(), b"old");
    }

    #[test]
    fn inplace_saves() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "r/urdf/r.urdf", URDF.as_bytes());
        write(dir.path(), "r/meshes/a.stl", b"old");
        let mut p = Project::default();
        open_impl(&mut p, &dir.path().join("r/urdf/r.urdf")).unwrap();
        // Without package.xml the root is the URDF folder's parent (`r/`).
        p.staged.insert("meshes/b.stl".into(), b"part".to_vec());
        let edited = URDF.replace("name=\"r\"", "name=\"r2\"");
        save_impl(&mut p, SaveArgs { urdf_text: edited.clone(), mode: "inplace".into(), target: None, include: vec![], remove: vec![] })
            .unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("r/urdf/r.urdf")).unwrap(), edited);
        assert_eq!(std::fs::read(dir.path().join("r/meshes/b.stl")).unwrap(), b"part");

        // Zip in place.
        let mut files = Files::new();
        files.insert("urdf/r.urdf".into(), URDF.as_bytes().to_vec());
        let zp = dir.path().join("p.zip");
        std::fs::write(&zp, project_core::write_zip(&files).unwrap()).unwrap();
        let mut z = Project::default();
        open_impl(&mut z, &zp).unwrap();
        z.staged.insert("meshes/new.stl".into(), b"x".to_vec());
        save_impl(&mut z, SaveArgs { urdf_text: edited, mode: "inplace".into(), target: None, include: vec![], remove: vec![] })
            .unwrap();
        let back = project_core::read_zip(&std::fs::read(&zp).unwrap()).unwrap();
        assert_eq!(back.len(), 2);
        assert!(String::from_utf8_lossy(&back["urdf/r.urdf"]).contains("r2"));
    }

    #[test]
    fn decode_header() {
        assert_eq!(percent_decode("a%20b/%E4%B8%AD.stl"), "a b/中.stl");
    }
}
