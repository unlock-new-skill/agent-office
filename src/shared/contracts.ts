import { z } from 'zod';

const id = z.string().min(1).max(128);
export const EventKindSchema = z.enum(['session.start', 'session.end', 'turn.start', 'turn.stop', 'tool.start', 'tool.done', 'tool.fail', 'permission.request']);
export const TelemetrySchema = z.object({
  id, ts: z.string().datetime(), kind: EventKindSchema,
  turnId: id.optional(), invocationId: id.optional(), tool: z.string().min(1).max(128).optional(), summary: z.string().max(200).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.kind.startsWith('session.') && !value.turnId) ctx.addIssue({ code: 'custom', message: 'turnId required', path: ['turnId'] });
  if (value.kind.startsWith('tool.') && !value.invocationId) ctx.addIssue({ code: 'custom', message: 'invocationId required', path: ['invocationId'] });
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

export const EnrollmentSchema = z.object({ agentId: id, project: z.string().min(1).max(512), sessionId: id, incarnation: id }).strict();
export const AgentRegistrationSchema = z.object({ nonce: id }).strict();
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;
export type AgentBinding = { agentId: string; sessionId: string; incarnation: string; project: string };
export type AppendEvent = Telemetry & AgentBinding & { source: 'claude'; producerId: string; producerIncarnation: string };
export type EventEnvelope = AppendEvent & { v: 1; seq: number; datasetGeneration: string; sessionIncarnation: string };
export const EventEnvelopeSchema = z.intersection(TelemetrySchema, z.object({
  v: z.literal(1), seq: z.number().int().positive(), datasetGeneration: id, source: z.literal('claude'),
  producerId: id, producerIncarnation: id, agentId: id, sessionId: id, incarnation: id, sessionIncarnation: id, project: z.string().min(1).max(512),
}));

export const LoginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
export type ActivityState = 'online' | 'working' | 'blocked' | 'idle' | 'error';
export type ContactState = 'connected' | 'contact_lost' | 'exited' | 'unknown';
export type AgentSnapshot = {
  id: string; project: string; source: 'claude'; sessionId: string; sessionIncarnation: string;
  state: ActivityState; contactState: ContactState; lastEventAt: string | null; currentTool: string | null;
  pendingInvocations: number; pendingPermissions: number;
  /** Last time the session reached the daemon (hook or wake poll); quiet sessions leave the lobby. */
  lastContactAt?: number | null;
  /** Hidden from the lobby by the manager until the session starts again. */
  dismissed?: boolean;
};
export type Snapshot = { generation: string; seq: number; agents: AgentSnapshot[]; org?: OrgView };
export type Delta = { type: 'delta'; generation: string; seq: number; event: EventEnvelope };

export type SeatRole = 'leader' | 'member';
export type WakeState = 'idle' | 'listening' | 'wake_limited';
/** deputySeatId: member seat that stands in for the leader (joins #leaders, woken with the leader's items while the leader is unavailable). */
export type Department = { id: string; name: string; color: string; sort: number; paused: boolean; deputySeatId: string | null };
export type Seat = { id: string; departmentId: string; title: string; description: string; role: SeatRole; sort: number; agentId: string | null; consecutiveWakes: number; wakeState: WakeState };
export type ChannelKind = 'department' | 'leaders';
export type Channel = { id: string; name: string; kind: ChannelKind; departmentId: string | null; memberSeatIds: string[]; lastSeq: number };
export type OrgView = { departments: Department[]; seats: Seat[]; channels: Channel[] };
export type SenderKind = 'seat' | 'manager' | 'system';
/** threadSeq: seq of the root this message replies to (null on top-level messages); replyCount/lastReplyAt describe a root's thread. */
export type ChatMessage = { id: string; channelId: string; seq: number; senderKind: SenderKind; senderId: string; body: string; mentions: string[]; createdAt: number; editedAt?: number | null; deletedAt?: number | null; threadSeq?: number | null; replyCount?: number; lastReplyAt?: number | null };
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export type SeatHandoff = { seatId: string; body: string; updatedAt: number; updatedBy: string };
/** requesterSeatId: leader of another department this task was requested by; told when it is blocked or done. */
export type Task = { id: string; departmentId: string; number: number; assigneeSeatId: string | null; requesterSeatId: string | null; createdByKind: 'seat' | 'manager'; createdById: string; title: string; body: string; status: TaskStatus; createdAt: number; updatedAt: number };
/** Realtime collaboration notifications; state lives in SQLite, clients refetch over REST after reconnect. */
export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired';
export type PermissionBehavior = 'allow' | 'deny';
export type PermissionRequest = { id: string; agentId: string; seatId: string | null; tool: string; summary: string; status: PermissionStatus; message: string; createdAt: number; decidedAt: number | null; decidedBy: string | null };

/** Prefix of prompts written by Agent Office itself (wakes, runner starts); they are not a human taking over. */
export const AUTO_PROMPT_MARK = '[Agent Office]';
/** Summary carried by turn.start telemetry for an automatic prompt, so the server keeps the auto-wake guard. */
export const AUTO_TURN_SUMMARY = 'agent-office:auto';

/** Headless seats run by a per-machine runner (connector mode `runner`). */
export type RunnerSeatState = 'starting' | 'running' | 'idle' | 'stopped' | 'failed';
export type RunnerSeat = { seatId: string; state: RunnerSeatState; sessionId: string | null; restarts: number; permissionMode: string; detail: string };
/**
 * A seat a machine should run, managed on the web. `sessionId` resumes an existing Claude session on that machine;
 * `showWindow` opens a read-only live view of the session in a terminal window on the machine's desktop; `model` is
 * passed to `claude --model` (null = the machine's default, e.g. from its proxy settings).
 */
export type MachineSeat = { seatId: string; cwd: string; permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'; sessionId: string | null; autoStart: boolean; showWindow: boolean; model?: string | null };
export type MachineConfig = { version: number; seats: MachineSeat[] };
/** A Claude session the machine's hooks registered: candidates for a seat's working directory and session id. */
export type MachineSession = { agentId: string; sessionId: string; project: string; ended: boolean; seatId: string | null; lastContactAt: number | null };
/** label: name given on the web; machine: the hostname the runner reports. config is the web-managed seat list. */
export type RunnerView = { id: string; label: string | null; machine: string; online: boolean; lastSeenAt: number; seats: RunnerSeat[]; config: MachineConfig };
export const RUNNER_COMMAND_KINDS = ['start', 'stop', 'restart', 'interrupt', 'prompt'] as const;
export type RunnerCommandKind = typeof RUNNER_COMMAND_KINDS[number];
export type RunnerCommandStatus = 'queued' | 'sent' | 'done' | 'failed' | 'expired';
export type RunnerCommand = { id: string; runnerId: string; seatId: string; kind: RunnerCommandKind; text: string | null; status: RunnerCommandStatus; result: string | null; requestedBy: string; createdAt: number; doneAt: number | null };
export type RunnerLogKind = 'text' | 'tool' | 'result' | 'error' | 'state' | 'prompt';
export type RunnerLogEntry = { seatId: string; ts: number; kind: RunnerLogKind; summary: string };

export type CollabEvent =
  | { type: 'collab'; kind: 'message'; message: ChatMessage }
  | { type: 'collab'; kind: 'org'; org: OrgView }
  | { type: 'collab'; kind: 'task'; task: Task }
  | { type: 'collab'; kind: 'permission'; pending: PermissionRequest[] }
  | { type: 'collab'; kind: 'runners'; runners: RunnerView[] }
  | { type: 'collab'; kind: 'runner-command'; command: RunnerCommand }
  | { type: 'collab'; kind: 'runner-log'; seatId: string; entries: RunnerLogEntry[] };

const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug');
export const SeatInputSchema = z.object({ id: slug.optional(), title: z.string().min(1).max(80), description: z.string().max(2000).default(''), role: z.enum(['leader', 'member']) }).strict();
export const DepartmentInputSchema = z.object({ id: slug.optional(), name: z.string().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b') }).strict();
export const OfficeConfigSchema = z.object({
  departments: z.array(DepartmentInputSchema.extend({ id: slug, seats: z.array(SeatInputSchema.extend({ id: slug })).default([]) })).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const department of value.departments) {
    if (department.id === 'leaders') ctx.addIssue({ code: 'custom', message: 'department id "leaders" is reserved', path: ['departments'] });
    if (department.seats.filter(seat => seat.role === 'leader').length > 1) ctx.addIssue({ code: 'custom', message: `department ${department.id} has more than one leader`, path: ['departments'] });
    for (const seat of department.seats) { if (ids.has(seat.id)) ctx.addIssue({ code: 'custom', message: `duplicate seat id ${seat.id}`, path: ['departments'] }); ids.add(seat.id); }
  }
});
export type OfficeConfig = z.infer<typeof OfficeConfigSchema>;
