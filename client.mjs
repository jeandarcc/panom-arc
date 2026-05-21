import { computed, onUnmounted, ref, watch } from 'vue';
import {
  detectArcPatternFromRgba,
  isArcCellOn,
  preprocessArcFrameFromRgba,
} from './shared.mjs';

export function createArcHttpClient(http) {
  return {
    createChallenge: () => http.post('/auth/arc/challenge').then((r) => r.data),
    pollStatus: (challengeId) => http.get(`/auth/arc/status/${challengeId}`).then((r) => r.data),
    createSessionChallenge: () => http.post('/auth/arc/session-challenge').then((r) => r.data),
    scan: (observedBits, candidateId) =>
      http.post('/auth/arc/scan', { observedBits, candidateId }).then((r) => r.data),
  };
}

export function useArcSlotPlayback(props, emit = {}) {
  const currentSlotIndex = ref(0);
  const currentBits = computed(() => props.slots[currentSlotIndex.value]?.bits ?? 0);
  let timer = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getSyncedStart() {
    if (!props.sessionStart) {
      return { slotIndex: 0, remainingMs: props.slots[0]?.durationMs ?? 0 };
    }
    const elapsed = Date.now() - new Date(props.sessionStart).getTime();
    let acc = 0;
    for (let i = 0; i < props.slots.length; i++) {
      acc += props.slots[i].durationMs;
      if (elapsed < acc) {
        return { slotIndex: i, remainingMs: acc - elapsed };
      }
    }
    return { slotIndex: props.slots.length, remainingMs: 0 };
  }

  function scheduleNext(overrideMs) {
    if (!props.active) return;
    const slot = props.slots[currentSlotIndex.value];
    if (!slot) {
      emit.expired?.();
      return;
    }
    emit.slotChanged?.(slot.bits, currentSlotIndex.value);
    timer = setTimeout(() => {
      currentSlotIndex.value++;
      scheduleNext();
    }, overrideMs ?? slot.durationMs);
  }

  function startSequence() {
    clearTimer();
    const { slotIndex, remainingMs } = getSyncedStart();
    if (slotIndex >= props.slots.length) {
      emit.expired?.();
      return;
    }
    currentSlotIndex.value = slotIndex;
    scheduleNext(remainingMs);
  }

  watch(
    () => props.active,
    (active) => {
      if (active) startSequence();
      else clearTimer();
    },
  );

  watch(
    () => props.slots,
    () => {
      if (props.active) startSequence();
    },
  );

  onUnmounted(clearTimer);

  return {
    currentSlotIndex,
    currentBits,
    startSequence,
    clearTimer,
    isCellOn: (row, col) => isArcCellOn(currentBits.value, row * 4 + col),
  };
}

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
      return {
        processed,
        focusRect,
        acceptedBits: null,
        overlayQuad: state.lockedQuad,
        overlayState: 'rejected',
        detection: null,
      };
    }

    const focusOverlap = overlapRatioWithRect(detection.quad, focusRect);
    if (focusOverlap < 0.42) {
      emit(events, `focus reject overlap=${focusOverlap.toFixed(2)}`, 'warn');
      return {
        processed,
        focusRect,
        acceptedBits: null,
        overlayQuad: detection.quad,
        overlayState: 'rejected',
        detection,
      };
    }

    if (!hasQuietZone(processed.gray, width, height, detection.quad)) {
      emit(events, 'quiet-zone reject', 'warn');
      return {
        processed,
        focusRect,
        acceptedBits: null,
        overlayQuad: detection.quad,
        overlayState: 'rejected',
        detection,
      };
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
        emit(
          events,
          `stabilizing bits=0x${frameState.acceptedBits.toString(16).padStart(4, '0')} votes=${bestCount}/${requiredVotes} ` +
          `window=${state.recentBits.map((v) => v.toString(16).padStart(4, '0')).join(',')}`
        );
      } else if (bestBits !== state.matchedBitsAwaitingChange) {
        const isDuplicate = bestBits === state.lastSubmittedBits;
        const minDelay = isDuplicate ? duplicateScanSubmitMs : minScanSubmitMs;
        if (nowMs - state.lastSubmitAt >= minDelay) {
          state.scanInFlight = true;
          state.lastSubmittedBits = bestBits;
          state.lastSubmitAt = nowMs;
          submit = {
            observedBits: bestBits,
            candidateId: state.candidateId ?? undefined,
          };
          emit(
            events,
            `→ send bits=0x${bestBits.toString(16).padStart(4, '0')} votes=${bestCount}/${state.recentBits.length} ` +
            `cand=${state.candidateId?.slice(-6) ?? 'none'}`
          );
        }
      }
    }

    return { events, submit, frame: frameState, state: getState() };
  }

  function handleScanResult(result) {
    const events = [];
    state.scanInFlight = false;
    if (result.verified && result.user) {
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

export function useArcAuthScanner(options) {
  const {
    videoRef,
    canvasRef,
    scan,
    onVerified,
    onMatched,
    onNoMatch,
    onTimeout,
    onDebug,
    scanIntervalMs = 200,
    sessionTimeoutMs = 60_000,
    requiredStableFrames = 2,
    stableWindowSize = 6,
    minScanSubmitMs = 250,
    duplicateScanSubmitMs = 700,
    maxLogs = 40,
    showProcessedPreview = false,
  } = options;

  const stream = ref(null);
  const cameraReady = ref(false);
  const cameraBlocked = ref(false);
  const verified = ref(false);
  const scanLocked = ref(false);
  const debugLogs = ref([]);
  const videoAspectRatio = ref(3 / 4);

  const engine = createArcScannerEngine({
    requiredStableFrames,
    stableWindowSize,
    minScanSubmitMs,
    duplicateScanSubmitMs,
  });

  let scanInterval = null;
  let timeoutHandle = null;

  function pushLog(msg, level = 'info') {
    const t = new Date().toISOString().slice(11, 23);
    debugLogs.value.unshift({ t, msg, level });
    if (debugLogs.value.length > maxLogs) debugLogs.value.length = maxLogs;
    onDebug?.(msg, level);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraBlocked.value = true;
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      stream.value = s;
      if (videoRef.value) {
        videoRef.value.srcObject = s;
        await new Promise((resolve) => {
          const video = videoRef.value;
          if (!video) {
            resolve();
            return;
          }

          const syncAspect = () => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              videoAspectRatio.value = video.videoWidth / video.videoHeight;
            }
            resolve();
          };

          if (video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0) {
            syncAspect();
            return;
          }

          video.addEventListener('loadedmetadata', syncAspect, { once: true });
        });
        cameraReady.value = true;
        pushLog(`camera ready ✓ ${videoRef.value.videoWidth}x${videoRef.value.videoHeight}`);
      }
    } catch (e) {
      cameraBlocked.value = true;
      pushLog(`camera blocked: ${e?.message ?? e}`, 'error');
    }
  }

  function stopCamera() {
    stream.value?.getTracks().forEach((t) => t.stop());
    stream.value = null;
  }

  function syncEngineState() {
    const state = engine.getState();
    verified.value = state.verified;
    scanLocked.value = state.scanLocked;
  }

  function emitEngineEvents(events) {
    for (const event of events) pushLog(event.msg, event.level);
    syncEngineState();
  }

  function captureFrameStep() {
    const video = videoRef.value;
    const canvas = canvasRef.value;
    if (!video || !canvas || !cameraReady.value) {
      pushLog('not ready', 'warn');
      return null;
    }

    const sourceWidth = video.videoWidth || 320;
    const sourceHeight = video.videoHeight || 240;
    const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
    const W = Math.max(96, Math.round(sourceWidth * scale));
    const H = Math.max(96, Math.round(sourceHeight * scale));
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, W, H);

    const px = ctx.getImageData(0, 0, W, H).data;
    const processed = preprocessArcFrameFromRgba(px, { width: W, height: H });
    const focusSide = Math.round(Math.min(W, H) * 0.5);
    const focusRect = {
      x: (W - focusSide) / 2,
      y: (H - focusSide) / 2,
      width: focusSide,
      height: focusSide,
    };
    if (showProcessedPreview) {
      const out = new Uint8ClampedArray(W * H * 4);
      for (let i = 0, p = 0; i < processed.gray.length; i++, p += 4) {
        const lum = processed.gray[i];
        out[p] = lum;
        out[p + 1] = lum;
        out[p + 2] = lum;
        out[p + 3] = 255;
      }
      ctx.putImageData(new ImageData(out, W, H), 0, 0);
    } else {
      ctx.clearRect(0, 0, W, H);
    }
    const outcome = engine.stepFrame({ rgba: px, width: W, height: H, nowMs: Date.now() });
    emitEngineEvents(outcome.events);

    function drawQuad(quad, state) {
      if (!quad) return;
      ctx.strokeStyle = state === 'locked' ? '#00ff00' : state === 'pending' ? '#ffcc00' : '#ff3333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      ctx.lineTo(quad[1].x, quad[1].y);
      ctx.lineTo(quad[3].x, quad[3].y);
      ctx.lineTo(quad[2].x, quad[2].y);
      ctx.closePath();
      ctx.stroke();
    }

    function drawFocusRect() {
      if (!showProcessedPreview) return;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(focusRect.x, focusRect.y, focusRect.width, focusRect.height);
    }

    drawFocusRect();
    const frameState = outcome.frame;
    drawQuad(frameState.overlayQuad, frameState.overlayState);
    return outcome;
  }

  async function scanLoop() {
    if (verified.value) return;

    const outcome = captureFrameStep();
    if (!outcome?.submit) {
      return;
    }

    try {
      const result = await scan(outcome.submit.observedBits, outcome.submit.candidateId);
      const handled = engine.handleScanResult(result);
      emitEngineEvents(handled.events);

      if (result.verified && result.user) {
        clearInterval(scanInterval);
        scanInterval = null;
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
        stopCamera();
        await onVerified?.(result);
      } else if (result.matched) {
        onMatched?.(result);
      } else {
        onNoMatch?.();
      }
    } catch (e) {
      const handled = engine.handleScanError(e);
      emitEngineEvents(handled.events);
    }
  }

  function startScanning() {
    scanInterval = setInterval(scanLoop, scanIntervalMs);
    timeoutHandle = setTimeout(() => {
      stop();
      onTimeout?.();
    }, sessionTimeoutMs);
  }

  function stop() {
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    stopCamera();
  }

  return {
    stream,
    cameraReady,
    cameraBlocked,
    verified,
    scanLocked,
    debugLogs,
    videoAspectRatio,
    candidateId: () => engine.getState().candidateId,
    trackingMode: () => engine.getState().trackingMode,
    lockedQuad: () => engine.getState().lockedQuad,
    startCamera,
    stopCamera,
    startScanning,
    scanLoop,
    captureAndDetect: captureFrameStep,
    stop,
  };
}

export { isArcCellOn, detectArcPatternFromRgba, preprocessArcFrameFromRgba };
