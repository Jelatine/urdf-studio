# URDF Studio

A desktop URDF editor built with **Rust + Tauri**, with Blender-style mesh editing as its core feature.

![icon](app-icon.png)

## Features

- **Open and save** a `.urdf` inside a ROS package folder, or a `.zip` archive containing the URDF and its meshes. Saving can write back in place, export a zip, or export to a folder.
  - Mesh references support `package://`, relative paths and `file://`. Paths are also resolved by suffix matching, so archives whose layout doesn't mirror the ROS workspace still load.
  - Unrecognized elements (`<gazebo>`, `<transmission>`, custom tags) are preserved verbatim.
- **3D scene**: Z-up (ROS convention), with visual and collision geometry, link frames and joint axes. Supports STL (binary/ASCII), Collada (DAE) and OBJ meshes.
- **Motion simulation**: per-joint sliders (limits enforced, `mimic` joints follow their leader), sinusoidal sweep, random targets that respect velocity limits, and keyframe animation. Selected links show their world pose.
- **Per-link and per-joint configuration**:
  - **Links**: inertial (mass, centre of mass, inertia tensor, plus inertia estimated from the bounding box), visual and collision geometry (box/cylinder/sphere/mesh, scale, origin), and materials.
  - **Joints**: type, parent/child, origin (also draggable with the viewport gizmo), axis, limit, dynamics, mimic, safety_controller and calibration.
  - **Tree editing**: add and delete links (with their subtrees), and drag links in the outliner to re-parent them. A validator checks names, references, cycles, limits and inertia.
- **Blender-style mesh editing** (Tab to enter edit mode). The geometry kernel is written in Rust and compiled to WebAssembly:
  - **Vertex, edge and face select modes** (1/2/3). Click and Shift-click selection, box select (drag / B), circle select (C), and select all / none / invert (A / Alt+A / Ctrl+I).
  - **Select linked** (L / Ctrl+L), and **select linked flat faces** (Shift+F) with an adjustable angle and an option to compare against the seed face (coplanar regions).
  - **Loop, ring and path selection**: edge loop (Alt+click), edge ring (Ctrl+Alt+click) and shortest path (Ctrl+click).
  - **Other selection tools**: grow/shrink selection, select similar (normal / area / perimeter / sides / coplanar / length / direction …), non-manifold, sharp edges, loose geometry, boundary loop, inner region and random. Hide/reveal with H / Shift+H / Alt+H.
  - **Delete and dissolve**: delete vertices / edges / faces / only edges & faces / only faces, dissolve vertices / edges / faces, and limited dissolve (merges the coplanar triangles of a triangulated STL back into polygons).
  - **Separate and split**: **separate** (P) moves the selection into a new mesh file, attached either to the same link or to a new link with a fixed joint. Split (Y) and duplicate (Shift+D) are also available.
  - **Modelling**: extrude (E, constrained along the normal), extrude individual faces, inset (I, drag to set thickness), fill / triangle fill (F / Alt+F), bridge edge loops, loop cut (Ctrl+R), subdivide, bisect, connect vertex path (J), poke, triangulate / tris-to-quads (Ctrl+T / Alt+J), rip / edge split (V) and smooth.
  - **Merge**: at centre / at 3D cursor / collapse / at first / at last / by distance.
  - **Normals**: flip, and recalculate pointing outside or inside (Shift+N).
  - **Transforms**: G / R / S with X/Y/Z axis constraints (press again for local axes, Shift+axis to exclude an axis), numeric input, Ctrl to snap, and proportional editing (O, scroll wheel changes the radius).
  - **Add primitives** (Shift+A): cube, plane, grid, circle, cylinder, cone and UV sphere, placed at the 3D cursor (Shift+right-click).
  - **Workflow**: every operation can be undone/redone. An **adjust last operation** panel re-runs the last command with new parameters, and F3 opens operator search.
  - Box, cylinder and sphere geometry can be converted into editable meshes.
  - **Fit primitives** (Shift+Alt+F): fit a box, cylinder or sphere to the selection (edit mode) or a whole mesh (object mode / Inspector "拟合"), enclosing all vertices or least-squares, optionally per connected part. Results are previewed in the viewport and added as URDF collision (or visual) geometry.

Press **F1** in the app for the full shortcut list.

## Architecture

```
crates/mesh-core     BMesh-style polygon kernel: selection, editing operators, undo, picking, STL/OBJ/DAE IO
crates/urdf-core     URDF data model, parsing and writing (preserves unknown elements), validation
crates/project-core  zip/folder projects and mesh path resolution
crates/mesh-wasm     wasm-bindgen bindings for the three crates above
src-tauri            Tauri 2 backend: open/read/stage/save project files
src                  React + TypeScript + three.js frontend
```

The frontend talks to the mesh kernel through serializable commands (`{op: "inset", thickness, …}`), which keeps the WASM boundary small and lets any operation be re-run with new parameters.

## Download

Windows portable builds are published on the [Releases](https://github.com/Jelatine/urdf-studio/releases) page: unzip and run `URDF Studio.exe` (needs the WebView2 runtime, preinstalled on Windows 10/11). Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the zip and attaches it to a GitHub release.

## Development

Requirements: Rust (stable), `wasm32-unknown-unknown` target, [`wasm-pack`](https://rustwasm.github.io/wasm-pack/), Node.js 20+.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run build:wasm      # compile the Rust kernel to WebAssembly
npm run examples        # (optional) regenerate examples/demo_arm
npm run tauri dev       # desktop app
npm run dev             # browser-only mode (http://localhost:1420), with an in-memory project fallback
cargo test --workspace  # Rust tests
npm run tauri build     # release build/installers
```

`examples/demo_arm` is a sample ROS package (STL + DAE (mm) + OBJ meshes, a mimic gripper and a gazebo extension), also packed as `examples/demo_arm.zip`.

## License

MIT
