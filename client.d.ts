export * from './shared';
import type { Ref, ComputedRef } from 'vue';
import type { ArcChallengeResult, ArcQuad, ArcScanResult, ArcSlot, ArcStatusResult } from './shared';

export interface ArcHttpClient {
  createChallenge(): Promise<ArcChallengeResult>;
  pollStatus(challengeId: string): Promise<ArcStatusResult>;
  createSessionChallenge(): Promise<ArcChallengeResult>;
  scan(observedBits: number, candidateId?: string): Promise<ArcScanResult>;
}

export declare function createArcHttpClient(http: {
  post<T = any>(url: string, body?: any): Promise<{ data: T }>;
  get<T = any>(url: string): Promise<{ data: T }>;
}): ArcHttpClient;

export interface ArcAuthScannerOptions {
  videoRef: Ref<HTMLVideoElement | null>;
  canvasRef: Ref<HTMLCanvasElement | null>;
  scan(observedBits: number, candidateId?: string): Promise<ArcScanResult>;
  onVerified?(result: ArcScanResult): void | Promise<void>;
  onMatched?(result: ArcScanResult): void;
  onNoMatch?(): void;
  onTimeout?(): void;
  onDebug?(message: string, level: 'info' | 'warn' | 'error'): void;
  scanIntervalMs?: number;
  sessionTimeoutMs?: number;
  requiredStableFrames?: number;
  stableWindowSize?: number;
  minScanSubmitMs?: number;
  duplicateScanSubmitMs?: number;
  maxLogs?: number;
  showProcessedPreview?: boolean;
}

export interface ArcScannerFrameInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  nowMs?: number;
}

export interface ArcScannerEvent {
  msg: string;
  level: 'info' | 'warn' | 'error';
}

export interface ArcScannerStepResult {
  events: ArcScannerEvent[];
  submit: null | { observedBits: number; candidateId?: string };
  frame: {
    processed: ReturnType<typeof import('./shared').preprocessArcFrameFromRgba>;
    focusRect: { x: number; y: number; width: number; height: number };
    acceptedBits: number | null;
    overlayQuad: ArcQuad | null;
    overlayState: 'locked' | 'pending' | 'rejected';
    detection: { bits: number; score: number; quad: ArcQuad } | null;
  };
  state: ArcScannerEngineStateSnapshot;
}

export interface ArcScannerEngineStateSnapshot {
  candidateId: string | null;
  trackingMode: 'SEARCH' | 'LOCKED';
  lockedQuad: ArcQuad | null;
  verified: boolean;
  scanLocked: boolean;
  scanInFlight: boolean;
  stableQuadCount: number;
  badFrames: number;
}

export interface ArcScannerEngine {
  stepFrame(frame: ArcScannerFrameInput): ArcScannerStepResult;
  handleScanResult(result: ArcScanResult): { events: ArcScannerEvent[]; state: ArcScannerEngineStateSnapshot };
  handleScanError(error: any): { events: ArcScannerEvent[]; state: ArcScannerEngineStateSnapshot };
  getState(): ArcScannerEngineStateSnapshot;
}

export declare function createArcScannerEngine(options?: Pick<ArcAuthScannerOptions, 'requiredStableFrames' | 'stableWindowSize' | 'minScanSubmitMs' | 'duplicateScanSubmitMs'>): ArcScannerEngine;

export interface ArcAuthScannerState {
  stream: Ref<MediaStream | null>;
  cameraReady: Ref<boolean>;
  cameraBlocked: Ref<boolean>;
  verified: Ref<boolean>;
  scanLocked: Ref<boolean>;
  debugLogs: Ref<{ t: string; msg: string; level: 'info' | 'warn' | 'error' }[]>;
  videoAspectRatio: Ref<number>;
  candidateId(): string | null;
  trackingMode(): 'SEARCH' | 'LOCKED';
  lockedQuad(): ArcQuad | null;
  startCamera(): Promise<void>;
  stopCamera(): void;
  startScanning(): void;
  scanLoop(): Promise<void>;
  captureAndDetect(): ArcScannerStepResult | null;
  stop(): void;
}

export declare function useArcAuthScanner(options: ArcAuthScannerOptions): ArcAuthScannerState;

export interface ArcSlotPlaybackProps {
  slots: ArcSlot[];
  active: boolean;
  sessionStart?: string;
}

export declare function useArcSlotPlayback(
  props: ArcSlotPlaybackProps,
  emit?: {
    expired?(): void;
    slotChanged?(bits: number, index: number): void;
  },
): {
  currentSlotIndex: Ref<number>;
  currentBits: ComputedRef<number>;
  startSequence(): void;
  clearTimer(): void;
  isCellOn(row: number, col: number): boolean;
};
