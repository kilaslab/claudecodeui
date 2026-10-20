import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { clearQueuedMessage } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A message sent while the websocket is not open used to vanish: the send was
 * skipped with a console warning, but the composer had already cleared the box
 * and drawn the message as sent, so the user saw a conversation that the server
 * never received (upstream #1270, mostly on phones whose tab sleeps). The send
 * now reports whether the frame left, and a refused one leaves the draft where
 * it was and says so.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const render = (socketIsOpen: boolean, { withSession = true, isLoading = false }: { withSession?: boolean; isLoading?: boolean } = {}) => {
  const sent: Array<{ type: string }> = [];
  const added: ChatMessage[] = [];
  const processing: string[] = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: withSession ? SESSION : null,
      currentSessionId: withSession ? SESSION.id : null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      processingSessions: new Map(),
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        if (!socketIsOpen) {
          return false;
        }
        sent.push(message as { type: string });
        return true;
      },
      onSessionProcessing: (sessionId) => { processing.push(String(sessionId)); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  return { view, sent, added, processing };
};

const submit = async (view: Pick<ReturnType<typeof render>['view'], 'result'>) => {
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

test('a send the socket refuses keeps the draft, draws no sent message and says what happened', async () => {
  const { view, sent, added, processing } = render(false);
  await act(async () => { view.result.current.setInput('please review the diff'); });

  await submit(view);

  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, 'please review the diff', 'the text is still in the box');
  assert.deepEqual(processing, [], 'no response is awaited');
  assert.deepEqual(added.filter((message) => message.type === 'user'), [], 'no sent bubble is drawn');
  assert.equal(added.filter((message) => message.type === 'error').length, 1);
  assert.match(String(added.find((message) => message.type === 'error')?.content), /not sent/i);
});

test('a send the socket takes clears the box and draws the message, as before', async () => {
  const { view, sent, added, processing } = render(true);
  await act(async () => { view.result.current.setInput('please review the diff'); });

  await submit(view);

  assert.deepEqual(sent.map((message) => message.type), ['chat.send']);
  assert.equal(view.result.current.input, '');
  assert.deepEqual(processing, ['session-1']);
  assert.equal(added.filter((message) => message.type === 'user').length, 1);
  assert.equal(added.filter((message) => message.type === 'error').length, 0);
});

test('a first message sent over a dead socket keeps its text, though the session was already created', async () => {
  // A new chat creates its session before the first send, and the app then
  // moves to that session: the composer's draft scope changes from the
  // project's to the new session's, which has an empty draft. The send then
  // fails, and the text must come with the user rather than be left behind.
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === '/api/providers/sessions') {
      return new Response(JSON.stringify({ data: { sessionId: 'session-new', sessionName: 'New chat' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const sent: Array<{ type: string }> = [];
  const added: ChatMessage[] = [];
  const view = renderHook(
    ({ session }: { session: ProjectSession | null }) =>
      useChatComposerState({
        selectedProject: PROJECT,
        selectedSession: session,
        currentSessionId: session?.id ?? null,
        provider: 'claude',
        permissionMode: 'default',
        cyclePermissionMode: () => undefined,
        resolvePermissionModeForProvider: () => 'default' as PermissionMode,
        currentProviderModel: 'test-model',
        currentProviderEffort: 'medium',
        isLoading: false,
        processingSessions: new Map(),
        canAbortSession: false,
        tokenBudget: null,
        // The socket refuses everything: nothing is sent, so nothing is recorded.
        sendMessage: () => false,
        onSessionEstablished: (sessionId) => { view.rerender({ session: { id: sessionId } }); },
        scrollToBottom: () => undefined,
        addMessage: (message) => { added.push(message); },
        setIsUserScrolledUp: () => undefined,
        setPendingPermissionRequests: () => undefined,
      }),
    { initialProps: { session: null as ProjectSession | null } },
  );
  await act(async () => { view.result.current.setInput('start the migration'); });

  await submit(view);

  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, 'start the migration', 'the text is still in the box');
  assert.equal(added.filter((message) => message.type === 'error').length, 1);
});

test('a steer the socket refuses gives the text back and is not left waiting for an answer', async () => {
  // Steering is the send mode for a turn that is running.
  const { view, sent, added } = render(false, { isLoading: true });
  await act(async () => { view.result.current.setInput('also check the tests'); });

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never, undefined, { mode: 'steer' });
  });

  assert.equal(sent.length, 0);
  assert.equal(view.result.current.input, 'also check the tests');
  assert.equal(added.filter((message) => message.type === 'error').length, 1);
  // Nothing reached the server, so a later rejection of "a steer" has none of
  // this one to match: there is no pending steer to resolve.
  let consumed: boolean | undefined;
  act(() => { consumed = view.result.current.handleSteerRejected('session-1', 'STEER_UNSUPPORTED'); });
  assert.equal(consumed, false);
});
