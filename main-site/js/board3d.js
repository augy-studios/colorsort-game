// The 3D board, with three.js: glass tubes of coloured water, or threaded
// bolts stacked with hex nuts. The same columns as the flat board, drawn as
// the pieces they are. Each colour carries its symbol (js/palette.js) on its
// sides, so no two colours are told apart by colour alone.
//
// Loaded only when the 3D view is on (js/board.js imports this file on
// demand). three.js is vendored under /vendor/three and mapped by the import
// map in index.html, so it is precached and works offline. Throws where
// WebGL is unavailable, and the flat board carries on.
//
// Input is js/board.js's: this file only says which column is under a point
// on screen. Nothing here is rendered unless something changed: a frame is
// drawn on demand and while something moves, never in an idle loop.
//
// How things move.
//
// Every animation is a job on a queue. A job names the columns it touches and
// runs as a list of steps. Jobs on different columns run side by side; a job
// waits for earlier jobs on any of its columns, and a column with work queued
// behind it plays faster to catch up. Nothing snaps to its end unless a new
// level is laid out. Once a column has no work left it is checked against the
// view: a nut it uncovered shows its colour, a picked column rises, a finished
// one gets its cork or cap.
//
// Water obeys gravity. Each layer of water is the inside of the tube cut
// between two level planes in world space, at the heights that hold the
// layers' volumes for the way the tube is tilted. So as a tube tips, its
// water stays level, runs towards the mouth, and pours from the lip only once
// it reaches it. A pour tips the tube just far enough for the water to reach
// its lip, one layer at a time, and the tube it pours into fills layer by
// layer. The cork goes on once the last layer is in.
//
// Nuts screw. Picking a bolt spins its top nuts up the thread one by one; off
// the end of the bolt they stop turning and wait there. Moved, they glide to
// above the other bolt without turning, stop, and spin down it one by one.
// The cap goes on once the last nut is down.

import * as THREE from "three";
import { COLOURS, HIDDEN, SYMBOLS } from "./palette.js";
import { cellSize, layoutFor, placeOf } from "./board.js";
import { colourOfUnit, isComplete, isHiddenUnit, runLength } from "./puzzle.js";
import { reducedMotion } from "./ui.js";

const TILT = (14 * Math.PI) / 180; // the camera looks down this far

const WATER = { uh: 0.5, r: 0.34, liquid: 0.3, floor: 0.04 };
const BOLT = { uh: 0.4, nut: 0.4, shaft: 0.12 };

const LIFT = 0.35; // how far a picked tube rises
const PITCH = 0.3; // how far a nut climbs per turn of the thread
const MAX_POUR = (112 * Math.PI) / 180; // the furthest a tube tips

// Durations in milliseconds, at normal speed.
const T = {
  lift: 240,
  travel: 460,
  pourUnit: 520,
  back: 460,
  unscrew: 340,
  glide: 420,
  screw: 360,
  capIn: 300,
  fast: 150,
};

/* ---- colours, from the theme's own tokens ---- */

const probe = document.createElement("canvas");
probe.width = probe.height = 1;
const probeCtx = probe.getContext("2d", { willReadFrequently: true });

// Any CSS colour, var() and color-mix() included, as a three.js colour.
function themeColor(expression) {
  const el = document.createElement("span");
  el.style.display = "none";
  el.style.color = expression;
  document.body.append(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  probeCtx.clearRect(0, 0, 1, 1);
  probeCtx.fillStyle = "#000";
  probeCtx.fillStyle = resolved;
  probeCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/* ---- textures: a colour with its symbol, repeated round the side ---- */

function symbolTexture(colour, repeats, withSymbol) {
  const canvas = document.createElement("canvas");
  canvas.width = 128 * repeats;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colour.hex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (withSymbol) {
    const path = new Path2D(SYMBOLS[colour.symbol]);
    ctx.fillStyle = colour.ink;
    ctx.globalAlpha = 0.75;
    for (let k = 0; k < repeats; k++) {
      ctx.save();
      ctx.translate(k * 128 + 64 - 30, 64 - 30);
      ctx.scale(60 / 24, 60 / 24);
      ctx.fill(path);
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function threadTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#d9dde1";
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = "#a9b0b7";
  ctx.fillRect(0, 22, 32, 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ---- easing ---- */

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeOutBack = (p) => 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;
const smooth = (p) => p * p * (3 - 2 * p);
// A turn of the nut that ends square, so a nut never comes to rest askew.
const squareTurn = (rot) => Math.round(rot / (Math.PI / 3)) * (Math.PI / 3);

/* ---- the inside of a tube: volumes and water levels ---- */

// The inside is a hemisphere of radius L on the floor, then a cylinder up to
// `top`, in the tube's own coordinates with y up its axis.
class TubeVolume {
  constructor(top) {
    this.L = WATER.liquid;
    this.y0 = WATER.floor;
    this.c0 = this.y0 + this.L; // centre of the rounded end
    this.top = top;
    this.unit = Math.PI * this.L * this.L * WATER.uh; // one layer of water
    this.hemi = (2 / 3) * Math.PI * this.L ** 3;
    this.capacity = this.hemi + Math.PI * this.L * this.L * (top - this.c0);
    this.N = 72;
  }

  radiusAt(y) {
    if (y >= this.c0) return this.L;
    const d = this.c0 - y;
    return Math.sqrt(Math.max(0, this.L * this.L - d * d));
  }

  // Upright: the height of the water holding volume v.
  uprightHeight(v) {
    if (v <= 0) return this.y0;
    if (v >= this.capacity) return this.top;
    if (v > this.hemi) return this.c0 + (v - this.hemi) / (Math.PI * this.L * this.L);
    // A cap of the sphere, height t: pi t^2 (3L - t) / 3.
    let lo = 0;
    let hi = this.L;
    for (let k = 0; k < 30; k++) {
      const t = (lo + hi) / 2;
      if ((Math.PI * t * t * (3 * this.L - t)) / 3 < v) lo = t;
      else hi = t;
    }
    return this.y0 + (lo + hi) / 2;
  }

  // Tipped by angle a: the volume below height h, measured from the tube's
  // origin. Slices across the axis, each a circle cut by the level line.
  volumeBelow(h, a) {
    const s = Math.abs(Math.sin(a));
    const c = Math.cos(a);
    const ds = (this.top - this.y0) / this.N;
    let v = 0;
    for (let k = 0; k < this.N; k++) {
      const y = this.y0 + (k + 0.5) * ds;
      const r = this.radiusAt(y);
      if (r <= 0) continue;
      const centre = y * c;
      let area;
      if (s < 1e-6) area = centre < h ? Math.PI * r * r : 0;
      else {
        const d = (h - centre) / s;
        if (d >= r) area = Math.PI * r * r;
        else if (d <= -r) area = 0;
        else area = r * r * Math.acos(-d / r) + d * Math.sqrt(r * r - d * d);
      }
      v += area * ds;
    }
    return v;
  }

  // Tipped by angle a: the height, from the tube's origin, of the level
  // holding volume v.
  levelFor(v, a) {
    if (Math.abs(Math.sin(a)) < 1e-3) return this.uprightHeight(v) * Math.cos(a);
    if (v <= 0) return -10;
    const s = Math.abs(Math.sin(a));
    const c = Math.cos(a);
    const ys = [this.y0 * c - this.L, this.top * c - this.L * s, this.top * c + this.L * s, this.y0 * c + this.L];
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    for (let k = 0; k < 26; k++) {
      const h = (lo + hi) / 2;
      if (this.volumeBelow(h, a) < v) lo = h;
      else hi = h;
    }
    return (lo + hi) / 2;
  }

  // The height of the lowest point of the mouth, tipped by angle a.
  lipHeight(a) {
    return this.top * Math.cos(a) - this.L * Math.abs(Math.sin(a));
  }

  // How far a tube holding volume v must tip for the water to reach its lip.
  pourAngle(v) {
    if (v >= this.capacity) return 0;
    let lo = 0;
    let hi = MAX_POUR;
    if (this.volumeBelow(this.lipHeight(hi), hi) > v) return hi;
    for (let k = 0; k < 22; k++) {
      const a = (lo + hi) / 2;
      if (this.volumeBelow(this.lipHeight(a), a) > v) lo = a;
      else hi = a;
    }
    return (lo + hi) / 2;
  }
}

export class Board3D {
  constructor(host) {
    this.host = host;
    this.view = null;
    this.mode = null;
    this.cols = []; // one record per column: its group, water or nuts
    this.jobs = [];
    this.fx = []; // pulses, outside the job queue
    this.frame = null;
    this.lastTick = 0;
    this.focus = -1;
    this.layout = null;
    this.pendingPulse = new Set();
    this.extraPx = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "board-canvas";
    // The flat buttons underneath are what assistive tech reads.
    this.canvas.setAttribute("aria-hidden", "true");
    host.append(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a90, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-3, 6, 8);
    this.scene.add(sun);

    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    // Geometry shared by every piece of its kind.
    this.geo = {
      nut: new THREE.CylinderGeometry(BOLT.nut, BOLT.nut, BOLT.uh * 0.9, 6, 1, false, Math.PI / 6).translate(0, (BOLT.uh * 0.9) / 2, 0),
      base: new THREE.CylinderGeometry(0.48, 0.52, 0.12, 40),
      knob: new THREE.SphereGeometry(BOLT.shaft * 1.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      cap: new THREE.SphereGeometry(0.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      cork: new THREE.CylinderGeometry(WATER.r * 0.95, WATER.r * 0.8, 0.22, 24).translate(0, 0.11, 0),
      halo: new THREE.PlaneGeometry(1, 1),
    };
    this.threads = threadTexture();
    this.mats = {
      metal: new THREE.MeshStandardMaterial({ color: 0xd4d9de, roughness: 0.35, metalness: 0.55 }),
      shaft: new THREE.MeshStandardMaterial({ map: this.threads, roughness: 0.4, metalness: 0.5 }),
      glass: new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.16, roughness: 0.08, depthWrite: false, side: THREE.FrontSide }),
      rim: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }),
      cork: new THREE.MeshStandardMaterial({ color: 0xb98454, roughness: 0.9 }),
      hint: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false }),
      target: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
      focus: new THREE.LineBasicMaterial({}),
    };
    this.colourMats = new Map(); // "mode|palette index|symbols" -> materials
    this.refreshColors();

    this.themeWatch = new MutationObserver(() => this.refreshColors());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "data-color-theme", "style"] });
    this.onVisible = () => document.visibilityState === "visible" && this.kick();
    document.addEventListener("visibilitychange", this.onVisible);
    this.resize();
  }

  tubeGeometry(height, r) {
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const a = -Math.PI / 2 + (k / 10) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, r * Math.cos(a)), r + r * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(r, height), new THREE.Vector2(r + 0.05, height + 0.03));
    return new THREE.LatheGeometry(pts, 32);
  }

  // The whole inside of a tube, which every layer of water is cut from. Its
  // texture runs up the tube one symbol per layer's height, lined up with
  // where the layers sit when the tube stands upright.
  liquidGeometry(top) {
    const L = WATER.liquid;
    const y0 = WATER.floor;
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const a = -Math.PI / 2 + (k / 12) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, L * Math.cos(a)), y0 + L + L * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(L, top));
    const geo = new THREE.LatheGeometry(pts, 32);
    // Upright, the first layer ends a third of a radius higher than a plain
    // cylinder's would, for the rounded end holds less.
    const vBase = y0 + L / 3;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, (pos.getY(k) - vBase) / WATER.uh);
    uv.needsUpdate = true;
    return geo;
  }

  refreshColors() {
    this.mats.glass.color.copy(themeColor("white"));
    this.mats.rim.color.copy(themeColor("color-mix(in srgb, var(--ink) 55%, var(--bg))"));
    this.mats.hint.color.copy(themeColor("var(--warn)"));
    this.mats.target.color.copy(themeColor("var(--brand-ink)"));
    this.mats.focus.color.copy(themeColor("var(--ink)"));
    this.draw();
  }

  // The materials for a unit: one per colour, with or without symbols.
  materialFor(code) {
    const hidden = isHiddenUnit(code);
    const palette = hidden ? -1 : this.view.palette[colourOfUnit(code)];
    const key = `${this.mode}|${palette}|${this.view.symbols ? 1 : 0}`;
    if (!this.colourMats.has(key)) {
      const colour = hidden ? HIDDEN : COLOURS[palette];
      const repeats = this.mode === "bolts" ? 6 : 4;
      const map = symbolTexture(colour, repeats, hidden || this.view.symbols);
      if (this.mode === "water") map.wrapS = map.wrapT = THREE.RepeatWrapping;
      const side = new THREE.MeshStandardMaterial({
        map,
        roughness: this.mode === "bolts" ? 0.45 : 0.25,
        metalness: this.mode === "bolts" ? 0.1 : 0,
        flatShading: this.mode === "bolts",
      });
      const top = new THREE.MeshStandardMaterial({ color: colour.hex, roughness: 0.35, flatShading: this.mode === "bolts" });
      // The surface of water seen from above: flat, a touch lighter.
      const surface = new THREE.Color(colour.hex).lerp(new THREE.Color(0xffffff), 0.14);
      this.colourMats.set(key, { side, top, surface });
    }
    return this.colourMats.get(key);
  }

  /* ---- building ---- */

  setup(view) {
    this.finishAll();
    for (const fx of this.fx) fx.done();
    this.fx = [];
    this.pendingPulse.clear();
    for (const col of this.cols) this.disposeColumn(col);
    this.cols = [];
    for (const m of this.colourMats.values()) {
      m.side.map?.dispose();
      m.side.dispose();
      m.top.dispose();
    }
    this.colourMats.clear();
    this.view = view;
    this.mode = view.mode;
    this.cap = view.cap;
    this.cell = cellSize(view.mode, view.cap);
    this.tubeGeo?.dispose();
    this.rimGeo?.dispose();
    this.shaftGeo?.dispose();
    this.liquidGeo?.dispose();
    if (view.mode === "water") {
      const h = view.cap * WATER.uh + 0.3;
      this.tubeGeo = this.tubeGeometry(h, WATER.r);
      this.rimGeo = this.tubeGeometry(h, WATER.r + 0.035);
      this.liquidGeo = this.liquidGeometry(h - 0.02);
      this.volume = new TubeVolume(h - 0.02);
      this.columnHeight = h;
    } else {
      const h = view.cap * BOLT.uh + 0.35;
      this.shaftGeo = new THREE.CylinderGeometry(BOLT.shaft, BOLT.shaft, h, 16, 1, true).translate(0, h / 2, 0);
      this.threads.repeat.set(1, view.cap * 3);
      this.columnHeight = h;
    }
    this.symbols = view.symbols;
    this.ensureColumns(view.cols.length);
    view.cols.forEach((_, i) => this.settle(i, false));
    this.dress(view);
    this.draw();
  }

  makeColumn(i) {
    const group = new THREE.Group();
    group.userData.i = i;
    const parts = {};
    if (this.mode === "water") {
      parts.glass = new THREE.Mesh(this.tubeGeo, this.mats.glass);
      parts.glass.renderOrder = 2;
      parts.rim = new THREE.Mesh(this.rimGeo, this.mats.rim);
      parts.rim.renderOrder = 1;
      parts.cork = new THREE.Mesh(this.geo.cork, this.mats.cork);
      parts.cork.userData.y = this.columnHeight - 0.08;
      parts.cork.position.y = parts.cork.userData.y;
      parts.cork.visible = false;
      group.add(parts.rim, parts.glass, parts.cork);
    } else {
      parts.base = new THREE.Mesh(this.geo.base, this.mats.metal);
      parts.base.position.y = -0.06;
      parts.shaft = new THREE.Mesh(this.shaftGeo, this.mats.shaft);
      parts.knob = new THREE.Mesh(this.geo.knob, this.mats.metal);
      parts.knob.position.y = this.columnHeight;
      parts.cap = new THREE.Mesh(this.geo.cap, this.mats.metal);
      parts.cap.userData.y = this.cap * BOLT.uh;
      parts.cap.position.y = parts.cap.userData.y;
      parts.cap.visible = false;
      group.add(parts.base, parts.shaft, parts.knob, parts.cap);
    }
    parts.halo = new THREE.Mesh(this.geo.halo, this.mats.hint);
    parts.halo.scale.set(this.cell.w * 0.92, this.cell.h * 0.98, 1);
    parts.halo.position.set(0, this.cell.h / 2 - 0.35, -0.6);
    parts.halo.visible = false;
    parts.focus = new THREE.LineSegments(new THREE.EdgesGeometry(this.geo.halo), this.mats.focus);
    parts.focus.scale.copy(parts.halo.scale);
    parts.focus.position.copy(parts.halo.position);
    parts.focus.visible = false;
    group.add(parts.halo, parts.focus);
    this.scene.add(group);
    // lift: how far a picked tube has risen. layers: water, bottom first.
    // nuts: bottom first; raised: how many of the top ones wait above the bolt.
    return { i, group, parts, home: new THREE.Vector3(), lift: 0, layers: [], nuts: [], raised: 0, doneShown: false };
  }

  disposeColumn(col) {
    for (const layer of col.layers) this.disposeLayer(col, layer);
    col.layers = [];
    for (const nut of col.nuts) nut.parent?.remove(nut);
    col.nuts = [];
    col.parts.focus.geometry.dispose();
    this.scene.remove(col.group);
  }

  ensureColumns(count) {
    if (this.cols.length !== count) this.finishAll();
    while (this.cols.length < count) this.cols.push(this.makeColumn(this.cols.length));
    while (this.cols.length > count) this.disposeColumn(this.cols.pop());
    this.relayout();
  }

  relayout() {
    const count = this.cols.length;
    if (!count) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const layout = layoutFor(count, this.cell, w, h);
    this.layout = layout;
    const worldW = layout.perRow * this.cell.w;
    const worldH = layout.rows * this.cell.h;
    this.cols.forEach((col, i) => {
      const p = placeOf(i, count, layout);
      const x = (p.col - (p.inRow - 1) / 2) * this.cell.w;
      const y = worldH / 2 - (p.row + 1) * this.cell.h + 0.35;
      col.home.set(x, y, 0);
      if (!this.busy(i)) this.place(col);
    });
    // Fit the camera round the board, with a margin for lifted pieces.
    const aspect = w / h;
    let halfW = (worldW / 2) * 1.04;
    let halfH = (worldH / 2) * 1.1;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    // Above the top row there is room to draw into: a tube pouring into the
    // top row, or nuts waiting above it, rise over the box's edge rather
    // than being cut off by it.
    const pxPerWorld = h / (2 * halfH);
    const extraWorld = this.mode === "water" ? this.columnHeight + 0.3 : this.cap * BOLT.uh + 0.4;
    this.extraPx = Math.round(Math.max(0, Math.min(extraWorld * pxPerWorld, h * 0.6)));
    this.canvas.style.top = `${-this.extraPx}px`;
    this.canvas.style.height = `${h + this.extraPx}px`;
    this.renderer.setSize(w, h + this.extraPx, false);
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH + this.extraPx / pxPerWorld;
    this.camera.bottom = -halfH;
    const d = 20;
    this.camera.position.set(0, Math.sin(TILT) * d, Math.cos(TILT) * d);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  resize() {
    this.relayout();
  }

  /* ---- pieces ---- */

  slotY(k) {
    return k * BOLT.uh;
  }

  hoverY(j) {
    return this.columnHeight + 0.18 + j * BOLT.uh;
  }

  makeNut(code) {
    const m = this.materialFor(code);
    const mesh = new THREE.Mesh(this.geo.nut, [m.side, m.top, m.top]);
    mesh.userData.code = code;
    mesh.userData.symbols = this.view.symbols;
    return mesh;
  }

  paintNut(mesh, code) {
    if (mesh.userData.code === code && mesh.userData.symbols === this.view.symbols) return;
    mesh.userData.code = code;
    mesh.userData.symbols = this.view.symbols;
    const m = this.materialFor(code);
    mesh.material = [m.side, m.top, m.top];
  }

  // A layer of water: the inside of the tube, cut between two level planes.
  // Seen from outside it is the coloured side; looking down into the cut,
  // the inside faces show as the flat surface of the water.
  makeLayer(col, code, vol) {
    const lower = new THREE.Plane(new THREE.Vector3(0, 1, 0), 10);
    const upper = new THREE.Plane(new THREE.Vector3(0, -1, 0), -10);
    const layer = { code, vol, lower, upper, front: null, back: null, symbols: null };
    this.paintLayer(col, layer, code);
    return layer;
  }

  paintLayer(col, layer, code) {
    if (layer.front && layer.code === code && layer.symbols === this.view.symbols) return;
    const m = this.materialFor(code);
    const side = m.side.clone();
    side.clippingPlanes = [layer.lower, layer.upper];
    // The surface is cut at the layer's top only, so it covers every layer
    // below; drawn after them (updateLiquid orders it), the top layer's
    // colour is the one seen looking down into the water.
    const surface = new THREE.MeshBasicMaterial({ color: m.surface, side: THREE.BackSide, clippingPlanes: [layer.upper] });
    if (layer.front) {
      layer.front.material.dispose();
      layer.back.material.dispose();
      layer.front.material = side;
      layer.back.material = surface;
    } else {
      layer.front = new THREE.Mesh(this.liquidGeo, side);
      layer.back = new THREE.Mesh(this.liquidGeo, surface);
      col.group.add(layer.front, layer.back);
    }
    layer.code = code;
    layer.symbols = this.view.symbols;
  }

  disposeLayer(col, layer) {
    col.group.remove(layer.front, layer.back);
    layer.front.material.dispose();
    layer.back.material.dispose();
  }

  // Sets each layer's two planes at the levels its volume reaches, for the
  // way the tube stands right now.
  updateLiquid(col) {
    if (this.mode !== "water") return;
    const g = col.group;
    const a = g.rotation.z;
    const base = g.position.y;
    let below = -1e3;
    let total = 0;
    for (const [k, layer] of col.layers.entries()) {
      layer.back.renderOrder = 0.01 * (k + 1);
      total += Math.max(0, layer.vol) * this.volume.unit;
      const level = base + this.volume.levelFor(total, a);
      layer.lower.constant = -below;
      layer.upper.constant = level;
      const show = layer.vol > 1e-3;
      layer.front.visible = show;
      layer.back.visible = show;
      below = level;
    }
  }

  surfaceY(col) {
    const total = col.layers.reduce((v, l) => v + Math.max(0, l.vol), 0) * this.volume.unit;
    return col.group.position.y + this.volume.levelFor(total, col.group.rotation.z);
  }

  // A column at rest: where it stands, and its pieces in their places.
  place(col) {
    const g = col.group;
    g.position.set(col.home.x, col.home.y + col.lift, 0);
    g.rotation.z = 0;
    if (this.mode === "water") this.updateLiquid(col);
    else {
      const n = col.nuts.length;
      col.nuts.forEach((mesh, k) => {
        if (mesh.parent !== g) g.attach(mesh);
        const j = k - (n - col.raised);
        mesh.position.set(0, j >= 0 ? this.hoverY(j) : this.slotY(k), 0);
      });
    }
  }

  /* ---- drawing a view ---- */

  render(view, change) {
    this.symbols = view.symbols;
    this.view = view;
    if (view.cols.length !== this.cols.length) this.ensureColumns(view.cols.length);
    if (change && !reducedMotion()) this.enqueueMove(change);
    view.cols.forEach((_, i) => {
      if (!this.busy(i)) this.settle(i, false);
    });
    this.dress(view);
    this.draw();
  }

  // Brings an idle column in line with the view. Anything that needs to
  // move to get there is queued, not snapped.
  settle(i, animate) {
    const col = this.cols[i];
    const view = this.view;
    if (!col || !view) return;
    const codes = view.cols[i] ?? [];
    const picked = view.selected === i;
    if (this.mode === "water") {
      if (col.layers.length !== codes.length) {
        for (const layer of col.layers) this.disposeLayer(col, layer);
        col.layers = codes.map((code) => this.makeLayer(col, code, 1));
      } else
        col.layers.forEach((layer, k) => {
          this.paintLayer(col, layer, codes[k]);
          layer.vol = 1;
        });
      const want = picked ? LIFT : 0;
      if (Math.abs(col.lift - want) > 1e-3) this.enqueueLift(i, want);
      else this.place(col);
    } else {
      if (col.nuts.length !== codes.length) {
        for (const nut of col.nuts) nut.parent?.remove(nut);
        col.nuts = codes.map((code) => {
          const mesh = this.makeNut(code);
          col.group.add(mesh);
          return mesh;
        });
        col.raised = 0;
      } else col.nuts.forEach((mesh, k) => this.paintNut(mesh, codes[k]));
      const want = picked ? Math.min(codes.length, Math.max(1, view.liftCount ?? runLength(codes))) : 0;
      if (col.raised !== want) {
        if (col.raised > 0) this.enqueueScrew(i, "down");
        if (want > 0) this.enqueueScrew(i, "up", want);
      } else this.place(col);
    }
    // A finished column is closed once everything is in it.
    const done = isComplete(codes, this.cap);
    const lid = this.mode === "water" ? col.parts.cork : col.parts.cap;
    if (done && this.mode === "bolts") lid.material = this.materialFor(codes[codes.length - 1]).top;
    if (done && !col.doneShown) {
      col.doneShown = true;
      if (animate && !reducedMotion()) this.enqueueLid(i);
      else {
        lid.visible = true;
        lid.position.y = lid.userData.y;
        lid.scale.setScalar(1);
        this.firePendingPulse(i);
      }
    } else if (!done) {
      col.doneShown = false;
      lid.visible = false;
    } else this.firePendingPulse(i);
  }

  // Haloes and the keyboard's ring.
  dress(view) {
    this.cols.forEach((col, i) => {
      const p = col.parts;
      const hint = view.hint && (view.hint.a === i || view.hint.b === i);
      const target = view.target === i;
      p.halo.visible = Boolean(hint || target);
      p.halo.material = target ? this.mats.target : this.mats.hint;
      p.focus.visible = this.focus === i;
    });
  }

  setFocus(i) {
    this.focus = i;
    if (this.view) this.dress(this.view);
    this.draw();
  }

  /* ---- the job queue ---- */

  busy(i) {
    return this.jobs.some((job) => job.cols.includes(i));
  }

  enqueue(cols, steps) {
    this.jobs.push({ cols, steps, k: -1, t: 0 });
    this.kick();
  }

  canStart(job) {
    for (const other of this.jobs) {
      if (other === job) return true;
      if (other.cols.some((c) => job.cols.includes(c))) return false;
    }
    return true;
  }

  // Runs a job's steps as far as its clock says. True once it is over.
  advance(job) {
    while (job.k < job.steps.length) {
      const step = job.steps[job.k];
      const dur = reducedMotion() ? 0 : step.dur ?? 0;
      if (dur > 0 && job.t < dur) {
        step.update?.(job.t / dur);
        return false;
      }
      step.update?.(1);
      step.done?.();
      job.t -= dur;
      job.k++;
      if (job.k < job.steps.length) job.steps[job.k].init?.();
    }
    return true;
  }

  startJob(job) {
    job.k = 0;
    job.t = 0;
    job.steps[0]?.init?.();
  }

  endJob(job) {
    this.jobs.splice(this.jobs.indexOf(job), 1);
    for (const c of job.cols) if (!this.busy(c)) this.settle(c, true);
  }

  // Plays every queued job to its end at once: for a new level, or columns
  // coming or going.
  finishAll() {
    let guard = 0;
    while (this.jobs.length && guard++ < 500) {
      const job = this.jobs[0];
      if (job.k < 0) this.startJob(job);
      job.t = Infinity;
      this.advance(job);
      this.endJob(job);
    }
  }

  /* ---- water ---- */

  enqueueLift(i, want) {
    const col = this.cols[i];
    let from = 0;
    const step = {
      init: () => {
        from = col.lift;
        step.dur = (T.lift * Math.abs(want - from)) / LIFT;
      },
      update: (p) => {
        col.lift = lerp(from, want, easeInOut(p));
        this.place(col);
      },
    };
    this.enqueue([i], [step]);
  }

  // Where the tube stands for its lip to be at q, tipped by angle a towards
  // `side` (+1: it comes from the right and tips left).
  pourPose(q, a, side) {
    const rot = side * a;
    const lx = -side * (WATER.r + 0.04);
    const ly = this.columnHeight + 0.03;
    const x = lx * Math.cos(rot) - ly * Math.sin(rot);
    const y = lx * Math.sin(rot) + ly * Math.cos(rot);
    return { pos: new THREE.Vector3(q.x - x, q.y - y, q.z), rot };
  }

  enqueuePour(a, b, n, fast) {
    const ca = this.cols[a];
    const cb = this.cols[b];
    const ctx = { ok: false };
    const prepare = () => {
      ctx.ok = ca.layers.length >= n;
      if (!ctx.ok) return;
      ctx.leaving = ca.layers.slice(ca.layers.length - n).reverse(); // top first
      ctx.arriving = ctx.leaving.map((layer) => {
        const fresh = this.makeLayer(cb, layer.code, 0);
        cb.layers.push(fresh);
        return fresh;
      });
      this.updateLiquid(cb);
    };
    const finishPour = () => {
      if (!ctx.ok) return;
      for (const layer of ctx.leaving) {
        this.disposeLayer(ca, layer);
        ca.layers.splice(ca.layers.indexOf(layer), 1);
      }
      for (const layer of ctx.arriving) layer.vol = 1;
      this.updateLiquid(cb);
    };
    // Volumes as the pour goes: one layer after another, each easing in and
    // out, so the stream swells and thins between layers.
    const flowAt = (p) => {
      const t = p * n;
      const j = Math.min(n - 1, Math.floor(t));
      const q = t - j;
      ctx.leaving.forEach((layer, k) => (layer.vol = k < j ? 0 : k === j ? 1 - smooth(q) : 1));
      ctx.arriving.forEach((layer, k) => (layer.vol = k < j ? 1 : k === j ? smooth(q) : 0));
      return p >= 1 ? 0 : 6 * q * (1 - q) / 1.5;
    };

    if (fast) {
      let from = 0;
      this.enqueue([a, b], [
        {
          dur: T.fast,
          init: () => {
            prepare();
            from = ca.lift;
          },
          update: (p) => {
            if (!ctx.ok) return;
            flowAt(p);
            ca.lift = from * (1 - p);
            this.place(ca);
            this.updateLiquid(cb);
          },
          done: finishPour,
        },
      ]);
      return;
    }

    const side = ca.home.x > cb.home.x + 1e-3 ? 1 : ca.home.x < cb.home.x - 1e-3 ? -1 : cb.home.x <= 0 ? 1 : -1;
    const lipTarget = () => new THREE.Vector3(cb.home.x + side * 0.05, cb.group.position.y + this.columnHeight + 0.12, 0.45);
    const remaining = () => ca.layers.reduce((v, l) => v + Math.max(0, l.vol), 0) * this.volume.unit;
    let liftFrom = 0;
    let start = null;
    let startRot = 0;
    let angle = 0;
    let stream = null;
    let streamGeo = null;

    const lift = {
      init: () => {
        liftFrom = ca.lift;
        lift.dur = (T.lift * Math.max(0, LIFT - liftFrom)) / LIFT;
      },
      update: (p) => {
        ca.lift = lerp(liftFrom, LIFT, easeInOut(p));
        this.place(ca);
      },
    };
    const travel = {
      init: () => {
        prepare();
        start = ca.group.position.clone();
        if (!ctx.ok) {
          travel.dur = 0;
          return;
        }
        angle = this.volume.pourAngle(remaining());
        const end = this.pourPose(lipTarget(), angle, side);
        travel.dur = T.travel + Math.min(320, start.distanceTo(end.pos) * 70);
      },
      update: (p) => {
        if (!ctx.ok) return;
        const end = this.pourPose(lipTarget(), angle, side);
        const e = easeInOut(p);
        const pos = start.clone().lerp(end.pos, e);
        pos.y += Math.sin(e * Math.PI) * 0.35;
        ca.group.position.copy(pos);
        // It starts to tip once under way, and is tipped as it arrives.
        ca.group.rotation.z = end.rot * easeInOut(clamp01((p - 0.3) / 0.7));
        this.updateLiquid(ca);
      },
    };
    const pour = {
      init: () => {
        if (!ctx.ok) {
          pour.dur = 0;
          return;
        }
        pour.dur = T.pourUnit * n;
        stream = new THREE.Mesh(new THREE.BufferGeometry(), this.materialFor(ctx.leaving[0].code).top);
        stream.visible = false;
        this.scene.add(stream);
      },
      update: (p) => {
        if (!ctx.ok) return;
        const flow = flowAt(p);
        // Tipped just as far as the water left needs to reach the lip, and
        // never back while it pours.
        angle = Math.max(angle, this.volume.pourAngle(remaining()));
        const pose = this.pourPose(lipTarget(), angle, side);
        ca.group.position.copy(pose.pos);
        ca.group.rotation.z = pose.rot;
        this.updateLiquid(ca);
        this.updateLiquid(cb);
        // The stream: off the lip and down through the mouth below.
        streamGeo?.dispose();
        streamGeo = null;
        if (flow > 0.04) {
          ca.group.updateMatrixWorld();
          const lip = ca.group.localToWorld(new THREE.Vector3(-side * (WATER.r + 0.02), this.columnHeight + 0.02, 0));
          const mouthY = cb.group.position.y + this.columnHeight;
          const floor = Math.min(this.surfaceY(cb), mouthY - 0.08);
          const curve = new THREE.CatmullRomCurve3([
            lip,
            lip.clone().add(new THREE.Vector3(-side * 0.04, -0.05, -0.08)),
            new THREE.Vector3(cb.home.x + side * 0.02, mouthY, 0.08),
            new THREE.Vector3(cb.home.x, floor, 0),
          ]);
          streamGeo = new THREE.TubeGeometry(curve, 24, 0.012 + 0.045 * Math.min(1, flow), 8, false);
          stream.geometry = streamGeo;
          stream.visible = true;
        } else stream.visible = false;
      },
      done: () => {
        if (stream) this.scene.remove(stream);
        streamGeo?.dispose();
        streamGeo = null;
        stream = null;
        finishPour();
      },
    };
    const back = {
      init: () => {
        start = ca.group.position.clone();
        startRot = ca.group.rotation.z;
        ca.lift = 0;
        back.dur = (ctx.ok ? T.back : T.lift) + Math.min(320, start.distanceTo(ca.home) * 70);
      },
      update: (p) => {
        const e = easeInOut(p);
        const pos = start.clone().lerp(ca.home, e);
        pos.y += Math.sin(e * Math.PI) * 0.25;
        ca.group.position.copy(pos);
        // Upright first, then down into its place.
        ca.group.rotation.z = startRot * (1 - easeInOut(clamp01(p / 0.55)));
        this.updateLiquid(ca);
      },
      done: () => this.place(ca),
    };
    this.enqueue([a, b], [lift, travel, pour, back]);
  }

  /* ---- bolts ---- */

  // Spins a column's nuts up off the top of the bolt (`up`, the top `count`
  // nuts, top first) or back down onto it (`down`, the lowest first). They
  // turn only while on the thread.
  screwSteps(col, dir, count, { speed = 1 } = {}) {
    let plan = [];
    let D = 0;
    let S = 0;
    const step = {
      init: () => {
        const n = col.nuts.length;
        plan = [];
        // A nut uncovered while the column was busy shows its colour now.
        const codes = this.view?.cols[col.i];
        if (codes && codes.length === n) col.nuts.forEach((mesh, k) => this.paintNut(mesh, codes[k]));
        if (dir === "up") {
          const c = Math.min(count, n);
          for (let m = 0; m < c; m++) {
            const k = n - 1 - m;
            plan.push({ mesh: col.nuts[k], to: this.hoverY(k - (n - c)) });
          }
        } else {
          for (let j = 0; j < col.raised; j++) {
            const k = n - col.raised + j;
            plan.push({ mesh: col.nuts[k], to: this.slotY(k) });
          }
        }
        for (const item of plan) {
          if (item.mesh.parent !== col.group) col.group.attach(item.mesh);
          item.from = item.mesh.position.y;
          item.rot0 = item.mesh.rotation.y;
          const threaded = Math.abs(Math.min(item.to, this.columnHeight) - Math.min(item.from, this.columnHeight));
          const turn = (threaded / PITCH) * Math.PI * 2 * (dir === "up" ? 1 : -1);
          item.rot1 = squareTurn(item.rot0 + turn);
        }
        D = T.unscrew / speed;
        S = D * 0.6;
        step.dur = plan.length ? D + S * (plan.length - 1) : 0;
      },
      update: (p) => {
        const t = p * step.dur;
        plan.forEach((item, m) => {
          const q = step.dur ? clamp01((t - m * S) / D) : 1;
          const y = lerp(item.from, item.to, easeInOut(q));
          item.mesh.position.set(0, y, 0);
          // How far along the thread it is, for how far it has turned.
          const a = Math.min(item.from, this.columnHeight);
          const b = Math.min(item.to, this.columnHeight);
          const f = Math.abs(b - a) < 1e-6 ? 1 : clamp01((Math.min(y, this.columnHeight) - a) / (b - a));
          item.mesh.rotation.y = lerp(item.rot0, item.rot1, f);
        });
      },
      done: () => {
        col.raised = dir === "up" ? plan.length : 0;
      },
    };
    return step;
  }

  enqueueScrew(i, dir, count = 0) {
    this.enqueue([i], [this.screwSteps(this.cols[i], dir, count)]);
  }

  enqueueNuts(a, b, n, fast) {
    const ca = this.cols[a];
    const cb = this.cols[b];
    const ctx = { ok: false, moving: [], starts: [], base: 0 };
    const speed = fast ? 3 : 1;
    const up = this.screwSteps(ca, "up", n, { speed });
    const ready = {
      init: () => {
        ctx.ok = ca.nuts.length >= n;
        // Raised already from being picked: none of this is needed.
        ready.skip = !ctx.ok || ca.raised >= n;
        if (!ready.skip && ca.raised > 0) {
          // Raised by a different count: back down first.
          ready.down = this.screwSteps(ca, "down", 0, { speed });
          ready.down.init();
        } else ready.down = null;
        ready.dur = ready.down?.dur ?? 0;
      },
      update: (p) => ready.down?.update(p),
      done: () => ready.down?.done(),
    };
    const raise = {
      init: () => {
        if (ready.skip) {
          raise.dur = 0;
          return;
        }
        up.init();
        raise.dur = up.dur;
      },
      update: (p) => !ready.skip && up.update(p),
      done: () => !ready.skip && up.done(),
    };
    // One nut at a time, the topmost first: it glides, not turning, to
    // above the other bolt, stops, and spins down it. The next one sets off
    // once the one before has started down. Any raised nuts that stay (the
    // other bolt had less room) spin back down once the last has gone.
    const transfer = {
      init: () => {
        if (!ctx.ok) {
          transfer.dur = 0;
          return;
        }
        const len = ca.nuts.length;
        const base = cb.nuts.length;
        const colTop = cb.home.y + this.columnHeight;
        const hover = cb.home.clone().add(new THREE.Vector3(0, this.hoverY(0), 0));
        const D = T.screw / speed;
        const first = new THREE.Vector3();
        ca.nuts[len - 1].getWorldPosition(first);
        const G = fast ? T.fast : T.glide + Math.min(320, first.distanceTo(hover) * 70);
        const gap = G + D * (fast ? 0.3 : 0.45);
        ctx.base = base;
        ctx.moving = ca.nuts.slice(len - n).reverse(); // topmost first
        ctx.plan = ctx.moving.map((mesh, m) => {
          const start = new THREE.Vector3();
          mesh.getWorldPosition(start);
          this.scene.attach(mesh);
          const slotY = cb.home.y + this.slotY(base + m);
          const threaded = colTop - slotY;
          const rot0 = mesh.rotation.y;
          return { mesh, start, slotY, t0: m * gap, rot0, rot1: squareTurn(rot0 - (threaded / PITCH) * Math.PI * 2) };
        });
        // Raised nuts staying on this bolt, bottom first.
        const stayFrom = len - Math.max(ca.raised, n);
        const tLeft = (n - 1) * gap + G;
        ctx.staying = ca.nuts.slice(stayFrom, len - n).map((mesh, j) => {
          const k = stayFrom + j;
          const from = mesh.position.y;
          const threaded = this.columnHeight - Math.min(this.slotY(k), this.columnHeight);
          const rot0 = mesh.rotation.y;
          return { mesh, from, to: this.slotY(k), t0: tLeft + j * D * 0.6, rot0, rot1: squareTurn(rot0 - (threaded / PITCH) * Math.PI * 2) };
        });
        ctx.G = G;
        ctx.D = D;
        ctx.hover = hover;
        ctx.colTop = colTop;
        const lastStay = ctx.staying.length ? ctx.staying[ctx.staying.length - 1].t0 + D : 0;
        transfer.dur = Math.max((n - 1) * gap + G + D, lastStay);
      },
      update: (p) => {
        if (!ctx.ok) return;
        const t = p * transfer.dur;
        const { G, D, hover, colTop } = ctx;
        for (const item of ctx.plan) {
          const local = t - item.t0;
          if (local <= 0) {
            item.mesh.position.copy(item.start);
          } else if (local < G) {
            const e = easeInOut(local / G);
            const pos = item.start.clone().lerp(hover, e);
            pos.y += Math.sin(e * Math.PI) * 0.3;
            // Forward, in front of any bolt on the way.
            pos.z += Math.sin(e * Math.PI) * 0.7;
            item.mesh.position.copy(pos);
            item.mesh.rotation.y = item.rot0;
          } else {
            const q = clamp01((local - G) / D);
            const y = lerp(hover.y, item.slotY, easeInOut(q));
            item.mesh.position.set(hover.x, y, 0);
            const f = colTop - item.slotY < 1e-6 ? 1 : clamp01((colTop - Math.min(y, colTop)) / (colTop - item.slotY));
            item.mesh.rotation.y = lerp(item.rot0, item.rot1, f);
          }
        }
        for (const item of ctx.staying) {
          const q = clamp01((t - item.t0) / D);
          const y = lerp(item.from, item.to, easeInOut(q));
          item.mesh.position.set(0, y, 0);
          const top = this.columnHeight;
          const a = Math.min(item.from, top);
          const f = Math.abs(a - item.to) < 1e-6 ? 1 : clamp01((a - Math.min(y, top)) / (a - item.to));
          item.mesh.rotation.y = lerp(item.rot0, item.rot1, f);
        }
      },
      done: () => {
        if (!ctx.ok) return;
        ca.nuts.splice(ca.nuts.length - n, n);
        ca.raised = 0;
        ctx.moving.forEach((mesh, m) => {
          cb.group.attach(mesh);
          mesh.position.set(0, this.slotY(ctx.base + m), 0);
        });
        cb.nuts.push(...ctx.moving);
        cb.raised = 0;
      },
    };
    this.enqueue([a, b], [ready, raise, transfer]);
  }

  /* ---- both ---- */

  enqueueMove({ a, b, n, fast }) {
    if (!this.cols[a] || !this.cols[b] || a === b || !(n > 0)) return;
    if (this.mode === "water") this.enqueuePour(a, b, n, Boolean(fast));
    else this.enqueueNuts(a, b, n, Boolean(fast));
  }

  // The cork or cap goes on: down from above, settling into place.
  enqueueLid(i) {
    const col = this.cols[i];
    const lid = this.mode === "water" ? col.parts.cork : col.parts.cap;
    this.enqueue([i], [
      {
        dur: T.capIn,
        init: () => {
          lid.visible = true;
        },
        update: (p) => {
          lid.position.y = lid.userData.y + (1 - easeOutBack(p)) * 0.6;
          lid.scale.setScalar(lerp(0.6, 1, easeOut(p)));
        },
        done: () => {
          lid.position.y = lid.userData.y;
          lid.scale.setScalar(1);
          this.firePendingPulse(i);
        },
      },
    ]);
  }

  /* ---- pulses ---- */

  pulse(cols, kind) {
    if (reducedMotion()) return;
    for (const i of cols) {
      if (!this.cols[i]) continue;
      // A finished column pops once it is closed, not while still filling.
      if (kind === "done" && this.busy(i)) this.pendingPulse.add(i);
      else this.startPulse(i, kind);
    }
  }

  firePendingPulse(i) {
    if (!this.pendingPulse.delete(i)) return;
    this.startPulse(i, "done");
  }

  startPulse(i, kind) {
    const col = this.cols[i];
    const g = col.group;
    const start = performance.now();
    const dur = kind === "bad" ? 320 : 420;
    this.fx.push({
      start,
      dur,
      step: (p) => {
        if (kind === "bad") g.position.x = col.home.x + Math.sin(p * Math.PI * 6) * 0.08 * (1 - p);
        else g.scale.setScalar(1 + Math.sin(p * Math.PI) * 0.06);
      },
      done: () => {
        if (kind === "bad") g.position.x = col.home.x;
        g.scale.setScalar(1);
      },
    });
    this.kick();
  }

  /* ---- frames ---- */

  kick() {
    if (this.frame === null) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  tick(now) {
    this.frame = null;
    // A frame after a long gap (a hidden tab) moves on by one frame's worth.
    const dt = this.lastTick ? Math.min(50, Math.max(0, now - this.lastTick)) : 16;
    this.lastTick = now;

    for (const job of [...this.jobs]) {
      if (!this.jobs.includes(job)) continue;
      if (job.k < 0) {
        if (!this.canStart(job)) continue;
        this.startJob(job);
      }
      // Work queued behind a job plays it faster, to catch up.
      const behind = this.jobs.filter((o) => o !== job && o.k < 0 && o.cols.some((c) => job.cols.includes(c))).length;
      job.t += dt * Math.min(3, 1 + behind * 0.8);
      if (this.advance(job)) this.endJob(job);
    }

    const live = [];
    for (const fx of this.fx) {
      const p = clamp01((now - fx.start) / fx.dur);
      fx.step(p);
      if (p >= 1) fx.done();
      else live.push(fx);
    }
    this.fx = live;

    this.renderer.render(this.scene, this.camera);
    if (this.jobs.length || this.fx.length) this.kick();
    else this.lastTick = 0;
    if (!this.jobs.length && this.idleWaiters?.length) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  // Resolves once every queued move has played out.
  idle() {
    if (!this.jobs.length) return Promise.resolve();
    this.idleWaiters ??= [];
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  draw() {
    this.kick();
  }

  /* ---- which column is under a point on screen ---- */

  columnAt(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.plane, hit)) return null;
    let best = null;
    let bestD = Infinity;
    this.cols.forEach((col, i) => {
      const home = col.home;
      const dx = Math.abs(hit.x - home.x);
      const bottom = home.y - 0.4;
      const top = home.y + this.cell.h - 0.2;
      if (dx > this.cell.w / 2 || hit.y < bottom || hit.y > top) return;
      if (dx < bestD) {
        bestD = dx;
        best = i;
      }
    });
    return best;
  }
}
