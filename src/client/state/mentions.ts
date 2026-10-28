import { ALL_MENTIONS } from '../../shared/join.js';

export type MentionSegment = { text: string; mention?: string };

/** Splits a message body into plain text and @mention segments; only known seat ids become mentions (mirrors the server parser). */
export const splitMentions = (body: string, seatIds: string[]): MentionSegment[] => {
  const known = new Set([...seatIds, ...ALL_MENTIONS]); const segments: MentionSegment[] = []; let cursor = 0;
  const pushText = (text: string): void => {
    if (!text) return;
    const last = segments.at(-1);
    if (last && last.mention === undefined) last.text += text; else segments.push({ text });
  };
  for (const match of body.matchAll(/(?<![\w@])@([a-z0-9][a-z0-9-]{0,63})/g)) {
    const seatId = match[1]!;
    if (!known.has(seatId)) continue;
    pushText(body.slice(cursor, match.index)); segments.push({ text: match[0], mention: seatId }); cursor = match.index + match[0].length;
  }
  pushText(body.slice(cursor));
  return segments;
};

/** Returns the partial @query right before the caret, or null when the caret is not inside a mention. */
export const mentionQueryAt = (text: string, caret: number): { query: string; start: number } | null => {
  const match = /(?:^|\s)@([a-z0-9-]*)$/.exec(text.slice(0, caret));
  return match ? { query: match[1]!, start: caret - match[1]!.length - 1 } : null;
};
