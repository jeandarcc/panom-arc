export * from './shared';
export interface ArcCameraRoundTripReport {
  total: number;
  scanCount: number;
  avgScanMs: number;
  minScanMs: number;
  maxScanMs: number;
  totalScanMs: number;
}
export interface ArcClientBackendSimulationReport {
  verifiedAtMs: number;
  timeToFirstLock: number | null;
  timeToCandidateId: number | null;
  submitsPerVerification: number;
  duplicateSubmitCount: number;
  wrongLockCount: number;
  nullFrameRatio: number;
  backendRejectReasonCounts: Record<string, number>;
  timeline: any[];
  profile?: string;
  verified?: boolean;
}
export interface ArcDifficultyLevelReport {
  level: number;
  severity: number;
  total: number;
  detectedCount: number;
  exactMatches: number;
  detectionRate: number;
  exactMatchRate: number;
  avgScanMs: number;
  minScanMs: number;
  maxScanMs: number;
}
export interface ArcDifficultySweepReport {
  levels: ArcDifficultyLevelReport[] | any[];
  scanScore: number;
  detectorScore?: number;
  rating: string;
}
export interface ArcNetworkProfileRunReport {
  profile: string;
  verified: boolean;
  verifiedAtMs: number | null;
}
export interface ArcNetworkProfileSweepReport {
  profiles: any[];
  networkResilienceScore: number;
  rating: string;
}
export declare function runArcCameraRoundTrip(): ArcCameraRoundTripReport | Promise<ArcCameraRoundTripReport>;
export declare function runArcClientBackendSimulation(): Promise<ArcClientBackendSimulationReport>;
export declare function runArcAdversarialCameraSimulation(): ArcDifficultySweepReport | Promise<ArcDifficultySweepReport>;
export declare function runArcDifficultySweep(): ArcDifficultySweepReport | Promise<ArcDifficultySweepReport>;
export declare function runArcRealisticAuthLoop(): Promise<ArcClientBackendSimulationReport>;
export declare function runArcNetworkProfileSweep(): Promise<ArcNetworkProfileSweepReport>;
export declare function runArcStartupSelfTests(): Promise<any> | void;
