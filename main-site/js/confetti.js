// Confetti for a solved level: a burst from both bottom corners on a canvas
// laid over the whole page, gone in about three seconds. Drawn in the
// game's own piece colours, which look the same in every theme. Nothing at
// all for players who ask their system for reduced motion, the same as the
// score count-up skips its animation for them.

import { COLOURS } from "./palette.js";
import { reducedMotion } from "./ui.js";

const PIECES_PER_SIDE = 70;
const GRAVITY = 1400; // px/s²
const DRAG = 0.9; // velocity kept per second, roughly
const LIFE_MS = 3200;

let canvas = null;
let ctx = null;
let pieces = [];
let frame = 0;
let lastT = 0;

function makeCanvas() {
  canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  ctx = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function teardown() {
  cancelAnimationFrame(frame);
  window.removeEventListener("resize", resize);
  canvas?.remove();
  canvas = ctx = null;
  pieces = [];
}

function spawn(fromLeft, now) {
  const w = innerWidth;
  const h = innerHeight;
  // Fast enough to reach about the top third of the screen, whatever its size.
  const speed = Math.sqrt(2 * GRAVITY * h * 0.75);
  for (let i = 0; i < PIECES_PER_SIDE; i++) {
    const angle = ((fromLeft ? -62 : -118) + (Math.random() - 0.5) * 34) * (Math.PI / 180);
    const v = speed * (0.55 + Math.random() * 0.6);
    const colour = COLOURS[Math.floor(Math.random() * COLOURS.length)].hex;
    pieces.push({
      x: fromLeft ? -10 : w + 10,
      y: h + 10,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 14,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 6 + Math.random() * 8,
      round: Math.random() < 0.25,
      colour,
      born: now,
    });
  }
}

function step(t) {
  const dt = Math.min((t - lastT) / 1000, 1 / 20);
  lastT = t;
  const keep = Math.pow(DRAG, dt);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  pieces = pieces.filter((p) => t - p.born < LIFE_MS && p.y < innerHeight + 40);
  for (const p of pieces) {
    p.vy += GRAVITY * dt * (p.vy > 0 ? 0.35 : 1); // flutters down slower than it flew up
    p.vx *= keep;
    p.vy *= p.vy > 0 ? Math.pow(0.4, dt) : keep;
    p.x += p.vx * dt + Math.sin(p.flip) * 20 * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;
    p.flip += p.flipSpeed * dt;
    const age = (t - p.born) / LIFE_MS;
    ctx.save();
    ctx.globalAlpha = age > 0.75 ? Math.max(0, (1 - age) / 0.25) : 1;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(1, Math.cos(p.flip)); // turning over in the air
    ctx.fillStyle = p.colour;
    if (p.round) {
      ctx.beginPath();
      ctx.arc(0, 0, p.h * 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }
  if (pieces.length) frame = requestAnimationFrame(step);
  else teardown();
}

// Fire one celebration. Calling it again while one is still falling adds to it.
export function celebrate() {
  if (reducedMotion() || document.hidden) return;
  if (!canvas) makeCanvas();
  const now = performance.now();
  spawn(true, now);
  spawn(false, now);
  cancelAnimationFrame(frame);
  lastT = now;
  frame = requestAnimationFrame(step);
}
