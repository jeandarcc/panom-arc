import server from './server.cjs';

export const SESSION_CHALLENGE_TTL_MS = server.SESSION_CHALLENGE_TTL_MS;
export const createArcChallenge = server.createArcChallenge;
export const getArcChallengeStatus = server.getArcChallengeStatus;
export const scanArcPattern = server.scanArcPattern;
export const bindArcChallengeUser = server.bindArcChallengeUser;
export const createArcRouteHarness = server.createArcRouteHarness;
export const createArcRouter = server.createArcRouter;

export default server;
