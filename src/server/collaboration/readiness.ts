import { MAX_EXECUTION_MINUTES, type Blocker, type BoardGroup, type ReadinessReason, type ReadinessState, type Task } from '../../shared/contracts.js';

/**
 * Readiness of one task from data only (no chat parsing, no guessing):
 * - tracking tasks are followed apart and never become ready; done/doing are reported as such;
 * - an execution task is ready only with a valid owner, an estimate of at most 4h, every dependency met under its own
 *   condition (completed = done; passed = done and result pass) and no open blocker;
 * - unclassified (legacy) tasks are never ready: their missing metadata is shown instead (fail closed).
 * `gate` lists the reasons that would stop the task now; for a doing task they become a warning to its owner.
 */
export type Evaluation = { state: ReadinessState; reasons: ReadinessReason[]; gate: ReadinessReason[] };
type Lookup = { task: (id: string) => Task | undefined; openBlockers: (taskId: string) => Blocker[] };

const need = (code: string, group: string, text: string): ReadinessReason => ({ code, group, text, action: 'needs-action' });
const wait = (code: string, group: string, text: string): ReadinessReason => ({ code, group, text, action: 'waiting' });

/** Dependency and blocker conditions: the part that can change under a task already in progress. */
const gateReasons = (task: Task, lookup: Lookup): ReadinessReason[] => {
  const reasons: ReadinessReason[] = [];
  for (const id of task.dependsOn) {
    const dependency = lookup.task(id);
    if (!dependency) { reasons.push(need('dependency_missing', `missing:${id}`, `dependency ${id} does not exist`)); continue; }
    if (dependency.status !== 'done') { reasons.push(wait('dependency_open', `dep:${id}`, `waits for ${id} (${dependency.status})`)); continue; }
    if (!task.passRequired.includes(id) || dependency.result === 'pass') continue;
    if (dependency.result === 'unknown') reasons.push(need('result_unconfirmed', `confirm:${id}`, `${id} is done but its result is not recorded; this task needs pass`));
    else reasons.push(wait('result_not_pass', `result:${id}`, `${id} is done with result ${dependency.result}; this task needs pass`));
  }
  // A step blocker stops one step only: the owner starts and continues the independent work, so it never gates the task.
  for (const blocker of lookup.openBlockers(task.id).filter(candidate => candidate.scope !== 'step')) {
    const text = `${blocker.id} ${blocker.kind}: ${blocker.description}`;
    reasons.push(blocker.kind === 'dependency' ? wait('blocker_open', blocker.id, text) : need('blocker_open', blocker.id, text));
  }
  return reasons;
};

export const evaluate = (task: Task, lookup: Lookup): Evaluation => {
  const gate = gateReasons(task, lookup);
  if (task.kind === 'tracking') return { state: 'tracking', reasons: [], gate: [] };
  if (task.status === 'done') return { state: 'done', reasons: [], gate: [] };
  if (task.status === 'doing') return { state: 'doing', reasons: gate, gate };
  const reasons: ReadinessReason[] = [];
  if (task.kind === null) reasons.push(need('unclassified', 'unclassified', 'not classified as execution or tracking yet'));
  if (task.assigneeSeatId === null) reasons.push(need('owner_missing', 'owner-missing', 'no assignee'));
  if (task.estimateMinutes === null) reasons.push(need('estimate_missing', 'estimate', 'no estimate from the assignee'));
  else if (task.kind === 'execution' && task.estimateMinutes > MAX_EXECUTION_MINUTES) reasons.push(need('estimate_too_big', 'estimate', `estimate ${task.estimateMinutes}m is over ${MAX_EXECUTION_MINUTES}m: split it`));
  reasons.push(...gate);
  // A status "blocked" with no blocker record says nothing about who unblocks it: shown as unresolved, never auto-run.
  // Declared blocked while only step blockers are open: the owner said it cannot move, so it is not offered; the owner decides.
  if (task.status === 'blocked' && gate.length === 0 && lookup.openBlockers(task.id).length > 0) reasons.push(need('blocked_step_only', 'blocked-step-only', 'status blocked but only step blockers are open: move it to doing to continue the independent work'));
  if (task.status === 'blocked' && lookup.openBlockers(task.id).length === 0) reasons.push(need('blocked_without_record', 'blocked-without-record', 'status blocked without a blocker record'));
  const state: ReadinessState = reasons.some(reason => reason.action === 'needs-action') ? 'needs-action' : reasons.length > 0 ? 'waiting' : 'ready';
  return { state, reasons, gate };
};

const GROUP_TITLES: Record<string, string> = {
  unclassified: 'Not classified (execution or tracking)', 'owner-missing': 'No assignee', estimate: 'Estimate missing or over 4h',
  'blocked-without-record': 'Blocked without a blocker record (legacy)', 'blocked-step-only': 'Blocked, but only a step is stuck (owner can continue)',
};

/**
 * Gathers reasons by root cause: one group per blocker, per predecessor or per kind of missing metadata, with the
 * people who resolve it and the next step. A task appears under every group that stops it.
 */
export const groupReasons = (entries: Array<{ task: Task; reasons: ReadinessReason[] }>, action: 'needs-action' | 'waiting', blocker: (id: string) => Blocker | undefined, task: (id: string) => Task | undefined): BoardGroup[] => {
  const groups = new Map<string, BoardGroup>();
  for (const entry of entries) {
    for (const reason of entry.reasons.filter(candidate => candidate.action === action)) {
      let group = groups.get(reason.group);
      if (!group) {
        const record = blocker(reason.group);
        const ref = reason.group.includes(':') ? task(reason.group.slice(reason.group.indexOf(':') + 1)) : undefined;
        group = record
          ? { id: record.id, title: record.description, kind: record.kind, resolver: record.resolverSeatId ? `@${record.resolverSeatId}` : record.resolverRole ?? null, nextStep: record.nextStep, dueAt: record.dueAt, blockerId: record.id, taskIds: [] }
          : reason.group.startsWith('dep:') ? { id: reason.group, title: `Waiting for ${ref?.id ?? reason.group.slice(4)} "${ref?.title ?? '?'}" (${ref?.status ?? 'missing'})`, kind: 'dependency', resolver: ref?.assigneeSeatId ? `@${ref.assigneeSeatId}` : null, nextStep: `finish ${ref?.id ?? ''}`, dueAt: null, blockerId: null, taskIds: [] }
          : reason.group.startsWith('result:') ? { id: reason.group, title: `${ref?.id} done with result ${ref?.result}; pass needed`, kind: 'dependency', resolver: ref?.assigneeSeatId ? `@${ref.assigneeSeatId}` : null, nextStep: `fix and re-verify ${ref?.id}, record result pass`, dueAt: null, blockerId: null, taskIds: [] }
          : reason.group.startsWith('confirm:') ? { id: reason.group, title: `Confirm the result of ${ref?.id} "${ref?.title ?? ''}"`, kind: 'decision', resolver: ref?.assigneeSeatId ? `@${ref.assigneeSeatId}` : null, nextStep: `record the result of ${ref?.id} (pass / fail / inconclusive)`, dueAt: null, blockerId: null, taskIds: [] }
          : reason.group.startsWith('missing:') ? { id: reason.group, title: `Dependency ${reason.group.slice(8)} does not exist`, kind: 'defect', resolver: null, nextStep: 'fix dependsOn', dueAt: null, blockerId: null, taskIds: [] }
          : { id: reason.group, title: GROUP_TITLES[reason.group] ?? reason.text, kind: reason.group === 'blocked-without-record' ? 'legacy' : 'metadata', resolver: reason.group === 'estimate' || reason.group === 'blocked-step-only' ? 'assignee' : 'leader', nextStep: reason.group === 'estimate' ? 'assignee sets estimateMinutes (split work over 4h)' : reason.group === 'blocked-step-only' ? 'owner moves it to doing for the independent work' : reason.group === 'owner-missing' ? 'leader or PM sets assigneeSeatId' : reason.group === 'unclassified' ? 'leader sets kind' : 'open a blocker record or move the task to todo', dueAt: null, blockerId: null, taskIds: [] };
        groups.set(reason.group, group);
      }
      if (!group.taskIds.includes(entry.task.id)) group.taskIds.push(entry.task.id);
    }
  }
  return [...groups.values()].sort((a, b) => b.taskIds.length - a.taskIds.length || a.id.localeCompare(b.id));
};
