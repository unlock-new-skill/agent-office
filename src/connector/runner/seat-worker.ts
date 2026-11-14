import { AUTO_PROMPT_MARK, type RunnerLogEntry, type RunnerLogKind, type RunnerSeat, type RunnerSeatState } from '../../shared/contracts.js';
import { promptBinding } from '../../shared/prompt-binding.js';
import type { ClaudeEvent, ClaudeProcessLike, PromptResponse, SpawnClaude } from './claude-process.js';
import type { RunnerState, SeatConfig } from './runner-config.js';

export type CommandResult = { ok: boolean; message: string };
/** Resolves with a wake reason for the session, or null when there is nothing (yet) or listening should stop. */
export type Listen = (sessionId: string, cwd: string, alive: () => boolean) => Promise<string | null>;
/** A prompt the seat's session is blocked on, as filed with Agent Office; binding = SHA-256 of the exact tool + input. */
export type PromptRequest = { seatId: string; sessionId: string; requestId: string; toolUseId: string; tool: string; input: Record<string, unknown>; binding: string };
/** The decision for one prompt. Anything but an allow bound to the same input is answered as a deny. */
export type PromptVerdict = { id: string | null; behavior: 'allow' | 'deny'; answers: Record<string, string> | null; message: string; binding: string | null };
/** Files the prompt and waits for its decision (expiry, cancel and errors resolve as deny, never allow). */
export type AskOffice = (request: PromptRequest, alive: () => boolean, onFiled: (id: string) => void) => Promise<PromptVerdict>;
export { promptBinding };
const NO_ANSWER = 'No answer came through Agent Office for this prompt, so it was not allowed. Continue without it: choose the safest option yourself or ask your leader in your channel. Do not run the same action another way.';

export type WorkerDeps = {
  spawn: SpawnClaude; state: RunnerState; listen: Listen;
  /** Routes prompts to Agent Office; without it every prompt is denied at once (nobody watches the terminal). */
  ask?: AskOffice; delivered?: (promptId: string) => void; cancelPrompts?: (promptIds: string[], reason: string) => void;
  /** After an allowed permission was delivered: whether the tool then ran without error. */
  outcome?: (promptId: string, ok: boolean) => void;
  onStatus: (seat: RunnerSeat) => void; onLog: (entry: RunnerLogEntry) => void;
  now?: () => number; sleep?: (ms: number) => Promise<void>; setTimer?: (run: () => void, ms: number) => void;
};

const RESTART_BACKOFF_MS = [2000, 5000, 10_000, 30_000, 60_000];
const CRASH_WINDOW_MS = 10 * 60_000; const MAX_CRASHES = 5; const STOP_GRACE_MS = 10_000; const RETRY_LISTEN_MS = 3000;

const firstPrompt = (seatId: string): string => `${AUTO_PROMPT_MARK} You are running unattended as seat @${seatId} through the Agent Office runner; nobody watches this terminal. Call agent_office_whoami, read your channels with agent_office_read_channel, handle anything addressed to you, then end your turn — you will be woken when someone mentions you.`;
const resumePrompt = `${AUTO_PROMPT_MARK} The runner restarted this session. Check your open tasks (agent_office_list_tasks mine=true) and unread mentions, finish interrupted work if any, then end your turn.`;

/**
 * One seat run headless by the runner: owns the `claude -p` process, resumes the seat's session after a restart or a
 * crash (bounded: MAX_CRASHES within CRASH_WINDOW_MS marks the seat failed), feeds wake reasons in as new turns while
 * idle, and executes manager commands.
 */
export class SeatWorker {
  private process: ClaudeProcessLike | null = null;
  private status: RunnerSeatState = 'stopped';
  private detail = 'stopped';
  private sessionId: string | null;
  private generation = 0;
  private stopping: (() => void) | null = null;
  private crashes: number[] = [];
  private restarts = 0;
  private sawInit = false;
  /** Prompts the current process is waiting on, by control request id; cleared when the process ends. */
  private prompts = new Map<string, string | null>();
  /** Allowed permissions handed to the session, by tool_use_id, until their tool result shows whether they ran. */
  private allowed = new Map<string, string>();

  constructor(readonly seat: SeatConfig, private readonly deps: WorkerDeps) { this.sessionId = deps.state.sessionId(seat.seatId); }

  snapshot(): RunnerSeat { return { seatId: this.seat.seatId, state: this.status, sessionId: this.sessionId, restarts: this.restarts, permissionMode: this.seat.permissionMode, detail: this.detail }; }

  start(prompt?: string): CommandResult {
    if (this.process) return { ok: false, message: 'already running' };
    if (this.status === 'failed') this.crashes = [];
    this.launch(prompt);
    return { ok: true, message: this.sessionId ? `started (resuming ${this.sessionId.slice(0, 8)})` : 'started (new session)' };
  }

  /** Next start opens a new Claude session instead of resuming the current one. */
  forgetSession(): void { this.sessionId = null; this.deps.state.setSessionId(this.seat.seatId, null); }

  async stop(): Promise<CommandResult> {
    const process = this.process;
    if (!process) { this.setStatus('stopped', 'stopped'); return { ok: true, message: 'already stopped' }; }
    this.generation++;
    const exited = new Promise<void>(resolve => { this.stopping = resolve; });
    process.close();
    (this.deps.setTimer ?? setTimeout)(() => { if (this.process === process) process.kill(); }, STOP_GRACE_MS);
    await exited;
    return { ok: true, message: 'stopped' };
  }

  async restart(): Promise<CommandResult> {
    await this.stop();
    return this.start();
  }

  interrupt(): CommandResult {
    if (!this.process || this.status !== 'running') return { ok: false, message: 'no turn is running' };
    this.process.interrupt(); this.log('state', 'interrupt requested');
    return { ok: true, message: 'interrupt sent' };
  }

  prompt(text: string): CommandResult {
    if (!this.process) return { ok: false, message: 'seat is stopped: start it first' };
    const busy = this.status === 'running' || this.status === 'starting';
    this.send(text, 'prompt');
    return { ok: true, message: busy ? 'queued after the current turn' : 'sent' };
  }

  private launch(prompt?: string): void {
    const generation = ++this.generation; this.sawInit = false;
    const resume = this.sessionId;
    this.process = this.deps.spawn(this.seat, resume, event => this.onEvent(event, generation, resume));
    this.setStatus('starting', resume ? 'resuming session' : 'new session');
    this.send(prompt ?? (resume ? resumePrompt : firstPrompt(this.seat.seatId)), prompt ? 'prompt' : 'state');
  }

  private send(text: string, kind: RunnerLogKind): void {
    this.process?.send(text);
    this.log(kind, text.startsWith(AUTO_PROMPT_MARK) ? text.slice(0, 160) : text);
    this.setStatus('running', 'working');
  }

  private onEvent(event: ClaudeEvent, generation: number, resumed: string | null): void {
    if (event.kind === 'exit') { this.onExit(event.code, event.stderr, resumed); return; }
    if (generation !== this.generation) return;
    if (event.kind === 'init') {
      this.sawInit = true;
      if (event.sessionId !== this.sessionId) { this.sessionId = event.sessionId; this.deps.state.setSessionId(this.seat.seatId, event.sessionId); }
      this.setStatus('running', 'working');
    } else if (event.kind === 'text') this.log('text', event.text);
    else if (event.kind === 'tool') this.log('tool', `${event.name}${event.summary ? `: ${event.summary}` : ''}`);
    else if (event.kind === 'prompt') void this.onPrompt(event, generation);
    else if (event.kind === 'prompt-cancel' && this.prompts.has(event.requestId)) {
      // Withdrawn by Claude Code: never answered; the filed prompt is cancelled so nobody answers into the void.
      const promptId = this.prompts.get(event.requestId) ?? null; this.prompts.delete(event.requestId);
      if (promptId) this.deps.cancelPrompts?.([promptId], 'the session withdrew the request');
      this.log('state', `prompt ${promptId ?? event.requestId.slice(0, 8)} withdrawn by the session`);
      if (this.status === 'running' && this.prompts.size === 0) this.setStatus('running', 'working');
    }
    else if (event.kind === 'tool-result') {
      const promptId = this.allowed.get(event.toolUseId);
      if (promptId) { this.allowed.delete(event.toolUseId); this.deps.outcome?.(promptId, event.ok); }
    }
    else if (event.kind === 'control') this.process?.respond?.(event.requestId, { error: `the Agent Office runner does not support ${event.subtype || 'this request'}` });
    else if (event.kind === 'result') {
      this.log('result', `${event.ok ? 'turn done' : 'turn failed'}${event.detail ? ` — ${event.detail}` : ''}`);
      this.crashes = [];
      this.setStatus('idle', 'listening for mentions');
      void this.listenLoop(this.generation);
    }
  }

  /** While idle, waits for a wake reason and hands it to Claude as the next turn. */
  private async listenLoop(generation: number): Promise<void> {
    const alive = (): boolean => this.generation === generation && this.status === 'idle' && this.process !== null;
    while (alive()) {
      const sessionId = this.sessionId;
      const reason = sessionId ? await this.deps.listen(sessionId, this.seat.cwd, alive).catch(() => null) : null;
      // Items in a wake reason are already marked read: deliver them even if a manager prompt started a turn meanwhile.
      if (reason && this.process && this.generation === generation) { this.send(reason, 'prompt'); return; }
      if (alive()) await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(RETRY_LISTEN_MS);
    }
  }

  /**
   * One prompt: filed with Agent Office, answered by a resolver, handed back to the same process if it is still the one
   * waiting. The answer applies only to the exact input it was asked for; an allow for a permission passes the original
   * input unchanged, and question answers are plain text the session reads.
   */
  private async onPrompt(event: Extract<ClaudeEvent, { kind: 'prompt' }>, generation: number): Promise<void> {
    const process = this.process; const sessionId = this.sessionId;
    if (!process) return;
    const deny = (message: string): void => { process.respond?.(event.requestId, { behavior: 'deny', message }); };
    const binding = promptBinding(event.tool, event.input);
    if (!this.deps.ask || !sessionId) { deny(NO_ANSWER); this.log('state', `${event.tool} prompt denied: no Agent Office routing`); return; }
    this.prompts.set(event.requestId, null);
    const what = event.tool === 'AskUserQuestion' ? 'a question' : `permission for ${event.tool}`;
    const since = new Date((this.deps.now ?? Date.now)()).toISOString().slice(11, 16);
    this.setStatus('running', `waiting for an answer to ${what} since ${since} UTC`);
    const alive = (): boolean => this.generation === generation && this.process === process && this.prompts.has(event.requestId);
    let verdict: PromptVerdict;
    try { verdict = await this.deps.ask({ seatId: this.seat.seatId, sessionId, requestId: event.requestId, toolUseId: event.toolUseId, tool: event.tool, input: event.input, binding }, alive, id => { if (this.prompts.has(event.requestId)) this.prompts.set(event.requestId, id); this.log('state', `prompt ${id} filed: ${what}`); }); }
    catch { verdict = { id: null, behavior: 'deny', answers: null, message: NO_ANSWER, binding: null }; }
    if (!alive()) return;
    this.prompts.delete(event.requestId);
    let response: PromptResponse;
    if (verdict.behavior === 'allow' && verdict.binding === binding) {
      response = { behavior: 'allow', updatedInput: event.tool === 'AskUserQuestion' ? { ...event.input, answers: verdict.answers ?? {} } : event.input };
    } else response = { behavior: 'deny', message: verdict.behavior === 'allow' ? NO_ANSWER : verdict.message || NO_ANSWER };
    process.respond?.(event.requestId, response);
    this.log('state', `prompt ${verdict.id ?? event.requestId.slice(0, 8)}: ${response.behavior === 'allow' ? 'answer delivered' : 'denied'}`);
    if (verdict.id) this.deps.delivered?.(verdict.id);
    if (verdict.id && response.behavior === 'allow' && event.tool !== 'AskUserQuestion' && event.toolUseId) this.allowed.set(event.toolUseId, verdict.id);
    if (this.status === 'running') this.setStatus('running', 'working');
  }

  private onExit(code: number | null, stderr: string, resumed: string | null): void {
    this.process = null;
    this.allowed.clear();
    if (this.prompts.size > 0) {
      // Only this process's own prompts: a restarted process files new ones that must stay live.
      const ids = [...this.prompts.values()].filter((id): id is string => id !== null);
      this.prompts.clear();
      if (ids.length > 0) this.deps.cancelPrompts?.(ids, 'the session stopped or restarted');
    }
    if (this.stopping) { const done = this.stopping; this.stopping = null; this.setStatus('stopped', 'stopped'); done(); return; }
    this.generation++;
    // A session that cannot be resumed (transcript gone) would crash forever: start fresh next time.
    if (resumed && !this.sawInit) { this.sessionId = null; this.deps.state.setSessionId(this.seat.seatId, null); }
    const now = (this.deps.now ?? Date.now)();
    this.crashes = [...this.crashes.filter(at => now - at < CRASH_WINDOW_MS), now];
    this.log('error', `claude exited (${code ?? 'signal'})${stderr ? `: ${stderr}` : ''}`);
    if (this.crashes.length >= MAX_CRASHES) { this.setStatus('failed', `crashed ${this.crashes.length}× in 10 min — start it again from the web`); return; }
    const delay = RESTART_BACKOFF_MS[Math.min(this.crashes.length - 1, RESTART_BACKOFF_MS.length - 1)]!;
    this.setStatus('starting', `restarting in ${Math.round(delay / 1000)} s`);
    const generation = this.generation;
    (this.deps.setTimer ?? setTimeout)(() => {
      if (this.generation !== generation || this.process) return;
      this.restarts++; this.launch();
    }, delay);
  }

  private setStatus(state: RunnerSeatState, detail: string): void {
    if (state === this.status && detail === this.detail) return;
    this.status = state; this.detail = detail; this.deps.onStatus(this.snapshot());
  }

  private log(kind: RunnerLogKind, summary: string): void { this.deps.onLog({ seatId: this.seat.seatId, ts: (this.deps.now ?? Date.now)(), kind, summary: summary.slice(0, 500) }); }
}
