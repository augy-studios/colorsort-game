// Seeds: a short code that decides a level, so the same code deals the same
// columns again. Written "WE12-BXK4-M9TR": the mode (W water, B bolts), the
// difficulty (E, M, H), the level number, and eight characters after the
// dash that are the seed proper. The level is part of the seed because it
// decides how many colours there are. Pure, so the API and Node use it too.
//
// Integer arithmetic only. Math.random differs between browsers and would
// deal a different level on the server.

import { DIFFICULTIES, MAX_LEVEL, MODES } from "./rules.js";

// No vowels, and no 0 O 1 I, as for pairing codes: a seed read aloud cannot
// be misheard and cannot spell a word.
export const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
export const BODY_LENGTH = 8;

const MODE_BY_LETTER = Object.fromEntries(Object.values(MODES).map((m) => [m.letter, m.id]));
const DIFFICULTY_BY_LETTER = Object.fromEntries(Object.values(DIFFICULTIES).map((d) => [d.letter, d.id]));

const isBody = (s) => s.length === BODY_LENGTH && [...s].every((c) => ALPHABET.includes(c));
const cleanLevel = (n) => (Number.isInteger(n) && n >= 1 && n <= MAX_LEVEL ? n : null);

function build(mode, difficulty, level, body) {
  return {
    mode,
    difficulty,
    level,
    body,
    text: `${MODES[mode].letter}${DIFFICULTIES[difficulty].letter}${level}-${body.slice(0, 4)}-${body.slice(4)}`,
  };
}

// A body from any source of random bytes: crypto.getRandomValues in the
// page, node:crypto on the server. Bytes at or above `limit` would make some
// characters likelier than others.
export function randomBody(nextByte) {
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < BODY_LENGTH) {
    const byte = nextByte();
    if (byte < limit) body += ALPHABET[byte % ALPHABET.length];
  }
  return body;
}

const browserByte = () => globalThis.crypto.getRandomValues(new Uint8Array(1))[0];

export function newSeed(mode, difficulty, level, nextByte = browserByte) {
  return build(
    MODES[mode] ? mode : "water",
    DIFFICULTIES[difficulty] ? difficulty : "easy",
    cleanLevel(level) ?? 1,
    randomBody(nextByte)
  );
}

// Whatever was typed or pasted, forgiving about case, spaces and dashes.
// Eight characters with no prefix take the mode, difficulty and level from
// `fallback`. null if it is not a seed.
export function parseSeed(input, fallback = {}) {
  const raw = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // The body is always the last eight characters, so the level's digits
  // and a body starting with a digit never run together.
  const full = raw.match(/^([A-Z])([A-Z])([0-9]{1,5})([A-Z0-9]{8})$/);
  if (full) {
    const mode = MODE_BY_LETTER[full[1]];
    const difficulty = DIFFICULTY_BY_LETTER[full[2]];
    const level = cleanLevel(Number(full[3]));
    if (mode && difficulty && level && isBody(full[4]) && !full[3].startsWith("0")) return build(mode, difficulty, level, full[4]);
    return null;
  }
  if (isBody(raw)) {
    return build(
      MODES[fallback.mode] ? fallback.mode : "water",
      DIFFICULTIES[fallback.difficulty] ? fallback.difficulty : "easy",
      cleanLevel(fallback.level) ?? 1,
      raw
    );
  }
  return null;
}
