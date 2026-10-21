// Kinematic motion playback: sinusoidal sweep, random targets (respecting
// velocity limits) and keyframe animation.

import { store } from "../state/store";
import { isMovable, jointRange } from "../types/urdf";

let t = 0;
let targets: Record<string, number> = {};

export function resetSimulation() {
  t = 0;
  targets = {};
}

const smooth = (x: number) => x * x * (3 - 2 * x);
const KEYFRAME_SECONDS = 1.5;

export function stepSimulation(dt: number) {
  const st = store.getState();
  const robot = st.robot;
  if (!robot || !st.playing) return;
  t += dt * st.simSpeed;
  const values = { ...st.jointValues };
  const movable = robot.joints.filter((j) => isMovable(j) && !j.mimic);

  if (st.playing === "sweep") {
    movable.forEach((j, i) => {
      const [lo, hi] = jointRange(j);
      const mid = (lo + hi) / 2;
      const amp = (hi - lo) / 2;
      values[j.name] = mid + amp * Math.sin(t * 0.8 + i * 0.9);
    });
  } else if (st.playing === "random") {
    for (const j of movable) {
      const [lo, hi] = jointRange(j);
      const cur = values[j.name] ?? 0;
      if (targets[j.name] === undefined || Math.abs(targets[j.name] - cur) < 1e-3) {
        targets[j.name] = lo + Math.random() * (hi - lo);
      }
      const vmax = (j.limit?.velocity && j.limit.velocity > 0 ? j.limit.velocity : 1) * dt * st.simSpeed;
      const d = targets[j.name] - cur;
      values[j.name] = cur + Math.sign(d) * Math.min(Math.abs(d), vmax);
    }
  } else if (st.playing === "keyframes") {
    const kf = st.keyframes;
    if (kf.length < 2) {
      store.setState({ playing: false });
      st.setStatus("关键帧播放至少需要 2 帧", "error");
      return;
    }
    const total = kf.length * KEYFRAME_SECONDS;
    const phase = (t % total) / KEYFRAME_SECONDS;
    const i = Math.floor(phase);
    const a = kf[i];
    const b = kf[(i + 1) % kf.length];
    const w = smooth(phase - i);
    for (const j of movable) {
      const va = a[j.name] ?? 0;
      const vb = b[j.name] ?? 0;
      values[j.name] = va + (vb - va) * w;
    }
  }
  store.setState({ jointValues: values });
}
