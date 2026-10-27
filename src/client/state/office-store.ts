import type { AgentSnapshot, ChatMessage, CollabEvent, OrgView, PermissionRequest, Seat, Snapshot, Task } from '../../shared/contracts.js';

export type OfficeState = {
  org: OrgView | null;
  agents: AgentSnapshot[];
  messages: Record<string, ChatMessage[]>;
  tasks: Record<string, Task>;
  /** Manager-side read cursor per channel (client only). */
  readSeq: Record<string, number>;
  connected: boolean;
  /** Permission prompts waiting for the manager (remote approval). */
  permissions: PermissionRequest[];
};

export type OfficeAction =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'org'; org: OrgView }
  | { type: 'agents'; agents: AgentSnapshot[] }
  | { type: 'collab'; event: CollabEvent }
  | { type: 'history'; channelId: string; messages: ChatMessage[]; mode: 'replace' | 'prepend' }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'permissions'; pending: PermissionRequest[] }
  | { type: 'read'; channelId: string; seq: number }
  | { type: 'connection'; connected: boolean }
  | { type: 'reset' };

export const initialOfficeState: OfficeState = { org: null, agents: [], messages: {}, tasks: {}, readSeq: {}, connected: false, permissions: [] };

const mergeMessages = (current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
};

export const officeReducer = (state: OfficeState, action: OfficeAction): OfficeState => {
  switch (action.type) {
    case 'snapshot': return { ...state, agents: action.snapshot.agents, org: action.snapshot.org ?? state.org };
    case 'org': return { ...state, org: action.org };
    case 'agents': return { ...state, agents: action.agents };
    case 'tasks': return { ...state, tasks: Object.fromEntries(action.tasks.map(task => [task.id, task])) };
    case 'read': return { ...state, readSeq: { ...state.readSeq, [action.channelId]: Math.max(state.readSeq[action.channelId] ?? 0, action.seq) } };
    case 'permissions': return { ...state, permissions: action.pending };
    case 'connection': return { ...state, connected: action.connected };
    case 'reset': return { ...state, messages: {} };
    case 'history': {
      const current = state.messages[action.channelId] ?? [];
      return { ...state, messages: { ...state.messages, [action.channelId]: action.mode === 'replace' ? mergeMessages([], action.messages) : mergeMessages(current, action.messages) } };
    }
    case 'collab': {
      const event = action.event;
      if (event.kind === 'org') return { ...state, org: event.org };
      if (event.kind === 'task') return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
      if (event.kind === 'permission') return { ...state, permissions: event.pending };
      const { message } = event;
      const org = state.org && { ...state.org, channels: state.org.channels.map(channel => channel.id === message.channelId ? { ...channel, lastSeq: Math.max(channel.lastSeq, message.seq) } : channel) };
      const loaded = state.messages[message.channelId];
      return { ...state, org, messages: loaded ? { ...state.messages, [message.channelId]: mergeMessages(loaded, [message]) } : state.messages };
    }
  }
};

export const unreadFor = (state: OfficeState, channelId: string): number => {
  const channel = state.org?.channels.find(candidate => candidate.id === channelId);
  return channel ? Math.max(channel.lastSeq - (state.readSeq[channelId] ?? 0), 0) : 0;
};

export type SeatStatus = 'vacant' | 'offline' | 'wake_limited' | 'working' | 'blocked' | 'listening' | 'idle';
export const SEAT_STATUS_LABEL: Record<SeatStatus, string> = { vacant: 'vacant', offline: 'offline', wake_limited: 'wake limit hit', working: 'working', blocked: 'waiting permission', listening: 'listening', idle: 'idle — needs nudge' };

/** Combines seat binding, session telemetry and wake state into one display status. */
export const seatStatus = (seat: Seat, agents: AgentSnapshot[]): SeatStatus => {
  if (!seat.agentId) return 'vacant';
  const agent = agents.find(candidate => candidate.id === seat.agentId);
  if (!agent || agent.contactState === 'exited') return 'offline';
  if (seat.wakeState === 'wake_limited') return 'wake_limited';
  if (agent.state === 'blocked') return 'blocked';
  if (agent.state === 'working') return 'working';
  return seat.wakeState === 'listening' ? 'listening' : 'idle';
};

/** Live sessions not bound to any seat (shown in the Org view tray). */
export const unassignedAgents = (state: OfficeState): AgentSnapshot[] => {
  const seated = new Set(state.org?.seats.map(seat => seat.agentId).filter(Boolean));
  return state.agents.filter(agent => !seated.has(agent.id) && agent.contactState !== 'exited');
};
