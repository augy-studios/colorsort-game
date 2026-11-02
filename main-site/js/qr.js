// A small QR encoder, so the pairing code can be scanned with no network
// and no third party script. Byte mode, error correction level M, smallest
// version that fits the URL, which for our short links is version 2 to 4.
//
// This is a standard QR implementation: Reed-Solomon over GF(256), the
// fixed function patterns, then the eight masks scored by the penalty rules
// in the spec. It is here rather than from a CDN so the join code can be
// shown even when the page has no connection. Copied from uwuPromptr.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const generator = rsGeneratorPoly(ecCount);
  const result = new Array(ecCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < ecCount; i++) {
      result[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return result;
}

// Per version, error correction level M: total codewords, EC codewords per
// block, block counts. Versions 1 to 9, which holds 182 bytes at level M and
// is far more than a pairing URL needs. The ceiling is 9 rather than a
// rounder number because byte mode switches from an 8 bit character count to
// a 16 bit one at version 10, and buildBitStream below writes the 8 bit one.
const VERSIONS = {
  1: { total: 26, ec: 10, groups: [[1, 16]] },
  2: { total: 44, ec: 16, groups: [[1, 28]] },
  3: { total: 70, ec: 26, groups: [[1, 44]] },
  4: { total: 100, ec: 18, groups: [[2, 32]] },
  5: { total: 134, ec: 24, groups: [[2, 43]] },
  6: { total: 172, ec: 16, groups: [[4, 27]] },
  7: { total: 196, ec: 18, groups: [[4, 31]] },
  8: { total: 242, ec: 22, groups: [[2, 38], [2, 39]] },
  9: { total: 292, ec: 22, groups: [[3, 36], [2, 37]] },
};

const MAX_VERSION = 9;

const ALIGNMENT_CENTRES = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// Format information for level M and each mask, already BCH-encoded and
// XOR-masked, which is the whole table rather than re-deriving it.
const FORMAT_BITS = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

// Version information, BCH(18,6). Only versions 7 and up carry it, in two
// 6x3 blocks beside the lower-left and upper-right finders. Leaving it out
// does not just omit a decoration: those cells are reserved, so data bits
// land in them and the whole symbol stops decoding.
const VERSION_BITS = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
};

function chooseVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const info = VERSIONS[v];
    const dataCodewords = info.groups.reduce((sum, [count, size]) => sum + count * size, 0);
    // Mode indicator plus the character count indicator: 4 bits then 8,
    // which is a byte and a half, so two whole codewords of overhead.
    const needed = byteLength + 2;
    if (dataCodewords >= needed) return v;
  }
  return null;
}

function buildBitStream(bytes, version) {
  const info = VERSIONS[version];
  const dataCodewords = info.groups.reduce((sum, [count, size]) => sum + count * size, 0);
  const bits = [];

  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  // Byte mode's character count is 8 bits up to version 9 and 16 from
  // version 10, which is why chooseVersion stops at MAX_VERSION.
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a byte boundary.
  const capacity = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // The two alternating pad codewords the spec names.
  const PADS = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(PADS[padIndex++ % 2]);
  }

  return codewords;
}

function interleave(codewords, version) {
  const info = VERSIONS[version];
  const blocks = [];
  let offset = 0;

  for (const [count, size] of info.groups) {
    for (let i = 0; i < count; i++) {
      const data = codewords.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: rsEncode(data, info.ec) });
    }
  }

  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < info.ec; i++) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFixed = (row, col, value) => {
    modules[row][col] = value;
    reserved[row][col] = true;
  };

  // Finder patterns and their separators.
  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFixed(row, col, onRing || inCore ? 1 : 0);
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFixed(6, i, i % 2 === 0 ? 1 : 0);
    setFixed(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT_CENTRES[version];
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          setFixed(row + r, col + c, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  // Version information areas, reserved here and filled in writeFormat.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      setFixed(size - 11 + col, row, 0);
      setFixed(row, size - 11 + col, 0);
    }
  }

  // The dark module, and the format information areas held back.
  setFixed(size - 8, 8, 1);
  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) { modules[8][i] = 0; reserved[8][i] = true; }
    if (modules[i][8] === null) { modules[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) { modules[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (modules[size - 1 - i][8] === null) { modules[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }

  return { modules, reserved, size };
}

function placeData(matrix, codewords) {
  const { modules, reserved, size } = matrix;
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }

  let index = 0;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    // Column 6 is the vertical timing pattern and is not part of the zigzag.
    if (right === 6) right = 5;

    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        modules[row][col] = index < bits.length ? bits[index++] : 0;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(matrix, mask) {
  const { modules, reserved, size } = matrix;
  const out = modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (maskBit(mask, r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function writeVersion(grid, size, version) {
  if (version < 7) return;
  const bits = VERSION_BITS[version];

  // Least significant bit first, down the three columns beside the
  // lower-left finder and mirrored beside the upper-right one.
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    grid[size - 11 + col][row] = bit;
    grid[row][size - 11 + col] = bit;
  }
}

function writeFormat(grid, size, mask) {
  const bits = FORMAT_BITS[mask];
  // The format word is placed most significant bit first: index 0 below is
  // bit 14 of the word, not bit 0. Indexing it the other way round produces
  // a symbol that looks perfectly well formed and decodes to nothing.
  const bit = (i) => (bits >> (14 - i)) & 1;

  for (let i = 0; i <= 5; i++) grid[8][i] = bit(i);
  grid[8][7] = bit(6);
  grid[8][8] = bit(7);
  grid[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) grid[14 - i][8] = bit(i);

  for (let i = 0; i <= 7; i++) grid[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) grid[8][size - 15 + i] = bit(i);

  grid[size - 8][8] = 1;
}

function penalty(grid, size) {
  let score = 0;

  // Rule 1: runs of five or more of the same colour.
  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let r = 0; r < size; r++) score += runScore(grid[r]);
  for (let c = 0; c < size; c++) score += runScore(grid.map((row) => row[c]));

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: the finder-like 1011101 pattern with four light modules beside it.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const REVERSED = [...PATTERN].reverse();
  const hasAt = (line, start, pattern) =>
    pattern.every((v, i) => line[start + i] === v);

  const patternScore = (line) => {
    let total = 0;
    for (let i = 0; i + PATTERN.length <= line.length; i++) {
      if (hasAt(line, i, PATTERN) || hasAt(line, i, REVERSED)) total += 40;
    }
    return total;
  };

  for (let r = 0; r < size; r++) score += patternScore(grid[r]);
  for (let c = 0; c < size; c++) score += patternScore(grid.map((row) => row[c]));

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

// Returns { size, modules } where modules is a size x size array of 0/1,
// or null if the text is too long for version 10 at level M.
export function encodeQr(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  if (!version) return null;

  const codewords = interleave(buildBitStream(bytes, version), version);
  const matrix = createMatrix(version);
  placeData(matrix, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = applyMask(matrix, mask);
    writeFormat(grid, matrix.size, mask);
    writeVersion(grid, matrix.size, version);
    const score = penalty(grid, matrix.size);
    if (!best || score < best.score) best = { score, grid };
  }

  return { size: matrix.size, modules: best.grid };
}

// One path for every dark module, which keeps the SVG small enough to set
// as innerHTML without a second thought.
export function qrToSvg(text, { quiet = 4 } = {}) {
  const code = encodeQr(text);
  if (!code) return "";

  const span = code.size + quiet * 2;
  let path = "";

  for (let r = 0; r < code.size; r++) {
    for (let c = 0; c < code.size; c++) {
      if (code.modules[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  return `<svg viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="QR code to join this game">
    <rect class="qr-bg" width="${span}" height="${span}" rx="1"/>
    <path class="qr-fg" d="${path}"/>
  </svg>`;
}
