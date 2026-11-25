const paths = {
  robot: "M12 4V2m-2 0h4M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm3 5h1m6 0h1m-7 4h6",
  tree: "M5 3v15h4M5 8h4m2-3h8v6h-8zm0 10h8v6h-8z",
  properties: "M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4",
  cube: "m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5m8 4.5v9",
  joint: "M8 8 4 4m12 12 4 4M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 5v2",
  folder: "M3 6h7l2 2h9l-2 11H3z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
  chevron: "m9 6 6 6-6 6",
  focus: "M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4m-4-11v6m-3-3h6",
  frame: "M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 8h8v8H8z",
  grid: "M4 4h16v16H4zM4 9h16M4 15h16M9 4v16m6-16v16",
  eye: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  move: "M12 3v18M3 12h18M9 6l3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3",
  rotate: "M4 11a8 8 0 1 1 2 7M4 5v6h6",
  scale: "M8 4H4v4m12 12h4v-4M4 4l6 6m10 10-6-6",
  box: "M4 4h3m3 0h4m3 0h3v3m0 3v4m0 3v3h-3m-3 0h-4m-3 0H4v-3m0-3v-4m0-3V4",
  circle: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z",
  link: "M10 14l4-4m-6 3-3 3a3 3 0 0 0 4 4l3-3m0-10 3-3a3 3 0 0 1 4 4l-3 3",
  face: "M8 5h13l-5 14H3z",
  similar: "M4 10h6V4H4zm10 10h6v-6h-6zm-1-13h7M4 17h7",
  extrude: "M5 16h14v5H5zm7 0V3m-4 4 4-4 4 4",
  inset: "M3 3h18v18H3zm5 5h8v8H8z",
  loop: "M4 4h16v16H4zm8 0v16",
  cut: "M4 4h16v16H4zm0 16L20 4",
  fill: "M4 4h16v16H4zm0 16L20 4M4 13l9-9m-2 16 9-9",
  bridge: "M3 7h5v10H3zm13 0h5v10h-5zM8 9h8m-8 6h8",
  merge: "M4 5l8 7-8 7m8-7h8m-3-3 3 3-3 3",
  split: "M4 12h8l8-7m-8 7 8 7",
  dissolve: "M4 5h16v14H4zm0 14L20 5",
  play: "m8 4 12 8-12 8z",
  pause: "M9 5v14m6-14v14",
  motion: "M2 12h4l3-7 5 14 3-7h5",
} satisfies Record<string, string>;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
