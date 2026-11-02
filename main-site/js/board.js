// The board on screen. The flat board is a row of buttons, one per tube or
// bolt, drawn in CSS. The 3D board (js/board3d.js, three.js) draws the same
// columns as glass tubes or threaded bolts and is loaded only when needed.
//
// The flat buttons are always there: in 3D they are invisible but still
// take keyboard focus and screen readers, and the 3D board rings whichever
// has focus. So the keyboard and assistive tech work the same in both views,
// and where WebGL is missing the flat board is simply what shows.
//
// Input is handled here, once, for both views: tap a column then another,
// or drag (swipe) from one to the other. Every touch on the board is the
// game's: touch-action is none and pointer events are captured, so a swipe
// never scrolls the page, pulls to refresh or selects text.
//
// The board knows nothing about the rules. It is told what is in each
// column and which column is picked up, and it says which columns somebody
// pointed at.

import { COLOURS, SYMBOLS, colourOf } from "./palette.js";
import { MODES } from "./rules.js";
import { colourOfUnit, isComplete, isHiddenUnit } from "./puzzle.js";
import { escapeHtml } from "./ui.js";

const DRAG_PX = 12;

// World size of one column's cell, for laying columns out in rows. The
// flat board uses the same proportions so both views lay out alike.
export function cellSize(mode, cap) {
  return mode === "bolts" ? { w: 1.3, h: cap * 0.4 + 0.75 } : { w: 1.15, h: cap * 0.5 + 0.7 };
}

// How many rows `count` columns go in, to make them as large as the box
// allows. Returns rows and how many go in each, the last row fewer.
export function layoutFor(count, cell, width, height) {
  let best = { rows: 1, perRow: count, scale: 0 };
  for (let rows = 1; rows <= 4; rows++) {
    const perRow = Math.ceil(count / rows);
    if (rows > 1 && perRow * (rows - 1) >= count) break;
    const scale = Math.min(width / (perRow * cell.w), height / (rows * cell.h));
    if (scale > best.scale * 1.04) best = { rows, perRow, scale };
  }
  return best;
}

// Which row and place in it column i takes, rows centred.
export function placeOf(i, count, layout) {
  const row = Math.floor(i / layout.perRow);
  const inRow = row === layout.rows - 1 ? count - layout.perRow * (layout.rows - 1) : layout.perRow;
  return { row, col: i % layout.perRow, inRow };
}

export const symbolSvg = (symbol, cls = "sym") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${SYMBOLS[symbol]}"/></svg>`;

// "Tube 3: red, red, blue, from the top" for screen readers.
export function describeColumn(view, i) {
  const mode = MODES[view.mode];
  const col = view.cols[i] ?? [];
  const name = `${mode.column.charAt(0).toUpperCase()}${mode.column.slice(1)} ${i + 1}`;
  if (!col.length) return `${name}: empty`;
  const parts = [...col].reverse().map((u) => (isHiddenUnit(u) ? "hidden" : COLOURS[view.palette[colourOfUnit(u)]].label.toLowerCase()));
  const done = isComplete(col, view.cap) ? ", finished" : "";
  return `${name}${done}: ${parts.join(", ")}, from the top`;
}

/* ---- the flat board ---- */

class FlatBoard {
  constructor(host) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "flat-board";
    this.el.setAttribute("role", "group");
    host.append(this.el);
    this.buttons = [];
    this.view = null;
    this.count = 0;
  }

  setup(view) {
    this.el.innerHTML = "";
    this.buttons = [];
    this.el.dataset.mode = view.mode;
    this.el.setAttribute("aria-label", MODES[view.mode].columns.charAt(0).toUpperCase() + MODES[view.mode].columns.slice(1));
    this.count = 0;
    this.view = null;
  }

  relayout() {
    if (!this.view) return;
    const { mode, cap } = this.view;
    const cell = cellSize(mode, cap);
    const box = this.host.getBoundingClientRect();
    const layout = layoutFor(this.count, cell, Math.max(1, box.width), Math.max(1, box.height));
    this.layout = layout;
    // One unit's height in px, from the scale the layout allows.
    const unit = Math.max(10, Math.min(56, (layout.scale * (mode === "bolts" ? 0.4 : 0.5)) | 0));
    this.el.style.setProperty("--u", `${unit}px`);
    this.el.style.setProperty("--cap", String(cap));
    this.el.style.setProperty("--per-row", String(layout.perRow));
  }

  ensureButtons(count) {
    if (count === this.count) return;
    this.count = count;
    this.el.innerHTML = "";
    this.buttons = [];
    for (let i = 0; i < count; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fcol";
      btn.dataset.i = String(i);
      btn.tabIndex = i === 0 ? 0 : -1;
      this.el.append(btn);
      this.buttons.push(btn);
    }
  }

  render(view) {
    this.view = view;
    this.ensureButtons(view.cols.length);
    this.relayout();
    const symbols = view.symbols;
    view.cols.forEach((col, i) => {
      const btn = this.buttons[i];
      const done = isComplete(col, view.cap);
      const units = col
        .map((u, k) => {
          const c = isHiddenUnit(u) ? colourOf(-1) : COLOURS[view.palette[colourOfUnit(u)]];
          const lifted = view.selected === i && k >= col.length - view.liftCount ? " lifted" : "";
          return `<span class="funit${lifted}" style="--c:${c.hex};--ci:${c.ink}">${symbols || isHiddenUnit(u) ? symbolSvg(c.symbol) : ""}</span>`;
        })
        .join("");
      btn.innerHTML = `<span class="fcol-body">${units}</span>`;
      btn.classList.toggle("selected", view.selected === i);
      btn.classList.toggle("done", done);
      btn.classList.toggle("hint", Boolean(view.hint && (view.hint.a === i || view.hint.b === i)));
      btn.classList.toggle("target", view.target === i);
      btn.setAttribute("aria-label", describeColumn(view, i) + (view.selected === i ? ", picked up" : ""));
      btn.setAttribute("aria-pressed", String(view.selected === i));
      btn.disabled = false;
      btn.setAttribute("aria-disabled", String(!view.interactive));
    });
  }

  columnAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.(".fcol");
    if (el && this.el.contains(el)) return Number(el.dataset.i);
    // Near misses go to the nearest column in the row under the finger.
    let best = null;
    let bestD = Infinity;
    for (const btn of this.buttons) {
      const r = btn.getBoundingClientRect();
      if (y < r.top - 20 || y > r.bottom + 20) continue;
      const d = Math.abs(x - (r.left + r.right) / 2);
      if (d < bestD && d < r.width) {
        bestD = d;
        best = Number(btn.dataset.i);
      }
    }
    return best;
  }

  pulse(cols, kind) {
    for (const i of cols) {
      const btn = this.buttons[i];
      if (!btn) continue;
      btn.classList.remove("pulse-bad", "pulse-done");
      void btn.offsetWidth;
      btn.classList.add(kind === "bad" ? "pulse-bad" : "pulse-done");
    }
  }
}

/* ---- the board, in either view ---- */

export class Board {
  constructor(host, { onPick = null, onDrop = null, onDragStart = null, onFallback = null } = {}) {
    this.host = host;
    this.host.classList.add("board-host");
    this.flat = new FlatBoard(host);
    this.three = null;
    this.want3d = true;
    this.loading = null;
    this.failed = false;
    this.onPick = onPick;
    this.onDrop = onDrop;
    this.onDragStart = onDragStart;
    this.onFallback = onFallback;
    this.view = null;
    this.focused = -1;
    this.drag = null;

    host.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    host.addEventListener("pointermove", (e) => this.onPointerMove(e));
    host.addEventListener("pointerup", (e) => this.onPointerUp(e));
    host.addEventListener("pointercancel", () => this.cancelDrag());
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    // Keyboard: arrows move between columns, Enter or Space picks one.
    this.flat.el.addEventListener("click", (e) => {
      // Pointer clicks are handled on pointerup; this is the keyboard's.
      if (e.detail !== 0) return;
      const btn = e.target.closest(".fcol");
      if (btn && this.view?.interactive) this.onPick?.(Number(btn.dataset.i));
    });
    this.flat.el.addEventListener("keydown", (e) => this.onKey(e));
    this.flat.el.addEventListener("focusin", (e) => {
      const btn = e.target.closest(".fcol");
      this.focused = btn ? Number(btn.dataset.i) : -1;
      // Ringed in 3D only when the keyboard put it there.
      this.three?.setFocus(btn?.matches(":focus-visible") ? this.focused : -1);
    });
    this.flat.el.addEventListener("focusout", () => {
      this.focused = -1;
      this.three?.setFocus(-1);
    });
    this.resizer = new ResizeObserver(() => {
      this.flat.relayout();
      if (this.is3d) this.three.resize();
    });
    this.resizer.observe(host);
  }

  get is3d() {
    return Boolean(this.three) && this.want3d;
  }

  // Flat or 3D, from the settings. 3D loads three.js the first time.
  async setView(want3d) {
    this.want3d = want3d && !this.failed;
    this.host.classList.toggle("is-3d", this.want3d && Boolean(this.three));
    if (!this.want3d || this.three) {
      // Back to 3D: the 3D board may still hold another level.
      if (this.want3d && this.view) {
        this.three.setup(this.view);
        this.three.resize();
      }
      if (this.view) this.render(this.view);
      return;
    }
    this.loading ??= import("./board3d.js")
      .then(({ Board3D }) => {
        this.three = new Board3D(this.host);
        return true;
      })
      .catch((err) => {
        console.warn("3D board unavailable, playing flat:", err);
        this.failed = true;
        this.want3d = false;
        this.onFallback?.();
        return false;
      });
    const ok = await this.loading;
    this.host.classList.toggle("is-3d", ok && this.want3d);
    if (ok && this.view && this.want3d) {
      this.three.setup(this.view);
      this.three.resize();
      this.three.render(this.view, null);
    }
  }

  setup(view) {
    this.cancelDrag();
    this.view = view;
    this.flat.setup(view);
    if (this.is3d) this.three.setup(view);
    this.render(view);
  }

  // `change` animates the 3D board: { a, b, n, fast } for units going from
  // a to b. Without it the board just shows the columns as they are.
  render(view, change = null) {
    this.view = view;
    this.flat.render(view);
    if (this.is3d) this.three.render(view, change);
  }

  pulse(cols, kind) {
    this.flat.pulse(cols, kind);
    if (this.is3d) this.three.pulse(cols, kind);
  }

  focus() {
    const btn = this.flat.buttons[Math.max(0, this.focused)] ?? this.flat.buttons[0];
    btn?.focus({ preventScroll: true });
  }

  columnAt(x, y) {
    return this.is3d ? this.three.columnAt(x, y) : this.flat.columnAt(x, y);
  }

  /* ---- pointer: tap, or drag from one column to another ---- */

  onPointerDown(e) {
    if (!this.view?.interactive || (e.pointerType === "mouse" && e.button !== 0)) return;
    const a = this.columnAt(e.clientX, e.clientY);
    // Every touch on the board is the game's, column or not.
    e.preventDefault();
    if (a === null) {
      this.drag = { a: null, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
      return;
    }
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    this.drag = { a, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, target: null };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    if (d.a === null) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) {
      d.moved = true;
      this.onDragStart?.(d.a);
    }
    if (!d.moved) return;
    const t = this.columnAt(e.clientX, e.clientY);
    const target = t === d.a ? null : t;
    if (target !== d.target) {
      d.target = target;
      if (this.view) this.render({ ...this.view, target });
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    this.drag = null;
    if (this.view?.target != null) this.render({ ...this.view, target: null });
    if (d.a === null) {
      this.onPick?.(null);
      return;
    }
    const b = this.columnAt(e.clientX, e.clientY);
    if (!d.moved) this.onPick?.(d.a);
    else if (b !== null && b !== d.a) this.onDrop?.(d.a, b);
    else this.onDrop?.(d.a, null);
  }

  cancelDrag() {
    this.drag = null;
  }

  onKey(e) {
    const btn = e.target.closest(".fcol");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const n = this.flat.buttons.length;
    const per = this.flat.layout?.perRow ?? n;
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - per, ArrowDown: i + per, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) {
      if (e.key === "Escape" && this.view?.selected !== null && this.view?.selected !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        this.onPick?.(null);
      }
      return;
    }
    e.preventDefault();
    const to = Math.max(0, Math.min(n - 1, next));
    this.flat.buttons.forEach((b, k) => (b.tabIndex = k === to ? 0 : -1));
    this.flat.buttons[to].focus();
  }
}

export const describeUnit = (palette, u) => (isHiddenUnit(u) ? "hidden" : COLOURS[palette[colourOfUnit(u)]].label);
export { escapeHtml };
