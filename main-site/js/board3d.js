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
// drawn on demand and while a move animates, never in an idle loop.

import * as THREE from "three";
import { COLOURS, HIDDEN, SYMBOLS } from "./palette.js";
import { cellSize, layoutFor, placeOf } from "./board.js";
import { colourOfUnit, isComplete, isHiddenUnit, runLength } from "./puzzle.js";
import { reducedMotion } from "./ui.js";

const TILT = (14 * Math.PI) / 180; // the camera looks down this far
const MOVE_MS = 520;
const FAST_MS = 140;

const WATER = { uh: 0.5, r: 0.34, liquid: 0.3 };
const BOLT = { uh: 0.4, nut: 0.4, shaft: 0.12 };

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

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

export class Board3D {
  constructor(host) {
    this.host = host;
    this.view = null;
    this.mode = null;
    this.groups = []; // one THREE.Group per column
    this.units = []; // meshes per column, bottom first
    this.tweens = [];
    this.frame = null;
    this.focus = -1;
    this.layout = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
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
      liquid: new THREE.CylinderGeometry(WATER.liquid, WATER.liquid, WATER.uh, 32, 1, true).translate(0, WATER.uh / 2, 0),
      liquidBottom: this.roundedLiquid(),
      liquidTop: new THREE.CircleGeometry(WATER.liquid, 32).rotateX(-Math.PI / 2),
      cork: new THREE.CylinderGeometry(WATER.r * 0.95, WATER.r * 0.8, 0.22, 24).translate(0, 0.11, 0),
      halo: new THREE.PlaneGeometry(1, 1),
      stream: new THREE.CylinderGeometry(0.05, 0.05, 1, 10).translate(0, -0.5, 0),
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

  roundedLiquid() {
    const r = WATER.liquid;
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const a = -Math.PI / 2 + (k / 10) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, r * Math.cos(a)), r + r * Math.sin(a)));
    }
    pts.push(new THREE.Vector2(r, WATER.uh));
    return new THREE.LatheGeometry(pts, 32);
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
      const side = new THREE.MeshStandardMaterial({
        map: symbolTexture(colour, repeats, hidden || this.view.symbols),
        roughness: this.mode === "bolts" ? 0.45 : 0.25,
        metalness: this.mode === "bolts" ? 0.1 : 0,
        flatShading: this.mode === "bolts",
      });
      const top = new THREE.MeshStandardMaterial({ color: colour.hex, roughness: 0.35, flatShading: this.mode === "bolts" });
      this.colourMats.set(key, { side, top });
    }
    return this.colourMats.get(key);
  }

  /* ---- building ---- */

  setup(view) {
    this.finishAll();
    for (const g of this.groups) this.scene.remove(g);
    this.groups = [];
    this.units = [];
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
    if (view.mode === "water") {
      const h = view.cap * WATER.uh + 0.3;
      this.tubeGeo = this.tubeGeometry(h, WATER.r);
      this.rimGeo = this.tubeGeometry(h, WATER.r + 0.035);
      this.columnHeight = h;
    } else {
      const h = view.cap * BOLT.uh + 0.35;
      this.shaftGeo = new THREE.CylinderGeometry(BOLT.shaft, BOLT.shaft, h, 16, 1, true).translate(0, h / 2, 0);
      this.threads.repeat.set(1, view.cap * 3);
      this.columnHeight = h;
    }
    this.symbols = view.symbols;
    this.ensureColumns(view.cols.length);
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
      parts.cork.position.y = this.columnHeight - 0.08;
      parts.cork.visible = false;
      group.add(parts.rim, parts.glass, parts.cork);
    } else {
      parts.base = new THREE.Mesh(this.geo.base, this.mats.metal);
      parts.base.position.y = -0.06;
      parts.shaft = new THREE.Mesh(this.shaftGeo, this.mats.shaft);
      parts.knob = new THREE.Mesh(this.geo.knob, this.mats.metal);
      parts.knob.position.y = this.columnHeight;
      parts.cap = new THREE.Mesh(this.geo.cap, this.mats.metal);
      parts.cap.position.y = this.cap * BOLT.uh;
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
    group.userData.parts = parts;
    group.userData.lift = 0;
    this.scene.add(group);
    return group;
  }

  ensureColumns(count) {
    while (this.groups.length < count) {
      this.groups.push(this.makeColumn(this.groups.length));
      this.units.push([]);
    }
    while (this.groups.length > count) {
      const g = this.groups.pop();
      this.scene.remove(g);
      this.units.pop();
    }
    this.relayout();
  }

  relayout() {
    const count = this.groups.length;
    if (!count) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const layout = layoutFor(count, this.cell, w, h);
    this.layout = layout;
    const worldW = layout.perRow * this.cell.w;
    const worldH = layout.rows * this.cell.h;
    this.groups.forEach((g, i) => {
      const p = placeOf(i, count, layout);
      const x = (p.col - (p.inRow - 1) / 2) * this.cell.w;
      const y = worldH / 2 - (p.row + 1) * this.cell.h + 0.35;
      g.userData.home = new THREE.Vector3(x, y, 0);
      g.position.set(x, y + g.userData.lift, 0);
    });
    // Fit the camera round the board, with a margin for lifted pieces.
    const aspect = w / h;
    let halfW = (worldW / 2) * 1.04;
    let halfH = (worldH / 2) * 1.1;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    const d = 20;
    this.camera.position.set(0, Math.sin(TILT) * d, Math.cos(TILT) * d);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.relayout();
  }

  /* ---- units ---- */

  slotY(k) {
    return this.mode === "water" ? 0.04 + k * WATER.uh : k * BOLT.uh;
  }

  makeUnit(code, k) {
    const m = this.materialFor(code);
    let mesh;
    if (this.mode === "water") {
      mesh = new THREE.Mesh(k === 0 ? this.geo.liquidBottom : this.geo.liquid, m.side);
      const surface = new THREE.Mesh(this.geo.liquidTop, m.top);
      surface.position.y = WATER.uh;
      mesh.add(surface);
      mesh.userData.surface = surface;
    } else {
      mesh = new THREE.Mesh(this.geo.nut, [m.side, m.top, m.top]);
    }
    mesh.userData.code = code;
    mesh.userData.slot = k;
    return mesh;
  }

  paintUnit(mesh, code) {
    if (mesh.userData.code === code && mesh.userData.symbols === this.view.symbols) return;
    mesh.userData.code = code;
    mesh.userData.symbols = this.view.symbols;
    const m = this.materialFor(code);
    if (this.mode === "water") {
      mesh.material = m.side;
      mesh.userData.surface.material = m.top;
    } else mesh.material = [m.side, m.top, m.top];
  }

  rebuildColumn(i, codes) {
    const g = this.groups[i];
    for (const mesh of this.units[i]) g.remove(mesh);
    this.units[i] = codes.map((code, k) => {
      const mesh = this.makeUnit(code, k);
      mesh.position.y = this.slotY(k);
      g.add(mesh);
      return mesh;
    });
  }

  /* ---- drawing a view ---- */

  render(view, change) {
    this.finishAll();
    const symbolsChanged = this.symbols !== view.symbols;
    this.symbols = view.symbols;
    this.view = view;
    this.ensureColumns(view.cols.length);
    if (change && !reducedMotion() && this.animateChange(change)) {
      // The rest of the view settles once the move lands.
    }
    view.cols.forEach((codes, i) => {
      const meshes = this.units[i];
      const moving = this.tweens.some((t) => t.column === i);
      if (moving) return;
      if (meshes.length !== codes.length) this.rebuildColumn(i, codes);
      else {
        meshes.forEach((mesh, k) => {
          this.paintUnit(mesh, codes[k]);
          if (symbolsChanged) mesh.userData.symbols = null;
          mesh.userData.slot = k;
          mesh.position.y = this.slotY(k);
          mesh.position.x = 0;
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);
          if (this.mode === "water") mesh.geometry = k === 0 ? this.geo.liquidBottom : this.geo.liquid;
        });
      }
    });
    this.dress(view);
    this.draw();
  }

  // Lifting the picked column, haloes, finished caps.
  dress(view) {
    this.groups.forEach((g, i) => {
      const p = g.userData.parts;
      const codes = view.cols[i] ?? [];
      const done = isComplete(codes, this.cap);
      const picked = view.selected === i;
      const hint = view.hint && (view.hint.a === i || view.hint.b === i);
      const target = view.target === i;
      p.halo.visible = Boolean(hint || target);
      p.halo.material = target ? this.mats.target : this.mats.hint;
      p.focus.visible = this.focus === i;
      if (this.mode === "water") {
        p.cork.visible = done;
        g.userData.lift = picked ? 0.35 : 0;
        if (!this.tweens.some((t) => t.group === g)) g.position.y = g.userData.home.y + g.userData.lift;
      } else {
        p.cap.visible = done;
        if (done) p.cap.material = this.materialFor(codes[codes.length - 1]).top;
        // A picked bolt's top nuts rise off the end of it.
        const run = picked ? Math.max(1, view.liftCount ?? runLength(codes)) : 0;
        const meshes = this.units[i];
        if (!this.tweens.some((t) => t.column === i)) {
          meshes.forEach((mesh, k) => {
            const lifted = k >= meshes.length - run;
            const over = this.columnHeight + 0.25 + (k - (meshes.length - run)) * BOLT.uh;
            mesh.position.y = lifted ? over : this.slotY(k);
          });
        }
      }
    });
  }

  setFocus(i) {
    this.focus = i;
    if (this.view) this.dress(this.view);
    this.draw();
  }

  /* ---- animation ---- */

  animateChange({ a, b, n, fast }) {
    const from = this.units[a];
    const to = this.units[b];
    if (!from || !to || n <= 0 || from.length < n) return false;
    const dur = fast ? FAST_MS : MOVE_MS;
    return this.mode === "water" ? this.pour(a, b, n, dur, fast) : this.flyNuts(a, b, n, dur);
  }

  flyNuts(a, b, n, dur) {
    const ga = this.groups[a];
    const gb = this.groups[b];
    const moving = this.units[a].splice(this.units[a].length - n, n);
    const base = this.units[b].length;
    this.units[b].push(...moving);
    const overA = this.columnHeight + 0.3;
    const overB = this.columnHeight + 0.3;
    moving.forEach((mesh, k) => {
      const start = new THREE.Vector3();
      mesh.getWorldPosition(start);
      this.scene.attach(mesh);
      const slot = base + k;
      const end = gb.userData.home.clone().add(new THREE.Vector3(0, this.slotY(slot), 0));
      const upA = ga.userData.home.clone().add(new THREE.Vector3(0, overA + k * BOLT.uh, 0));
      const upB = gb.userData.home.clone().add(new THREE.Vector3(0, overB + k * BOLT.uh, 0));
      this.tweens.push({
        column: b,
        start: performance.now() + (n - 1 - k) * (dur * 0.06),
        dur,
        step: (p) => {
          let pos;
          if (p < 0.3) pos = start.clone().lerp(upA, ease(p / 0.3));
          else if (p < 0.7) {
            const q = ease((p - 0.3) / 0.4);
            pos = upA.clone().lerp(upB, q);
            pos.y += Math.sin(q * Math.PI) * 0.35;
          } else pos = upB.clone().lerp(end, ease((p - 0.7) / 0.3));
          mesh.position.copy(pos);
          mesh.rotation.y = p * Math.PI * 2;
        },
        done: () => {
          mesh.rotation.y = 0;
          gb.attach(mesh);
          mesh.position.set(0, this.slotY(slot), 0);
        },
      });
    });
    this.tweens.push({ column: a, start: performance.now(), dur: dur * 0.3, step: () => {}, done: () => {} });
    this.kick();
    return true;
  }

  pour(a, b, n, dur, fast) {
    const ga = this.groups[a];
    const gb = this.groups[b];
    const leaving = this.units[a].splice(this.units[a].length - n, n);
    const base = this.units[b].length;
    const arriving = leaving.map((old, k) => {
      const mesh = this.makeUnit(old.userData.code, base + k);
      mesh.position.y = this.slotY(base + k);
      mesh.scale.y = 0.0001;
      gb.add(mesh);
      return mesh;
    });
    this.units[b].push(...arriving);
    const home = ga.userData.home.clone();
    const right = gb.userData.home.x >= home.x;
    const over = gb.userData.home.clone().add(new THREE.Vector3(right ? -0.55 : 0.55, this.columnHeight * 0.55 + 0.4, 0.4));
    const tilt = right ? -1.15 : 1.15;
    const colour = leaving[0] ? this.materialFor(leaving[0].userData.code).top : null;
    const stream = colour && !fast ? new THREE.Mesh(this.geo.stream, colour) : null;
    if (stream) {
      stream.visible = false;
      this.scene.add(stream);
    }
    const startLift = ga.userData.lift;
    const moveOut = fast ? 0 : 0.3;
    const moveBack = fast ? 1 : 0.78;
    this.tweens.push({
      column: a,
      group: ga,
      start: performance.now(),
      dur,
      step: (p) => {
        if (!fast) {
          let q;
          if (p < moveOut) q = ease(p / moveOut);
          else if (p < moveBack) q = 1;
          else q = 1 - ease((p - moveBack) / (1 - moveBack));
          const lifted = home.clone().add(new THREE.Vector3(0, startLift, 0));
          ga.position.copy(lifted.lerp(over, q));
          ga.rotation.z = tilt * q;
        }
        const pour = Math.min(1, Math.max(0, (p - moveOut) / (moveBack - moveOut)));
        leaving.forEach((mesh) => (mesh.scale.y = Math.max(0.0001, 1 - pour)));
        arriving.forEach((mesh) => (mesh.scale.y = Math.max(0.0001, pour)));
        if (stream) {
          stream.visible = pour > 0 && pour < 1;
          const mouth = new THREE.Vector3(0, this.columnHeight, 0);
          ga.localToWorld(mouth);
          const into = gb.userData.home.clone().add(new THREE.Vector3(0, this.slotY(base + n) + 0.05, 0));
          // Straight down from the height of the mouth into the target.
          stream.position.set(into.x, mouth.y, into.z);
          stream.scale.set(1, Math.max(0.01, mouth.y - into.y), 1);
        }
      },
      done: () => {
        for (const mesh of leaving) ga.remove(mesh);
        if (stream) this.scene.remove(stream);
        ga.rotation.z = 0;
        ga.position.copy(home).add(new THREE.Vector3(0, ga.userData.lift, 0));
        arriving.forEach((mesh) => (mesh.scale.y = 1));
      },
    });
    this.tweens.push({ column: b, start: performance.now(), dur, step: () => {}, done: () => {} });
    this.kick();
    return true;
  }

  pulse(cols, kind) {
    if (reducedMotion()) return;
    for (const i of cols) {
      const g = this.groups[i];
      if (!g) continue;
      const home = g.userData.home.clone();
      this.tweens.push({
        start: performance.now(),
        dur: kind === "bad" ? 320 : 420,
        pulse: true,
        step: (p) => {
          if (kind === "bad") g.position.x = home.x + Math.sin(p * Math.PI * 6) * 0.08 * (1 - p);
          else g.scale.setScalar(1 + Math.sin(p * Math.PI) * 0.06);
        },
        done: () => {
          g.position.x = home.x;
          g.scale.setScalar(1);
        },
      });
    }
    this.kick();
  }

  // Ends every animation at its last frame, so a new move starts from where
  // the pieces really are.
  finishAll() {
    const all = this.tweens;
    this.tweens = [];
    for (const t of all) {
      t.step(1);
      t.done();
    }
  }

  kick() {
    if (this.frame === null) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  tick(now) {
    this.frame = null;
    const live = [];
    for (const t of this.tweens) {
      const p = Math.max(0, Math.min(1, (now - t.start) / t.dur));
      t.step(p);
      if (p >= 1) t.done();
      else live.push(t);
    }
    const finished = live.length < this.tweens.length;
    this.tweens = live;
    this.renderer.render(this.scene, this.camera);
    // Once a move lands, the columns it touched are checked against the
    // view: a nut it uncovered shows its colour, and lifts settle.
    if (finished && !live.length && this.view) this.render(this.view, null);
    else if (this.tweens.length) this.kick();
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
    this.groups.forEach((g, i) => {
      const home = g.userData.home;
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
