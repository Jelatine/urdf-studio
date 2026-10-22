import { useEffect, useState } from "react";
import * as THREE from "three";
import { getMesh } from "../mesh/registry";
import { convertToMesh, editRobot, enterEditMode, openFitDialog, renameJoint, renameLink, updateJoint } from "../state/actions";
import { useStore } from "../state/store";
import { isMovable, jointRange, zeroPose, type Collision, type Geometry, type Joint, type JointType, type Link, type Material, type Pose, type Robot, type Visual } from "../types/urdf";
import { getEngine } from "../viewport/engine";
import { Check, NumField, RAD2DEG, Row, Section, Select, TextField, Vec3Field } from "./widgets";

const s = () => useStore.getState();

function PoseFields(props: { pose: Pose; onChange: (p: Pose, scrub?: boolean) => void }) {
  const [deg, setDeg] = useState(false);
  const k = deg ? RAD2DEG : 1;
  return (
    <>
      <Vec3Field label="位置 xyz" value={props.pose.xyz} step={0.001} onChange={(xyz, sc) => props.onChange({ ...props.pose, xyz }, sc)} />
      <Vec3Field
        label={
          <span>
            旋转 rpy{" "}
            <button className="unit-btn" onClick={() => setDeg(!deg)} title="切换弧度/角度显示">
              {deg ? "°" : "rad"}
            </button>
          </span>
        }
        names={["R", "P", "Y"]}
        value={props.pose.rpy.map((v) => v * k) as [number, number, number]}
        step={deg ? 1 : 0.01}
        onChange={(rpy, sc) => props.onChange({ ...props.pose, rpy: rpy.map((v) => v / k) as [number, number, number] }, sc)}
      />
    </>
  );
}

const GEOM_TYPES = [
  { value: "box", label: "立方体 box" },
  { value: "cylinder", label: "圆柱 cylinder" },
  { value: "sphere", label: "球 sphere" },
  { value: "mesh", label: "网格 mesh" },
] as const;

function defaultGeometry(type: Geometry["type"], prev: Geometry): Geometry {
  switch (type) {
    case "box":
      return { type, size: [0.1, 0.1, 0.1] };
    case "cylinder":
      return { type, radius: 0.05, length: 0.1 };
    case "sphere":
      return { type, radius: 0.05 };
    case "mesh":
      return { type, filename: prev.type === "mesh" ? prev.filename : "", scale: null };
  }
}

function GeometryFields(props: { g: Geometry; onChange: (g: Geometry, scrub?: boolean) => void }) {
  const { g, onChange } = props;
  const meshPaths = useStore((st) => st.meshPaths);
  return (
    <>
      <Row label="几何类型">
        <Select value={g.type} options={GEOM_TYPES.map((x) => ({ ...x }))} onChange={(t) => onChange(defaultGeometry(t, g))} />
      </Row>
      {g.type === "box" && <Vec3Field label="尺寸" value={g.size} step={0.001} onChange={(size, sc) => onChange({ ...g, size }, sc)} />}
      {g.type === "cylinder" && (
        <Row label="半径 / 长度">
          <NumField label="r" value={g.radius} step={0.001} min={0} onChange={(radius, sc) => onChange({ ...g, radius }, sc)} />
          <NumField label="l" value={g.length} step={0.001} min={0} onChange={(length, sc) => onChange({ ...g, length }, sc)} />
        </Row>
      )}
      {g.type === "sphere" && (
        <Row label="半径">
          <NumField value={g.radius} step={0.001} min={0} onChange={(radius, sc) => onChange({ ...g, radius }, sc)} />
        </Row>
      )}
      {g.type === "mesh" && (
        <>
          <Row label="文件">
            <TextField value={g.filename} onChange={(filename) => onChange({ ...g, filename })} placeholder="package://pkg/meshes/x.stl" />
          </Row>
          <div className={`mesh-resolve ${meshPaths[g.filename] ? "" : "missing"}`}>
            {meshPaths[g.filename] ? `→ ${meshPaths[g.filename]}` : "未找到此文件"}
          </div>
          <Vec3Field
            label="缩放"
            value={g.scale ?? [1, 1, 1]}
            step={0.001}
            onChange={(scale, sc) => onChange({ ...g, scale: scale.every((v) => v === 1) ? null : scale }, sc)}
          />
        </>
      )}
    </>
  );
}

function MaterialFields(props: { robot: Robot; m: Material | null; onChange: (m: Material | null) => void }) {
  const { m, robot } = props;
  const color = m?.color ?? robot.materials.find((x) => x.name === m?.name)?.color ?? null;
  const hex = color ? `#${new THREE.Color(color[0], color[1], color[2]).getHexString()}` : "#b8bcc4";
  return (
    <>
      <Row label="材质">
        <TextField value={m?.name ?? ""} placeholder="(无)" onChange={(name) => props.onChange(name || m?.color ? { name, color: m?.color ?? null, texture: m?.texture ?? null } : null)} />
      </Row>
      <Row label="颜色 / 透明度">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            const c = new THREE.Color(e.target.value);
            props.onChange({ name: m?.name ?? "", color: [c.r, c.g, c.b, color?.[3] ?? 1], texture: m?.texture ?? null });
          }}
        />
        <NumField value={color?.[3] ?? 1} min={0} max={1} step={0.05} onChange={(a) => color && props.onChange({ name: m?.name ?? "", color: [color[0], color[1], color[2], a], texture: m?.texture ?? null })} />
        {m?.color && (
          <button className="small" onClick={() => props.onChange(m.name ? { ...m, color: null } : null)} title="移除内联颜色">
            清除
          </button>
        )}
      </Row>
    </>
  );
}

function GeomItem(props: { link: Link; role: "visual" | "collision"; index: number; item: Visual | Collision; robot: Robot }) {
  const { link, role, index, item, robot } = props;
  const meshPaths = useStore((st) => st.meshPaths);
  const mode = useStore((st) => st.mode);
  const editTarget = useStore((st) => st.editTarget);
  const update = (fn: (it: Visual | Collision) => void, merge = false) =>
    editRobot((r) => {
      const l = r.links.find((x) => x.name === link.name)!;
      fn(role === "visual" ? l.visuals[index] : l.collisions[index]);
    }, merge);
  const g = item.geometry;
  const meshPath = g.type === "mesh" ? meshPaths[g.filename] : null;
  const editable = !!meshPath && !!getMesh(meshPath);
  const editing = mode === "edit" && editTarget?.link === link.name && editTarget.role === role && editTarget.index === index;
  return (
    <Section
      title={
        <>
          {role === "visual" ? "外观" : "碰撞"} #{index} <span className="dim">{item.name ?? ""}</span>
        </>
      }
      actions={
        <>
          {g.type === "mesh" ? (
            <button
              className={`small ${editing ? "active" : ""}`}
              disabled={!editable}
              onClick={() => enterEditMode({ link: link.name, role, index, meshPath: meshPath! })}
              title="在视图中编辑该网格 (Tab)"
            >
              {editing ? "编辑中" : "编辑网格"}
            </button>
          ) : null}
          {g.type === "mesh" ? (
            <button
              className="small"
              disabled={!editable}
              onClick={() => openFitDialog({ link: link.name, role, index, meshPath: meshPath!, all: true })}
              title="用立方体 / 圆柱 / 球拟合整个网格，生成碰撞体 (Shift+Alt+F)"
            >
              拟合
            </button>
          ) : (
            <button className="small" onClick={() => convertToMesh(link.name, role, index)} title="把基本几何体转换为可编辑的 STL 网格">
              转为网格
            </button>
          )}
          <button
            className="small"
            title="删除"
            onClick={() =>
              editRobot((r) => {
                const l = r.links.find((x) => x.name === link.name)!;
                (role === "visual" ? l.visuals : l.collisions).splice(index, 1);
              })
            }
          >
            ✕
          </button>
        </>
      }
    >
      <Row label="名称">
        <TextField value={item.name ?? ""} placeholder="(可选)" onChange={(name) => update((it) => (it.name = name || null))} />
      </Row>
      <PoseFields pose={item.origin} onChange={(p, sc) => update((it) => (it.origin = p), sc)} />
      <GeometryFields g={g} onChange={(ng, sc) => update((it) => (it.geometry = ng), sc)} />
      {role === "visual" && (
        <MaterialFields robot={robot} m={(item as Visual).material} onChange={(m) => update((it) => ((it as Visual).material = m))} />
      )}
    </Section>
  );
}

/** Box-approximation inertia of the link's visual bounds. */
function estimateInertia(link: Link, mass: number) {
  const eng = getEngine();
  const box = new THREE.Box3();
  const frame = eng?.robotView.links.get(link.name);
  if (eng && frame) {
    const inv = frame.matrixWorld.clone().invert();
    for (const g of eng.robotView.geoms) {
      if (g.link !== link.name || g.role !== "visual") continue;
      const geo = g.mesh.geometry;
      geo.computeBoundingBox();
      if (!geo.boundingBox) continue;
      const m = inv.clone().multiply(g.mesh.matrixWorld);
      box.union(geo.boundingBox.clone().applyMatrix4(m));
    }
  }
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const k = mass / 12;
  return {
    origin: { xyz: [c.x, c.y, c.z] as [number, number, number], rpy: [0, 0, 0] as [number, number, number] },
    mass,
    inertia: {
      ixx: k * (size.y ** 2 + size.z ** 2),
      iyy: k * (size.x ** 2 + size.z ** 2),
      izz: k * (size.x ** 2 + size.y ** 2),
      ixy: 0,
      ixz: 0,
      iyz: 0,
    },
  };
}

function useLinkWorldPose(name: string) {
  const values = useStore((st) => st.jointValues);
  const robot = useStore((st) => st.robot);
  const [pose, setPose] = useState<{ p: THREE.Vector3; e: THREE.Euler } | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const frame = getEngine()?.robotView.links.get(name);
      if (!frame) return setPose(null);
      frame.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      frame.matrixWorld.decompose(p, q, new THREE.Vector3());
      setPose({ p, e: new THREE.Euler().setFromQuaternion(q, "ZYX") });
    });
    return () => cancelAnimationFrame(id);
  }, [name, values, robot]);
  return pose;
}

function LinkInspector({ robot, link }: { robot: Robot; link: Link }) {
  const pose = useLinkWorldPose(link.name);
  const updLink = (fn: (l: Link) => void, merge = false) =>
    editRobot((r) => {
      fn(r.links.find((x) => x.name === link.name)!);
    }, merge);
  const inertial = link.inertial;
  return (
    <>
      <div className="inspector-title">
        <span className="icon link-icon">▣</span> Link
      </div>
      <Row label="名称">
        <TextField value={link.name} onChange={(n) => renameLink(link.name, n)} />
      </Row>
      {pose && (
        <div className="readout" title="当前关节位置下 link 坐标系的世界位姿">
          世界位姿: [{pose.p.x.toFixed(4)}, {pose.p.y.toFixed(4)}, {pose.p.z.toFixed(4)}] rpy°[{(pose.e.x * RAD2DEG).toFixed(1)}, {(pose.e.y * RAD2DEG).toFixed(1)},{" "}
          {(pose.e.z * RAD2DEG).toFixed(1)}]
        </div>
      )}
      <Section
        title="惯性 inertial"
        actions={
          <Check
            label="启用"
            checked={!!inertial}
            onChange={(on) => updLink((l) => (l.inertial = on ? { origin: zeroPose(), mass: 1, inertia: { ixx: 1e-3, ixy: 0, ixz: 0, iyy: 1e-3, iyz: 0, izz: 1e-3 } } : null))}
          />
        }
      >
        {inertial ? (
          <>
            <Row label="质量 (kg)">
              <NumField value={inertial.mass} min={0} step={0.01} onChange={(mass, sc) => updLink((l) => (l.inertial!.mass = mass), sc)} />
              <button
                className="small"
                title="按外观包围盒(长方体)估算惯量与质心"
                onClick={() => {
                  const est = estimateInertia(link, inertial.mass);
                  if (est) updLink((l) => (l.inertial = est));
                  else s().setStatus("没有可用于估算的外观几何", "error");
                }}
              >
                估算惯量
              </button>
            </Row>
            <PoseFields pose={inertial.origin} onChange={(p, sc) => updLink((l) => (l.inertial!.origin = p), sc)} />
            <Vec3Field
              label="ixx iyy izz"
              names={["xx", "yy", "zz"]}
              step={1e-5}
              value={[inertial.inertia.ixx, inertial.inertia.iyy, inertial.inertia.izz]}
              onChange={(v, sc) => updLink((l) => Object.assign(l.inertial!.inertia, { ixx: v[0], iyy: v[1], izz: v[2] }), sc)}
            />
            <Vec3Field
              label="ixy ixz iyz"
              names={["xy", "xz", "yz"]}
              step={1e-5}
              value={[inertial.inertia.ixy, inertial.inertia.ixz, inertial.inertia.iyz]}
              onChange={(v, sc) => updLink((l) => Object.assign(l.inertial!.inertia, { ixy: v[0], ixz: v[1], iyz: v[2] }), sc)}
            />
          </>
        ) : (
          <div className="dim pad">无惯性参数</div>
        )}
      </Section>
      {link.visuals.map((v, i) => (
        <GeomItem key={`v${i}`} link={link} role="visual" index={i} item={v} robot={robot} />
      ))}
      {link.collisions.map((c, i) => (
        <GeomItem key={`c${i}`} link={link} role="collision" index={i} item={c} robot={robot} />
      ))}
      <div className="button-row">
        <button onClick={() => updLink((l) => l.visuals.push({ name: null, origin: zeroPose(), geometry: { type: "box", size: [0.1, 0.1, 0.1] }, material: null }))}>
          + 外观
        </button>
        <button onClick={() => updLink((l) => l.collisions.push({ name: null, origin: zeroPose(), geometry: { type: "box", size: [0.1, 0.1, 0.1] } }))}>
          + 碰撞
        </button>
        <button
          title="把所有外观几何复制为碰撞几何"
          onClick={() => updLink((l) => (l.collisions = l.visuals.map((v) => ({ name: v.name, origin: structuredClone(v.origin), geometry: structuredClone(v.geometry) }))))}
        >
          外观→碰撞
        </button>
      </div>
      {link.extras.length > 0 && <div className="dim pad">保留了 {link.extras.length} 个未识别的子元素</div>}
    </>
  );
}

const JOINT_TYPES: { value: JointType; label: string }[] = [
  { value: "revolute", label: "revolute 旋转(有限位)" },
  { value: "continuous", label: "continuous 连续旋转" },
  { value: "prismatic", label: "prismatic 平移" },
  { value: "fixed", label: "fixed 固定" },
  { value: "floating", label: "floating 浮动" },
  { value: "planar", label: "planar 平面" },
];

function JointInspector({ robot, joint }: { robot: Robot; joint: Joint }) {
  const value = useStore((st) => st.jointValues[joint.name]);
  const upd = (fn: (j: Joint) => void, merge = false) => updateJoint(joint.name, fn, merge);
  const links = robot.links.map((l) => ({ value: l.name, label: l.name }));
  const angular = joint.joint_type !== "prismatic";
  const [lo, hi] = jointRange(joint);
  return (
    <>
      <div className="inspector-title">
        <span className="icon joint-icon">⟳</span> Joint
      </div>
      <Row label="名称">
        <TextField value={joint.name} onChange={(n) => renameJoint(joint.name, n)} />
      </Row>
      <Row label="类型">
        <Select
          value={joint.joint_type}
          options={JOINT_TYPES}
          onChange={(t) =>
            upd((j) => {
              j.joint_type = t;
              if ((t === "revolute" || t === "prismatic") && !j.limit) {
                j.limit = t === "revolute" ? { lower: -Math.PI, upper: Math.PI, effort: 10, velocity: 1 } : { lower: 0, upper: 0.1, effort: 10, velocity: 0.1 };
              }
            })
          }
        />
      </Row>
      <Row label="父 link">
        <Select value={joint.parent} options={links} onChange={(p) => upd((j) => (j.parent = p))} />
      </Row>
      <Row label="子 link">
        <Select value={joint.child} options={links} onChange={(c) => upd((j) => (j.child = c))} />
      </Row>
      {isMovable(joint) && !joint.mimic && (
        <Row label={`当前值 ${angular ? "(°)" : "(m)"}`}>
          <input
            type="range"
            min={lo}
            max={hi}
            step={(hi - lo) / 1000}
            value={value ?? 0}
            onChange={(e) => useStore.setState({ jointValues: { ...s().jointValues, [joint.name]: Number(e.target.value) } })}
          />
          <span className="readout-inline">{angular ? ((value ?? 0) * RAD2DEG).toFixed(1) : (value ?? 0).toFixed(4)}</span>
        </Row>
      )}
      <Section title="原点 origin (相对父 link)">
        <PoseFields pose={joint.origin} onChange={(p, sc) => upd((j) => (j.origin = p), sc)} />
        <div className="dim pad">提示: 在对象模式按 G / R 可用操纵器在视图中拖动关节原点</div>
      </Section>
      {!(joint.joint_type === "fixed" || joint.joint_type === "floating") && (
        <Section title="轴 axis">
          <Vec3Field label="方向" value={joint.axis} step={0.01} onChange={(a, sc) => upd((j) => (j.axis = a), sc)} />
          <div className="button-row">
            {(["X", "Y", "Z"] as const).map((n, i) => (
              <button key={n} className="small" onClick={() => upd((j) => (j.axis = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]))}>
                {n}
              </button>
            ))}
            <button className="small" onClick={() => upd((j) => (j.axis = j.axis.map((v) => -v) as [number, number, number]))}>
              反向
            </button>
            <button
              className="small"
              onClick={() =>
                upd((j) => {
                  const l = Math.hypot(...j.axis) || 1;
                  j.axis = j.axis.map((v) => v / l) as [number, number, number];
                })
              }
            >
              归一化
            </button>
          </div>
        </Section>
      )}
      <Section
        title="限位 limit"
        actions={<Check label="启用" checked={!!joint.limit} onChange={(on) => upd((j) => (j.limit = on ? { lower: -1, upper: 1, effort: 10, velocity: 1 } : null))} />}
      >
        {joint.limit && (
          <>
            <Row label={`下限 / 上限 ${angular ? "(°)" : "(m)"}`}>
              <NumField
                value={joint.limit.lower * (angular ? RAD2DEG : 1)}
                step={angular ? 1 : 0.001}
                onChange={(v, sc) => upd((j) => (j.limit!.lower = v / (angular ? RAD2DEG : 1)), sc)}
              />
              <NumField
                value={joint.limit.upper * (angular ? RAD2DEG : 1)}
                step={angular ? 1 : 0.001}
                onChange={(v, sc) => upd((j) => (j.limit!.upper = v / (angular ? RAD2DEG : 1)), sc)}
              />
            </Row>
            <Row label="力矩 / 速度">
              <NumField label="e" value={joint.limit.effort} min={0} step={0.1} onChange={(v, sc) => upd((j) => (j.limit!.effort = v), sc)} />
              <NumField label="v" value={joint.limit.velocity} min={0} step={0.01} onChange={(v, sc) => upd((j) => (j.limit!.velocity = v), sc)} />
            </Row>
          </>
        )}
      </Section>
      <Section
        title="动力学 dynamics"
        defaultOpen={!!joint.dynamics}
        actions={<Check label="启用" checked={!!joint.dynamics} onChange={(on) => upd((j) => (j.dynamics = on ? { damping: 0, friction: 0 } : null))} />}
      >
        {joint.dynamics && (
          <Row label="阻尼 / 摩擦">
            <NumField label="d" value={joint.dynamics.damping} min={0} step={0.01} onChange={(v, sc) => upd((j) => (j.dynamics!.damping = v), sc)} />
            <NumField label="f" value={joint.dynamics.friction} min={0} step={0.01} onChange={(v, sc) => upd((j) => (j.dynamics!.friction = v), sc)} />
          </Row>
        )}
      </Section>
      <Section
        title="联动 mimic"
        defaultOpen={!!joint.mimic}
        actions={
          <Check
            label="启用"
            checked={!!joint.mimic}
            onChange={(on) => upd((j) => (j.mimic = on ? { joint: robot.joints.find((x) => x.name !== j.name)?.name ?? "", multiplier: 1, offset: 0 } : null))}
          />
        }
      >
        {joint.mimic && (
          <>
            <Row label="跟随关节">
              <Select
                value={joint.mimic.joint}
                options={robot.joints.filter((x) => x.name !== joint.name).map((x) => ({ value: x.name, label: x.name }))}
                onChange={(n) => upd((j) => (j.mimic!.joint = n))}
              />
            </Row>
            <Row label="倍率 / 偏移">
              <NumField label="k" value={joint.mimic.multiplier} step={0.1} onChange={(v, sc) => upd((j) => (j.mimic!.multiplier = v), sc)} />
              <NumField label="b" value={joint.mimic.offset} step={0.01} onChange={(v, sc) => upd((j) => (j.mimic!.offset = v), sc)} />
            </Row>
          </>
        )}
      </Section>
      <Section
        title="安全控制器 safety_controller"
        defaultOpen={!!joint.safety_controller}
        actions={
          <Check
            label="启用"
            checked={!!joint.safety_controller}
            onChange={(on) =>
              upd((j) => (j.safety_controller = on ? { soft_lower_limit: j.limit?.lower ?? 0, soft_upper_limit: j.limit?.upper ?? 0, k_position: 0, k_velocity: 0 } : null))
            }
          />
        }
      >
        {joint.safety_controller && (
          <>
            <Row label="软下限 / 软上限">
              <NumField value={joint.safety_controller.soft_lower_limit} step={0.01} onChange={(v, sc) => upd((j) => (j.safety_controller!.soft_lower_limit = v), sc)} />
              <NumField value={joint.safety_controller.soft_upper_limit} step={0.01} onChange={(v, sc) => upd((j) => (j.safety_controller!.soft_upper_limit = v), sc)} />
            </Row>
            <Row label="k_position / k_velocity">
              <NumField value={joint.safety_controller.k_position} step={0.1} onChange={(v, sc) => upd((j) => (j.safety_controller!.k_position = v), sc)} />
              <NumField value={joint.safety_controller.k_velocity} step={0.1} onChange={(v, sc) => upd((j) => (j.safety_controller!.k_velocity = v), sc)} />
            </Row>
          </>
        )}
      </Section>
      <Section
        title="标定 calibration"
        defaultOpen={!!joint.calibration}
        actions={<Check label="启用" checked={!!joint.calibration} onChange={(on) => upd((j) => (j.calibration = on ? { rising: 0, falling: null } : null))} />}
      >
        {joint.calibration && (
          <Row label="rising / falling">
            <NumField value={joint.calibration.rising ?? 0} step={0.01} onChange={(v) => upd((j) => (j.calibration!.rising = v))} />
            <NumField value={joint.calibration.falling ?? 0} step={0.01} onChange={(v) => upd((j) => (j.calibration!.falling = v))} />
          </Row>
        )}
      </Section>
      {joint.extras.length > 0 && <div className="dim pad">保留了 {joint.extras.length} 个未识别的子元素</div>}
    </>
  );
}

function RobotInspector({ robot }: { robot: Robot }) {
  const issues = useStore((st) => st.issues);
  return (
    <>
      <div className="inspector-title">🤖 Robot</div>
      <Row label="名称">
        <TextField value={robot.name} onChange={(n) => n && editRobot((r) => (r.name = n))} />
      </Row>
      <div className="readout">
        {robot.links.length} links · {robot.joints.length} joints · {robot.joints.filter(isMovable).length} 个可动关节
      </div>
      <Section title={`全局材质 (${robot.materials.length})`}>
        {robot.materials.map((m, i) => (
          <MaterialFields
            key={i}
            robot={robot}
            m={m}
            onChange={(nm) =>
              editRobot((r) => {
                if (nm) r.materials[i] = nm;
                else r.materials.splice(i, 1);
              })
            }
          />
        ))}
        <button className="small" onClick={() => editRobot((r) => r.materials.push({ name: `material_${r.materials.length}`, color: [0.7, 0.7, 0.7, 1], texture: null }))}>
          + 材质
        </button>
      </Section>
      <Section title={`检查 (${issues.length})`}>
        {issues.length === 0 && <div className="ok pad">✓ 未发现问题</div>}
        {issues.map((i, k) => (
          <div
            key={k}
            className={`issue ${i.level}`}
            onClick={() => {
              if (!i.target) return;
              const isLink = robot.links.some((l) => l.name === i.target);
              useStore.setState({ selection: { kind: isLink ? "link" : "joint", name: i.target } });
            }}
          >
            {i.level === "error" ? "✕" : "⚠"} {i.message}
          </div>
        ))}
      </Section>
      {robot.extras.length > 0 && <div className="dim pad">保留了 {robot.extras.length} 个顶层扩展元素 (gazebo/transmission 等)</div>}
    </>
  );
}

function MeshInspector() {
  const stats = useStore((st) => st.meshStats);
  const target = useStore((st) => st.editTarget);
  const version = useStore((st) => st.meshVersion);
  const [center, setCenter] = useState<[number, number, number] | null>(null);
  const editor = target ? getMesh(target.meshPath)?.editor : undefined;
  useEffect(() => {
    const c = editor?.selectionCenter();
    setCenter(c ? [c[0], c[1], c[2]] : null);
  }, [editor, version]);
  const prop = useStore((st) => st.proportional);
  if (!stats || !target) return null;
  return (
    <Section title="网格编辑">
      <div className="readout">
        {target.link} / {target.role === "visual" ? "外观" : "碰撞"} #{target.index}
        <br />
        {target.meshPath}
      </div>
      {center && (
        <Vec3Field
          label="选中中心 (局部)"
          value={center}
          step={0.001}
          onChange={(v) => {
            editor?.run({ op: "set_median", position: v });
            useStore.setState((st) => ({ meshStats: editor!.stats(), meshVersion: st.meshVersion + 1, lastOp: null }));
          }}
        />
      )}
      <Row label="比例编辑 (O)">
        <Check label="启用" checked={prop.enabled} onChange={(enabled) => useStore.setState({ proportional: { ...prop, enabled } })} />
        <Check label="仅相连" checked={prop.connected} onChange={(connected) => useStore.setState({ proportional: { ...prop, connected } })} />
      </Row>
      <Row label="衰减 / 半径">
        <Select
          value={prop.falloff}
          options={[
            { value: "smooth", label: "平滑" },
            { value: "sphere", label: "球状" },
            { value: "root", label: "根" },
            { value: "sharp", label: "锐利" },
            { value: "linear", label: "线性" },
            { value: "constant", label: "常值" },
          ]}
          onChange={(falloff) => useStore.setState({ proportional: { ...prop, falloff } })}
        />
        <NumField value={prop.radius} min={1e-6} step={0.001} onChange={(radius) => useStore.setState({ proportional: { ...prop, radius } })} />
      </Row>
    </Section>
  );
}

export function Inspector() {
  const robot = useStore((st) => st.robot);
  const selection = useStore((st) => st.selection);
  const mode = useStore((st) => st.mode);
  if (!robot) return <div className="panel-empty">属性</div>;
  const link = selection?.kind === "link" ? robot.links.find((l) => l.name === selection.name) : undefined;
  const joint = selection?.kind === "joint" ? robot.joints.find((j) => j.name === selection.name) : undefined;
  return (
    <div className="inspector">
      {mode === "edit" && <MeshInspector />}
      {link ? <LinkInspector robot={robot} link={link} /> : joint ? <JointInspector robot={robot} joint={joint} /> : <RobotInspector robot={robot} />}
    </div>
  );
}
