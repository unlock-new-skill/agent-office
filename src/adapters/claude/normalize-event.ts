import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AUTO_PROMPT_MARK, AUTO_TURN_SUMMARY, type AppendEvent } from '../../shared/contracts.js';

const HookSchema = z.object({
  session_id: z.string().min(1), transcript_path: z.string().nullable().optional(), cwd: z.string().optional(), hook_event_name: z.string(), prompt_id: z.string().optional(), prompt: z.string().optional(), tool_use_id: z.string().optional(), tool_name: z.string().optional(), tool_input: z.unknown().optional(), error: z.string().optional(), last_assistant_message: z.string().nullable().optional(),
}).passthrough();
export type ClaudeBinding = { producerId: string; agentId: string; project: string; sessionId: string; incarnation: string };
const short = (value: unknown): string | undefined => typeof value === 'string' ? value.replace(/[\r\n\t]/g, ' ').slice(0, 200) : undefined;
const eventId = (payload: z.infer<typeof HookSchema>, kind: string): string => createHash('sha256').update(JSON.stringify([payload.session_id, payload.prompt_id ?? '', payload.tool_use_id ?? '', kind, payload.error ?? ''])).digest('hex');

export const normalizeClaudeHook = (raw: unknown, binding: ClaudeBinding): AppendEvent | null => {
  const payload = HookSchema.parse(raw); const now = new Date().toISOString();
  const map: Record<string, AppendEvent['kind']> = { SessionStart: 'session.start', SessionEnd: 'session.end', UserPromptSubmit: 'turn.start', Stop: 'turn.stop', PreToolUse: 'tool.start', PostToolUse: 'tool.done', PostToolUseFailure: 'tool.fail', PermissionRequest: 'permission.request' };
  const kind = map[payload.hook_event_name]; if (!kind) return null;
  const turnId = payload.prompt_id;
  const invocationId = payload.tool_use_id;
  const result: AppendEvent = { id: eventId(payload, kind), ts: now, kind, source: 'claude', producerId: binding.producerId, producerIncarnation: binding.incarnation, agentId: binding.agentId, project: binding.project, sessionId: binding.sessionId, incarnation: binding.incarnation, ...(turnId ? { turnId } : {}), ...(invocationId ? { invocationId } : {}), ...(payload.tool_name ? { tool: payload.tool_name } : {}), ...(payload.error ? { summary: short(payload.error) } : {}), ...(kind === 'turn.start' && payload.prompt?.startsWith(AUTO_PROMPT_MARK) ? { summary: AUTO_TURN_SUMMARY } : {}) };
  return result;
};
