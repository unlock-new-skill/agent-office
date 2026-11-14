import { randomUUID } from 'node:crypto';
import { promptBinding } from '../../shared/prompt-binding.js';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import type { AgentPrompt, AgentPromptStatus, CollabEvent, PermissionBehavior, PromptQuestion, Seat } from '../../shared/contracts.js';
import type { Actor, MessageService } from './message-service.js';
import { conflict, forbidden, notFound, OfficeError } from './office-error.js';
import { LEADERS_CHANNEL_ID, type OrgService } from './org-service.js';
import type { RunnerService } from './runner-service.js';

/** How long a prompt waits for an answer. Nothing is ever allowed by timeout: an expired prompt is denied. */
export const PROMPT_TTL_MS = 20 * 60_000;
const MAX_PENDING_PER_SEAT = 4; const MAX_WAITERS = 64; const MAX_ANSWER = 500; const MAX_SHOWN = 2000;

/**
 * Everything a permission would run, one `key: value` line per input field (descriptions last). What a delegate sees is
 * what runs: a prompt whose input does not fit is shown cut and left to the manager.
 */
const showInput = (tool: string, input: Record<string, unknown>): { text: string; complete: boolean } => {
  const lines = Object.entries(input).sort(([a], [b]) => Number(a === 'description') - Number(b === 'description'))
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`);
  const text = `${tool}\n${lines.join('\n')}`;
  return { text: text.slice(0, MAX_SHOWN), complete: text.length <= MAX_SHOWN };
};
export const bindingOf = promptBinding;
/** Every string in the input as plain text (not JSON-escaped), so a newline cannot hide words from the scan. */
const plainText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(plainText).join(' ') : value && typeof value === 'object' ? Object.entries(value).map(([key, entry]) => `${key} ${plainText(entry)}`).join(' ') : String(value ?? '');

const QuestionsSchema = z.array(z.object({
  question: z.string().trim().min(1).max(500), header: z.string().max(40).default(''), multiSelect: z.boolean().default(false),
  options: z.array(z.object({ label: z.string().trim().min(1).max(120), description: z.string().max(300).default('') }).passthrough()).min(1).max(8),
}).passthrough()).min(1).max(4);

/**
 * Words that keep a prompt with the manager: secrets, system or security settings, money, production/live and
 * destructive operations are never decided by a delegate. A heuristic on the visible text, so it errs towards the manager.
 */
const MANAGER_ONLY = /\.env\b|secret|token|passw|credential|api[ _-]?key|private[ _-]?key|\.ssh\b|id_rsa|settings\.json|\.ckignore|executionpolicy|\bsudo\b|\brm\s+-[a-z]*r|git\s+push|deploy|\bssh\b|\bscp\b|schtasks|taskkill|\breg\s+add|drop\s+table|delete\s+from|truncate|production|\bprod\b|\blive\b|\bpaid\b|purchase|billing|payment|wipe|destroy/i;

type Row = {
  id: string; runnerId: string; seatId: string; sessionId: string; requestId: string; kind: AgentPrompt['kind']; tool: string; summary: string;
  questionsJson: string; binding: string; resolversJson: string; managerOnly: number; managerReason: string; status: AgentPromptStatus;
  behavior: PermissionBehavior | null; answersJson: string | null; message: string; decidedBy: string | null; noticeChannel: string | null; noticeSeq: number | null;
  taskId: string | null; outcome: 'succeeded' | 'failed' | null; cancelReason: string | null; createdAt: number; expiresAt: number; decidedAt: number | null; deliveredAt: number | null;
};
const COLUMNS = `id,runner_id AS runnerId,seat_id AS seatId,session_id AS sessionId,request_id AS requestId,kind,tool,summary,questions_json AS questionsJson,
  binding,resolvers_json AS resolversJson,manager_only AS managerOnly,manager_reason AS managerReason,status,behavior,answers_json AS answersJson,message,
  decided_by AS decidedBy,task_id AS taskId,outcome,cancel_reason AS cancelReason,notice_channel AS noticeChannel,notice_seq AS noticeSeq,created_at AS createdAt,expires_at AS expiresAt,decided_at AS decidedAt,delivered_at AS deliveredAt`;

type Resolver = AgentPrompt['resolvers'][number];
const who = (decidedBy: string | null): string => decidedBy === 'manager' ? 'the manager' : decidedBy?.startsWith('seat:') ? `@${decidedBy.slice(5)}` : decidedBy ?? 'nobody';
/** Deny, expiry and cancel all mean "not run", but stay distinct; allowed and delivered are not "ran". */
const stateOf = (row: Pick<Row, 'status' | 'behavior' | 'kind' | 'outcome' | 'decidedBy' | 'cancelReason'>): string => {
  switch (row.status) {
    case 'pending': return 'waiting for an answer';
    case 'answered': return `${row.kind === 'question' ? 'answered' : 'allowed'} by ${who(row.decidedBy)}, not yet delivered to the session`;
    case 'denied': return `denied by ${who(row.decidedBy)}, not yet delivered to the session`;
    case 'expired': return 'expired without an answer: denied, not run';
    case 'cancelled': return `cancelled (${row.cancelReason ?? 'withdrawn'})${row.decidedBy ? `, after ${row.behavior === 'deny' ? 'a deny' : 'an answer'} by ${who(row.decidedBy)} that was never delivered` : ''}: not run`;
    case 'delivered':
      if (row.behavior === 'deny') return `denied by ${who(row.decidedBy)}: denial delivered, not run`;
      if (row.kind === 'question') return `answered by ${who(row.decidedBy)}: answer delivered to the session`;
      return `allowed by ${who(row.decidedBy)}: delivered, ${row.outcome === 'succeeded' ? 'ran' : row.outcome === 'failed' ? 'ran with an error' : 'not reported as run yet'}`;
  }
};
type NoticeThread = { channelId: string; seq: number | null };
export type PromptInput = { seatId: string; sessionId: string; requestId: string; toolUseId: string; tool: string; input: Record<string, unknown>; binding: string };
export type PromptAnswer = { binding: string; behavior: PermissionBehavior; answers?: Record<string, string> | undefined; message?: string | undefined };
/** What the waiting runner gets back: the decision with the binding it must match before applying it. */
export type PromptDecision = Pick<AgentPrompt, 'id' | 'status' | 'behavior' | 'answers' | 'message' | 'binding'>;

/**
 * Prompts of runner-managed sessions routed to people who may answer them in place of the manager. The runner files
 * the request Claude Code is blocked on and long-polls the decision; a resolver or the manager answers once. A prompt is
 * bound to the task the seat has in progress: the task's technical lead(s) (leaders/deputy of the task's department,
 * the lead of its parent task) and the PM coordinators (business, priority) may answer within it. Rules enforced here,
 * never by the asking agent:
 * - nobody answers their own prompt, and a seat outside the resolver list cannot answer;
 * - no task in progress, no resolver other than the asker, or sensitive wording (an extra signal, never a reason to
 *   allow) leaves the prompt to the manager, shown as such;
 * - one decision per prompt (the first answer wins), only while pending and not expired, bound to the exact input;
 * - timeout, cancel, a stopped session or a lost runner never allow anything.
 */
export class PromptService {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly runners: RunnerService, private readonly emit: (event: CollabEvent) => void, private readonly now: () => number = Date.now) {}

  /** Files a prompt; the same request id from the same runner returns the existing prompt (retries are idempotent). */
  create(runnerId: string, input: PromptInput): AgentPrompt {
    if (!this.runners.offersSeat(runnerId, input.seatId)) throw notFound('seat');
    // The binding is checked against the input received, so a decision can only ever apply to exactly this input.
    if (bindingOf(input.tool, input.input) !== input.binding) throw new OfficeError('prompt_binding_mismatch', 400);
    const existing = this.existing(runnerId, input);
    if (existing) return existing;
    const seat = this.org.seat(input.seatId);
    const kind = input.tool === 'AskUserQuestion' ? 'question' : 'permission';
    let questions: PromptQuestion[] = [];
    if (kind === 'question') {
      const parsed = QuestionsSchema.safeParse(input.input.questions);
      if (!parsed.success) throw new OfficeError('invalid_questions', 400);
      questions = parsed.data.map(item => ({ question: item.question, header: item.header, multiSelect: item.multiSelect, options: item.options.map(option => ({ label: option.label, description: option.description })) }));
    }
    const shown = kind === 'question'
      ? { text: `AskUserQuestion: ${questions.map(item => item.question).join(' | ')}`.slice(0, MAX_SHOWN), complete: true }
      : showInput(input.tool, input.input);
    const summary = shown.text;
    // Sensitive words are looked for in the whole input, not only in what fits on screen.
    const scanned = kind === 'question' ? questions.map(item => [item.header, item.question, ...item.options.map(option => `${option.label} ${option.description}`)].join(' ')).join(' ') : plainText(input.input);
    const sensitive = MANAGER_ONLY.exec(scanned)?.[0] ?? null;
    const { taskId, resolvers, steering, reason, thread } = this.resolversFor(seat, kind);
    const managerReason = sensitive ? `sensitive: "${sensitive.trim().slice(0, 30)}"` : !shown.complete ? 'input too long to show in full' : reason;
    const prompt: Row = {
      id: `pr-${randomUUID().slice(0, 8)}`, runnerId, seatId: seat.id, sessionId: input.sessionId, requestId: input.requestId, kind, tool: input.tool.slice(0, 128), summary,
      questionsJson: JSON.stringify(questions), binding: input.binding, resolversJson: JSON.stringify(managerReason ? [] : resolvers), managerOnly: managerReason ? 1 : 0, managerReason,
      status: 'pending', behavior: null, answersJson: null, message: '', decidedBy: null, noticeChannel: null, noticeSeq: null, taskId, outcome: null, cancelReason: null,
      createdAt: this.now(), expiresAt: this.now() + PROMPT_TTL_MS, decidedAt: null, deliveredAt: null,
    };
    try {
      this.db.transaction(() => {
      const { count } = this.db.raw.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE seat_id=? AND status='pending'").get(seat.id) as { count: number };
      if (count >= MAX_PENDING_PER_SEAT) throw conflict('too_many_pending_prompts');
      this.db.raw.prepare(`INSERT INTO agent_prompts(id,runner_id,seat_id,session_id,request_id,tool_use_id,kind,tool,summary,questions_json,binding,resolvers_json,manager_only,manager_reason,status,task_id,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(prompt.id, runnerId, seat.id, input.sessionId, input.requestId, input.toolUseId.slice(0, 128), kind, prompt.tool, summary, prompt.questionsJson, input.binding, prompt.resolversJson, prompt.managerOnly, managerReason, 'pending', taskId, prompt.createdAt, prompt.expiresAt);
      });
    } catch (error) {
      // A concurrent retry of the same request won the insert: return that prompt.
      const raced = error instanceof OfficeError ? null : this.existing(runnerId, input);
      if (raced) return raced;
      throw error;
    }
    this.notice(prompt, seat, thread ?? { channelId: steering ? LEADERS_CHANNEL_ID : seat.departmentId, seq: null });
    this.publish();
    return this.get(prompt.id);
  }

  get(id: string): AgentPrompt { return this.view(this.row(id)); }

  /** A retry must be the same request: same seat, session and input; anything else is refused. */
  private existing(runnerId: string, input: PromptInput): AgentPrompt | null {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM agent_prompts WHERE runner_id=? AND request_id=?`).get(runnerId, input.requestId) as Row | undefined;
    if (!row) return null;
    if (row.seatId !== input.seatId || row.sessionId !== input.sessionId || row.binding !== input.binding) throw conflict('prompt_request_reused');
    return this.view(row);
  }

  /** Pending prompts the actor may answer (the manager sees all), then the latest decided ones they could see. */
  list(actor: Actor): AgentPrompt[] {
    this.expireDue();
    const rows = this.db.raw.prepare(`SELECT ${COLUMNS} FROM agent_prompts WHERE status='pending' OR created_at>? ORDER BY status='pending' DESC, created_at DESC LIMIT 100`).all(this.now() - 24 * 3_600_000) as Row[];
    const scopes = new Map<string, ReturnType<PromptService['resolversFor']>>();
    return rows.filter(row => this.canRead(actor, row, scopes)).slice(0, 40).map(row => this.view(row));
  }

  read(actor: Actor, id: string): AgentPrompt {
    const row = this.row(id);
    if (!this.canRead(actor, row)) throw forbidden('forbidden_prompt');
    return this.view(row);
  }

  /** One decision per prompt: the first valid answer wins; later or concurrent answers get prompt_already_resolved. */
  answer(actor: Actor, id: string, answer: PromptAnswer): AgentPrompt {
    this.expireDue();
    const row = this.row(id);
    if (actor.kind === 'seat') {
      if (actor.seatId === row.seatId) throw forbidden('cannot_answer_own_prompt');
      if (row.managerOnly === 1) throw forbidden('prompt_manager_only');
      if (!this.resolverIds(row).includes(actor.seatId)) throw forbidden('not_prompt_resolver');
      // The scope is checked again now: a task finished or reassigned, or a lead who lost the role, cannot answer.
      if (!this.stillInScope(row, actor.seatId)) throw forbidden('prompt_scope_changed');
    }
    if (row.status !== 'pending') throw conflict(row.status === 'expired' ? 'prompt_expired' : 'prompt_already_resolved');
    if (answer.binding !== row.binding) throw conflict('prompt_binding_mismatch');
    let answers: Record<string, string> | null = null;
    if (answer.behavior === 'allow' && row.kind === 'question') answers = this.checkAnswers(JSON.parse(row.questionsJson) as PromptQuestion[], answer.answers ?? {});
    if (answer.behavior === 'allow' && row.kind === 'permission' && answer.answers) throw new OfficeError('answers_only_for_questions', 400);
    const by = actor.kind === 'manager' ? 'manager' : `seat:${actor.seatId}`;
    const status: AgentPromptStatus = answer.behavior === 'allow' ? 'answered' : 'denied';
    const message = (answer.message ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 500);
    const changed = this.db.raw.prepare("UPDATE agent_prompts SET status=?,behavior=?,answers_json=?,message=?,decided_by=?,decided_at=? WHERE id=? AND status='pending' AND expires_at>?")
      .run(status, answer.behavior, answers ? JSON.stringify(answers) : null, message, by, this.now(), id, this.now());
    if (changed.changes === 0) throw conflict('prompt_already_resolved');
    if (row.noticeChannel && row.noticeSeq) {
      try { this.messages.postSystem(row.noticeChannel, `Prompt ${id} of @${row.seatId}: ${status === 'answered' ? 'answered' : 'denied'} by ${actor.kind === 'manager' ? 'the manager' : `@${actor.seatId}`}. The session continues when the runner delivers it.`, [], row.noticeSeq); } catch { /* the notice thread is gone */ }
    }
    this.wakeWaiters(id); this.publish();
    return this.get(id);
  }

  /** Long-poll for the runner that filed the prompt. Past its expiry a pending prompt is expired, never allowed. */
  async wait(runnerId: string, id: string, timeoutMs: number, signal?: AbortSignal): Promise<PromptDecision> {
    let row = this.row(id);
    if (row.runnerId !== runnerId) throw forbidden('forbidden_prompt');
    const remaining = row.expiresAt - this.now();
    if (row.status === 'pending' && remaining > 0 && timeoutMs > 0 && !signal?.aborted && this.waiterCount() < MAX_WAITERS) {
      await new Promise<void>(resolve => {
        const listeners = this.waiters.get(id) ?? new Set<() => void>(); this.waiters.set(id, listeners);
        const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); listeners.delete(done); if (listeners.size === 0) this.waiters.delete(id); resolve(); };
        const timer = setTimeout(done, Math.min(timeoutMs, remaining + 50));
        listeners.add(done); signal?.addEventListener('abort', done, { once: true });
      });
    }
    this.expireDue();
    row = this.row(id);
    const view = this.view(row);
    return { id: view.id, status: view.status, behavior: view.behavior, answers: view.answers, message: view.message, binding: view.binding };
  }

  /** The runner handed the decision to the session that was waiting: recorded once, later calls change nothing. */
  delivered(runnerId: string, id: string): AgentPrompt {
    const row = this.row(id);
    if (row.runnerId !== runnerId) throw forbidden('forbidden_prompt');
    const changed = this.db.raw.prepare("UPDATE agent_prompts SET status='delivered',delivered_at=? WHERE id=? AND status IN ('answered','denied')").run(this.now(), id);
    if (changed.changes > 0) this.publish();
    return this.get(id);
  }

  /**
   * After an allowed permission was delivered, the runner reports whether the tool then ran: allowed and delivered do
   * not mean executed. Recorded once.
   */
  outcome(runnerId: string, id: string, ok: boolean): AgentPrompt {
    const row = this.row(id);
    if (row.runnerId !== runnerId) throw forbidden('forbidden_prompt');
    // The tool result can arrive before the delivery notice: a tool that ran was delivered.
    const changed = this.db.raw.prepare("UPDATE agent_prompts SET outcome=?,outcome_at=?,status='delivered',delivered_at=COALESCE(delivered_at,?) WHERE id=? AND status IN ('answered','delivered') AND behavior='allow' AND kind='permission' AND outcome IS NULL").run(ok ? 'succeeded' : 'failed', this.now(), this.now(), id);
    if (changed.changes > 0) this.publish();
    return this.get(id);
  }

  /**
   * Nothing waits on these prompts any more: Claude Code withdrew the request (control_cancel_request), the process
   * ended, or the runner restarted (ids omitted = every pending prompt of the runner, or of one seat).
   */
  cancel(runnerId: string, scope: { ids?: string[] | undefined; seatId?: string | undefined }, reason: string): number {
    // Named prompts are ones the session no longer waits on: pending, or decided but never delivered (who decided is
    // kept). A sweeping cancel (runner restart or offline) cannot know whether a decision reached the session, so it only
    // takes pending prompts and leaves decided ones as they are, rather than record something that ran as "not run".
    const statuses = scope.ids ? "('pending','answered','denied')" : "('pending')";
    const rows = (this.db.raw.prepare(`SELECT id,seat_id AS seatId FROM agent_prompts WHERE runner_id=? AND status IN ${statuses}`).all(runnerId) as Array<{ id: string; seatId: string }>)
      .filter(row => (!scope.ids || scope.ids.includes(row.id)) && (!scope.seatId || row.seatId === scope.seatId));
    for (const { id } of rows) this.db.raw.prepare(`UPDATE agent_prompts SET status='cancelled',cancel_reason=?,decided_at=COALESCE(decided_at,?) WHERE id=? AND status IN ${statuses}`).run(reason.slice(0, 120), this.now(), id);
    for (const { id } of rows) this.wakeWaiters(id);
    if (rows.length > 0) this.publish();
    return rows.length;
  }

  /** Prompts of runners that went offline: nobody can deliver an answer to them. */
  cancelOffline(online: (runnerId: string) => boolean): number {
    const runners = this.db.raw.prepare("SELECT DISTINCT runner_id AS runnerId FROM agent_prompts WHERE status='pending'").all() as Array<{ runnerId: string }>;
    return runners.filter(({ runnerId }) => !online(runnerId)).reduce((count, { runnerId }) => count + this.cancel(runnerId, {}, 'the runner went offline'), 0);
  }

  expireDue(): number {
    const due = this.db.raw.prepare("SELECT id FROM agent_prompts WHERE status='pending' AND expires_at<=?").all(this.now()) as Array<{ id: string }>;
    if (due.length === 0) return 0;
    this.db.raw.prepare("UPDATE agent_prompts SET status='expired',decided_at=? WHERE status='pending' AND expires_at<=?").run(this.now(), this.now());
    for (const { id } of due) this.wakeWaiters(id);
    this.publish();
    return due.length;
  }

  waiterCount(): number { let count = 0; for (const listeners of this.waiters.values()) count += listeners.size; return count; }
  close(): void { for (const id of [...this.waiters.keys()]) this.wakeWaiters(id); }

  /**
   * Who may answer for a seat, bound to the task it has in progress (an execution task first): technical = leaders and
   * deputy of the task's department (for members) and the parent task's assignee when it is the leader or deputy of the
   * parent task's department; business = the coordinators (PM).
   * Never the seat itself. No task in progress or nobody left means the manager, with the reason shown.
   */
  private resolversFor(seat: Seat, kind: AgentPrompt['kind'], skipWaiting = true): { taskId: string | null; resolvers: Resolver[]; steering: boolean; reason: string; thread: NoticeThread | null } {
    const view = this.org.view();
    const home = view.departments.find(item => item.id === seat.departmentId);
    const steering = seat.role === 'leader' || seat.coordinator || home?.deputySeatId === seat.id;
    const doing = this.db.raw.prepare(`SELECT t.id,t.kind,t.department_id AS departmentId,t.thread_seq AS threadSeq,p.assignee_seat_id AS parentLead,p.department_id AS parentDepartmentId FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id
      WHERE t.assignee_seat_id=? AND t.status='doing' AND t.archived_at IS NULL ORDER BY t.id`).all(seat.id) as Array<{ id: string; kind: string | null; departmentId: string; threadSeq: number | null; parentLead: string | null; parentDepartmentId: string | null }>;
    // The scope must be unambiguous: the one execution task in progress, else the only task in progress.
    const executions = doing.filter(item => item.kind === 'execution');
    const task = executions.length === 1 ? executions[0] : doing.length === 1 ? doing[0] : undefined;
    if (!task) return { taskId: null, resolvers: [], steering, reason: doing.length === 0 ? 'no task in progress for this seat: nobody can answer within an assigned scope' : `several tasks in progress (${doing.map(item => item.id).join(', ')}): the scope is ambiguous`, thread: null };
    const department = view.departments.find(item => item.id === task.departmentId);
    // The parent task's assignee counts only as a lead of that department (its leader or deputy): being named on the
    // parent task gives an ordinary member no say.
    const parentDepartment = view.departments.find(item => item.id === task.parentDepartmentId);
    const parentLead = task.parentLead && (view.seats.some(item => item.id === task.parentLead && item.departmentId === task.parentDepartmentId && item.role === 'leader') || parentDepartment?.deputySeatId === task.parentLead) ? task.parentLead : null;
    const technical = [
      ...(steering ? [] : view.seats.filter(item => item.departmentId === task.departmentId && item.role === 'leader').map(item => item.id)),
      ...(!steering && department?.deputySeatId ? [department.deputySeatId] : []),
      ...(parentLead ? [parentLead] : []),
    ];
    const resolvers: Resolver[] = [];
    for (const seatId of technical) if (seatId !== seat.id && !resolvers.some(item => item.seatId === seatId)) resolvers.push({ seatId, role: 'technical' });
    // A tool permission is a technical decision: only the task's technical leads answer it. Questions may be business too.
    if (kind === 'question') for (const item of view.seats.filter(candidate => candidate.coordinator)) if (item.id !== seat.id && !resolvers.some(entry => entry.seatId === item.id)) resolvers.push({ seatId: item.id, role: 'business' });
    // A resolver whose own session is blocked on a prompt cannot answer now: two seats never wait on each other.
    const waiting = skipWaiting ? new Set((this.db.raw.prepare("SELECT DISTINCT seat_id AS seatId FROM agent_prompts WHERE status='pending'").all() as Array<{ seatId: string }>).map(row => row.seatId)) : new Set<string>();
    const free = resolvers.filter(item => !waiting.has(item.seatId));
    const reason = resolvers.length === 0 ? (kind === 'permission' ? `no technical lead other than @${seat.id} for ${task.id}` : `no resolver other than @${seat.id} for ${task.id}`) : free.length === 0 ? 'every resolver is itself waiting on a prompt' : '';
    return { taskId: task.id, resolvers: free, steering, reason, thread: { channelId: task.departmentId, seq: task.threadSeq } };
  }

  private resolverIds(row: Row): string[] { return (JSON.parse(row.resolversJson) as Resolver[]).map(item => item.seatId); }

  /** Every question answered with plain text (an option label or the user's own words); nothing else is accepted. */
  private checkAnswers(questions: PromptQuestion[], answers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const item of questions) {
      const value = answers[item.question];
      if (typeof value !== 'string' || !value.trim()) throw new OfficeError('answer_missing', 400);
      result[item.question] = value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, MAX_ANSWER);
    }
    if (Object.keys(answers).some(key => !questions.some(item => item.question === key))) throw new OfficeError('answer_unknown_question', 400);
    return result;
  }

  /**
   * One neutral line where the resolvers are woken: prompt id, kind and task only. Nothing the agent wrote (headers,
   * questions, tool input, the sensitive word that kept it with the manager) goes into the channel; the details are read
   * with the prompt tool, which checks who is asking. Posted in the task's thread (mentioned resolvers outside the
   * channel become thread guests), else in the seat's channel.
   */
  private notice(prompt: Row, seat: Seat, thread: NoticeThread): void {
    const resolvers = JSON.parse(prompt.resolversJson) as Resolver[];
    const channel = thread.channelId;
    const what = prompt.kind === 'question' ? 'a question' : 'a tool permission';
    const technical = resolvers.filter(item => item.role === 'technical').map(item => `@${item.seatId}`);
    const business = resolvers.filter(item => item.role === 'business').map(item => `@${item.seatId}`);
    const who = resolvers.length > 0
      ? `${[technical.length ? `technical: ${technical.join(' ')}` : '', business.length ? `business/priority: ${business.join(' ')}` : ''].filter(Boolean).join('; ')} — answer only within ${prompt.taskId}`
      : 'Only the manager can answer (the reason is in the prompt)';
    const body = `[prompt ${prompt.id}] @${seat.id} is waiting on ${what}${prompt.taskId ? ` (task ${prompt.taskId})` : ''}. ${who}: agent_office_prompts { action: "get", promptId: "${prompt.id}" }, then action "answer". Unanswered by ${new Date(prompt.expiresAt).toISOString().slice(11, 16)} UTC it is denied.`;
    try {
      const posted = this.messages.postSystem(channel, body, resolvers.map(item => item.seatId), thread.seq ?? undefined);
      // The thread root, so the decision line lands in the same thread.
      this.db.raw.prepare('UPDATE agent_prompts SET notice_channel=?,notice_seq=? WHERE id=?').run(channel, posted.threadSeq ?? posted.seq, prompt.id);
    } catch { /* no such channel: the prompt still shows in the web UI */ }
  }

  /**
   * The manager reads every prompt and the asker its own. A resolver reads a prompt only while still in its scope: listed
   * when it was filed and still a resolver of the same task now. Losing the role or the task ending revokes reading too.
   */
  private canRead(actor: Actor, row: Row, scopes?: Map<string, ReturnType<PromptService['resolversFor']>>): boolean {
    if (actor.kind === 'manager') return true;
    if (actor.seatId === row.seatId) return true;
    return row.managerOnly === 0 && this.resolverIds(row).includes(actor.seatId) && this.stillInScope(row, actor.seatId, scopes);
  }

  /** Whether the seat is, right now, a resolver of the same task the prompt was filed under. */
  private stillInScope(row: Row, seatId: string, scopes?: Map<string, ReturnType<PromptService['resolversFor']>>): boolean {
    const key = `${row.seatId}:${row.kind}`;
    let now = scopes?.get(key);
    if (!now) {
      const asker = this.org.view().seats.find(item => item.id === row.seatId);
      if (!asker) return false;
      now = this.resolversFor(asker, row.kind, false);
      scopes?.set(key, now);
    }
    return now.taskId === row.taskId && now.resolvers.some(item => item.seatId === seatId);
  }

  private row(id: string): Row {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM agent_prompts WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw notFound('prompt');
    return row;
  }

  private view(row: Row): AgentPrompt {
    return {
      state: stateOf(row),
      id: row.id, seatId: row.seatId, sessionId: row.sessionId, kind: row.kind, tool: row.tool, summary: row.summary, questions: JSON.parse(row.questionsJson) as PromptQuestion[],
      taskId: row.taskId, resolvers: JSON.parse(row.resolversJson) as Resolver[], outcome: row.outcome,
      binding: row.binding, resolverSeatIds: this.resolverIds(row), managerOnly: row.managerOnly === 1, managerReason: row.managerReason, status: row.status,
      behavior: row.behavior, answers: row.answersJson ? JSON.parse(row.answersJson) as Record<string, string> : null, message: row.message, decidedBy: row.decidedBy,
      createdAt: row.createdAt, expiresAt: row.expiresAt, decidedAt: row.decidedAt, deliveredAt: row.deliveredAt,
    };
  }

  private wakeWaiters(id: string): void { for (const done of [...this.waiters.get(id) ?? []]) done(); }
  private publish(): void {
    const pending = (this.db.raw.prepare(`SELECT ${COLUMNS} FROM agent_prompts WHERE status='pending' ORDER BY created_at`).all() as Row[]).map(row => this.view(row));
    const recent = (this.db.raw.prepare(`SELECT ${COLUMNS} FROM agent_prompts WHERE status<>'pending' ORDER BY COALESCE(decided_at,created_at) DESC LIMIT 8`).all() as Row[]).map(row => this.view(row));
    this.emit({ type: 'collab', kind: 'prompts', pending, recent });
  }
}
