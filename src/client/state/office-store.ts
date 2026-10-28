import type { AgentSnapshot, ChatMessage, CollabEvent, OrgView, PermissionRequest, RunnerCommand, RunnerLogEntry, RunnerSeat, RunnerView, Seat, Snapshot, Task } from '../../shared/contracts.js';

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
  /** Open threads by `${channelId}:${rootSeq}`; channel `messages` hold top-level messages only. */
  threads: Record<string, { root: ChatMessage; replies: ChatMessage[] }>;
  /** Machines running seats headless, their live log and the manager's commands, per seat. */
  runners: RunnerView[];
  runnerLogs: Record<string, RunnerLogEntry[]>;
  runnerCommands: Record<string, RunnerCommand[]>;
};

export type OfficeAction =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'org'; org: OrgView }
  | { type: 'agents'; agents: AgentSnapshot[] }
  | { type: 'collab'; event: CollabEvent }
  | { type: 'history'; channelId: string; messages: ChatMessage[]; mode: 'replace' | 'prepend' }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'permissions'; pending: PermissionRequest[] }
  | { type: 'thread'; channelId: string; root: ChatMessage; replies: ChatMessage[] }
  | { type: 'read'; channelId: string; seq: number }
  | { type: 'connection'; connected: boolean }
  | { type: 'runners'; runners: RunnerView[] }
  | { type: 'runner-log'; seatId: string; entries: RunnerLogEntry[] }
  | { type: 'runner-commands'; seatId: string; commands: RunnerCommand[] }
  | { type: 'reset' };

export const initialOfficeState: OfficeState = { org: null, agents: [], messages: {}, tasks: {}, readSeq: {}, connected: false, permissions: [], threads: {}, runners: [], runnerLogs: {}, runnerCommands: {} };
const LOG_RING = 300;

/** The runner that offers a seat (online one first) and that runner's view of the seat. */
export const runnerSeatFor = (state: OfficeState, seatId: string): { runner: RunnerView; seat: RunnerSeat } | null => {
  for (const runner of [...state.runners].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt)) {
    const seat = runner.seats.find(candidate => candidate.seatId === seatId);
    if (seat) return { runner, seat };
  }
  return null;
};

const upsertCommand = (list: RunnerCommand[], command: RunnerCommand): RunnerCommand[] => [command, ...list.filter(item => item.id !== command.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
export const threadKey = (channelId: string, seq: number): string => `${channelId}:${seq}`;

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
    case 'thread': return { ...state, threads: { ...state.threads, [threadKey(action.channelId, action.root.seq)]: { root: action.root, replies: mergeMessages([], action.replies) } } };
    case 'connection': return { ...state, connected: action.connected };
    case 'runners': return { ...state, runners: action.runners };
    case 'runner-log': return { ...state, runnerLogs: { ...state.runnerLogs, [action.seatId]: action.entries.slice(-LOG_RING) } };
    case 'runner-commands': return { ...state, runnerCommands: { ...state.runnerCommands, [action.seatId]: action.commands } };
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
      if (event.kind === 'runners') return { ...state, runners: event.runners };
      if (event.kind === 'runner-log') return { ...state, runnerLogs: { ...state.runnerLogs, [event.seatId]: [...state.runnerLogs[event.seatId] ?? [], ...event.entries].slice(-LOG_RING) } };
      if (event.kind === 'runner-command') return { ...state, runnerCommands: { ...state.runnerCommands, [event.command.seatId]: upsertCommand(state.runnerCommands[event.command.seatId] ?? [], event.command) } };
      const { message } = event;
      const org = state.org && { ...state.org, channels: state.org.channels.map(channel => channel.id === message.channelId ? { ...channel, lastSeq: Math.max(channel.lastSeq, message.seq) } : channel) };
      if (message.threadSeq) {
        // Replies live only in their thread; the root's new reply count arrives as its own update.
        const key = threadKey(message.channelId, message.threadSeq); const thread = state.threads[key];
        return { ...state, org, threads: thread ? { ...state.threads, [key]: { ...thread, replies: mergeMessages(thread.replies, [message]) } } : state.threads };
      }
      const loaded = state.messages[message.channelId]; const key = threadKey(message.channelId, message.seq); const thread = state.threads[key];
      return {
        ...state, org,
        messages: loaded ? { ...state.messages, [message.channelId]: mergeMessages(loaded, [message]) } : state.messages,
        threads: thread ? { ...state.threads, [key]: { ...thread, root: message } } : state.threads,
      };
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
