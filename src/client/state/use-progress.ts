import { useEffect, useState } from 'react';
import type { SeatActivity, TaskOutput, TaskParticipant } from '../../shared/contracts.js';
import type { Api } from '../api/http.js';
import type { OfficeState } from './office-store.js';

export type Progress = { participants: TaskParticipant[]; outputs: TaskOutput[]; activity: SeatActivity[] };
const EMPTY: Progress = { participants: [], outputs: [], activity: [] };

/** Participants, outputs and seat activity; reloaded when tasks or progress records change, and every minute (staleness). */
export const useProgress = (api: Api, state: OfficeState): Progress => {
  const [progress, setProgress] = useState<Progress>(EMPTY);
  const tasksVersion = Object.values(state.tasks).reduce((latest, task) => Math.max(latest, task.updatedAt + task.revision), 0) + Object.keys(state.tasks).length;
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    // Bursts of task events load once, a second after the last one.
    let live = true;
    const timer = setTimeout(() => { api.get<Progress>('/v1/progress').then(result => { if (live) setProgress(result); }).catch(() => undefined); }, 1_000);
    return () => { live = false; clearTimeout(timer); };
  }, [api, tasksVersion, state.progressVersion, tick]);
  return progress;
};
