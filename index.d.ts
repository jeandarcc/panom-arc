export declare const ARC_ANCHOR_MASK = 0x9009;
export declare const ARC_ANCHOR_ON = 0x100d;
export declare const ARC_PAYLOAD_MASK: number;
export declare const ARC_PAYLOAD_INDICES: readonly number[];
export declare const DEFAULT_WIDTH = 320;
export declare const DEFAULT_HEIGHT = 240;

export type ArcPoint = { x: number; y: number };
export type ArcQuad = [ArcPoint, ArcPoint, ArcPoint, ArcPoint];
export type ArcDetection = {
  bits: number;
  score: number;
  quad: ArcQuad;
  cornerLums: number[];
};
export type ArcScenario = {
  label?: string;
  side: number;
  cx: number;
  cy: number;
  angleRad?: number;
};
export type ArcFixture = { label: string; bits: number };
export type ArcSlot = { bits: number; durationMs: number };
export type ArcChallengeResult = {
  challengeId: string;
  slots: ArcSlot[];
  sessionStart: string;
  expiresAt: string;
};
export type ArcStatusResult = {
  status: 'pending' | 'verified' | 'expired';
  userId?: string;
  user?: {
    id: string;
    firstName: string;
    panomId: string;
    avatar: string | null;
    isAdmin: boolean;
    vacationMode: boolean;
    locale: string;
    theme: string;
    isNewUser: boolean;
  };
  accessToken?: string;
  refreshToken?: string;
};
export type ArcScanResult = {
  matched: boolean;
  candidateId?: string;
  hits?: number;
  verified?: boolean;
  challengeId?: string;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: ArcStatusResult['user'];
};

export declare function applyArcAnchors(bits: number): number;
export declare function payloadBits(bits: number): number;
export declare function hammingDistance(a: number, b: number): number;
export declare function isArcCellOn(bits: number, bitIndex: number): boolean;
export declare function gridText(bits: number): string;
export declare function xorshift32(seed: number): () => number;
export declare function renderArcToPixels(
  bits: number,
  scenario: ArcScenario,
  options?: { width?: number; height?: number },
): Uint8ClampedArray;
export declare function makeArcFixtures(count?: number, seed?: number): ArcFixture[];
export declare function makeArcScenarios(
  count: number,
  options?: {
    width?: number;
    height?: number;
    seed?: number;
    minSide?: number;
    maxSide?: number;
    maxRotationDeg?: number;
  },
): Required<ArcScenario>[];
export declare function preprocessArcFrameFromRgba(
  data: Uint8ClampedArray | Uint8Array | number[],
  options?: { width?: number; height?: number },
): {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
  analysisGray: Uint8ClampedArray;
  dark: Uint8Array;
};
export declare function detectArcPatternFromRgba(
  data: Uint8ClampedArray | Uint8Array | number[],
  options?: { width?: number; height?: number; focusRect?: { x: number; y: number; width: number; height: number } },
): ArcDetection | null;
