export const ARC_ANCHOR_MASK = 0x9009;
export const ARC_ANCHOR_ON = 0x100d;
export const ARC_PAYLOAD_MASK = (~ARC_ANCHOR_MASK) & 0xffff;
export const ARC_PAYLOAD_INDICES = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14];
export const DEFAULT_WIDTH = 320;
export const DEFAULT_HEIGHT = 240;

export function applyArcAnchors(bits) {
  return (bits & ARC_PAYLOAD_MASK) | ARC_ANCHOR_ON;
}

export function payloadBits(bits) {
  return bits & ARC_PAYLOAD_MASK;
}

export function hammingDistance(a, b) {
  let x = (a ^ b) & ARC_PAYLOAD_MASK;
  let count = 0;
  while (x) {
    x &= x - 1;
    count++;
  }
  return count;
}

export function isArcCellOn(bits, bitIndex) {
  return (
    bitIndex === 0 ||
    bitIndex === 3 ||
    bitIndex === 12 ||
    (bitIndex !== 15 && ((bits >> bitIndex) & 1) === 1)
  );
}

export function gridText(bits) {
  return Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => (((bits >> (r * 4 + c)) & 1) ? '#' : '.')).join('')
  ).join(' | ');
}

export function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 0x100000000;
  };
}

export function renderArcToPixels(bits, scenario, options) {
  const width = options?.width ?? DEFAULT_WIDTH;
  const height = options?.height ?? DEFAULT_HEIGHT;
  const data = new Uint8ClampedArray(width * height * 4);
  const cos = Math.cos(scenario.angleRad ?? 0);
  const sin = Math.sin(scenario.angleRad ?? 0);
  const side = scenario.side;
  const gap = Math.max(2, side * 0.025);
  const cell = (side - gap * 3) / 4;
  const pitch = cell + gap;
  const cx = scenario.cx;
  const cy = scenario.cy;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = cos * dx + sin * dy + side / 2;
      const ly = -sin * dx + cos * dy + side / 2;

      let lum = 128;
      if (lx >= 0 && lx < side && ly >= 0 && ly < side) {
        const col = Math.min(3, Math.floor(lx / pitch));
        const row = Math.min(3, Math.floor(ly / pitch));
        const inCellX = lx - col * pitch;
        const inCellY = ly - row * pitch;
        lum = inCellX < cell && inCellY < cell && isArcCellOn(bits, row * 4 + col) ? 0 : 255;
      }

      const idx = (y * width + x) * 4;
      data[idx] = lum;
      data[idx + 1] = lum;
      data[idx + 2] = lum;
      data[idx + 3] = 255;
    }
  }

  return data;
}

export function makeArcFixtures(count = 20, seed = 0xdeadbeef) {
  const fixtures = [
    { label: 'checkerboard-A', bits: applyArcAnchors(0b0101010101010101) },
    { label: 'checkerboard-B', bits: applyArcAnchors(0b1010101010101010) },
    { label: 'payload-zero', bits: applyArcAnchors(0x0000) },
    { label: 'payload-full', bits: applyArcAnchors(0xffff) },
    { label: 'top-row-ON', bits: applyArcAnchors(0x000f) },
    { label: 'bottom-row-ON', bits: applyArcAnchors(0xf000) },
    { label: 'left-col-ON', bits: applyArcAnchors(0x1111) },
    { label: 'right-col-ON', bits: applyArcAnchors(0x8888) },
  ];
  const rand = xorshift32(seed);
  for (let i = 0; i < count; i++) {
    fixtures.push({ label: `random-${i}`, bits: applyArcAnchors(Math.floor(rand() * 0x10000)) });
  }
  return fixtures;
}

export function makeArcScenarios(count, options) {
  const width = options?.width ?? DEFAULT_WIDTH;
  const height = options?.height ?? DEFAULT_HEIGHT;
  const seed = options?.seed ?? 0xabcddcba;
  const minSide = options?.minSide ?? 72;
  const maxSide = options?.maxSide ?? 172;
  const maxRotationDeg = options?.maxRotationDeg ?? 35;
  const rand = xorshift32(seed);
  const scenarios = [];

  for (let i = 0; i < count; i++) {
    const side = minSide + rand() * (maxSide - minSide);
    const radius = side * Math.SQRT2 / 2 + 4;
    const cx = radius + rand() * (width - radius * 2);
    const cy = radius + rand() * (height - radius * 2);
    const angleDeg = -maxRotationDeg + rand() * maxRotationDeg * 2;
    scenarios.push({
      label: `scene-${i}-s${Math.round(side)}-r${angleDeg.toFixed(1)}`,
      side,
      cx,
      cy,
      angleRad: angleDeg * Math.PI / 180,
    });
  }

  return scenarios;
}

export function preprocessArcFrameFromRgba(data, options) {
  const W = options?.width ?? DEFAULT_WIDTH;
  const H = options?.height ?? DEFAULT_HEIGHT;
  const gray = new Uint8ClampedArray(W * H);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const y = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    gray[i] = y;
  }

  const lowW = W;
  const lowH = H;
  const lowGray = new Uint8ClampedArray(lowW * lowH);
  let lowSum = 0;

  // Camera-like cleanup pipeline:
  // 1) keep near-native resolution for large ARC cells
  // 2) blur lightly to stabilize neighboring pixels
  // 3) snap toward pure black/white before detection
  for (let y = 0; y < lowH; y++) {
    const y0 = Math.floor(y * H / lowH);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * H / lowH));
    for (let x = 0; x < lowW; x++) {
      const x0 = Math.floor(x * W / lowW);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * W / lowW));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += gray[sy * W + sx];
          count++;
        }
      }
      const lum = sum / Math.max(1, count);
      lowGray[y * lowW + x] = lum;
      lowSum += lum;
    }
  }

  const blurred = new Uint8ClampedArray(lowW * lowH);
  for (let y = 0; y < lowH; y++) {
    for (let x = 0; x < lowW; x++) {
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const sy = y + oy;
        if (sy < 0 || sy >= lowH) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const sx = x + ox;
          if (sx < 0 || sx >= lowW) continue;
          sum += lowGray[sy * lowW + sx];
          count++;
        }
      }
      blurred[y * lowW + x] = sum / Math.max(1, count);
    }
  }

  const lowThreshold = (lowSum / Math.max(1, lowGray.length)) * 0.58;
  const lowDark = new Uint8Array(lowW * lowH);
  for (let i = 0; i < lowDark.length; i++) {
    lowDark[i] = blurred[i] < lowThreshold ? 1 : 0;
  }

  // Keep dark pixels only when they belong to a locally dark neighborhood.
  // Isolated dark specks get promoted back to white so blob finding stays calmer.
  const refinedLowDark = new Uint8Array(lowW * lowH);
  for (let y = 0; y < lowH; y++) {
    for (let x = 0; x < lowW; x++) {
      const idx = y * lowW + x;
      if (!lowDark[idx]) continue;
      let darkNeighbors = 0;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const sy = y + oy;
        if (sy < 0 || sy >= lowH) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const sx = x + ox;
          if (sx < 0 || sx >= lowW) continue;
          neighbors++;
          darkNeighbors += lowDark[sy * lowW + sx];
        }
      }
      if (darkNeighbors >= Math.max(4, Math.ceil(neighbors * 0.55))) {
        refinedLowDark[idx] = 1;
      }
    }
  }

  const analysisGray = new Uint8ClampedArray(W * H);
  const processedGray = new Uint8ClampedArray(W * H);
  const dark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(lowH - 1, Math.floor(y * lowH / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(lowW - 1, Math.floor(x * lowW / W));
      const idx = sy * lowW + sx;
      const smooth = blurred[idx];
      const snapped = refinedLowDark[idx] ? 0 : 255;
      const out = y * W + x;
      analysisGray[out] = smooth;
      processedGray[out] = snapped;
      dark[out] = snapped === 0 ? 1 : 0;
    }
  }

  return { width: W, height: H, gray: processedGray, analysisGray, dark };
}

export function detectArcPatternFromRgba(data, options) {
  const { width: W, height: H, gray: processedGray, analysisGray, dark } = preprocessArcFrameFromRgba(data, options);
  const focusRect = options?.focusRect ?? null;
  const smallFocusMode = !!focusRect && Math.min(focusRect.width, focusRect.height) <= 140;

  function findBlobs() {
    const seen = new Uint8Array(W * H);
    const stack = [];
    const blobs = [];

    for (let start = 0; start < dark.length; start++) {
      if (!dark[start] || seen[start]) continue;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = W;
      let minY = H;
      let maxX = 0;
      let maxY = 0;
      seen[start] = 1;
      stack.push(start);

      while (stack.length) {
        const idx = stack.pop();
        const x = idx % W;
        const y = (idx / W) | 0;
        area++;
        sumX += x;
        sumY += y;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const left = idx - 1;
        const right = idx + 1;
        const up = idx - W;
        const down = idx + W;
        if (x > 0 && dark[left] && !seen[left]) { seen[left] = 1; stack.push(left); }
        if (x < W - 1 && dark[right] && !seen[right]) { seen[right] = 1; stack.push(right); }
        if (y > 0 && dark[up] && !seen[up]) { seen[up] = 1; stack.push(up); }
        if (y < H - 1 && dark[down] && !seen[down]) { seen[down] = 1; stack.push(down); }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / Math.max(1, bh);
      const cx = sumX / area;
      const cy = sumY / area;
      const minArea = smallFocusMode ? 10 : 20;
      const maxArea = smallFocusMode ? 1800 : 2400;
      const minAspect = smallFocusMode ? 0.28 : 0.35;
      const maxAspect = smallFocusMode ? 3.2 : 2.8;
      if (area >= minArea && area <= maxArea && aspect >= minAspect && aspect <= maxAspect) {
        if (focusRect) {
          const marginX = focusRect.width * 0.4;
          const marginY = focusRect.height * 0.4;
          const inFocus =
            cx >= focusRect.x - marginX &&
            cx <= focusRect.x + focusRect.width + marginX &&
            cy >= focusRect.y - marginY &&
            cy <= focusRect.y + focusRect.height + marginY;
          if (!inFocus) continue;
          const overlapW = Math.max(0, Math.min(maxX, focusRect.x + focusRect.width) - Math.max(minX, focusRect.x));
          const overlapH = Math.max(0, Math.min(maxY, focusRect.y + focusRect.height) - Math.max(minY, focusRect.y));
          const overlapArea = overlapW * overlapH;
          if (overlapArea / Math.max(1, bw * bh) < 0.08) continue;
        }
        blobs.push({ x: cx, y: cy, minX, minY, maxX, maxY, area });
      }
    }

    return blobs;
  }

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function sampleGray(x, y) {
    const clampedX = Math.max(0, Math.min(W - 1.001, x));
    const clampedY = Math.max(0, Math.min(H - 1.001, y));
    const x0 = Math.floor(clampedX);
    const y0 = Math.floor(clampedY);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const fx = clampedX - x0;
    const fy = clampedY - y0;
    const top = analysisGray[y0 * W + x0] * (1 - fx) + analysisGray[y0 * W + x1] * fx;
    const bottom = analysisGray[y1 * W + x0] * (1 - fx) + analysisGray[y1 * W + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  }

  function solveHomography(src) {
    const dst = [{ x: 0, y: 0 }, { x: 63, y: 0 }, { x: 0, y: 63 }, { x: 63, y: 63 }];
    const a = [];
    for (let i = 0; i < 4; i++) {
      const u = dst[i].x;
      const v = dst[i].y;
      const x = src[i].x;
      const y = src[i].y;
      a.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      a.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }

    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++) {
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      }
      if (Math.abs(a[pivot][col]) < 1e-9) return null;
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const div = a[col][col];
      for (let c = col; c < 9; c++) a[col][c] /= div;
      for (let row = 0; row < 8; row++) {
        if (row === col) continue;
        const factor = a[row][col];
        for (let c = col; c < 9; c++) a[row][c] -= factor * a[col][c];
      }
    }

    return [a[0][8], a[1][8], a[2][8], a[3][8], a[4][8], a[5][8], a[6][8], a[7][8], 1];
  }

  function warpSample(quad) {
    const h = solveHomography(quad);
    if (!h) return null;
    const canonical = [];

    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const den = h[6] * x + h[7] * y + 1;
        if (Math.abs(den) < 1e-9) return null;
        canonical.push(sampleGray((h[0] * x + h[1] * y + h[2]) / den, (h[3] * x + h[4] * y + h[5]) / den));
      }
    }

    return canonical;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 128;
  }

  function cellLum(canonical, cellIndex) {
    return cellLumSized(canonical, cellIndex, 5, 11);
  }

  function cellLumSized(canonical, cellIndex, startOffset, endOffset) {
    const col = cellIndex % 4;
    const row = (cellIndex / 4) | 0;
    let sum = 0;
    let count = 0;
    for (let y = row * 16 + startOffset; y < row * 16 + endOffset; y++) {
      for (let x = col * 16 + startOffset; x < col * 16 + endOffset; x++) {
        sum += canonical[y * 64 + x];
        count++;
      }
    }
    return sum / count;
  }

  function sampleCanonicalRect(canonical, startX, endX, startY, endY) {
    let sum = 0;
    let count = 0;
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        sum += canonical[y * 64 + x];
        count++;
      }
    }
    return sum / Math.max(1, count);
  }

  function structureScore(canonical, localThreshold, sampleStart, sampleEnd) {
    let cellConfidence = 0;
    for (let idx = 0; idx < 16; idx++) {
      cellConfidence += Math.abs(cellLumSized(canonical, idx, sampleStart, sampleEnd) - localThreshold);
    }
    cellConfidence /= 16;

    let seamBrightness = 0;
    let seamCount = 0;
    for (const seam of [16, 32, 48]) {
      seamBrightness += sampleCanonicalRect(canonical, seam - 1, seam + 1, 0, 64);
      seamBrightness += sampleCanonicalRect(canonical, 0, 64, seam - 1, seam + 1);
      seamCount += 2;
    }
    seamBrightness /= Math.max(1, seamCount);

    return cellConfidence + Math.max(0, seamBrightness - localThreshold) * 0.6;
  }

  function readQuad(quad) {
    const canonical = warpSample(quad);
    if (!canonical) return null;
    const bounds = quadBounds(quad);
    const estimatedSide = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const smallCandidate = estimatedSide < 42;
    const sampleStart = smallCandidate ? 4 : 5;
    const sampleEnd = smallCandidate ? 12 : 11;

    const cornerLums = [
      cellLumSized(canonical, 0, sampleStart, sampleEnd),
      cellLumSized(canonical, 3, sampleStart, sampleEnd),
      cellLumSized(canonical, 12, sampleStart, sampleEnd),
      cellLumSized(canonical, 15, sampleStart, sampleEnd),
    ];
    const blackRef = median([cornerLums[0], cornerLums[1], cornerLums[2]]);
    const whiteRef = cornerLums[3];
    const contrast = whiteRef - blackRef;
    if (contrast < (smallCandidate ? 24 : 35)) return null;

    const localThreshold = (blackRef + whiteRef) / 2;
    const anchorSlack = smallCandidate ? 8 : 0;
    if (!(
      cornerLums[0] < localThreshold + anchorSlack &&
      cornerLums[1] < localThreshold + anchorSlack &&
      cornerLums[2] < localThreshold + anchorSlack &&
      cornerLums[3] > localThreshold - anchorSlack
    )) {
      return null;
    }

    let bits = ARC_ANCHOR_ON;
    for (const idx of ARC_PAYLOAD_INDICES) {
      if (cellLumSized(canonical, idx, sampleStart, sampleEnd) < localThreshold) bits |= 1 << idx;
    }

    const cornerScore = Math.min(
      localThreshold - cornerLums[0],
      localThreshold - cornerLums[1],
      localThreshold - cornerLums[2],
      cornerLums[3] - localThreshold,
    );
    const innerGridScore = structureScore(canonical, localThreshold, sampleStart, sampleEnd);
    return { bits, score: contrast + cornerScore + innerGridScore, quad, cornerLums };
  }

  function quadFromCenters(tl, tr, bl, br) {
    const ux = tr.x - tl.x;
    const uy = tr.y - tl.y;
    const vx = bl.x - tl.x;
    const vy = bl.y - tl.y;
    return [
      { x: tl.x - (ux + vx) / 6, y: tl.y - (uy + vy) / 6 },
      { x: tr.x + ux / 6 - vx / 6, y: tr.y + uy / 6 - vy / 6 },
      { x: bl.x - ux / 6 + vx / 6, y: bl.y - uy / 6 + vy / 6 },
      { x: br.x + (ux + vx) / 6, y: br.y + (uy + vy) / 6 },
    ];
  }

  function quadBounds(quad) {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }

  function scoreFocus(quad) {
    if (!focusRect) return 0;
    const bounds = quadBounds(quad);
    const qx = (bounds.minX + bounds.maxX) / 2;
    const qy = (bounds.minY + bounds.maxY) / 2;
    const fx = focusRect.x + focusRect.width / 2;
    const fy = focusRect.y + focusRect.height / 2;
    const dist = Math.hypot(qx - fx, qy - fy);
    const maxDist = Math.hypot(focusRect.width, focusRect.height) * 0.75;
    const centerBias = Math.max(0, 1 - dist / Math.max(1, maxDist));

    const overlapW = Math.max(0, Math.min(bounds.maxX, focusRect.x + focusRect.width) - Math.max(bounds.minX, focusRect.x));
    const overlapH = Math.max(0, Math.min(bounds.maxY, focusRect.y + focusRect.height) - Math.max(bounds.minY, focusRect.y));
    const overlapArea = overlapW * overlapH;
    const quadArea = Math.max(1, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
    const overlapRatio = overlapArea / quadArea;

    if (overlapRatio < 0.18) return -1e6;
    return centerBias * 120 + overlapRatio * 220;
  }

  const blobs = findBlobs();
  let best = null;

  for (let i = 0; i < blobs.length - 2; i++) {
    for (let j = i + 1; j < blobs.length - 1; j++) {
      for (let k = j + 1; k < blobs.length; k++) {
        const tri = [blobs[i], blobs[j], blobs[k]];
        for (const p of [{ right: 0, a: 1, b: 2 }, { right: 1, a: 0, b: 2 }, { right: 2, a: 0, b: 1 }]) {
          const r = tri[p.right];
          const a = tri[p.a];
          const b = tri[p.b];
          const da = Math.sqrt(dist2(r, a));
          const db = Math.sqrt(dist2(r, b));
          const dh2 = dist2(a, b);
          if (Math.min(da, db) < (smallFocusMode ? 18 : 30)) continue;

          const sideBalance = Math.min(da, db) / Math.max(da, db);
          const rightScore = 1 - Math.min(1, Math.abs(dh2 - da * da - db * db) / Math.max(1, dh2));
          const minSideBalance = smallFocusMode ? 0.42 : 0.55;
          const minRightScore = smallFocusMode ? 0.58 : 0.72;
          if (sideBalance < minSideBalance || rightScore < minRightScore) continue;

          const cross = (a.x - r.x) * (b.y - r.y) - (a.y - r.y) * (b.x - r.x);
          const tr = cross > 0 ? a : b;
          const bl = cross > 0 ? b : a;
          const br = { x: tr.x + bl.x - r.x, y: tr.y + bl.y - r.y };
          const candidates = [
            quadFromCenters(r, tr, bl, br),
            quadFromCenters(tr, br, r, bl),
            quadFromCenters(bl, r, br, tr),
            quadFromCenters(br, bl, tr, r),
          ];

          for (const quad of candidates) {
            const detected = readQuad(quad);
            if (detected) {
              const focusScore = scoreFocus(quad);
              if (focusScore < -1e5) continue;
              detected.score += (da + db) * sideBalance * rightScore;
              detected.score += focusScore;
              if (!best || detected.score > best.score) best = detected;
            }
          }
        }
      }
    }
  }

  return best;
}

export default {
  ARC_ANCHOR_MASK,
  ARC_ANCHOR_ON,
  ARC_PAYLOAD_MASK,
  ARC_PAYLOAD_INDICES,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  applyArcAnchors,
  payloadBits,
  hammingDistance,
  isArcCellOn,
  gridText,
  xorshift32,
  renderArcToPixels,
  makeArcFixtures,
  makeArcScenarios,
  preprocessArcFrameFromRgba,
  detectArcPatternFromRgba,
};
