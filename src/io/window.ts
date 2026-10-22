// Native window helpers for the custom title bar. In a plain browser there is
// no native window, so everything degrades to no-ops.

import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { isTauri } from "./project";

export const appWindow: Window | null = isTauri() ? getCurrentWindow() : null;

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const platform: "mac" | "windows" | "linux" = /Mac/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : "linux";

/** macOS keeps its native traffic lights (overlay title bar); elsewhere we draw our own controls. */
export const customControls = !!appWindow && platform !== "mac";
export const macOverlay = !!appWindow && platform === "mac";
