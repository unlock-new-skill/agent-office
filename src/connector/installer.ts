/**
 * Claude Code settings for Agent Office: which hook events call the connector, and how to merge them into (or remove
 * them from) a user's existing ~/.claude/settings.json without touching their other hooks.
 */
type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };
export type ClaudeSettings = { hooks?: Record<string, HookEntry[]>; [key: string]: unknown };

const TELEMETRY_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd'];
/** Commands we installed, from a repo checkout (claude-hook.js) or the bundled connector (agent-office.mjs). */
const OURS = /claude-hook\.js|agent-office\.mjs/;

/** Hook settings for one command. PermissionRequest may wait for the manager; Stop long-polls for work. */
export const agentOfficeHooks = (command: string, permissionWaitSeconds: number): Record<string, HookEntry[]> => ({
  ...Object.fromEntries(TELEMETRY_EVENTS.map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 10 }] }]])),
  PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: Math.min(Math.max(permissionWaitSeconds, 0), 580) + 15 }] }],
  Stop: [{ hooks: [{ type: 'command', command, timeout: 600 }] }],
});

/** Drops every hook command we own; entries left empty are removed, other tools' hooks are kept as they were. */
export const removeAgentOfficeHooks = (settings: ClaudeSettings): ClaudeSettings => {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.map(entry => ({ ...entry, hooks: entry.hooks.filter(hook => !OURS.test(hook.command)) })).filter(entry => entry.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const rest = { ...settings }; delete rest.hooks;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
};

/** Replaces any earlier Agent Office hooks (e.g. a repo-checkout install) with the given ones. */
export const mergeAgentOfficeHooks = (settings: ClaudeSettings, ours: Record<string, HookEntry[]>): ClaudeSettings => {
  const base = removeAgentOfficeHooks(settings); const hooks = { ...(base.hooks ?? {}) };
  for (const [event, entries] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...base, hooks };
};

/** Shell command Claude Code runs; forward slashes keep Windows paths valid in Git Bash and cmd alike. */
export const hookCommand = (nodePath: string, scriptPath: string): string => `"${nodePath.replaceAll('\\', '/')}" "${scriptPath.replaceAll('\\', '/')}" hook`;
