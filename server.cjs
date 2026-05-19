'use strict';

const crypto = require('crypto');
const {
  applyArcAnchors,
  hammingDistance,
  payloadBits,
} = require('./index.cjs');

const SESSION_TTL_MS = 60_000;
const SESSION_CHALLENGE_TTL_MS = SESSION_TTL_MS;
const ARC_LOCK_MISS_TOLERANCE = 3;
const ARC_NEAR_MISS_BITS = 3;

const store = new Map();

function fmtBits(bits) {
  return `0x${bits.toString(16).padStart(4, '0')}`;
}

function fmtPayload(bits) {
  return `0x${payloadBits(bits).toString(16).padStart(3, '0')}`;
}

function getNowMs(ctx) {
  return typeof ctx?.nowMs === 'number' ? ctx.nowMs : Date.now();
}

function closestSlotIndex(activeIndex, activeDistance, prevBits, prevDistance) {
  if (prevBits === null) return activeIndex;
  return prevDistance <= activeDistance ? activeIndex - 1 : activeIndex;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt.getTime() < now - 120_000) store.delete(id);
  }
}, 30_000);

function generateFrameBits(seed, nonce, frameIndex) {
  const mac = crypto
    .createHmac('sha256', seed)
    .update(`${nonce}:${frameIndex}`)
    .digest();
  const bits = ((mac[0] << 8) | mac[1]) & 0xffff;
  return applyArcAnchors(bits);
}

function randomDelta(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getActiveSlot(slots, sessionStart, nowMs = Date.now()) {
  const elapsed = nowMs - sessionStart.getTime();
  if (elapsed < 0) return null;
  let acc = 0;
  for (let i = 0; i < slots.length; i++) {
    acc += slots[i].durationMs;
    if (elapsed < acc) return { slot: slots[i], index: i };
  }
  return null;
}

async function createArcChallenge(_ctx, userId) {
  const nowMs = getNowMs(_ctx);
  const seed = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(16).toString('hex');
  const sessionStart = new Date(nowMs);
  const expiresAt = new Date(sessionStart.getTime() + SESSION_TTL_MS);
  const id = crypto.randomUUID();

  const slots = [];
  let remaining = SESSION_TTL_MS;
  let i = 0;
  while (remaining > 0) {
    const dur = Math.min(randomDelta(1500, 2000), remaining);
    slots.push({ bits: generateFrameBits(seed, nonce, i), durationMs: dur });
    remaining -= dur;
    i++;
  }

  store.set(id, {
    id,
    slots,
    sessionStart,
    expiresAt,
    userId: userId ?? null,
    status: 'PENDING',
    consecutiveHits: 0,
    consecutiveMisses: 0,
    lastHitSlotIndex: -1,
    candidateIp: null,
  });

  console.log(`[ARC] challenge created id=${id.slice(-6)} userId=${userId ?? 'none'} slots=${slots.length} firstBits=0x${slots[0].bits.toString(16).padStart(4,'0')}`);

  return {
    challengeId: id,
    slots,
    sessionStart: sessionStart.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function getArcChallengeStatus(challengeId) {
  const entry = store.get(challengeId);
  if (!entry) return { status: 'expired' };
  if (entry.status === 'VERIFIED' && entry.userId) return { status: 'verified', userId: entry.userId };
  if (entry.status === 'EXPIRED') return { status: 'expired' };
  if (entry.expiresAt.getTime() < Date.now()) {
    entry.status = 'EXPIRED';
    return { status: 'expired' };
  }
  return { status: 'pending' };
}

async function scanArcPattern(observedBits, candidateId, ipHash, _ctx) {
  const nowMs = getNowMs(_ctx);
  const now = new Date(nowMs);
  console.log(
    `[ARC scan] observed=${fmtBits(observedBits)} payload=${fmtPayload(observedBits)} candidate=${candidateId ? candidateId.slice(-6) : 'none'} ip=${ipHash?.slice(-6) ?? 'null'}`
  );

  if (candidateId) {
    const entry = store.get(candidateId);
    if (!entry) {
      console.log(`[ARC lock] reject candidate=${candidateId.slice(-6)} reason=missing`);
      return { matched: false };
    }
    if (entry.status !== 'PENDING') {
      console.log(`[ARC lock] reject candidate=${candidateId.slice(-6)} reason=status:${entry.status}`);
      return { matched: false };
    }
    if (entry.expiresAt < now) {
      console.log(`[ARC lock] reject candidate=${candidateId.slice(-6)} reason=expired`);
      return { matched: false };
    }
    if (entry.candidateIp && entry.candidateIp !== ipHash) {
      console.log(
        `[ARC lock] reject candidate=${candidateId.slice(-6)} reason=ip-mismatch locked=${entry.candidateIp?.slice(-6) ?? 'null'} got=${ipHash?.slice(-6) ?? 'null'}`
      );
      return { matched: false };
    }

    const active = getActiveSlot(entry.slots, entry.sessionStart, nowMs);
    if (!active) {
      console.log(`[ARC lock] reject candidate=${candidateId.slice(-6)} reason=no-active-slot`);
      return { matched: false };
    }

    const { slot: activeSlot, index: activeIndex } = active;
    const prevBits = activeIndex > 0 ? entry.slots[activeIndex - 1].bits : null;

    if (activeIndex === entry.lastHitSlotIndex) {
      entry.consecutiveMisses = 0;
      return { matched: true, candidateId: entry.id, hits: entry.consecutiveHits };
    }

    const observedPayload = payloadBits(observedBits);
    const activePayload = payloadBits(activeSlot.bits);
    const prevPayload = prevBits !== null ? payloadBits(prevBits) : null;
    const activeDistance = hammingDistance(observedBits, activeSlot.bits);
    const prevDistance = prevBits !== null ? hammingDistance(observedBits, prevBits) : Number.POSITIVE_INFINITY;
    const prevIndex = activeIndex - 1;
    console.log(
      `[ARC lock] candidate=${entry.id.slice(-6)} slot=${activeIndex} hits=${entry.consecutiveHits} observed=${fmtBits(observedBits)}/${fmtPayload(observedBits)} active=${fmtBits(activeSlot.bits)}/${fmtPayload(activeSlot.bits)} prev=${prevBits !== null ? `${fmtBits(prevBits)}/${fmtPayload(prevBits)}` : 'none'} dist=${activeDistance}/${Number.isFinite(prevDistance) ? prevDistance : '-'}`
    );

    if (observedPayload === activePayload && activeIndex > entry.lastHitSlotIndex) {
      const newHits = entry.consecutiveHits + 1;
      entry.consecutiveHits = newHits;
      entry.consecutiveMisses = 0;
      entry.lastHitSlotIndex = activeIndex;
      entry.candidateIp = ipHash;
      console.log(
        `[ARC lock] hit candidate=${entry.id.slice(-6)} slot=${activeIndex} hits=${newHits}/3 payload=${fmtPayload(observedBits)}`
      );
      if (newHits >= 3) {
        entry.status = 'VERIFIED';
        entry.usedAt = now;
        console.log(
          `[ARC lock] ✅ VERIFIED candidate=${entry.id.slice(-6)} userId=${entry.userId ?? 'none'} observed=${fmtBits(observedBits)}`
        );
        return { matched: true, verified: true, challengeId: entry.id, hits: newHits, userId: entry.userId ?? undefined };
      }
      return { matched: true, candidateId: entry.id, hits: newHits };
    }

    if (prevPayload !== null && observedPayload === prevPayload) {
      if (prevIndex > entry.lastHitSlotIndex) {
        const newHits = entry.consecutiveHits + 1;
        entry.consecutiveHits = newHits;
        entry.consecutiveMisses = 0;
        entry.lastHitSlotIndex = prevIndex;
        entry.candidateIp = ipHash;
        console.log(
          `[ARC lock] hit-prev candidate=${entry.id.slice(-6)} slot=${prevIndex} hits=${newHits}/3 payload=${fmtPayload(observedBits)}`
        );
        if (newHits >= 3) {
          entry.status = 'VERIFIED';
          entry.usedAt = now;
          console.log(
            `[ARC lock] ✅ VERIFIED candidate=${entry.id.slice(-6)} userId=${entry.userId ?? 'none'} observed=${fmtBits(observedBits)} via=prev`
          );
          return { matched: true, verified: true, challengeId: entry.id, hits: newHits, userId: entry.userId ?? undefined };
        }
        return { matched: true, candidateId: entry.id, hits: newHits };
      }
      entry.consecutiveMisses = 0;
      console.log(
        `[ARC lock] stale-prev candidate=${entry.id.slice(-6)} prevSlot=${prevIndex} hits=${entry.consecutiveHits}/3 payload=${fmtPayload(observedBits)}`
      );
      return { matched: true, candidateId: entry.id, hits: entry.consecutiveHits };
    }

    if (Math.min(activeDistance, prevDistance) <= ARC_NEAR_MISS_BITS) {
      entry.consecutiveMisses = 0;
      console.log(
        `[ARC lock] near miss candidate=${entry.id.slice(-6)} hit=${entry.consecutiveHits} activeDist=${activeDistance} prevDist=${Number.isFinite(prevDistance) ? prevDistance : '-'}`
      );
      return { matched: true, candidateId: entry.id, hits: entry.consecutiveHits };
    }

    entry.consecutiveMisses++;
    if (entry.consecutiveMisses < ARC_LOCK_MISS_TOLERANCE) {
      console.log(
        `[ARC lock] hold candidate=${entry.id.slice(-6)} miss=${entry.consecutiveMisses}/${ARC_LOCK_MISS_TOLERANCE} activeDist=${activeDistance} prevDist=${Number.isFinite(prevDistance) ? prevDistance : '-'}`
      );
      return { matched: true, candidateId: entry.id, hits: entry.consecutiveHits };
    }

    entry.consecutiveHits = 0;
    entry.consecutiveMisses = 0;
    entry.lastHitSlotIndex = -1;
    entry.candidateIp = null;
    console.log(
      `[ARC lock] unlock candidate=${entry.id.slice(-6)} reason=miss-tolerance observed=${fmtBits(observedBits)}`
    );
    return { matched: false };
  }

  const storeSize = store.size;
  if (storeSize === 0) {
    console.log(`[ARC pool] empty observed=${fmtBits(observedBits)}`);
    return { matched: false };
  }
  console.log(`[ARC pool] store=${storeSize} observed=${fmtBits(observedBits)} payload=${fmtPayload(observedBits)} ip=${ipHash?.slice(-6) ?? 'null'}`);

  for (const [entryId, entry] of store) {
    if (entry.status !== 'PENDING') { console.log(`[ARC pool]   skip ${entry.id.slice(-6)} status=${entry.status}`); continue; }
    if (entry.expiresAt < now) { store.delete(entryId); console.log(`[ARC pool]   skip ${entry.id.slice(-6)} EXPIRED`); continue; }
    if (entry.candidateIp !== null && entry.candidateIp !== ipHash) { console.log(`[ARC pool]   skip ${entry.id.slice(-6)} ip-locked`); continue; }

    const active = getActiveSlot(entry.slots, entry.sessionStart, nowMs);
    if (!active) { console.log(`[ARC pool]   skip ${entry.id.slice(-6)} slots exhausted`); continue; }

    const prevBits = active.index > 0 ? entry.slots[active.index - 1].bits : null;
    const activeDistance = hammingDistance(observedBits, active.slot.bits);
    const prevDistance = prevBits !== null ? hammingDistance(observedBits, prevBits) : Number.POSITIVE_INFINITY;
    console.log(
      `[ARC pool]   entry=${entry.id.slice(-6)} activeSlot[${active.index}]=${fmtBits(active.slot.bits)}/${fmtPayload(active.slot.bits)} prev=${prevBits !== null ? `${fmtBits(prevBits)}/${fmtPayload(prevBits)}` : 'none'} observed=${fmtBits(observedBits)}/${fmtPayload(observedBits)} dist=${activeDistance}/${Number.isFinite(prevDistance) ? prevDistance : '-'}`
    );

    const observedPayload = payloadBits(observedBits);
    const isActive = payloadBits(active.slot.bits) === observedPayload;
    const isPrev = prevBits !== null && payloadBits(prevBits) === observedPayload;
    if (!isActive && !isPrev) {
      if (Math.min(activeDistance, prevDistance) > ARC_NEAR_MISS_BITS) {
        continue;
      }
      console.log(
        `[ARC pool]   near miss candidate=${entry.id.slice(-6)} activeDist=${activeDistance} prevDist=${Number.isFinite(prevDistance) ? prevDistance : '-'}`
      );
    }

    const matchedSlotIndex = isActive
      ? active.index
      : isPrev
        ? active.index - 1
        : closestSlotIndex(active.index, activeDistance, prevBits, prevDistance);
    entry.consecutiveHits = 1;
    entry.consecutiveMisses = 0;
    entry.lastHitSlotIndex = matchedSlotIndex;
    entry.candidateIp = ipHash;
    console.log(
      `[ARC pool]   ✅ LOCKED onto ${entry.id.slice(-6)} slot=${matchedSlotIndex} source=${isActive ? 'active' : isPrev ? 'prev' : matchedSlotIndex === active.index ? 'near-active' : 'near-prev'} hits=1/3`
    );
    return { matched: true, candidateId: entry.id, hits: 1 };
  }

  console.log(`[ARC pool] no-match observed=${fmtBits(observedBits)} payload=${fmtPayload(observedBits)}`);
  return { matched: false };
}

async function bindArcChallengeUser(challengeId, userId) {
  const entry = store.get(challengeId);
  if (entry) entry.userId = userId;
}

function createArcRouteHarness(deps) {
  const {
    issueSession,
    publicSessionUser,
    getUserById,
    logArcLogin,
  } = deps;

  const USER_PUBLIC_SELECT = {
    id: true,
    panomId: true,
    firstName: true,
    avatar: true,
    vacationMode: true,
    locale: true,
    theme: true,
    isAdmin: true,
    isDeleted: true,
  };

  async function audit(ctx, outcome, opts = {}) {
    if (!logArcLogin) return;
    try {
      await logArcLogin(ctx, outcome, opts);
    } catch {
      // audit must never break auth
    }
  }

  return {
    async challenge(ctx) {
      return { statusCode: 200, body: await createArcChallenge(ctx) };
    },
    async sessionChallenge(ctx, userId) {
      return { statusCode: 200, body: await createArcChallenge(ctx, userId) };
    },
    async status(ctx, challengeId) {
      if (!challengeId || typeof challengeId !== 'string') {
        return { statusCode: 400, body: { error: 'Invalid challengeId' } };
      }
      const status = await getArcChallengeStatus(challengeId);
      if (status.status === 'verified' && status.userId) {
        const user = await getUserById(status.userId, USER_PUBLIC_SELECT);
        if (!user || user.isDeleted) {
          await audit(ctx, 'FAILURE', { userId: status.userId, reason: 'user_not_found_or_deleted' });
          return { statusCode: 200, body: { status: 'expired' } };
        }
        const responseShell = {};
        const { accessToken, refreshToken } = await issueSession(responseShell, user, ctx);
        await audit(ctx, 'SUCCESS', { userId: user.id });
        return {
          statusCode: 200,
          body: { status: 'verified', accessToken, refreshToken, user: publicSessionUser(user, false) },
        };
      }
      return { statusCode: 200, body: { status: status.status } };
    },
    async scan(ctx, observedBits, candidateId) {
      if (typeof observedBits !== 'number' || observedBits < 0 || observedBits > 0xffff) {
        console.log(`[ARC route] reject scan reason=invalid-bits got=${String(observedBits)}`);
        return { statusCode: 400, body: { error: 'observedBits must be a 16-bit integer' } };
      }
      if (candidateId !== undefined && typeof candidateId !== 'string') {
        console.log(`[ARC route] reject scan reason=invalid-candidate-id got=${typeof candidateId}`);
        return { statusCode: 400, body: { error: 'candidateId must be a string' } };
      }

      const result = await scanArcPattern(observedBits, candidateId ?? undefined, ctx.ipHash ?? null, ctx);
      if (result.verified && !result.userId && result.challengeId && ctx.userId) {
        await bindArcChallengeUser(result.challengeId, ctx.userId);
        result.userId = ctx.userId;
      }
      console.log(
        `[ARC route] result observed=${fmtBits(observedBits)} candidate=${candidateId ? candidateId.slice(-6) : 'none'} matched=${result.matched ? 'yes' : 'no'} hits=${result.hits ?? 0} verified=${result.verified ? 'yes' : 'no'} next=${result.candidateId ? result.candidateId.slice(-6) : result.challengeId ? result.challengeId.slice(-6) : 'none'}`
      );
      if (result.verified && result.userId) {
        const user = await getUserById(result.userId, USER_PUBLIC_SELECT);
        if (!user || user.isDeleted) {
          console.log(`[ARC route] verified-user-missing challenge=${result.challengeId?.slice(-6) ?? 'none'} userId=${result.userId}`);
          await audit(ctx, 'FAILURE', { userId: result.userId, reason: 'user_not_found_or_deleted' });
          return { statusCode: 403, body: { error: 'User not found or deleted' } };
        }
        const responseShell = {};
        const { accessToken, refreshToken } = await issueSession(responseShell, user, ctx);
        console.log(`[ARC route] session-issued challenge=${result.challengeId?.slice(-6) ?? 'none'} userId=${user.id}`);
        await audit(ctx, 'SUCCESS', { userId: user.id });
        return {
          statusCode: 200,
          body: {
            matched: true,
            verified: true,
            hits: result.hits,
            accessToken,
            refreshToken,
            user: publicSessionUser(user, false),
          },
        };
      }
      return { statusCode: 200, body: result };
    },
  };
}

function createArcRouter(deps) {
  const router = deps.routerFactory ? deps.routerFactory() : null;
  if (!router) {
    throw new Error('createArcRouter requires deps.routerFactory');
  }
  const {
    authContext,
    issueSession,
    publicSessionUser,
    getUserById,
    logArcLogin,
    privacySanitizer,
    authMiddleware,
    requireFeature,
    ipLimiter,
    optionalAuthMiddleware,
    routerFactory,
  } = deps;

  const handlers = createArcRouteHarness({
    issueSession,
    publicSessionUser,
    getUserById,
    logArcLogin,
  });

  router.post(
    '/challenge',
    privacySanitizer,
    ipLimiter(10, 60_000),
    async (req, res) => {
      const ctx = authContext(req);
      try {
        const result = await handlers.challenge(ctx);
        return res.status(result.statusCode).json(result.body);
      } catch (err) {
        console.error('[ARC] challenge creation error:', err);
        return res.status(500).json({ error: 'Failed to create challenge' });
      }
    }
  );

  router.get(
    '/status/:challengeId',
    ipLimiter(240, 60_000),
    async (req, res) => {
      const { challengeId } = req.params;
      if (!challengeId || typeof challengeId !== 'string') {
        return res.status(400).json({ error: 'Invalid challengeId' });
      }

      const ctx = authContext(req);
      try {
        const result = await handlers.status(ctx, challengeId);
        return res.status(result.statusCode).json(result.body);
      } catch (err) {
        console.error('[ARC] status poll error:', err);
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  router.post(
    '/session-challenge',
    privacySanitizer,
    requireFeature('arcEnabled'),
    authMiddleware,
    async (req, res) => {
      const ctx = authContext(req);
      const userId = req.user.id;
      try {
        const result = await handlers.sessionChallenge(ctx, userId);
        return res.status(result.statusCode).json(result.body);
      } catch (err) {
        console.error('[ARC] session-challenge error:', err);
        return res.status(500).json({ error: 'Failed to create challenge' });
      }
    }
  );

  router.post(
    '/scan',
    privacySanitizer,
    ...(optionalAuthMiddleware ? [optionalAuthMiddleware] : []),
    ipLimiter(360, 60_000),
    async (req, res) => {
      const ctx = { ...authContext(req), userId: req.user?.id ?? null };
      const { observedBits, candidateId } = req.body;
      try {
        const result = await handlers.scan(ctx, observedBits, candidateId ?? undefined);
        return res.status(result.statusCode).json(result.body);
      } catch (err) {
        console.error('[ARC] scan error:', err);
        return res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  return router;
}

module.exports = {
  SESSION_CHALLENGE_TTL_MS,
  createArcChallenge,
  getArcChallengeStatus,
  scanArcPattern,
  bindArcChallengeUser,
  createArcRouteHarness,
  createArcRouter,
};
