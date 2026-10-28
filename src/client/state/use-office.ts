import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AgentSnapshot, ChatMessage, OrgView, PermissionRequest, RunnerView, Task } from '../../shared/contracts.js';
import type { Api } from '../api/http.js';
import { connectStream } from '../api/stream.js';
import { initialOfficeState, officeReducer, type OfficeState } from './office-store.js';

export type OfficeHandle = {
  state: OfficeState;
  api: Api;
  loadHistory: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<boolean>;
  markRead: (channelId: string, seq: number) => void;
  loadThread: (channelId: string, seq: number) => Promise<void>;
};

/** Owns office state: initial REST load, realtime stream, and debounced agent refresh on telemetry deltas. */
export const useOffice = (api: Api): OfficeHandle => {
  const [state, dispatch] = useReducer(officeReducer, initialOfficeState);
  const loaded = useRef(new Set<string>()); const openThreads = useRef(new Set<string>());
  const agentRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAll = useCallback(async () => {
    const [org, agents, tasks, permissions, runners] = await Promise.all([api.get<OrgView>('/v1/org'), api.get<{ agents: AgentSnapshot[] }>('/v1/agents'), api.get<{ tasks: Task[] }>('/v1/tasks'), api.get<{ pending: PermissionRequest[] }>('/v1/permissions'), api.get<{ runners: RunnerView[] }>('/v1/runners')]);
    dispatch({ type: 'org', org }); dispatch({ type: 'agents', agents: agents.agents }); dispatch({ type: 'tasks', tasks: tasks.tasks }); dispatch({ type: 'permissions', pending: permissions.pending }); dispatch({ type: 'runners', runners: runners.runners });
  }, [api]);

  const loadHistory = useCallback(async (channelId: string) => {
    const { messages } = await api.get<{ messages: ChatMessage[] }>(`/v1/channels/${encodeURIComponent(channelId)}/messages?limit=100&view=timeline`);
    loaded.current.add(channelId); dispatch({ type: 'history', channelId, messages, mode: 'replace' });
  }, [api]);

  const loadOlder = useCallback(async (channelId: string) => {
    const oldest = state.messages[channelId]?.[0]; if (!oldest || oldest.seq <= 1) return false;
    const { messages } = await api.get<{ messages: ChatMessage[] }>(`/v1/channels/${encodeURIComponent(channelId)}/messages?before=${oldest.seq}&limit=100&view=timeline`);
    dispatch({ type: 'history', channelId, messages, mode: 'prepend' }); return messages.length > 0;
  }, [api, state.messages]);

  const markRead = useCallback((channelId: string, seq: number) => dispatch({ type: 'read', channelId, seq }), []);

  const loadThread = useCallback(async (channelId: string, seq: number) => {
    const thread = await api.get<{ root: ChatMessage; replies: ChatMessage[] }>(`/v1/channels/${encodeURIComponent(channelId)}/threads/${seq}`);
    openThreads.current.add(`${channelId}:${seq}`); dispatch({ type: 'thread', channelId, root: thread.root, replies: thread.replies });
  }, [api]);

  useEffect(() => {
    void refreshAll().catch(() => undefined);
    const dispose = connectStream({
      onStatus: connected => {
        dispatch({ type: 'connection', connected });
        // After a reconnect, REST is the source of truth: refetch org/tasks and the histories already on screen.
        if (connected) {
          void refreshAll().catch(() => undefined);
          for (const channelId of loaded.current) void loadHistory(channelId).catch(() => undefined);
          for (const key of openThreads.current) { const [channelId, seq] = key.split(':'); void loadThread(channelId!, Number(seq)).catch(() => undefined); }
        }
      },
      onMessage: message => {
        if (message.type === 'snapshot') dispatch({ type: 'snapshot', snapshot: message });
        else if (message.type === 'reset') dispatch({ type: 'snapshot', snapshot: message.snapshot });
        else if (message.type === 'collab') dispatch({ type: 'collab', event: message });
        else if (message.type === 'delta') {
          if (agentRefresh.current) return;
          agentRefresh.current = setTimeout(() => {
            agentRefresh.current = null;
            void api.get<{ agents: AgentSnapshot[] }>('/v1/agents').then(result => dispatch({ type: 'agents', agents: result.agents })).catch(() => undefined);
          }, 400);
        }
      },
    });
    // Contact state is time-based on the server; poll slowly so "offline" sessions show up without new events.
    const poll = setInterval(() => void api.get<{ agents: AgentSnapshot[] }>('/v1/agents').then(result => dispatch({ type: 'agents', agents: result.agents })).catch(() => undefined), 15_000);
    return () => { dispose(); clearInterval(poll); if (agentRefresh.current) clearTimeout(agentRefresh.current); };
  }, [api, refreshAll, loadHistory, loadThread]);

  return useMemo(() => ({ state, api, loadHistory, loadOlder, markRead, loadThread }), [state, api, loadHistory, loadOlder, markRead, loadThread]);
};
