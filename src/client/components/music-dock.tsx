import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** The office playlist, played from the pantry speaker. youtube-nocookie keeps YouTube cookies off until it plays. */
const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
const PLAYLIST_EMBED = `${PLAYER_ORIGIN}/embed/CXJJDxg7Mos?list=PLHxnME2C2kCaTZMH6iGOV5JfLwbEbloGO&index=2&autoplay=1&loop=1&playsinline=1&rel=0&enablejsapi=1`;

export type MusicProgress = { title: string; current: number; duration: number };
export type Music = { on: boolean; toggle: () => void; progress: MusicProgress | null; setProgress: (progress: MusicProgress | null) => void };

/** Music on/off for the session. Off by default: browsers only allow sound after the viewer clicks something. */
export const useMusic = (): Music => {
  const [on, setOn] = useState(false); const [progress, setProgress] = useState<MusicProgress | null>(null);
  const toggle = useCallback(() => { setOn(current => !current); setProgress(null); }, []);
  return { on, toggle, progress, setProgress };
};

/** m:ss, or h:mm:ss for long tracks. */
export const clock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds)); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};

type PlayerInfo = { currentTime?: number; duration?: number; videoData?: { title?: string } };

/**
 * Invisible YouTube player: mounted on the click that turns music on (so it may start with sound), unmounted to stop.
 * It reports the track and position over the player's postMessage API; the speaker on the map shows them.
 */
export function MusicDock({ music }: { music: Music }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const info = useRef<{ title: string; current: number; duration: number }>({ title: '', current: 0, duration: 0 });
  const { on, setProgress } = music;

  useEffect(() => {
    if (!on) return;
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
  }, [on, setProgress]);

  if (!on) return null;
  // The player asks for no layout space; "listening" makes it push infoDelivery updates to this page.
  return <iframe ref={frame} className="music-player" src={PLAYLIST_EMBED} title="Office music player" tabIndex={-1} aria-hidden="true" allow="autoplay; encrypted-media"
    referrerPolicy="strict-origin-when-cross-origin" onLoad={() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'office-music', channel: 'widget' }), PLAYER_ORIGIN)} />;
}
