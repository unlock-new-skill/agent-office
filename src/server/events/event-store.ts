import { createHash } from 'node:crypto';
import type { Database } from '../db/database.js';
import { EventEnvelopeSchema, type AgentSnapshot, type AppendEvent, type Delta, type EventEnvelope, type Snapshot } from '../../shared/contracts.js';

const meta = (db: Database, key: string): string => (db.raw.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string }).value;
const SECRET_KEY = /^(?:password|token|api[_-]?key|authorization|client[_-]?secret|private[_-]?key|secret)$/i;
const redactJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : redactJson(item)]));
  return value;
};
const redact = (summary: string | undefined): string | undefined => {
  if (summary === undefined) return undefined;
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (parsed && typeof parsed === 'object') return JSON.stringify(redactJson(parsed)).slice(0, 200);
  } catch { /* fallback to bounded text redaction */ }
  return summary
    .replace(/(authorization\s*[:=]\s*)[^\s,;}"}]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[^\s,;}"}]+/gi, '$1[REDACTED]')
    .replace(/((?:"?(?:password|token|api[_-]?key|authorization)"?)\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:password|token|api[_-]?key|authorization)\s*[:=]\s*"?)([^\s,;}"}]+)/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]/g, ' ').slice(0, 200);
};
const normalized = (input: AppendEvent): AppendEvent => {
  const summary = redact(input.summary);
  return summary === undefined ? input : { ...input, summary };
};
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
};
const hashPayload = (payload: AppendEvent): string => createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');

export class EventStore {
  constructor(private readonly db: Database, private readonly publish: (delta: Delta) => void) {}

  append(rawInput: AppendEvent): EventEnvelope {
    const input = normalized(rawInput);
    const payloadHash = hashPayload(input);
    const existing = this.db.raw.prepare('SELECT payload_hash,payload_json FROM events WHERE producer_id=? AND producer_incarnation=? AND event_id=?').get(input.producerId, input.producerIncarnation, input.id) as { payload_hash: string; payload_json: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error('conflicting_event');
      return EventEnvelopeSchema.parse(JSON.parse(existing.payload_json));
    }
    const event = this.db.transaction(() => {
      const generation = meta(this.db, 'dataset_generation'); const seq = Number(meta(this.db, 'event_seq') || '0') + 1;
      const envelope = EventEnvelopeSchema.parse({ ...input, v: 1, seq, datasetGeneration: generation, sessionIncarnation: input.incarnation });
      this.db.raw.prepare('UPDATE meta SET value=? WHERE key=?').run(String(seq), 'event_seq');
      this.db.raw.prepare('INSERT INTO events(generation,producer_id,producer_incarnation,event_id,payload_hash,payload_json,session_id,turn_id,invocation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        generation, envelope.producerId, envelope.producerIncarnation, envelope.id, payloadHash, JSON.stringify(envelope), envelope.sessionId, envelope.turnId ?? null, envelope.invocationId ?? null, envelope.ts,
      );
      this.updateProjection(envelope); return envelope;
    });
    try { this.publish({ type: 'delta', generation: event.datasetGeneration, seq: event.seq, event }); } catch { /* durable replay repairs notification failure */ }
    return event;
  }

  snapshot(): Snapshot {
    return this.db.transaction(() => {
      const agents = this.db.raw.prepare("SELECT a.id,a.source,a.project,a.session_id AS sessionId,a.incarnation AS sessionIncarnation,a.activity AS state,CASE WHEN a.ended_at IS NOT NULL THEN 'exited' WHEN a.last_contact_at IS NULL THEN 'unknown' WHEN a.last_contact_at < ? THEN 'contact_lost' ELSE 'connected' END AS contactState,a.last_event_at AS lastEventAt,(SELECT tool FROM invocations i WHERE i.agent_id=a.id AND i.state='open' ORDER BY rowid DESC LIMIT 1) AS currentTool,COALESCE(i.pending,0) AS pendingInvocations,COALESCE(p.pending,0) AS pendingPermissions FROM agents a LEFT JOIN (SELECT agent_id,COUNT(*) AS pending FROM invocations WHERE state='open' GROUP BY agent_id) i ON i.agent_id=a.id LEFT JOIN (SELECT agent_id,COUNT(*) AS pending FROM permission_waits GROUP BY agent_id) p ON p.agent_id=a.id ORDER BY a.id").all(Date.now() - 20_000) as AgentSnapshot[];
      return { generation: meta(this.db, 'dataset_generation'), seq: Number(meta(this.db, 'event_seq') || '0'), agents };
    });
  }

  replayPage(generation: string, afterSeq: number, limit = 500): { deltas: Delta[]; nextAfter: number | null; hasMore: boolean; highWater: number; coverageThrough: number } {
    const currentGeneration = meta(this.db, 'dataset_generation'); const highWater = Number(meta(this.db, 'event_seq') || '0');
    if (generation !== currentGeneration) throw new Error('cursor_generation_mismatch');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('cursor_invalid');
    if (afterSeq > highWater) throw new Error('cursor_future');
    const rows = this.db.raw.prepare('SELECT payload_json FROM events WHERE generation=? AND seq>? AND session_id NOT IN (SELECT session_id FROM purge_suppressions) ORDER BY seq LIMIT ?').all(generation, afterSeq, limit + 1) as Array<{ payload_json: string }>;
    const hasMore = rows.length > limit; const visible = hasMore ? rows.slice(0, limit) : rows;
    const deltas: Delta[] = visible.map(row => { const event = EventEnvelopeSchema.parse(JSON.parse(row.payload_json)); return { type: 'delta' as const, generation, seq: event.seq, event }; });
    const nextAfter = hasMore ? (deltas.at(-1)?.seq ?? afterSeq) : (highWater > afterSeq && deltas.length === 0 ? highWater : null);
    return { deltas, nextAfter, hasMore, highWater, coverageThrough: highWater };
  }

  replay(generation: string, afterSeq: number, limit = 500): Delta[] { return this.replayPage(generation, afterSeq, limit).deltas; }

  private updateProjection(event: EventEnvelope): void {
    let current = this.db.raw.prepare('SELECT incarnation,ended_at,last_event_at FROM agents WHERE id=?').get(event.agentId) as { incarnation: string; ended_at: string | null; last_event_at: string | null } | undefined;
    if (current && current.incarnation !== event.incarnation) {
      if (event.kind !== 'session.start' || current.ended_at === null) return;
      this.db.raw.prepare('DELETE FROM turns WHERE agent_id=?').run(event.agentId); this.db.raw.prepare('DELETE FROM invocations WHERE agent_id=?').run(event.agentId); this.db.raw.prepare('DELETE FROM permission_waits WHERE agent_id=?').run(event.agentId);
      this.db.raw.prepare('UPDATE agents SET source=?,project=?,session_id=?,incarnation=?,ended_at=NULL,last_event_at=NULL,last_contact_at=NULL,active_turn=NULL,turn_started_at=NULL,activity=? WHERE id=?').run(event.source, event.project, event.sessionId, event.incarnation, this.activity(event.kind), event.agentId);
      current = { incarnation: event.incarnation, ended_at: null, last_event_at: null };
    }
    const terminal = event.kind === 'tool.done' || event.kind === 'tool.fail' || event.kind === 'turn.stop' || event.kind === 'session.end';
    const stale = Boolean(current?.last_event_at && event.ts < current.last_event_at);
    if (current && current.ended_at !== null && !terminal) return;
    if (stale && !terminal) return;
    if (event.turnId) {
      const turn = this.db.raw.prepare('SELECT closed FROM turns WHERE agent_id=? AND turn_id=?').get(event.agentId, event.turnId) as { closed: number } | undefined;
      if (turn?.closed && (event.kind === 'turn.start' || event.kind === 'tool.start' || event.kind === 'permission.request')) return;
    }
    if (event.kind === 'tool.start') {
      const invocation = this.db.raw.prepare('SELECT state FROM invocations WHERE agent_id=? AND invocation_id=?').get(event.agentId, event.invocationId!) as { state: string } | undefined;
      if (invocation?.state === 'closed') return;
    }
    const canUpdateAgent = !stale && current?.ended_at === null;
    const exists = this.db.raw.prepare('SELECT 1 FROM agents WHERE id=?').get(event.agentId);
    if (!exists) this.db.raw.prepare('INSERT INTO agents(id,source,project,session_id,incarnation,last_event_at,last_contact_at,activity) VALUES (?,?,?,?,?,?,?,?)').run(event.agentId, event.source, event.project, event.sessionId, event.incarnation, event.ts, Date.now(), this.activity(event.kind));
    else if (canUpdateAgent) this.db.raw.prepare('UPDATE agents SET last_event_at=?,last_contact_at=?,activity=?,ended_at=CASE WHEN ? THEN ? ELSE ended_at END,active_turn=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE active_turn END,turn_started_at=CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE turn_started_at END WHERE id=? AND incarnation=?').run(
      event.ts, Date.now(), this.activity(event.kind), event.kind === 'session.end' ? 1 : 0, event.ts, event.kind === 'turn.start' ? 1 : 0, event.turnId ?? null, event.kind === 'turn.stop' || event.kind === 'session.end' ? 1 : 0, event.kind === 'turn.start' ? 1 : 0, event.ts, event.kind === 'turn.stop' || event.kind === 'session.end' ? 1 : 0, event.agentId, event.incarnation,
    );
    if (event.turnId) {
      this.db.raw.prepare('INSERT OR IGNORE INTO turns(agent_id,turn_id) VALUES (?,?)').run(event.agentId, event.turnId);
      if (event.kind === 'turn.stop') this.db.raw.prepare('UPDATE turns SET closed=1 WHERE agent_id=? AND turn_id=?').run(event.agentId, event.turnId);
    }
    if (event.kind === 'tool.start') this.db.raw.prepare('INSERT OR REPLACE INTO invocations(agent_id,turn_id,invocation_id,tool,state) VALUES (?,?,?,?,?)').run(event.agentId, event.turnId!, event.invocationId!, event.tool ?? null, 'open');
    if (event.kind === 'tool.done' || event.kind === 'tool.fail') this.db.raw.prepare("UPDATE invocations SET state='closed' WHERE agent_id=? AND invocation_id=?").run(event.agentId, event.invocationId!);
    if (event.kind === 'permission.request') this.db.raw.prepare('INSERT OR IGNORE INTO permission_waits(agent_id,turn_id,invocation_key) VALUES (?,?,?)').run(event.agentId, event.turnId!, event.invocationId ?? event.id);
    if (event.kind === 'session.end') { this.db.raw.prepare("UPDATE invocations SET state='closed' WHERE agent_id=?").run(event.agentId); this.db.raw.prepare('UPDATE turns SET closed=1 WHERE agent_id=?').run(event.agentId); this.db.raw.prepare('DELETE FROM permission_waits WHERE agent_id=?').run(event.agentId); }
    else if ((event.kind === 'tool.done' || event.kind === 'tool.fail') && event.invocationId) this.db.raw.prepare('DELETE FROM permission_waits WHERE agent_id=? AND invocation_key=?').run(event.agentId, event.invocationId);
    else if (event.kind === 'turn.stop' && event.turnId) this.db.raw.prepare('DELETE FROM permission_waits WHERE agent_id=? AND turn_id=?').run(event.agentId, event.turnId);
  }

  private activity(kind: AppendEvent['kind']): AgentSnapshot['state'] {
    if (kind === 'permission.request') return 'blocked'; if (kind === 'tool.fail') return 'error'; if (kind === 'session.end' || kind === 'turn.stop') return 'idle'; if (kind === 'tool.start' || kind === 'turn.start') return 'working'; return 'online';
  }
}
