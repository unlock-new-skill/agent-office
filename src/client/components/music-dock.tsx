import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MusicTrack } from '../../shared/contracts.js';
import { errorText, type Api } from '../api/http.js';

/** youtube-nocookie keeps YouTube cookies off until a track plays. */
const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
const TRACK_KEY = 'agent-office.music-track';
/** One video, looped (YouTube loops a single video only when it is also its own playlist). */
const embedUrl = (track: MusicTrack): string => `${PLAYER_ORIGIN}/embed/${track.videoId}?playlist=${track.videoId}&start=${track.startSeconds}&autoplay=1&loop=1&playsinline=1&rel=0&enablejsapi=1`;

export type MusicProgress = { title: string; current: number; duration: number };
export type Music = {
  on: boolean; toggle: () => void; progress: MusicProgress | null; setProgress: (progress: MusicProgress | null) => void;
  tracks: MusicTrack[]; track: MusicTrack | null; play: (track: MusicTrack) => void;
  /** Present for the manager only: saved tracks are shared by everyone. */
  add?: (link: string) => Promise<void>; remove?: (track: MusicTrack) => Promise<void>;
};

const savedTrack = (): string | null => { try { return localStorage.getItem(TRACK_KEY); } catch { return null; } };

/**
 * Pantry speaker state: the saved tracks, which one is chosen (remembered per browser) and whether it plays. One track
 * plays at a time. Off by default: browsers only allow sound after the viewer clicks something.
 */
export const useMusic = (api: Api | null): Music => {
  const [on, setOn] = useState(false); const [progress, setProgress] = useState<MusicProgress | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]); const [chosen, setChosen] = useState<string | null>(savedTrack);
  const load = useCallback(async () => {
    const result = api ? await api.get<{ tracks: MusicTrack[] }>('/v1/music') : await (await fetch('/v1/public/music')).json() as { tracks: MusicTrack[] };
    setTracks(result.tracks);
  }, [api]);
  useEffect(() => { load().catch(() => undefined); }, [load]);
  const track = tracks.find(candidate => candidate.id === chosen) ?? tracks[0] ?? null;
  const toggle = useCallback(() => { setOn(current => !current); setProgress(null); }, []);
  const play = useCallback((next: MusicTrack) => {
    setChosen(next.id); setProgress(null); setOn(true);
    try { localStorage.setItem(TRACK_KEY, next.id); } catch { /* the choice is only remembered for this visit */ }
  }, []);
  const add = useCallback(async (link: string) => {
    if (!api) return;
    const added = await api.send<MusicTrack>('POST', '/v1/music', { url: link });
    await load(); play(added);
  }, [api, load, play]);
  const remove = useCallback(async (removed: MusicTrack) => {
    if (!api) return;
    await api.send('DELETE', `/v1/music/${encodeURIComponent(removed.id)}`);
    if (removed.id === track?.id) setOn(false);
    await load();
  }, [api, load, track?.id]);
  return { on, toggle, progress, setProgress, tracks, track, play, ...(api ? { add, remove } : {}) };
};

/** m:ss, or h:mm:ss for long tracks. */
export const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds)); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

type PlayerInfo = { currentTime?: number; duration?: number; videoData?: { title?: string } };

/**
 * Invisible YouTube player: mounted on the click that turns music on (so it may start with sound), unmounted to stop,
 * remounted when another track is chosen. It reports the track and position over the player's postMessage API; the
 * speaker on the map shows them.
 */
export function MusicDock({ music }: { music: Music }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const info = useRef<MusicProgress>({ title: '', current: 0, duration: 0 });
  const { on, setProgress, track } = music;

  useEffect(() => {
    if (!on) return;
    info.current = { title: track?.title ?? '', current: 0, duration: 0 };
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== PLAYER_ORIGIN || event.source !== frame.current?.contentWindow || typeof event.data !== 'string') return;
      let message: { event?: string; info?: PlayerInfo };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.event !== 'infoDelivery' || !message.info) return;
      const next = { ...info.current };
      if (typeof message.info.currentTime === 'number') next.current = message.info.currentTime;
      if (typeof message.info.duration === 'number') next.duration = message.info.duration;
      if (message.info.videoData?.title) next.title = message.info.videoData.title;
      // Re-render once per second of playback, not on every player tick.
      const changed = Math.floor(next.current) !== Math.floor(info.current.current) || next.title !== info.current.title || next.duration !== info.current.duration;
      info.current = next;
      if (changed) setProgress({ ...next });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [on, setProgress, track?.id, track?.title]);

  if (!on || !track) return null;
  // The player asks for no layout space; "listening" makes it push infoDelivery updates to this page.
  return <iframe key={track.id} ref={frame} className="music-player" src={embedUrl(track)} title="Office music player" tabIndex={-1} aria-hidden="true" allow="autoplay; encrypted-media"
    referrerPolicy="strict-origin-when-cross-origin" onLoad={() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'office-music', channel: 'widget' }), PLAYER_ORIGIN)} />;
}

/** The map bar's music button: shows the time while playing and opens the track list (pick, add a YouTube link, remove). */
export function MusicMenu({ music, notify }: { music: Music; notify: (text: string) => void }): ReactNode {
  const [open, setOpen] = useState(false); const [link, setLink] = useState(''); const [busy, setBusy] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', close); window.addEventListener('pointerdown', close);
    return () => { window.removeEventListener('keydown', close); window.removeEventListener('pointerdown', close); };
  }, [open]);
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (!music.add || !link.trim()) return;
    setBusy(true);
    music.add(link.trim()).then(() => setLink('')).catch(error => notify(errorText(error) === 'invalid_youtube_link' ? 'Link YouTube không hợp lệ (cần link 1 video).' : errorText(error))).finally(() => setBusy(false));
  };
  const label = music.on ? `♪ ${music.progress ? `${clock(music.progress.current)} / ${clock(music.progress.duration)}` : 'Loading…'}` : '♪ Music';
  return (
    <span className="music-menu" ref={root}>
      <button type="button" className={`btn btn-small ${music.on ? 'active' : ''}`} aria-expanded={open} aria-haspopup="dialog" title="Pantry speaker: pick, add or stop music" onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="music-panel" role="dialog" aria-label="Music">
        <header><strong>Pantry speaker</strong><span className="spacer" />{music.on && <button type="button" className="btn btn-small" onClick={music.toggle}>■ Stop</button>}</header>
        <ul>
          {music.tracks.map(track => {
            const current = track.id === music.track?.id;
            return (
              <li key={track.id} className={current ? 'current' : ''}>
                <button type="button" className="music-track" aria-pressed={current && music.on} onClick={() => (current && music.on ? music.toggle() : music.play(track))}>
                  <span aria-hidden>{current && music.on ? '❚❚' : '▶'}</span><span className="music-title">{track.title}</span>{track.startSeconds > 0 && <span className="muted">từ {clock(track.startSeconds)}</span>}
                </button>
                {music.remove && <button type="button" className="icon-btn" aria-label={`Remove ${track.title}`} onClick={() => music.remove!(track).catch(error => notify(errorText(error)))}>✕</button>}
              </li>
            );
          })}
          {music.tracks.length === 0 && <li className="muted">Chưa có bài nào.</li>}
        </ul>
        {music.add && <form onSubmit={submit}>
          <label className="sr-only" htmlFor="music-link">YouTube link</label>
          <input id="music-link" value={link} onChange={event => setLink(event.target.value)} placeholder="Dán link YouTube…" maxLength={500} />
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !link.trim()}>{busy ? '…' : 'Thêm'}</button>
        </form>}
      </div>}
    </span>
  );
}
