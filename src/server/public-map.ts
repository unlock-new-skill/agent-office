import type { AgentSnapshot, OrgView } from '../shared/contracts.js';
import { isLobbySession } from '../shared/lobby.js';

/**
 * What an anonymous visitor of /map may see: departments, seats and their live status. Session ids, project paths,
 * seat descriptions, channels and messages are left out, and agent ids are replaced by per-response aliases.
 */
export const publicMap = (org: OrgView, agents: AgentSnapshot[], now = Date.now()): { org: OrgView; agents: AgentSnapshot[] } => {
  const aliases = new Map<string, string>();
  const alias = (id: string): string => { let value = aliases.get(id); if (!value) { value = `a${aliases.size + 1}`; aliases.set(id, value); } return value; };
  const seated = new Set(org.seats.map(seat => seat.agentId).filter((id): id is string => Boolean(id)));
  const visible = agents.filter(agent => seated.has(agent.id) || isLobbySession(agent, now));
  return {
    org: {
      departments: org.departments.map(department => ({ ...department, deputySeatId: null })),
      seats: org.seats.map(seat => ({ ...seat, description: '', agentId: seat.agentId ? alias(seat.agentId) : null })),
      channels: [],
    },
    agents: visible.map(agent => ({
      id: alias(agent.id), project: '', source: 'claude', sessionId: '', sessionIncarnation: '', state: agent.state, contactState: agent.contactState,
      lastEventAt: null, currentTool: agent.currentTool, pendingInvocations: 0, pendingPermissions: agent.pendingPermissions > 0 ? 1 : 0, lastContactAt: agent.lastContactAt ?? null, dismissed: false,
    })),
  };
};
