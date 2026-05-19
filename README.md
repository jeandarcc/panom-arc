# `@panom/arc`

Camera-readable ARC authentication toolkit.

`@panom/arc` packages the full ARC stack in one place:

- shared grid and detection primitives
- Vue client helpers for rendering and camera scanning
- Express-friendly server routes
- realistic testing and simulation utilities

It is designed for device-linking flows like WhatsApp Web or Steam Guard, where one device shows a short-lived visual code and another authenticated device scans it.

## Installation

Install only the entrypoints you need.

```bash
npm install @panom/arc
```

Optional peer dependencies:

- `vue` for `@panom/arc/client`
- `express` for `@panom/arc/server`

## Package entrypoints

### `@panom/arc`

Shared types and low-level helpers:

- `applyArcAnchors`
- `payloadBits`
- `hammingDistance`
- `renderArcToPixels`
- `detectArcPatternFromRgba`
- `makeArcFixtures`
- `makeArcScenarios`

### `@panom/arc/client`

Vue-facing client helpers:

- `createArcHttpClient()`
- `useArcAuthScanner()`
- `useArcSlotPlayback()`
- `createArcScannerEngine()`

### `@panom/arc/server`

Server helpers:

- `createArcRouter()`
- `createArcRouteHarness()`
- `createArcChallenge()`
- `getArcChallengeStatus()`
- `scanArcPattern()`
- `bindArcChallengeUser()`

### `@panom/arc/testing`

Simulation and self-test helpers:

- `runArcCameraRoundTrip()`
- `runArcDifficultySweep()`
- `runArcRealisticAuthLoop()`
- `runArcNetworkProfileSweep()`
- `runArcStartupSelfTests()`

## Quick start

### 1. Server

```ts
import express, { Router } from 'express';
import {
  createArcRouter,
} from '@panom/arc/server';

const app = express();

app.use('/auth/arc', createArcRouter({
  routerFactory: () => Router(),
  authContext: (req) => ({
    ipHash: req.ip,
    ipEnc: null,
    userAgent: req.get('user-agent') ?? null,
    userId: req.user?.id ?? null,
  }),
  issueSession: async ({ user, res, accessToken, refreshToken }) => {
    res.json({ user, accessToken, refreshToken });
  },
  publicSessionUser: (user) => user,
  getUserById: async (userId) => findUser(userId),
  logArcLogin: async () => {},
  authMiddleware,
  optionalAuthMiddleware,
  privacySanitizer,
  requireFeature,
  ipLimiter,
}));
```

### 2. Client HTTP adapter

```ts
import axios from 'axios';
import { createArcHttpClient } from '@panom/arc/client';

const api = axios.create({ baseURL: '/api' });
const arcClient = createArcHttpClient(api);
```

### 3. Code display page

```ts
import type { ArcSlot } from '@panom/arc';
import { useArcSlotPlayback } from '@panom/arc/client';
```

Use `useArcSlotPlayback()` to render the active 4x4 ARC slot sequence on the device that needs to sign in.

### 4. Scanner page

```ts
import { ref } from 'vue';
import { useArcAuthScanner } from '@panom/arc/client';

const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const scanner = useArcAuthScanner({
  videoRef,
  canvasRef,
  scan: (observedBits, candidateId) => arcClient.scan(observedBits, candidateId),
  onVerified: async (result) => {
    console.log('ARC verified', result.user?.id);
  },
});
```

Then:

```ts
await scanner.startCamera();
scanner.startScanning();
```

## Device-linking model

Typical ARC flow:

1. Device A opens the ARC code page and requests `createChallenge()`.
2. Device A displays the animated 4x4 ARC sequence.
3. Device B is already authenticated and opens the scanner page.
4. Device B scans the ARC sequence and sends `scan(observedBits, candidateId?)`.
5. The server locks onto the correct challenge, verifies three slots, and binds the challenge to the scanning user.
6. Device A keeps polling `pollStatus(challengeId)` until the challenge becomes `verified`.
7. Device A receives the issued session tokens and signs in.

## Testing and simulation

Run the built-in self-test suite:

```bash
npm run selftest
```

This covers:

- baseline detector round-trips
- realistic camera degradation
- frontend-scanner plus backend-route auth loop
- network latency and jitter profiles
- PNG and JSON artifacts in `test-logs/`

## Publishing

Before publishing:

1. Make sure the version in `package.json` is correct.
2. Run:

   ```bash
   npm run pack:check
   npm run selftest
   ```

3. Log in to npm:

   ```bash
   npm login
   ```

4. Publish the scoped package publicly:

   ```bash
   npm publish --access public
   ```

See [`PUBLISHING.md`](./PUBLISHING.md) for a complete step-by-step release checklist.

## Notes

- The client entry is ESM-only at runtime.
- The server entry does not directly import Express; you pass your own router and middleware.
- The testing entry is intended for Node environments.
- `test-logs/` is generated output and is not published.
