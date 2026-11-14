import type { Database } from '../db/database.js';
import type { Project, ProjectChange, ProjectDetail, ProjectPriority, ProjectStatus, ProjectSummary, ProjectTask, ProjectTaskState, Task } from '../../shared/contracts.js';
import type { DispatchService } from './dispatch-service.js';
import type { Evaluation } from './readiness.js';
import type { Actor, MessageService } from './message-service.js';
import { conflict, forbidden, invalid, notFound } from './office-error.js';
import type { OrgService } from './org-service.js';
import type { TaskService } from './task-service.js';

/** Order fields; everything but the title may stay empty so an order can be sent in one line and completed later. */
export type ProjectInput = { title: string; goal?: string | undefined; spec?: string | undefined; requirements?: string | undefined; acceptance?: string | undefined; priority?: ProjectPriority | undefined; links?: string[] | undefined };
export type ProjectPatch = Omit<ProjectInput, 'title'> & { title?: string | undefined; status?: ProjectStatus | undefined; expectedRevision?: number | undefined };
type CleanProject = { title: string; goal: string; spec: string; requirements: string; acceptance: string; priority: ProjectPriority; links: string[] };
type Field = 'title' | 'goal' | 'spec' | 'requirements' | 'acceptance' | 'priority' | 'links' | 'status';
const FIELDS: Field[] = ['title', 'goal', 'spec', 'requirements', 'acceptance', 'priority', 'links', 'status'];
const LIMITS = { title: 200, goal: 4000, spec: 20_000, requirements: 20_000, acceptance: 8000 } as const;
const MAX_LINKS = 20; const MAX_LINK = 500;
type Row = Omit<Project, 'links'> & { links: string };
const COLUMNS = 'id,number,title,goal,spec,requirements,acceptance,priority,links,status,created_by_kind AS createdByKind,created_by_id AS createdById,created_at AS createdAt,updated_at AS updatedAt,revision';
const toProject = (row: Row): Project => ({ ...row, links: JSON.parse(row.links) as string[] });
const actorId = (actor: Actor): string => actor.kind === 'manager' ? 'manager' : actor.seatId;
const emptyCounts = (): Record<ProjectTaskState, number> => ({ done: 0, doing: 0, waiting: 0, blocked: 0, todo: 0 });

/**
 * Projects (orders): the manager files what is wanted — goal, spec, requirements, acceptance, priority, links — and
 * the PM splits it into ordinary tasks linked by projectId (owners then start, finish and hand over as usual; nothing
 * here adds an approval or a step). The manager and coordinators (PM) file and edit orders; every seat reads them,
 * since owners work from the spec. A new order or a changed one is told to the coordinators once, in their channel.
 * The project page derives each task's state from the task's own data and readiness; it never changes a task.
 */
export class ProjectService {
  constructor(private readonly db: Database, private readonly org: OrgService, private readonly messages: MessageService, private readonly tasks: TaskService, private readonly dispatch: DispatchService) {}

  /** Orders, open first. Task counts cover only the tasks the reader may see. */
  list(actor: Actor): ProjectSummary[] {
    const projects = (this.db.raw.prepare(`SELECT ${COLUMNS} FROM projects ORDER BY status='closed',updated_at DESC`).all() as Row[]).map(toProject);
    const evals = this.evaluations();
    return projects.map(project => ({ ...project, counts: this.tasksOf(actor, project.id, evals).reduce((counts, entry) => { counts[entry.state]++; return counts; }, emptyCounts()) }));
  }

  get(projectId: string): Project {
    const row = this.db.raw.prepare(`SELECT ${COLUMNS} FROM projects WHERE id=?`).get(projectId) as Row | undefined;
    if (!row) throw notFound('project');
    return toProject(row);
  }

  /** The order with its tasks the reader may see (a member sees its own department's part; leads, PM and manager more). */
  detail(actor: Actor, projectId: string): ProjectDetail {
    const project = this.get(projectId); const tasks = this.tasksOf(actor, projectId, this.evaluations());
    return { project, tasks, counts: tasks.reduce((counts, entry) => { counts[entry.state]++; return counts; }, emptyCounts()), changes: this.changes(projectId) };
  }

  /**
   * Files an order. Sending the same order twice (same title, all fields equal, still open) returns the first one
   * instead of a copy; the same title with different content is refused so two orders are never confused.
   */
  create(actor: Actor, input: ProjectInput): Project {
    this.requireEditor(actor);
    const values = this.clean({ priority: 'normal', goal: '', spec: '', requirements: '', acceptance: '', links: [], ...input });
    const twin = this.db.raw.prepare(`SELECT ${COLUMNS} FROM projects WHERE status='open' AND lower(trim(title))=lower(?)`).get(values.title) as Row | undefined;
    if (twin) {
      const existing = toProject(twin);
      if ((['goal', 'spec', 'requirements', 'acceptance', 'priority'] as const).every(field => existing[field] === values[field]) && JSON.stringify(existing.links) === JSON.stringify(values.links)) return existing;
      throw conflict('project_exists', { project: existing });
    }
    const now = Date.now();
    const project = this.db.transaction(() => {
      const number = (this.db.raw.prepare('SELECT COALESCE(MAX(number),0)+1 AS next FROM projects').get() as { next: number }).next;
      const id = `p-${number}`;
      this.db.raw.prepare('INSERT INTO projects(id,number,title,goal,spec,requirements,acceptance,priority,links,status,created_by_kind,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, number, values.title, values.goal, values.spec, values.requirements, values.acceptance, values.priority, JSON.stringify(values.links), 'open', actor.kind, actorId(actor), now, now);
      return this.get(id);
    });
    this.tellCoordinators(actor, `New order ${project.id} "${project.title}" (priority ${project.priority}) from ${actor.kind === 'manager' ? 'the manager' : `@${actorId(actor)}`}. Read the spec (agent_office_project { action: "get", projectId: "${project.id}" }), split it into tasks with owner, output, acceptance and real dependencies, and file them with projectId "${project.id}". Owners then start, finish and hand over to their lead as usual.`);
    return project;
  }

  /** Field edit with revision check and audit; tasks already filed keep their status, result and history. */
  update(actor: Actor, projectId: string, patch: ProjectPatch): Project {
    this.requireEditor(actor);
    const project = this.get(projectId);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== project.revision) throw conflict('stale_revision', { project });
    const values = this.clean({ ...project, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as ProjectInput & { status: ProjectStatus });
    const status = patch.status ?? project.status;
    if (status !== 'open' && status !== 'closed') throw invalid('invalid_project');
    if (status === 'open') {
      const clash = this.db.raw.prepare(`SELECT ${COLUMNS} FROM projects WHERE status='open' AND id<>? AND lower(trim(title))=lower(?)`).get(projectId, values.title) as Row | undefined;
      if (clash) throw conflict('project_exists', { project: toProject(clash) });
    }
    const after: Record<Field, unknown> = { ...values, status };
    const changed = FIELDS.filter(field => JSON.stringify(after[field]) !== JSON.stringify(project[field]));
    if (changed.length === 0) return project;
    const now = Date.now();
    const updated = this.db.transaction(() => {
      const written = this.db.raw.prepare('UPDATE projects SET title=?,goal=?,spec=?,requirements=?,acceptance=?,priority=?,links=?,status=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
        .run(values.title, values.goal, values.spec, values.requirements, values.acceptance, values.priority, JSON.stringify(values.links), status, now, projectId, project.revision);
      if (Number(written.changes) === 0) throw conflict('stale_revision', { project: this.get(projectId) });
      const audit = this.db.raw.prepare('INSERT INTO project_changes(project_id,revision,actor_kind,actor_id,field,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const field of changed) audit.run(projectId, project.revision + 1, actor.kind, actorId(actor), field, JSON.stringify(project[field]), JSON.stringify(after[field]), now);
      return this.get(projectId);
    });
    const what = changed.map(field => field === 'status' ? `status=${status}` : field).join(', ');
    this.tellCoordinators(actor, `Order ${projectId} "${updated.title}" changed (${what}) by ${actor.kind === 'manager' ? 'the manager' : `@${actorId(actor)}`}. Check whether its tasks still match; tasks already done stay done unless you decide otherwise.`);
    return updated;
  }

  changes(projectId: string): ProjectChange[] {
    return (this.db.raw.prepare('SELECT project_id AS projectId,revision,actor_kind AS actorKind,actor_id AS actorId,field,before_json AS beforeJson,after_json AS afterJson,created_at AS createdAt FROM project_changes WHERE project_id=? ORDER BY id').all(projectId) as Array<Omit<ProjectChange, 'before' | 'after'> & { beforeJson: string | null; afterJson: string | null }>)
      .map(({ beforeJson, afterJson, ...row }) => ({ ...row, before: beforeJson === null ? null : JSON.parse(beforeJson) as unknown, after: afterJson === null ? null : JSON.parse(afterJson) as unknown }));
  }

  /** Each task of the project with where it stands; one missing input shows on that task only, never on the whole order. */
  /** One readiness evaluation of the whole office per request, shared by every task shown. */
  private evaluations(): Map<string, Evaluation> {
    return new Map(this.dispatch.evaluations().map(entry => [entry.task.id, entry.evaluation]));
  }

  private tasksOf(actor: Actor, projectId: string, evals: Map<string, Evaluation>): ProjectTask[] {
    return this.tasks.ofProject(projectId).filter(task => this.tasks.canRead(actor, task)).map(task => this.stateOf(task, evals.get(task.id)));
  }

  /**
   * blocked = something only a person can clear (a blocker that is not a dependency, or the owner declared it blocked
   * with no waiting reason); waiting = an input task or a dependency blocker is not finished yet; todo = the rest.
   */
  private stateOf(task: Task, evaluation: Evaluation | undefined): ProjectTask {
    const output = task.status === 'done' ? this.tasks.doneNote(task.id) : null;
    if (task.status === 'done') return { task, state: 'done', reasons: [], output };
    if (task.status === 'doing') return { task, state: 'doing', reasons: [], output };
    const reasons = evaluation?.reasons ?? [];
    const text = reasons.map(reason => reason.text);
    const waiting = reasons.some(reason => reason.action === 'waiting');
    const stuck = reasons.some(reason => reason.code === 'blocker_open' && reason.action === 'needs-action');
    if (stuck || (task.status === 'blocked' && !waiting)) return { task, state: 'blocked', reasons: text, output };
    if (waiting) return { task, state: 'waiting', reasons: text, output };
    return { task, state: 'todo', reasons: text, output };
  }

  private requireEditor(actor: Actor): void {
    if (actor.kind === 'seat' && !this.org.seat(actor.seatId).coordinator) throw forbidden('project_editor_only');
  }

  private clean(input: ProjectInput & { status?: ProjectStatus }): CleanProject {
    const title = (input.title ?? '').trim();
    if (title.length === 0) throw invalid('invalid_project: a title is required');
    const text = (field: keyof typeof LIMITS): string => {
      const value = field === 'title' ? title : (input[field] ?? '').trim();
      if (value.length > LIMITS[field]) throw invalid(`invalid_project: ${field} is longer than ${LIMITS[field]} characters`);
      return value;
    };
    const priority = input.priority ?? 'normal';
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw invalid('invalid_project: priority');
    const links = [...new Set((input.links ?? []).map(link => link.trim()).filter(Boolean))];
    if (links.length > MAX_LINKS || links.some(link => link.length > MAX_LINK)) throw invalid('invalid_project: links');
    return { title: text('title'), goal: text('goal'), spec: text('spec'), requirements: text('requirements'), acceptance: text('acceptance'), priority, links };
  }

  /** One line per coordinator department channel, mentioning the coordinators there (the actor is never woken by its own change). */
  private tellCoordinators(actor: Actor, body: string): void {
    const byChannel = new Map<string, string[]>();
    for (const seat of this.org.view().seats.filter(candidate => candidate.coordinator)) {
      if (actor.kind === 'seat' && actor.seatId === seat.id) continue;
      byChannel.set(seat.departmentId, [...byChannel.get(seat.departmentId) ?? [], seat.id]);
    }
    for (const [channelId, seats] of byChannel) this.messages.postSystem(channelId, `${seats.map(id => `@${id}`).join(' ')} ${body}`, seats);
  }
}
