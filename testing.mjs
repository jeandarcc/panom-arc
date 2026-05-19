import {
  applyArcAnchors,
  detectArcPatternFromRgba,
  gridText,
  makeArcFixtures,
  payloadBits,
} from './shared.mjs';
import { createArcScannerEngine } from './scanner-engine.mjs';
import { createArcRouteHarness } from './server.mjs';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const CANVAS_W = 320;
const CANVAS_H = 240;
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'test-logs');
const FOCUS_SIDE = Math.round(Math.min(CANVAS_W, CANVAS_H) * 0.5);
const FOCUS_RECT = {
  x: (CANVAS_W - FOCUS_SIDE) / 2,
  y: (CANVAS_H - FOCUS_SIDE) / 2,
  width: FOCUS_SIDE,
  height: FOCUS_SIDE,
};
const CLIENT_SCAN_INTERVAL_MS = 200;
const SESSION_DURATION_MS = 6_000;
const NETWORK_PROFILES = [
  { name: 'stable', baseLatencyMs: 45, jitterMs: 20, spikeChance: 0.03, spikeMs: 90 },
  { name: 'mobile', baseLatencyMs: 140, jitterMs: 75, spikeChance: 0.08, spikeMs: 180 },
  { name: 'poor', baseLatencyMs: 260, jitterMs: 140, spikeChance: 0.14, spikeMs: 320 },
];
const REALISTIC_LEVELS = [
  { name: 'camera-baseline', severity: 0.28, weight: 1.0 },
  { name: 'camera-mid', severity: 0.48, weight: 1.15 },
  { name: 'camera-hard', severity: 0.72, weight: 1.35 },
];

function detedToHex(bits) {
  return bits.toString(16).padStart(4, '0');
}

function ensureCleanLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
  for (const entry of readdirSync(LOG_DIR)) rmSync(join(LOG_DIR, entry), { recursive: true, force: true });
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffers) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i++) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32([typeBuffer, data]), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function writePngImage(filename, pixels, width = CANVAS_W, height = CANVAS_H) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < stride; x++) raw[rowOffset + 1 + x] = pixels[y * stride + x];
  }
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(join(LOG_DIR, filename), png);
}

function writeJsonLog(filename, value) {
  writeFileSync(join(LOG_DIR, filename), JSON.stringify(value, null, 2));
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function seedFromString(input) {
  let seed = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) seed = Math.imul(seed ^ input.charCodeAt(i), 16777619) >>> 0;
  return seed >>> 0;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function createBlankPixels(lum = 245) {
  const pixels = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = lum;
    pixels[i + 1] = lum;
    pixels[i + 2] = lum;
    pixels[i + 3] = 255;
  }
  return pixels;
}

function fillRect(pixels, x0, y0, w, h, color) {
  const startX = clamp(Math.floor(x0), 0, CANVAS_W);
  const startY = clamp(Math.floor(y0), 0, CANVAS_H);
  const endX = clamp(Math.ceil(x0 + w), 0, CANVAS_W);
  const endY = clamp(Math.ceil(y0 + h), 0, CANVAS_H);
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * CANVAS_W + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }
}

function fillCircle(pixels, cx, cy, r, color) {
  const minX = clamp(Math.floor(cx - r), 0, CANVAS_W - 1);
  const maxX = clamp(Math.ceil(cx + r), 0, CANVAS_W - 1);
  const minY = clamp(Math.floor(cy - r), 0, CANVAS_H - 1);
  const maxY = clamp(Math.ceil(cy + r), 0, CANVAS_H - 1);
  const rr = r * r;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > rr) continue;
      const idx = (y * CANVAS_W + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }
}

function makeFocusedScenarios(count, options = {}) {
  const minSide = options.minSide ?? 44;
  const maxSide = options.maxSide ?? 68;
  const maxRotationDeg = options.maxRotationDeg ?? 30;
  const rand = xorshift32(options.seed ?? 0x12345678);
  const scenarios = [];
  for (let i = 0; i < count; i++) {
    const side = minSide + rand() * (maxSide - minSide);
    const radius = side * Math.SQRT2 / 2;
    const minX = FOCUS_RECT.x + radius;
    const maxX = FOCUS_RECT.x + FOCUS_RECT.width - radius;
    const minY = FOCUS_RECT.y + radius;
    const maxY = FOCUS_RECT.y + FOCUS_RECT.height - radius;
    const cx = minX + rand() * Math.max(1, maxX - minX);
    const cy = minY + rand() * Math.max(1, maxY - minY);
    const angleDeg = -maxRotationDeg + rand() * maxRotationDeg * 2;
    scenarios.push({
      label: `focus-${i}-s${Math.round(side)}-r${angleDeg.toFixed(1)}`,
      side,
      cx,
      cy,
      angleRad: angleDeg * Math.PI / 180,
    });
  }
  return scenarios;
}

function jitteredScenario(base, frameIndex, severity, seed) {
  const rand = xorshift32(seed ^ (frameIndex * 2654435761 >>> 0));
  const drift = severity * 3.5;
  const wave = frameIndex * 0.37;
  return {
    ...base,
    cx: base.cx + Math.sin(wave) * drift + (rand() - 0.5) * drift,
    cy: base.cy + Math.cos(wave * 0.9) * drift + (rand() - 0.5) * drift,
    side: base.side * (1 + (rand() - 0.5) * severity * 0.05),
    angleRad: base.angleRad + (rand() - 0.5) * severity * 0.09,
  };
}

function buildUiBackground(seed, frameIndex = 0) {
  const rand = xorshift32(seed ^ frameIndex);
  const pixels = createBlankPixels(248);
  fillRect(pixels, 0, 0, CANVAS_W, 34, [54, 57, 62]);
  fillRect(pixels, 8, 8, CANVAS_W - 16, 14, [112, 118, 126]);
  fillRect(pixels, 0, 34, CANVAS_W, 42, [255, 252, 248]);
  fillRect(pixels, 0, 76, CANVAS_W, 1, [220, 220, 220]);
  fillRect(pixels, 12, 45, 72, 12, [20, 20, 20]);
  fillCircle(pixels, CANVAS_W - 72, 54, 18, [255, 255, 255]);
  fillCircle(pixels, CANVAS_W - 32, 54, 18, [255, 255, 255]);
  fillRect(pixels, FOCUS_RECT.x - 20, FOCUS_RECT.y - 20, FOCUS_RECT.width + 40, FOCUS_RECT.height + 40, [252, 252, 252]);
  for (let i = 0; i < 3; i++) {
    const h = 4 + rand() * 6;
    const y = 100 + i * 18 + rand() * 6;
    const w = 40 + rand() * 120;
    const x = 10 + rand() * (CANVAS_W - w - 20);
    fillRect(pixels, x, y, w, h, [230, 230, 230]);
  }
  fillRect(pixels, 0, CANVAS_H - 28, CANVAS_W, 28, [58, 61, 66]);
  for (let i = 0; i < 4; i++) fillCircle(pixels, 38 + i * 82, CANVAS_H - 14, 7, [115, 118, 122]);
  return pixels;
}

function drawArcOntoScene(bits, scenario, pixels) {
  const cos = Math.cos(scenario.angleRad ?? 0);
  const sin = Math.sin(scenario.angleRad ?? 0);
  const side = scenario.side;
  const gap = Math.max(2, side * 0.025);
  const cell = (side - gap * 3) / 4;
  const pitch = cell + gap;
  const cx = scenario.cx;
  const cy = scenario.cy;

  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = cos * dx + sin * dy + side / 2;
      const ly = -sin * dx + cos * dy + side / 2;
      if (lx < 0 || lx >= side || ly < 0 || ly >= side) continue;
      const col = Math.min(3, Math.floor(lx / pitch));
      const row = Math.min(3, Math.floor(ly / pitch));
      const inCellX = lx - col * pitch;
      const inCellY = ly - row * pitch;
      const isCell = inCellX < cell && inCellY < cell;
      const lum = isCell && ((row === 0 && (col === 0 || col === 3)) || (row === 3 && col === 0) || ((row !== 3 || col !== 3) && ((bits >> (row * 4 + col)) & 1) === 1)) ? 0 : 255;
      const idx = (y * CANVAS_W + x) * 4;
      pixels[idx] = lum;
      pixels[idx + 1] = lum;
      pixels[idx + 2] = lum;
    }
  }
}

function addDistractors(pixels, severity, seed) {
  const rand = xorshift32(seed ^ 0xa53c9e21);
  for (let i = 0; i < 2 + Math.floor(severity * 8); i++) {
    const w = 12 + rand() * (20 + severity * 60);
    const h = 5 + rand() * (8 + severity * 20);
    const x = rand() < 0.5 ? 0 : CANVAS_W - w;
    const y = rand() < 0.5 ? rand() * 40 : CANVAS_H - 30 - rand() * 26;
    fillRect(pixels, x, y, w, h, [0, 0, 0]);
  }
  for (let i = 0; i < 2 + Math.floor(severity * 7); i++) {
    const size = 6 + rand() * (10 + severity * 18);
    const x = rand() * (CANVAS_W - size);
    const y = rand() * (CANVAS_H - size);
    if (x > FOCUS_RECT.x - 10 && x < FOCUS_RECT.x + FOCUS_RECT.width + 10 && y > FOCUS_RECT.y - 10 && y < FOCUS_RECT.y + FOCUS_RECT.height + 10) continue;
    fillRect(pixels, x, y, size, size, [0, 0, 0]);
  }
}

function blurPixels(pixels, strength = 1) {
  if (strength <= 0) return pixels;
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < CANVAS_H; y++) {
    for (let x = 0; x < CANVAS_W; x++) {
      let r = 0; let g = 0; let b = 0; let count = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const sy = y + oy;
        if (sy < 0 || sy >= CANVAS_H) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const sx = x + ox;
          if (sx < 0 || sx >= CANVAS_W) continue;
          const idx = (sy * CANVAS_W + sx) * 4;
          const weight = (ox === 0 && oy === 0) ? 2 + strength : 1;
          r += pixels[idx] * weight;
          g += pixels[idx + 1] * weight;
          b += pixels[idx + 2] * weight;
          count += weight;
        }
      }
      const outIdx = (y * CANVAS_W + x) * 4;
      out[outIdx] = r / count;
      out[outIdx + 1] = g / count;
      out[outIdx + 2] = b / count;
      out[outIdx + 3] = 255;
    }
  }
  return out;
}

function applyCameraEffects(pixels, severity, seed, frameIndex) {
  const rand = xorshift32(seed ^ (frameIndex * 1103515245 >>> 0));
  let out = blurPixels(pixels, 1 + severity * 0.6);
  const exposure = 0.94 + rand() * 0.18;
  const contrast = 0.96 + rand() * 0.18;
  const tintR = 1 + (rand() - 0.5) * 0.08;
  const tintB = 1 + (rand() - 0.5) * 0.08;
  const glare = severity > 0.35 ? {
    x: rand() * CANVAS_W,
    y: rand() * CANVAS_H,
    r: 24 + rand() * (36 + severity * 24),
    alpha: 0.12 + severity * 0.14,
  } : null;

  for (let i = 0; i < out.length; i += 4) {
    let r = out[i];
    let g = out[i + 1];
    let b = out[i + 2];
    r = clamp(((r - 128) * contrast + 128) * exposure * tintR + (rand() - 0.5) * (6 + severity * 14), 0, 255);
    g = clamp(((g - 128) * contrast + 128) * exposure + (rand() - 0.5) * (6 + severity * 14), 0, 255);
    b = clamp(((b - 128) * contrast + 128) * exposure * tintB + (rand() - 0.5) * (6 + severity * 14), 0, 255);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }

  if (glare) {
    for (let y = 0; y < CANVAS_H; y++) {
      for (let x = 0; x < CANVAS_W; x++) {
        const dx = x - glare.x;
        const dy = y - glare.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > glare.r) continue;
        const lift = (1 - dist / glare.r) * glare.alpha * 255;
        const idx = (y * CANVAS_W + x) * 4;
        out[idx] = clamp(out[idx] + lift, 0, 255);
        out[idx + 1] = clamp(out[idx + 1] + lift, 0, 255);
        out[idx + 2] = clamp(out[idx + 2] + lift, 0, 255);
      }
    }
  }
  return out;
}

function renderRealisticFrame(bits, baseScenario, frameIndex, severity, seed) {
  const scenario = jitteredScenario(baseScenario, frameIndex, severity, seed);
  const pixels = buildUiBackground(seed, frameIndex);
  drawArcOntoScene(bits, scenario, pixels);
  addDistractors(pixels, severity, seed + frameIndex * 17);
  return applyCameraEffects(pixels, severity, seed, frameIndex);
}

function activeSlotIndexAt(slots, elapsedMs) {
  let acc = 0;
  for (let i = 0; i < slots.length; i++) {
    acc += slots[i].durationMs;
    if (elapsedMs < acc) return i;
  }
  return slots.length;
}

function makeSimUser() {
  return {
    id: 'sim-user',
    panomId: 'sim-panom',
    firstName: 'Sim',
    avatar: null,
    vacationMode: false,
    locale: 'en',
    theme: 'light',
    isAdmin: false,
    isDeleted: false,
  };
}

function createHarness() {
  return createArcRouteHarness({
    issueSession: async () => ({ accessToken: 'sim-access', refreshToken: 'sim-refresh' }),
    publicSessionUser: (user) => user,
    getUserById: async () => makeSimUser(),
    logArcLogin: async () => {},
  });
}

function makeLatencySampler(profile, seed) {
  const rand = xorshift32(seed);
  return () => {
    let latency = profile.baseLatencyMs + (rand() - 0.5) * profile.jitterMs * 2;
    if (rand() < profile.spikeChance) latency += profile.spikeMs * (0.75 + rand() * 0.5);
    return Math.max(15, Math.round(latency));
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function assertAnchors(bits, label) {
  const anchorsOk = ((bits >> 0) & 1) === 1 && ((bits >> 3) & 1) === 1 && ((bits >> 12) & 1) === 1 && ((bits >> 15) & 1) === 0;
  if (!anchorsOk) throw new Error(`[${label}] invalid ARC anchors in bits=0x${bits.toString(16).padStart(4, '0')}`);
}

function detectBitsRealistic(bits, scenario, severity, seed, frameIndex = 0) {
  const pixels = renderRealisticFrame(bits, scenario, frameIndex, severity, seed);
  const scanStart = performance.now();
  const detected = detectArcPatternFromRgba(pixels, { width: CANVAS_W, height: CANVAS_H, focusRect: FOCUS_RECT })?.bits ?? null;
  return { pixels, detected, scanMs: performance.now() - scanStart };
}

export function runArcCameraRoundTrip() {
  const fixtures = makeArcFixtures(20);
  const scenarios = makeFocusedScenarios(6, { seed: 0xaaa55111, minSide: 44, maxSide: 68, maxRotationDeg: 30 });
  const failures = [];
  let scanCount = 0;
  let totalScanMs = 0;
  let minScanMs = Number.POSITIVE_INFINITY;
  let maxScanMs = 0;

  for (const { label, bits } of fixtures) {
    assertAnchors(bits, label);
    for (const scenario of scenarios) {
      const { detected, scanMs } = detectBitsRealistic(bits, scenario, 0.12, seedFromString(`${label}:${scenario.label}`));
      scanCount++;
      totalScanMs += scanMs;
      minScanMs = Math.min(minScanMs, scanMs);
      maxScanMs = Math.max(maxScanMs, scanMs);
      if (detected !== bits) failures.push(`  [${label}/${scenario.label}] expected=0x${detedToHex(bits)} got=${detected === null ? 'null' : `0x${detedToHex(detected)}`}`);
    }
  }

  const total = fixtures.length * scenarios.length;
  if (failures.length > 0) {
    throw new Error(`ARC camera-simulation test FAILED (${failures.length}/${total} scenes):\n${failures.slice(0, 20).join('\n')}`);
  }

  const report = { total, scanCount, avgScanMs: totalScanMs / scanCount, minScanMs, maxScanMs, totalScanMs };
  console.log(`[selfTest] ✅ ARC camera simulation: ${total}/${total} transformed scenes OK`);
  console.log(`[selfTest] ARC scan timing: avg=${report.avgScanMs.toFixed(2)}ms min=${report.minScanMs.toFixed(2)}ms max=${report.maxScanMs.toFixed(2)}ms total=${report.totalScanMs.toFixed(2)}ms`);
  return report;
}

async function runAuthLoopForProfile(profile, runIndex = 0, logArtifacts = false) {
  const harness = createHarness();
  const engine = createArcScannerEngine({
    requiredStableFrames: 2,
    stableWindowSize: 6,
    minScanSubmitMs: 250,
    duplicateScanSubmitMs: 700,
  });
  const seed = seedFromString(`${profile.name}:${runIndex}`);
  const user = makeSimUser();
  const challenge = await harness.sessionChallenge({ ipHash: 'sim-ip', nowMs: 0 }, user.id);
  const slots = challenge.body.slots;
  const scenarios = makeFocusedScenarios(slots.length, {
    seed: seed ^ 0x4567abcd,
    minSide: 42,
    maxSide: 70,
    maxRotationDeg: 34,
  });
  const latency = makeLatencySampler(profile, seed ^ 0x9e3779b9);
  const queue = [];
  const timeline = [];
  const rejectCounts = {};
  let verifiedAtMs = null;
  let timeToFirstLock = null;
  let timeToCandidateId = null;
  let submits = 0;
  let duplicateSubmitCount = 0;
  let wrongLockCount = 0;
  let nullFrames = 0;
  let totalFrames = 0;
  let lastSubmittedBits = null;

  for (let nowMs = 0; nowMs <= SESSION_DURATION_MS && verifiedAtMs === null; nowMs += CLIENT_SCAN_INTERVAL_MS) {
    queue.sort((a, b) => a.dueMs - b.dueMs);
    while (queue.length && queue[0].dueMs <= nowMs) {
      const item = queue.shift();
      const handled = engine.handleScanResult(item.response.body);
      const state = handled.state;
      timeline.push({ t: item.dueMs, type: 'response', body: item.response.body, events: handled.events });
      if (item.response.body.matched && timeToFirstLock === null) timeToFirstLock = item.dueMs;
      if (state.candidateId && timeToCandidateId === null) timeToCandidateId = item.dueMs;
      if (item.response.body.matched === false && state.candidateId) wrongLockCount++;
      if (item.response.statusCode >= 400) {
        const key = item.response.body?.error ?? `status_${item.response.statusCode}`;
        rejectCounts[key] = (rejectCounts[key] ?? 0) + 1;
      }
      if (item.response.body.verified) {
        verifiedAtMs = item.dueMs;
        break;
      }
    }
    if (verifiedAtMs !== null) break;

    const activeIndex = activeSlotIndexAt(slots, nowMs);
    if (activeIndex >= slots.length) break;

    const slot = slots[activeIndex];
    const { pixels } = detectBitsRealistic(slot.bits, scenarios[activeIndex], profile.name === 'stable' ? 0.28 : profile.name === 'mobile' ? 0.46 : 0.72, seed, nowMs / CLIENT_SCAN_INTERVAL_MS);
    const stepped = engine.stepFrame({ rgba: pixels, width: CANVAS_W, height: CANVAS_H, nowMs });
    totalFrames++;
    if (stepped.frame.acceptedBits === null) nullFrames++;
    timeline.push({
      t: nowMs,
      type: 'frame',
      slotIndex: activeIndex,
      acceptedBits: stepped.frame.acceptedBits !== null ? `0x${detedToHex(stepped.frame.acceptedBits)}` : null,
      overlayState: stepped.frame.overlayState,
      events: stepped.events,
    });
    if (logArtifacts && totalFrames <= 3) {
      writePngImage(`${profile.name}-run${runIndex}-frame${totalFrames}.png`, pixels);
    }

    if (stepped.submit) {
      submits++;
      if (lastSubmittedBits === stepped.submit.observedBits) duplicateSubmitCount++;
      lastSubmittedBits = stepped.submit.observedBits;
      const networkDelay = latency();
      const arrivalMs = nowMs + networkDelay;
      const response = await harness.scan({ ipHash: 'sim-ip', nowMs: arrivalMs }, stepped.submit.observedBits, stepped.submit.candidateId);
      queue.push({
        dueMs: arrivalMs,
        response,
      });
      timeline.push({
        t: nowMs,
        type: 'submit',
        arrivalMs,
        observedBits: `0x${detedToHex(stepped.submit.observedBits)}`,
        candidateId: stepped.submit.candidateId ?? null,
      });
    }
  }

  queue.sort((a, b) => a.dueMs - b.dueMs);
  while (queue.length && verifiedAtMs === null) {
    const item = queue.shift();
    const handled = engine.handleScanResult(item.response.body);
    timeline.push({ t: item.dueMs, type: 'response', body: item.response.body, events: handled.events });
    if (item.response.body.matched && timeToFirstLock === null) timeToFirstLock = item.dueMs;
    if (handled.state.candidateId && timeToCandidateId === null) timeToCandidateId = item.dueMs;
    if (item.response.body.verified) verifiedAtMs = item.dueMs;
  }

  const report = {
    profile: profile.name,
    verified: verifiedAtMs !== null,
    verifiedAtMs,
    timeToFirstLock,
    timeToCandidateId,
    submitsPerVerification: submits,
    duplicateSubmitCount,
    wrongLockCount,
    nullFrameRatio: totalFrames === 0 ? 1 : nullFrames / totalFrames,
    backendRejectReasonCounts: rejectCounts,
    timeline,
  };

  if (logArtifacts) writeJsonLog(`${profile.name}-run${runIndex}-timeline.json`, report);
  return report;
}

export async function runArcRealisticAuthLoop() {
  const report = await runAuthLoopForProfile(NETWORK_PROFILES[0], 0, true);
  if (!report.verified || report.verifiedAtMs === null) {
    throw new Error(`ARC realistic auth loop did not verify for profile=${report.profile}`);
  }
  console.log(
    `[selfTest] ✅ ARC realistic auth loop (${report.profile}): verified in ${report.verifiedAtMs}ms ` +
    `firstLock=${report.timeToFirstLock ?? '-'}ms candidate=${report.timeToCandidateId ?? '-'}ms submits=${report.submitsPerVerification}`
  );
  return report;
}

export async function runArcNetworkProfileSweep() {
  const perProfile = [];
  for (const profile of NETWORK_PROFILES) {
    const runs = [];
    for (let i = 0; i < 6; i++) runs.push(await runAuthLoopForProfile(profile, i, i === 0));
    const verifyTimes = runs.filter((run) => run.verifiedAtMs !== null).map((run) => run.verifiedAtMs);
    const verifiedCount = verifyTimes.length;
    const profileReport = {
      profile: profile.name,
      totalRuns: runs.length,
      verifiedCount,
      successRate: verifiedCount / runs.length,
      p50VerifyMs: percentile(verifyTimes, 0.5),
      p95VerifyMs: percentile(verifyTimes, 0.95),
      avgSubmits: runs.reduce((sum, run) => sum + run.submitsPerVerification, 0) / runs.length,
      avgNullFrameRatio: runs.reduce((sum, run) => sum + run.nullFrameRatio, 0) / runs.length,
      runs,
    };
    perProfile.push(profileReport);
    console.log(
      `[selfTest] ARC network ${profile.name}: success=${(profileReport.successRate * 100).toFixed(1)}% ` +
      `p50=${profileReport.p50VerifyMs ?? '-'}ms p95=${profileReport.p95VerifyMs ?? '-'}ms avgSubmits=${profileReport.avgSubmits.toFixed(1)}`
    );
  }
  const resilienceScore = perProfile.reduce((sum, profile) => {
    const latencyPenalty = profile.p95VerifyMs === null ? 0 : Math.max(0, 1 - profile.p95VerifyMs / 7000);
    return sum + profile.successRate * 75 + latencyPenalty * 25;
  }, 0) / perProfile.length;
  console.log(`[selfTest] ARC network resilience score: ${resilienceScore.toFixed(1)}% (${scoreLabel(resilienceScore)})`);
  return { profiles: perProfile, networkResilienceScore: resilienceScore, rating: scoreLabel(resilienceScore) };
}

export function runArcClientBackendSimulation() {
  throw new Error('runArcClientBackendSimulation is now async via runArcRealisticAuthLoop; use runArcStartupSelfTests or runArcRealisticAuthLoop');
}

export function runArcAdversarialCameraSimulation() {
  return runArcDifficultySweep();
}

function scoreLabel(score) {
  if (score >= 98) return 'excellent';
  if (score >= 92) return 'very good';
  if (score >= 84) return 'good';
  if (score >= 72) return 'fair';
  return 'weak';
}

export function runArcDifficultySweep() {
  const fixtures = makeArcFixtures(20);
  const levels = [];
  let weightedScore = 0;
  let totalWeight = 0;
  let sampleIndex = 0;

  for (const level of REALISTIC_LEVELS) {
    const scenarios = makeFocusedScenarios(6, {
      seed: seedFromString(level.name),
      minSide: 38,
      maxSide: 70,
      maxRotationDeg: 34,
    });
    let total = 0;
    let detectedCount = 0;
    let exactMatches = 0;
    let totalScanMs = 0;
    for (const fixture of makeArcFixtures(20)) {
      assertAnchors(fixture.bits, fixture.label);
      for (const scenario of scenarios) {
        const { pixels, detected, scanMs } = detectBitsRealistic(fixture.bits, scenario, level.severity, seedFromString(`${fixture.label}:${scenario.label}:${level.name}`), total);
        total++;
        totalScanMs += scanMs;
        if (detected !== null) detectedCount++;
        if (detected === fixture.bits) exactMatches++;
        if (sampleIndex < 6) {
          const prefix = `${level.name}-sample${sampleIndex++}`;
          writePngImage(`${prefix}.png`, pixels);
          writeJsonLog(`${prefix}.json`, {
            severity: level.severity,
            fixture: fixture.label,
            bits: `0x${detedToHex(fixture.bits)}`,
            detectedBits: detected === null ? null : `0x${detedToHex(detected)}`,
            scenario,
          });
        }
      }
    }
    const report = {
      level: level.name,
      severity: level.severity,
      total,
      detectedCount,
      exactMatches,
      detectionRate: detectedCount / total,
      exactMatchRate: exactMatches / total,
      avgScanMs: totalScanMs / total,
    };
    levels.push(report);
    weightedScore += report.exactMatchRate * 100 * level.weight;
    totalWeight += level.weight;
    console.log(`[selfTest] ARC realistic ${level.name}: exact=${exactMatches}/${total} (${(report.exactMatchRate * 100).toFixed(1)}%) detect=${(report.detectionRate * 100).toFixed(1)}% avg=${report.avgScanMs.toFixed(2)}ms`);
  }

  const detectorScore = weightedScore / totalWeight;
  console.log(`[selfTest] ARC detector score: ${detectorScore.toFixed(1)}% (${scoreLabel(detectorScore)})`);
  return { levels, scanScore: detectorScore, detectorScore, rating: scoreLabel(detectorScore) };
}

export async function runArcStartupSelfTests() {
  ensureCleanLogDir();
  console.log('[selfTest] Running 5 startup test(s)...');
  const baselineFixture = makeArcFixtures(1)[0];
  const baselineScenario = makeFocusedScenarios(1, { seed: 0xabc12345 })[0];
  const baselinePixels = renderRealisticFrame(baselineFixture.bits, baselineScenario, 0, 0.22, 0xabc12345);
  writePngImage('baseline-sample.png', baselinePixels);
  writeJsonLog('baseline-sample.json', {
    fixture: baselineFixture.label,
    bits: `0x${detedToHex(baselineFixture.bits)}`,
    scenario: baselineScenario,
    focusRect: FOCUS_RECT,
  });

  const camera = runArcCameraRoundTrip();
  const auth = await runArcRealisticAuthLoop();
  const detector = runArcDifficultySweep();
  const network = await runArcNetworkProfileSweep();
  const overallScore = (detector.detectorScore * 0.45) + (network.networkResilienceScore * 0.55);
  console.log(`[selfTest] ARC overall score: ${overallScore.toFixed(1)}% (${scoreLabel(overallScore)})`);
  console.log(`[selfTest] Logs written to ${LOG_DIR}`);
  console.log('[selfTest] All tests passed.\n');
  return { camera, auth, detector, network, overallScore, rating: scoreLabel(overallScore) };
}

export { applyArcAnchors };
