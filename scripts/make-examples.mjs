// Generates examples/demo_arm (a 6-DoF demo arm as a ROS package with STL,
// Collada and OBJ meshes) plus examples/demo_arm.zip and a copy in public/
// for the browser build. Meshes are authored with the project's own WASM
// mesh kernel. Run: npm run build:wasm && npm run examples
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync, MeshEditor, writeZip } from "../src/wasm/pkg/mesh_wasm.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "src/wasm/pkg/mesh_wasm_bg.wasm")) });

const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const S = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

function mesh(build) {
  const m = MeshEditor.empty();
  build((cmd) => m.run(cmd));
  m.run({ op: "select_all", action: "select" });
  m.run({ op: "recalc_normals", inside: false });
  return m;
}

// Base: a squat cylinder.
const base = mesh((run) => {
  run({ op: "add_primitive", shape: "cylinder", size: 1, segments: 48 });
  run({ op: "transform", matrix: S(0.24, 0.24, 0.06) });
  run({ op: "transform", matrix: T(0, 0, 0.03) });
});
const shoulder = mesh((run) => {
  run({ op: "add_primitive", shape: "cylinder", size: 1, segments: 40 });
  run({ op: "transform", matrix: S(0.14, 0.14, 0.12) });
  run({ op: "transform", matrix: T(0, 0, 0.06) });
});
const upperArm = mesh((run) => {
  run({ op: "add_primitive", shape: "cube", size: 1 });
  run({ op: "transform", matrix: S(0.07, 0.08, 0.32) });
  run({ op: "transform", matrix: T(0, 0, 0.16) });
  run({ op: "select_all", action: "select" });
  run({ op: "subdivide", levels: 1 });
});
// Forearm in millimetres (URDF applies scale 0.001), exported as Collada.
const forearm = mesh((run) => {
  run({ op: "add_primitive", shape: "cylinder", size: 1, segments: 32 });
  run({ op: "transform", matrix: S(55, 55, 260) });
  run({ op: "transform", matrix: T(0, 0, 130) });
});
const wrist = mesh((run) => {
  run({ op: "add_primitive", shape: "uv_sphere", size: 1, segments: 24, rings: 12 });
  run({ op: "transform", matrix: S(0.07, 0.07, 0.07) });
});
const palm = mesh((run) => {
  run({ op: "add_primitive", shape: "cube", size: 1 });
  run({ op: "transform", matrix: S(0.05, 0.12, 0.03) });
  run({ op: "transform", matrix: T(0, 0, 0.015) });
});
const finger = mesh((run) => {
  run({ op: "add_primitive", shape: "cube", size: 1 });
  run({ op: "transform", matrix: S(0.02, 0.012, 0.06) });
  run({ op: "transform", matrix: T(0, 0, 0.03) });
});

const urdf = `<?xml version="1.0"?>
<robot name="demo_arm">
  <material name="dark"><color rgba="0.18 0.19 0.22 1"/></material>
  <material name="orange"><color rgba="1.0 0.55 0.15 1"/></material>
  <material name="light"><color rgba="0.82 0.84 0.87 1"/></material>

  <link name="base_link">
    <inertial><origin xyz="0 0 0.03"/><mass value="3"/><inertia ixx="0.012" ixy="0" ixz="0" iyy="0.012" iyz="0" izz="0.022"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/base.stl"/></geometry><material name="dark"/></visual>
    <collision><origin xyz="0 0 0.03"/><geometry><cylinder radius="0.12" length="0.06"/></geometry></collision>
  </link>

  <joint name="shoulder_pan" type="revolute">
    <origin xyz="0 0 0.06" rpy="0 0 0"/>
    <parent link="base_link"/><child link="shoulder_link"/>
    <axis xyz="0 0 1"/>
    <limit lower="-2.9" upper="2.9" effort="80" velocity="1.5"/>
    <dynamics damping="0.5" friction="0.1"/>
  </joint>
  <link name="shoulder_link">
    <inertial><origin xyz="0 0 0.06"/><mass value="2"/><inertia ixx="0.005" ixy="0" ixz="0" iyy="0.005" iyz="0" izz="0.005"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/shoulder.stl"/></geometry><material name="orange"/></visual>
    <collision><origin xyz="0 0 0.06"/><geometry><cylinder radius="0.07" length="0.12"/></geometry></collision>
  </link>

  <joint name="shoulder_lift" type="revolute">
    <origin xyz="0 0 0.12" rpy="0 0 0"/>
    <parent link="shoulder_link"/><child link="upper_arm"/>
    <axis xyz="0 1 0"/>
    <limit lower="-1.8" upper="1.8" effort="60" velocity="1.2"/>
  </joint>
  <link name="upper_arm">
    <inertial><origin xyz="0 0 0.16"/><mass value="1.5"/><inertia ixx="0.013" ixy="0" ixz="0" iyy="0.013" iyz="0" izz="0.002"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/upper_arm.stl"/></geometry><material name="light"/></visual>
    <collision><origin xyz="0 0 0.16"/><geometry><box size="0.07 0.08 0.32"/></geometry></collision>
  </link>

  <joint name="elbow" type="revolute">
    <origin xyz="0 0 0.32" rpy="0 0 0"/>
    <parent link="upper_arm"/><child link="forearm"/>
    <axis xyz="0 1 0"/>
    <limit lower="-2.4" upper="2.4" effort="40" velocity="1.5"/>
  </joint>
  <link name="forearm">
    <inertial><origin xyz="0 0 0.13"/><mass value="1"/><inertia ixx="0.006" ixy="0" ixz="0" iyy="0.006" iyz="0" izz="0.001"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/forearm.dae" scale="0.001 0.001 0.001"/></geometry><material name="orange"/></visual>
    <collision><origin xyz="0 0 0.13"/><geometry><cylinder radius="0.03" length="0.26"/></geometry></collision>
  </link>

  <joint name="wrist_pitch" type="revolute">
    <origin xyz="0 0 0.26" rpy="0 0 0"/>
    <parent link="forearm"/><child link="wrist"/>
    <axis xyz="0 1 0"/>
    <limit lower="-2" upper="2" effort="10" velocity="2"/>
  </joint>
  <link name="wrist">
    <inertial><mass value="0.3"/><inertia ixx="0.0002" ixy="0" ixz="0" iyy="0.0002" iyz="0" izz="0.0002"/></inertial>
    <visual><geometry><mesh filename="../meshes/wrist.obj"/></geometry><material name="dark"/></visual>
    <collision><geometry><sphere radius="0.035"/></geometry></collision>
  </link>

  <joint name="wrist_roll" type="continuous">
    <origin xyz="0 0 0.035" rpy="0 0 0"/>
    <parent link="wrist"/><child link="gripper"/>
    <axis xyz="0 0 1"/>
    <limit effort="5" velocity="3"/>
  </joint>
  <link name="gripper">
    <inertial><origin xyz="0 0 0.015"/><mass value="0.2"/><inertia ixx="0.0002" ixy="0" ixz="0" iyy="0.0001" iyz="0" izz="0.0002"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/palm.stl"/></geometry><material name="light"/></visual>
    <collision><origin xyz="0 0 0.015"/><geometry><box size="0.05 0.12 0.03"/></geometry></collision>
  </link>

  <joint name="finger_left_joint" type="prismatic">
    <origin xyz="0 0.012 0.03" rpy="0 0 0"/>
    <parent link="gripper"/><child link="finger_left"/>
    <axis xyz="0 1 0"/>
    <limit lower="0" upper="0.04" effort="20" velocity="0.05"/>
  </joint>
  <link name="finger_left">
    <inertial><mass value="0.03"/><inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/finger.stl"/></geometry><material name="dark"/></visual>
  </link>
  <joint name="finger_right_joint" type="prismatic">
    <origin xyz="0 -0.012 0.03" rpy="0 0 0"/>
    <parent link="gripper"/><child link="finger_right"/>
    <axis xyz="0 1 0"/>
    <limit lower="-0.04" upper="0" effort="20" velocity="0.05"/>
    <mimic joint="finger_left_joint" multiplier="-1" offset="0"/>
  </joint>
  <link name="finger_right">
    <inertial><mass value="0.03"/><inertia ixx="1e-5" ixy="0" ixz="0" iyy="1e-5" iyz="0" izz="1e-5"/></inertial>
    <visual><geometry><mesh filename="package://demo_arm/meshes/finger.stl"/></geometry><material name="dark"/></visual>
  </link>

  <gazebo reference="base_link"><static>true</static></gazebo>
</robot>
`;

const packageXml = `<?xml version="1.0"?>
<package format="3">
  <name>demo_arm</name>
  <version>0.1.0</version>
  <description>Demo arm for URDF Studio</description>
  <maintainer email="dev@example.com">urdf-studio</maintainer>
  <license>MIT</license>
  <buildtool_depend>ament_cmake</buildtool_depend>
</package>
`;

const enc = new TextEncoder();
const files = {
  "demo_arm/package.xml": enc.encode(packageXml),
  "demo_arm/urdf/demo_arm.urdf": enc.encode(urdf),
  "demo_arm/meshes/base.stl": base.toStl("base"),
  "demo_arm/meshes/shoulder.stl": shoulder.toStl("shoulder"),
  "demo_arm/meshes/upper_arm.stl": upperArm.toStl("upper_arm"),
  "demo_arm/meshes/forearm.dae": enc.encode(forearm.toDae("forearm")),
  "demo_arm/meshes/wrist.obj": enc.encode(wrist.toObj("wrist")),
  "demo_arm/meshes/palm.stl": palm.toStl("palm"),
  "demo_arm/meshes/finger.stl": finger.toStl("finger"),
};

for (const [p, data] of Object.entries(files)) {
  const out = join(root, "examples", p);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, data);
}
const paths = Object.keys(files);
const zip = writeZip(paths, paths.map((p) => files[p]));
writeFileSync(join(root, "examples/demo_arm.zip"), zip);
mkdirSync(join(root, "public/examples"), { recursive: true });
copyFileSync(join(root, "examples/demo_arm.zip"), join(root, "public/examples/demo_arm.zip"));
console.log(`wrote ${paths.length} files and examples/demo_arm.zip (${zip.length} bytes)`);
