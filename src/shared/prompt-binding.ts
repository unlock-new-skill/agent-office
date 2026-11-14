import { createHash } from 'node:crypto';

/**
 * The binding of a prompt: SHA-256 of the exact tool name and input Claude Code asked about. Computed by the runner when
 * it files the prompt and again by the server on the input it receives, so a decision applies to exactly that input.
 * Node only (runner and server); the web client never imports it.
 */
export const promptBinding = (tool: string, input: Record<string, unknown>): string => createHash('sha256').update(JSON.stringify({ tool, input })).digest('hex');
