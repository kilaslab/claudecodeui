import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { clearQueuedMessage } from '@/shared/chatDrafts';
import type * as ChatDrafts from '@/shared/chatDrafts';
import type { BackgroundSendChoice, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps its
 * composer usable, and a message sent to it goes straight to the process that
 * holds the work: the work keeps running and reports back to it. Nothing is
 * stopped, so nothing is asked. Only an edit of an earlier message rewinds the
 * conversation and takes the process over, which stops the work — so only an
 * edit asks first: send anyway, queue the message until the work finishes (the
 * server holds it while the work runs), or cancel.
 */

const { writeQueuedMessage } = vi.hoisted(() => ({ writeQueuedMessage: vi.fn() }));

vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatDrafts>();
  return {
    ...actual,
    writeQueuedMessage: (...args: Parameters<typeof actual.writeQueuedMessage>) => {
      writeQueuedMessage(...args);
      actual.writeQueuedMessage(...args);
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
const UPLOADED = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [
      { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
      { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
      { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
    ],
  },
]]);

const render = (processingSessions: SessionActivityMap) => {
  const sent: Array<{ type: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); return true; },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  const sends = () => sent.filter((message) => message.type === 'chat.send' || message.type === 'chat.edit-send');
  return { view, sends };
};

type View = ReturnType<typeof render>['view'];

const startSubmit = (view: View) => {
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  return pending;
};

// Submits, waits for the prompt, answers it, and lets the submit finish.
const submitAndAnswer = async (view: View, choice: BackgroundSendChoice) => {
  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt(choice);
    await pending;
  });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/assets/files')) {
      return new Response(JSON.stringify({ attachments: [UPLOADED] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  // The drafts store is module state; a message queued by one test must not
  // be restored into the next one's composer.
  clearQueuedMessage(SESSION.id);
  writeQueuedMessage.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a message sent on a session with background work goes straight out, and nothing is asked', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(view.result.current.backgroundSendPrompt, null, 'no prompt: the message does not stop the work');
  assert.equal(sends().length, 1);
  assert.equal(writeQueuedMessage.mock.calls.length, 0, 'and it is not queued behind the work');
  assert.equal(view.result.current.input, '', 'the composer clears as for any send');
});

const startEdit = async (view: View) => {
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'first draft', timestamp: new Date(), transcriptAnchorId: 'anchor-1' } as never);
  });
  await act(async () => { view.result.current.setInput('second draft'); });
};

test('editing an earlier message over background work asks first, naming the session\'s own tasks', async () => {
  const { view, sends } = render(backgroundOnly);
  await startEdit(view);

  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));

  assert.deepEqual(view.result.current.backgroundSendPrompt, {
    work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
  });
  assert.equal(sends().length, 0, 'nothing is sent while the prompt is open');

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await pending;
  });
});

test('cancelling an edit prompt (the default answer to Enter, Esc or a click outside) sends nothing and keeps the draft', async () => {
  const { view, sends } = render(backgroundOnly);
  await startEdit(view);

  await submitAndAnswer(view, 'cancel');

  assert.equal(sends().length, 0, 'declined: nothing is sent');
  assert.equal(writeQueuedMessage.mock.calls.length, 0, 'and nothing is queued');
  assert.equal(view.result.current.input, 'second draft', 'and the draft stays in the composer');
  assert.equal(view.result.current.backgroundSendPrompt, null, 'and the prompt closes');
});

test('send anyway sends the edit', async () => {
  const { view, sends } = render(backgroundOnly);
  await startEdit(view);

  await submitAndAnswer(view, 'send');

  // The edit is its own frame, not a plain send.
  assert.deepEqual(sends().map((message) => message.type), ['chat.edit-send']);
  assert.equal(writeQueuedMessage.mock.calls.length, 0);
});

test('a second submit while the edit prompt is open neither opens another prompt nor sends', async () => {
  const { view, sends } = render(backgroundOnly);
  await startEdit(view);

  const first = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  const prompt = view.result.current.backgroundSendPrompt;

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.equal(view.result.current.backgroundSendPrompt, prompt, 'the same prompt is still the open one');
  assert.equal(sends().length, 0);

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await first;
  });
  assert.equal(sends().length, 0, 'exactly zero sends');
});

test('a session with nothing in the background sends without asking', async () => {
  const { view, sends } = render(new Map());
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(view.result.current.backgroundSendPrompt, null);
  assert.equal(sends().length, 1);
});

test('stopping a session\'s background work asks the server to stop the session', () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions: backgroundOnly,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as Record<string, unknown>); return true; },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  act(() => { view.result.current.handleStopBackgroundWork(); });

  // The turn has ended, so there is nothing for the ordinary Stop to abort;
  // the server stops the work the session's process is still holding.
  assert.deepEqual(sent.filter((message) => message.type === 'chat.abort'), [{ type: 'chat.abort', sessionId: SESSION.id }]);
});
