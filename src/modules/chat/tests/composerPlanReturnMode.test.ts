import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { clearQueuedMessage } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A run started in plan mode returns, once its plan is approved, to the mode
 * the composer returns to — which only the composer knows. It travels with the
 * message, and only for a message sent in plan mode.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const render = (permissionMode: PermissionMode, planReturnMode: PermissionMode = 'auto') => {
  const sent: Array<{ type: string; options?: Record<string, unknown> }> = [];
  const getPlanReturnPermissionMode = vi.fn(() => planReturnMode);
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode,
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: (_provider, mode) => mode as PermissionMode,
      getPlanReturnPermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions: new Map(),
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string; options?: Record<string, unknown> }); return true; },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  return { view, sent, getPlanReturnPermissionMode };
};

const send = async (view: ReturnType<typeof render>['view']) => {
  await act(async () => { view.result.current.setInput('plan the migration'); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  clearQueuedMessage(SESSION.id);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a message sent in plan mode names the mode its approved plan returns to', async () => {
  const { view, sent, getPlanReturnPermissionMode } = render('plan', 'acceptEdits');
  await send(view);

  const message = sent.find((entry) => entry.type === 'chat.send');
  assert.equal(message?.options?.permissionMode, 'plan');
  assert.equal(message?.options?.planReturnMode, 'acceptEdits');
  assert.deepEqual(getPlanReturnPermissionMode.mock.calls.at(-1), ['session-1']);
});

test('a message sent in any other mode carries no return mode', async () => {
  const { view, sent } = render('auto');
  await send(view);

  const message = sent.find((entry) => entry.type === 'chat.send');
  assert.equal(message?.options?.permissionMode, 'auto');
  assert.equal('planReturnMode' in (message?.options ?? {}), false);
});
