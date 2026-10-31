import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MapLayout } from '../map/office-map-layout.js';
import type { SeatSprite } from '../map/office-map-painter.js';
import type { TimeOfDay } from '../map3d/day-night.js';
import type { Office3D, Target3D } from '../map3d/office-3d.js';
import type { MusicProgress } from '../components/music-dock.js';

type Props = {
  layout: MapLayout; seats: Map<string, SeatSprite>; leaders: Set<string>; lobbyLabels: Map<string, string>;
  hovered: string | null; selected: string | null; timeOfDay: TimeOfDay;
  /** Bumped by the Reset view button: glides back to the whole office. */
  resetView: number;
  musicOn: boolean; musicProgress: MusicProgress | null;
  onHover: (target: Target3D | null, x: number, y: number) => void; onSelect: (target: Target3D | null) => void; onUnavailable: () => void;
};

/** Hosts the Three.js office. The 3D module (and three itself) is loaded only when this stage mounts. */
export function Map3DStage({ layout, seats, leaders, lobbyLabels, hovered, selected, timeOfDay, resetView, musicOn, musicProgress, onHover, onSelect, onUnavailable }: Props): ReactNode {
  const host = useRef<HTMLDivElement>(null); const office = useRef<Office3D | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef({ layout, seats, leaders, lobbyLabels, hovered, selected, timeOfDay, onHover, onSelect, onUnavailable });
  latest.current = { layout, seats, leaders, lobbyLabels, hovered, selected, timeOfDay, onHover, onSelect, onUnavailable };

  useEffect(() => {
    let disposed = false;
    import('../map3d/office-3d.js').then(module => {
      if (disposed || !host.current) return;
      if (!module.webglAvailable()) { latest.current.onUnavailable(); return; }
      const created = new module.Office3D(host.current, {
        onHover: (target, x, y) => latest.current.onHover(target, x, y),
        onSelect: target => latest.current.onSelect(target),
      });
      office.current = created; setLoading(false);
      const current = latest.current;
      created.setModel({ layout: current.layout, seats: current.seats, leaders: current.leaders, lobbyLabels: current.lobbyLabels });
      created.setHighlight(current.hovered, current.selected); created.setTimeOfDay(current.timeOfDay);
    }).catch(() => { if (!disposed) latest.current.onUnavailable(); });
    return () => { disposed = true; office.current?.dispose(); office.current = null; };
  }, []);

  useEffect(() => { office.current?.setModel({ layout, seats, leaders, lobbyLabels }); }, [layout, seats, leaders, lobbyLabels]);
  useEffect(() => { office.current?.setHighlight(hovered, selected); }, [hovered, selected]);
  useEffect(() => { office.current?.setTimeOfDay(timeOfDay); }, [timeOfDay]);
  useEffect(() => { if (resetView > 0) office.current?.resetView(); }, [resetView]);
  useEffect(() => { office.current?.setMusic(musicOn, musicProgress); }, [musicOn, musicProgress, loading]);

  return <div className="map-3d" ref={host}>{loading && <p className="map-3d-loading muted">Loading 3D office…</p>}</div>;
}
