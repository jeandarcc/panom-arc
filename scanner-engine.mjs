import { detectArcPatternFromRgba, preprocessArcFrameFromRgba } from './shared.mjs';

function quadCenter(quad) {
  return quad.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
}

function quadArea(quad) {
  let area = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
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

function quadDimensions(quad) {
  const bounds = quadBounds(quad);
  return {
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}

function boundsToRect(bounds) {
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}

function overlapRatioWithRect(quad, focusRect) {
  const bounds = quadBounds(quad);
  const overlapW = Math.max(0, Math.min(bounds.maxX, focusRect.x + focusRect.width) - Math.max(bounds.minX, focusRect.x));
  const overlapH = Math.max(0, Math.min(bounds.maxY, focusRect.y + focusRect.height) - Math.max(bounds.minY, focusRect.y));
  const overlapArea = overlapW * overlapH;
  const quadAreaBox = Math.max(1, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
  return overlapArea / quadAreaBox;
}

function quadsAreSimilar(a, b) {
  if (!a || !b) return false;
  const centerA = quadCenter(a);
  const centerB = quadCenter(b);
  const areaA = quadArea(a);
  const areaB = quadArea(b);
  const dimsA = quadDimensions(a);
  const dimsB = quadDimensions(b);
  const boundsA = quadBounds(a);
  const boundsB = quadBounds(b);
  const centerDist = Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
  const sizeRef = Math.sqrt(Math.max(1, (areaA + areaB) / 2));
  const areaRatio = Math.max(areaA, areaB) / Math.max(1, Math.min(areaA, areaB));
  const widthRatio = Math.max(dimsA.width, dimsB.width) / Math.max(1, Math.min(dimsA.width, dimsB.width));
  const heightRatio = Math.max(dimsA.height, dimsB.height) / Math.max(1, Math.min(dimsA.height, dimsB.height));
  const overlapA = overlapRatioWithRect(a, boundsToRect(boundsB));
  const overlapB = overlapRatioWithRect(b, boundsToRect(boundsA));
  const overlap = Math.max(overlapA, overlapB);
  return (
    centerDist <= sizeRef * 0.42 &&
    areaRatio <= 1.85 &&
    widthRatio <= 1.6 &&
    heightRatio <= 1.6 &&
    overlap >= 0.45
  );
}

function hasQuietZone(gray, width, height, quad) {
  const bounds = quadBounds(quad);
  const pad = 6;
  const outerMinX = Math.max(0, Math.floor(bounds.minX - pad));
  const outerMinY = Math.max(0, Math.floor(bounds.minY - pad));
  const outerMaxX = Math.min(width - 1, Math.ceil(bounds.maxX + pad));
  const outerMaxY = Math.min(height - 1, Math.ceil(bounds.maxY + pad));
  const innerMinX = Math.max(0, Math.floor(bounds.minX));
  const innerMinY = Math.max(0, Math.floor(bounds.minY));
  const innerMaxX = Math.min(width - 1, Math.ceil(bounds.maxX));
  const innerMaxY = Math.min(height - 1, Math.ceil(bounds.maxY));
  let whiteish = 0;
  let count = 0;
  for (let y = outerMinY; y <= outerMaxY; y++) {
    for (let x = outerMinX; x <= outerMaxX; x++) {
      if (x >= innerMinX && x <= innerMaxX && y >= innerMinY && y <= innerMaxY) continue;
      if (gray[y * width + x] >= 180) whiteish++;
      count++;
    }
  }
  return count > 0 && whiteish / count >= 0.58;
}

function createFocusRect(width, height) {
  const focusSide = Math.round(Math.min(width, height) * 0.5);
  return {
    x: (width - focusSide) / 2,
    y: (height - focusSide) / 2,
    width: focusSide,
    height: focusSide,
  };
}

export function createArcScannerEngine(options = {}) {
  const {
    requiredStableFrames = 2,
    stableWindowSize = 6,
    minScanSubmitMs = 250,
    duplicateScanSubmitMs = 700,
  } = options;

  const state = {
    candidateId: null,
    trackingMode: 'SEARCH',
    lockedQuad: null,
    badFrames: 0,
    scanInFlight: false,
    lastSubmittedBits: null,
    lastSubmitAt: 0,
    recentBits: [],
    matchedBitsAwaitingChange: null,
    stableQuad: null,
    stableQuadCount: 0,
    verified: false,
    scanLocked: false,
  };

  function emit(events, msg, level = 'info') {
    events.push({ msg, level });
  }

  function evaluateFrame(frame, events) {
    const { rgba, width, height } = frame;
    const processed = preprocessArcFrameFromRgba(rgba, { width, height });
    const focusRect = createFocusRect(width, height);
    const detection = detectArcPatternFromRgba(rgba, { width, height, focusRect });

    if (!detection) {
      state.badFrames++;
      if (state.badFrames >= 3) {
        state.trackingMode = 'SEARCH';
        state.lockedQuad = null;
        state.scanLocked = false;
        state.stableQuad = null;
        state.stableQuadCount = 0;
      }
      emit(events, `no finder mode=${state.trackingMode} bad=${state.badFrames}`, 'warn');
      return { processed, focusRect, acceptedBits: null, overlayQuad: state.lockedQuad, overlayState: 'rejected', detection: null };
    }

    const focusOverlap = overlapRatioWithRect(detection.quad, focusRect);
    if (focusOverlap < 0.42) {
      emit(events, `focus reject overlap=${focusOverlap.toFixed(2)}`, 'warn');
      return { processed, focusRect, acceptedBits: null, overlayQuad: detection.quad, overlayState: 'rejected', detection };
    }

    if (!hasQuietZone(processed.gray, width, height, detection.quad)) {
      emit(events, 'quiet-zone reject', 'warn');
      return { processed, focusRect, acceptedBits: null, overlayQuad: detection.quad, overlayState: 'rejected', detection };
    }

    if (quadsAreSimilar(state.stableQuad, detection.quad)) {
      state.stableQuadCount = Math.min(3, state.stableQuadCount + 1);
    } else {
      state.stableQuad = detection.quad;
      state.stableQuadCount = 1;
    }

    const softLocked = state.stableQuadCount < 2;
    state.trackingMode = 'LOCKED';
    state.lockedQuad = detection.quad;
    state.badFrames = 0;
    state.scanLocked = true;
    if (softLocked) emit(events, `quad soft-lock ${state.stableQuadCount}/2 score=${detection.score.toFixed(0)}`);

    const grid = Array.from({ length: 4 }, (_, r) =>
      Array.from({ length: 4 }, (_, c) => (((detection.bits >> (r * 4 + c)) & 1) ? '█' : '░')).join(''),
    ).join('|');
    emit(events, `mode=${state.trackingMode} score=${detection.score.toFixed(0)} bits=0x${detection.bits.toString(16).padStart(4, '0')} [${grid}]`);

    return {
      processed,
      focusRect,
      acceptedBits: detection.bits,
      overlayQuad: state.lockedQuad,
      overlayState: softLocked ? 'pending' : 'locked',
      detection,
    };
  }

  function summarizeRecentBits() {
    const counts = new Map();
    let bestBits = null;
    let bestCount = 0;
    for (const value of state.recentBits) {
      const next = (counts.get(value) ?? 0) + 1;
      counts.set(value, next);
      if (next >= bestCount) {
        bestBits = value;
        bestCount = next;
      }
    }
    return { bestBits, bestCount };
  }

  function stepFrame(frame) {
    const nowMs = frame.nowMs ?? Date.now();
    const events = [];
    const frameState = evaluateFrame(frame, events);
    let submit = null;

    if (!state.verified && !state.scanInFlight && frameState.acceptedBits !== null) {
      state.recentBits.push(frameState.acceptedBits);
      if (state.recentBits.length > stableWindowSize) state.recentBits.shift();
      const { bestBits, bestCount } = summarizeRecentBits();
      if (bestBits !== state.matchedBitsAwaitingChange) state.matchedBitsAwaitingChange = null;
      const requiredVotes = state.candidateId ? Math.max(2, requiredStableFrames) : requiredStableFrames;

      if (bestBits === null || bestCount < requiredVotes) {
        emit(events, `stabilizing bits=0x${frameState.acceptedBits.toString(16).padStart(4, '0')} votes=${bestCount}/${requiredVotes} window=${state.recentBits.map((v) => v.toString(16).padStart(4, '0')).join(',')}`);
      } else if (bestBits !== state.matchedBitsAwaitingChange) {
        const isDuplicate = bestBits === state.lastSubmittedBits;
        const minDelay = isDuplicate ? duplicateScanSubmitMs : minScanSubmitMs;
        if (nowMs - state.lastSubmitAt >= minDelay) {
          state.scanInFlight = true;
          state.lastSubmittedBits = bestBits;
          state.lastSubmitAt = nowMs;
          submit = { observedBits: bestBits, candidateId: state.candidateId ?? undefined };
          emit(events, `→ send bits=0x${bestBits.toString(16).padStart(4, '0')} votes=${bestCount}/${state.recentBits.length} cand=${state.candidateId?.slice(-6) ?? 'none'}`);
        }
      }
    }

    return { events, submit, frame: frameState, state: getState() };
  }

  function handleScanResult(result) {
    const events = [];
    state.scanInFlight = false;
    if (result.verified && result.user && result.accessToken) {
      emit(events, '✅ VERIFIED');
      state.verified = true;
      state.scanLocked = true;
    } else if (result.matched) {
      emit(events, `🔒 hit=${result.hits} cand=...${result.candidateId?.slice(-6)}`);
      state.candidateId = result.candidateId ?? state.candidateId;
      state.scanLocked = true;
      state.matchedBitsAwaitingChange = state.lastSubmittedBits;
    } else {
      emit(events, '❌ no match — pool scan');
      state.candidateId = null;
      state.scanLocked = false;
    }
    return { events, state: getState() };
  }

  function handleScanError(error) {
    const events = [];
    state.scanInFlight = false;
    const status = error?.response?.status ?? '?';
    const data = error?.response?.data;
    const cf = error?.response?.headers?.['cf-ray'] ? ' [CF]' : '';
    emit(events, `req failed: ${status}${cf} ${JSON.stringify(data)}`, 'error');
    return { events, state: getState() };
  }

  function getState() {
    return {
      candidateId: state.candidateId,
      trackingMode: state.trackingMode,
      lockedQuad: state.lockedQuad,
      verified: state.verified,
      scanLocked: state.scanLocked,
      scanInFlight: state.scanInFlight,
      stableQuadCount: state.stableQuadCount,
      badFrames: state.badFrames,
    };
  }

  return {
    stepFrame,
    handleScanResult,
    handleScanError,
    getState,
  };
}
