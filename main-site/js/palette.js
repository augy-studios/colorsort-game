// The colours a level is dealt from, each with a symbol, so no two are told
// apart by colour alone. Fixed-meaning colours, like the footer heart: they
// are the pieces of the game and look the same in every theme.
//
// The order is part of the deal. Adding a colour at the end is safe;
// reordering or removing one changes every seed's level.
//
// Symbols are SVG path data on a 24 by 24 box, drawn filled. The flat board
// puts them in an <svg>; the 3D board hands the same string to Path2D.

export const COLOURS = [
  { id: "red", label: "Red", hex: "#e8384f", ink: "#7a0f1f", symbol: "heart" },
  { id: "orange", label: "Orange", hex: "#fd8c2b", ink: "#7a3a00", symbol: "bolt" },
  { id: "yellow", label: "Yellow", hex: "#ffd23f", ink: "#7a5a00", symbol: "sun" },
  { id: "green", label: "Green", hex: "#2fb84f", ink: "#0b4a1a", symbol: "clover" },
  { id: "blue", label: "Blue", hex: "#2f6fe0", ink: "#0d2a66", symbol: "drop" },
  { id: "purple", label: "Purple", hex: "#8b4fd6", ink: "#36156a", symbol: "moon" },
  { id: "pink", label: "Pink", hex: "#ff6fb5", ink: "#7a1048", symbol: "crown" },
  { id: "cyan", label: "Cyan", hex: "#3fd0e8", ink: "#0a5866", symbol: "diamond" },
  { id: "brown", label: "Brown", hex: "#9a5a34", ink: "#3b1e0b", symbol: "cloud" },
  { id: "lime", label: "Lime", hex: "#a6d930", ink: "#3d5408", symbol: "leaf" },
  { id: "teal", label: "Teal", hex: "#15998f", ink: "#053f3a", symbol: "star" },
  { id: "navy", label: "Navy", hex: "#3a4aa8", ink: "#dfe4ff", symbol: "triangle" },
];

// A hidden nut, before it is uncovered.
export const HIDDEN = { id: "hidden", label: "Hidden", hex: "#8f969c", ink: "#2f3438", symbol: "question" };

export const SYMBOLS = {
  heart: "M12 20.5 4.2 12.9A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 7.8 6.3Z",
  bolt: "M13.5 2.5 5.5 13.5h5.2L9.5 21.5l9-11.5h-5.3Z",
  sun: "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm-1-5h2v3h-2Zm0 17h2v3h-2ZM2 11h3v2H2Zm17 0h3v2h-3ZM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4Zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4ZM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1Zm12.1-12.1 2.1-2.1 1.4 1.4-2.1 2.1Z",
  clover: "M12 3.5a3.6 3.6 0 0 1 3.4 4.9 3.6 3.6 0 1 1-1.4 6.6l1 5.5h-6l1-5.5a3.6 3.6 0 1 1-1.4-6.6A3.6 3.6 0 0 1 12 3.5Z",
  drop: "M12 2.5c3.5 4.6 6.2 8.3 6.2 11.7a6.2 6.2 0 0 1-12.4 0c0-3.4 2.7-7.1 6.2-11.7Z",
  moon: "M15.5 3a9 9 0 1 0 5.5 13.6A7.5 7.5 0 0 1 15.5 3Z",
  crown: "M3 18.5h18l-1.2-11-4.6 4.3L12 5l-3.2 6.8L4.2 7.5Z",
  diamond: "M12 2.5 20 12l-8 9.5L4 12Z",
  cloud: "M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 17.8 9 4.6 4.6 0 0 1 17.5 19Z",
  leaf: "M20 4C9.5 4 4 9 4 15.5c0 1.3.3 2.5.8 3.5L3.5 20.5l1.1 1 1.4-1.4c1 .5 2.2.9 3.5.9C16.5 21 20 14.5 20 4Z",
  star: "M12 2.8 14.6 9l6.6.4-5.1 4.2 1.7 6.5L12 16.5l-5.8 3.6 1.7-6.5-5.1-4.2L9.4 9Z",
  triangle: "M12 3.5 21 19.5H3Z",
  question:
    "M12 2.5a6 6 0 0 1 6 6c0 2.6-1.6 3.8-3 4.8-1 .7-1.5 1.1-1.5 2.2v.5h-3v-.7c0-2.3 1.3-3.3 2.6-4.2 1.1-.8 1.9-1.4 1.9-2.6a3 3 0 0 0-6 0H6a6 6 0 0 1 6-6ZM10.5 18h3v3h-3Z",
};

export const colourOf = (c) => (c < 0 ? HIDDEN : COLOURS[c]);
