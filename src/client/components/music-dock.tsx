import { useCallback, useState, type ReactNode } from 'react';

/** The office playlist, played from the pantry speaker. youtube-nocookie keeps YouTube cookies off until it plays. */
const PLAYLIST_EMBED = 'https://www.youtube-nocookie.com/embed/CXJJDxg7Mos?list=PLHxnME2C2kCaTZMH6iGOV5JfLwbEbloGO&index=2&autoplay=1&loop=1&playsinline=1&rel=0';

export type Music = { on: boolean; toggle: () => void };

/** Music on/off for the session. Off by default: browsers only allow sound after the viewer clicks something. */
export const useMusic = (): Music => {
  const [on, setOn] = useState(false);
  const toggle = useCallback(() => setOn(current => !current), []);
  return { on, toggle };
};

/**
 * Small player docked in the corner while music is on. It is mounted on the click that turns music on, so the browser
 * lets it start with sound; closing it unmounts the player and stops the music.
 */
export function MusicDock({ music }: { music: Music }): ReactNode {
  if (!music.on) return null;
  return (
    <aside className="music-dock" aria-label="Office music">
      <header><span aria-hidden>♪</span> Pantry radio<span className="spacer" /><button type="button" className="icon-btn" aria-label="Stop music" onClick={music.toggle}>✕</button></header>
      <iframe src={PLAYLIST_EMBED} title="Office music playlist" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" />
    </aside>
  );
}
