export * from './shared';
import type { Request, Response, RequestHandler } from 'express';
import type { ArcScanResult } from './shared';

export interface ArcAuthContext {
  ipHash?: string | null;
  ipEnc?: string | null;
  userAgent?: string | null;
  nowMs?: number;
  userId?: string | null;
}

export interface ArcRouterDeps {
  authContext(req: Request): ArcAuthContext;
  issueSession(res: Response, user: any, ctx: ArcAuthContext): Promise<{ accessToken: string; refreshToken: string }>;
  publicSessionUser(user: any, isNewUser: boolean): any;
  getUserById(userId: string, select?: any): Promise<any>;
  logArcLogin?(
    ctx: ArcAuthContext,
    outcome: 'SUCCESS' | 'FAILURE',
    opts?: { userId?: string; reason?: string },
  ): Promise<void>;
  privacySanitizer: RequestHandler;
  authMiddleware: RequestHandler;
  requireFeature(feature: string): RequestHandler;
  ipLimiter(limit: number, windowMs: number): RequestHandler;
  optionalAuthMiddleware?: RequestHandler;
  routerFactory(): any;
}

export declare const SESSION_CHALLENGE_TTL_MS: number;
export declare function createArcChallenge(ctx: ArcAuthContext, userId?: string): Promise<{
  challengeId: string;
  slots: import('./shared').ArcSlot[];
  sessionStart: string;
  expiresAt: string;
}>;
export declare function getArcChallengeStatus(challengeId: string): Promise<{
  status: 'pending' | 'verified' | 'expired';
  userId?: string;
}>;
export declare function scanArcPattern(
  observedBits: number,
  candidateId: string | undefined,
  ipHash: string | null,
  ctx: ArcAuthContext,
): Promise<ArcScanResult>;
export declare function bindArcChallengeUser(challengeId: string, userId: string): Promise<void>;
export declare function createArcRouteHarness(deps: Pick<ArcRouterDeps, 'issueSession' | 'publicSessionUser' | 'getUserById' | 'logArcLogin'>): {
  challenge(ctx: ArcAuthContext): Promise<{ statusCode: number; body: any }>;
  sessionChallenge(ctx: ArcAuthContext, userId: string): Promise<{ statusCode: number; body: any }>;
  status(ctx: ArcAuthContext, challengeId: string, res?: Response): Promise<{ statusCode: number; body: any }>;
  scan(ctx: ArcAuthContext, observedBits: number, candidateId?: string, res?: Response): Promise<{ statusCode: number; body: any }>;
};
export declare function createArcRouter(deps: ArcRouterDeps): any;
