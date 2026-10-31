import type { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from './db/database.js';
import type { MusicTrack } from '../shared/contracts.js';

type Deps = { db: Database; manager: (request: Request) => unknown; fetch?: typeof fetch };
const json = (message: string, status: number): Response => Response.json({ error: message }, { status });
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_TRACKS = 100;
const COLUMNS = 'id,video_id AS videoId,start_seconds AS startSeconds,title,added_at AS addedAt';

/** "253", "253s", "4m13s", "1h2m3s" → seconds; anything else → 0. */
const seconds = (value: string | null): number => {
  if (!value) return 0;
  if (/^\d+s?$/.test(value)) return Number.parseInt(value, 10);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  return match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0;
};

/** One video from a YouTube link (watch, youtu.be, shorts, embed, live), with its start time; null when it is not one. */
export const parseYouTube = (link: string): { videoId: string; startSeconds: number } | null => {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return null; }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let videoId: string | null = null;
  if (host === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    videoId = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? null;
  }
  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  return { videoId, startSeconds: Math.min(seconds(url.searchParams.get('t') ?? url.searchParams.get('start')), 86_400) };
};

/**
 * Pantry speaker tracks. Anyone who can see the map reads the list; only the manager adds or removes tracks. The title
 * comes from YouTube's oEmbed endpoint (the video id when it cannot be reached).
 */
export const registerMusicRoutes = (app: Hono, deps: Deps): void => {
  const list = (): MusicTrack[] => deps.db.raw.prepare(`SELECT ${COLUMNS} FROM music_tracks ORDER BY added_at`).all() as MusicTrack[];
  const titleOf = async (videoId: string): Promise<string> => {
    try {
      const response = await (deps.fetch ?? fetch)(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return videoId;
      const title = ((await response.json()) as { title?: unknown }).title;
      return typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : videoId;
    } catch { return videoId; }
  };

  app.get('/v1/public/music', c => c.json({ tracks: list() }));
  app.get('/v1/music', c => deps.manager(c.req.raw) ? c.json({ tracks: list() }) : json('unauthorized', 401));
  app.post('/v1/music', async c => {
    if (!deps.manager(c.req.raw)) return json('unauthorized', 401);
    const parsed = z.object({ url: z.string().min(1).max(500) }).strict().safeParse(await c.req.json().catch(() => null));
    const track = parsed.success ? parseYouTube(parsed.data.url) : null;
    if (!track) return json('invalid_youtube_link', 400);
    const existing = deps.db.raw.prepare(`SELECT ${COLUMNS} FROM music_tracks WHERE video_id=?`).get(track.videoId) as MusicTrack | undefined;
    if (existing) return c.json(existing);
    if ((deps.db.raw.prepare('SELECT COUNT(*) AS n FROM music_tracks').get() as { n: number }).n >= MAX_TRACKS) return json('too_many_tracks', 409);
    const title = await titleOf(track.videoId);
    deps.db.raw.prepare('INSERT INTO music_tracks(id,video_id,start_seconds,title,added_at) VALUES (?,?,?,?,?) ON CONFLICT(video_id) DO NOTHING').run(track.videoId, track.videoId, track.startSeconds, title, Date.now());
    return c.json(deps.db.raw.prepare(`SELECT ${COLUMNS} FROM music_tracks WHERE video_id=?`).get(track.videoId) as MusicTrack, 201);
  });
  app.delete('/v1/music/:id', c => {
    if (!deps.manager(c.req.raw)) return json('unauthorized', 401);
    deps.db.raw.prepare('DELETE FROM music_tracks WHERE id=?').run(c.req.param('id'));
    return c.json({ ok: true });
  });
};
