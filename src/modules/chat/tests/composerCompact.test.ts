import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * Compacting a conversation from chat mode: `/compact` is a built-in the menu
 * offers, and the Compact button runs the same thing. The CLI does the work
 * when it receives `/compact [instructions]` as a message, so both send exactly
 * that — and neither touches what the user is typing.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const COMPACT = { name: '/compact', description: 'Summarize the conversation to free up context', namespace: 'builtin', metadata: { type: 'builtin' } };

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

const renderComposer = (isLoading = false, { withSession = true }: { withSession?: boolean } = {}) => {
  const sent: Array<{ type: string; content?: string }> = [];
  const added: Array<{ type: string; content?: unknown }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: withSession ? { id: 'session-existing' } : null,
      currentSessionId: withSession ? 'session-existing' : null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string; content?: string }); return true; },
      onSessionEstablished: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message as { type: string; content?: unknown }); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  return { view, added, sent: () => sent, chatSends: () => sent.filter((message) => message.type === 'chat.send') };
};

beforeEach(() => {
  fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === '/api/commands/list' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ builtIn: [COMPACT], custom: [], count: 1 }));
    }
    if (target.startsWith('/api/providers/claude/skills')) {
      return Promise.resolve(jsonResponse({ success: true, data: { skills: [] } }));
    }
    if (target === '/api/commands/execute' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { rawArgs?: string };
      return Promise.resolve(jsonResponse({ type: 'builtin', action: 'compact', data: { instructions: (body.rawArgs ?? '').trim() }, command: '/compact' }));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('the Compact button sends /compact and leaves the draft alone', async () => {
  const { view, chatSends } = renderComposer();
  await act(async () => { view.result.current.setInput('half a thought'); });

  await act(async () => { view.result.current.compactConversation(); });

  await waitFor(() => assert.deepEqual(chatSends().map((message) => message.content), ['/compact']));
  assert.equal(view.result.current.input, 'half a thought');
});

test('typing /compact with instructions compacts with those instructions', async () => {
  const { view, chatSends } = renderComposer();
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));
  await act(async () => { view.result.current.setInput('/compact keep the API decisions'); });

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  await waitFor(() => assert.deepEqual(chatSends().map((message) => message.content), ['/compact keep the API decisions']));
  assert.equal(view.result.current.input, '', 'the command text is consumed as for any command');
});

test('compacting while a response is running waits: nothing is sent, the draft stays, and the user is told', async () => {
  const { view, chatSends, added } = renderComposer(true);
  await act(async () => { view.result.current.setInput('half a thought'); });

  await act(async () => { view.result.current.compactConversation(); });

  assert.equal(chatSends().length, 0, 'not sent into the running turn');
  assert.equal(view.result.current.queuedDraft, null, 'and not queued over the draft');
  assert.equal(view.result.current.input, 'half a thought');
  assert.match(String(added.at(-1)?.content), /waits for the current response/i);
});

test('compacting while an earlier message is being edited does not replace the conversation', async () => {
  // The edit state is the composer's; a message the app sends on the user's
  // behalf must not ride on it and become an edit-send of "/compact".
  const { view, chatSends, added, sent } = renderComposer();
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'first draft', timestamp: new Date(), transcriptAnchorId: 'anchor-1' } as never);
  });

  await act(async () => { view.result.current.compactConversation(); });

  assert.equal(chatSends().length, 0);
  assert.equal(sent().filter((message) => message.type === 'chat.edit-send').length, 0, 'nothing is replaced');
  assert.equal(view.result.current.editingAnchorId, 'anchor-1', 'the edit is still open');
  assert.equal(view.result.current.input, 'first draft');
  assert.match(String(added.at(-1)?.content), /finish or cancel the edit/i);
});

test('compacting a chat that has no session yet sends nothing and creates no session', async () => {
  const { view, chatSends, added, sent } = renderComposer(false, { withSession: false });

  await act(async () => { view.result.current.compactConversation(); });

  assert.equal(chatSends().length, 0);
  assert.equal(sent().length, 0);
  assert.equal(
    fetchMock.mock.calls.some(([url]) => String(url) === '/api/providers/sessions'),
    false,
    'no session is created for a message that has nothing to compact',
  );
  assert.match(String(added.at(-1)?.content), /nothing to compact/i);
});
