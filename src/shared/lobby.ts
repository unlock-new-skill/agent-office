import type { AgentSnapshot } from './contracts.js';

/** A session quiet this long (no hook, no wake poll) is treated as gone; listening sessions poll at least once a minute. */
export const LOBBY_QUIET_MS = 5 * 60_000;

/** Unseated sessions worth showing in the lobby: still running, not dismissed by the manager, recently in touch. */
export const isLobbySession = (agent: AgentSnapshot, now = Date.now()): boolean =>
  agent.contactState !== 'exited' && !agent.dismissed && (agent.lastContactAt == null || now - agent.lastContactAt < LOBBY_QUIET_MS);
