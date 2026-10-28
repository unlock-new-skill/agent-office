import { useCallback, useEffect, useState, type MouseEvent } from 'react';

/** Each workspace view has its own URL so reloads, links and back/forward land on the same screen. */
export type View = 'chat' | 'map' | 'org' | 'machines' | 'requests' | 'setup';
export type Route = { view: View; channelId: string | null };
const VIEWS: View[] = ['chat', 'map', 'org', 'machines', 'requests', 'setup'];
const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;

/** `/chat`, `/chat/<channel>`, `/map`, `/org`, `/machines`, `/requests`, `/setup`; anything else (including `/`) is the chat. */
export const parseRoute = (pathname: string): Route => {
  const [first, second] = pathname.split('/').filter(Boolean);
  const view = VIEWS.find(candidate => candidate === first) ?? 'chat';
  const channelId = first === 'chat' && second && CHANNEL.test(second) ? decodeURIComponent(second) : null;
  return { view, channelId };
};

export const routePath = (route: Route): string => route.view === 'chat' && route.channelId ? `/chat/${encodeURIComponent(route.channelId)}` : `/${route.view}`;

/** Current route plus navigation through the History API (no router dependency). Keeps `?query` such as `?hour=`. */
export const useRoute = (): { route: Route; navigate: (route: Route, options?: { replace?: boolean }) => void; link: (route: Route) => { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void } } => {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = (): void => setRoute(parseRoute(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const url = `${routePath(next)}${location.search}`;
    if (url !== `${location.pathname}${location.search}`) history[options.replace ? 'replaceState' : 'pushState'](null, '', url);
    setRoute(next);
  }, []);
  const link = useCallback((next: Route) => ({
    href: routePath(next),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle new-tab/window clicks; plain clicks navigate in place.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(next);
    },
  }), [navigate]);
  return { route, navigate, link };
};
