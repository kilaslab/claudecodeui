import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * "Load more sessions" must fetch when pressed. The controller used to decide
 * whether to fetch from a flag set inside a state updater, which React does
 * not run until render once anything else is already queued — and the sidebar
 * always has something queued (the running-sessions poll) — so the button did
 * nothing. The guard now lives in a ref.
 */

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NO_IDS: ReadonlySet<string> = new Set<string>();
const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'one', fullPath: '/repo', sessions: [] } as unknown as Project;
// Held outside the hook call: `projects` is an effect dependency.
const PROJECTS = [PROJECT];

beforeEach(() => {
  vi.stubGlobal('alert', vi.fn());
});

const renderController = (onLoadMoreSessions: (projectId: string) => Promise<void>) =>
  renderHook(() =>
    useSidebarController({
      projects: PROJECTS,
      selectedProject: null,
      selectedSession: null,
      activeSessions: NO_IDS,
      backgroundSessionIds: NO_IDS,
      isLoading: false,
      isMobile: false,
      t,
      onRefresh: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onSessionDelete: noop,
      onLoadMoreSessions,
      onProjectDelete: noop,
      setCurrentProject: noop,
      setSidebarVisible: noop,
      sidebarVisible: true,
    }),
  );

test('loads more sessions even when another update is already queued', async () => {
  const onLoadMoreSessions = vi.fn().mockResolvedValue(undefined);
  const { result } = renderController(onLoadMoreSessions);

  await act(async () => {
    // Anything queued on the sidebar first, as the 5 s poll does.
    result.current.setSearchFilter('x');
    await result.current.loadMoreSessionsForProject('project-1');
  });

  assert.deepEqual(onLoadMoreSessions.mock.calls, [['project-1']]);
});

test('a second press while the first load is out does not fetch again, and a later press does', async () => {
  let finish: () => void = noop;
  const onLoadMoreSessions = vi.fn().mockImplementation(
    () => new Promise<void>((resolve) => { finish = resolve; }),
  );
  const { result } = renderController(onLoadMoreSessions);

  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.loadMoreSessionsForProject('project-1');
    await result.current.loadMoreSessionsForProject('project-1');
  });
  assert.equal(onLoadMoreSessions.mock.calls.length, 1);
  assert.equal(result.current.loadingMoreProjects.has('project-1'), true);

  await act(async () => {
    finish();
    await first;
  });
  assert.equal(result.current.loadingMoreProjects.has('project-1'), false);

  await act(async () => {
    const second = result.current.loadMoreSessionsForProject('project-1');
    finish();
    await second;
  });
  assert.equal(onLoadMoreSessions.mock.calls.length, 2);
});
