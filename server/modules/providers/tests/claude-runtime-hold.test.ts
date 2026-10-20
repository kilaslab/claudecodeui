import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  hasActiveHeldTurn,
  listActiveHeldTurns,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  readHeldTurnWaitMs,
  resolveToolApproval,
  steerClaudeSDKSession,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** What the run asked of the process, in order: `interrupt`, `release`, `close`. */
  calls: string[];
  /** Runs when the process is interrupted; a real CLI answers with the turn's `result`. */
  onInterrupt: (() => void) | null;
  /** Runs when the process is closed, in place of ending the stream at once. */
  onClose: (() => void) | null;
  /** Every record the run wrote to the process's stdin, in order. */
  prompts: Array<Record<string, any>>;
  /** What the run asked of the process through control requests: `permission:<mode>`, `model:<id>`. */
  controls: string[];
  /** How many processes the run started. */
  queries: number;
  /** The SDK options of the latest process the run started (its `canUseTool`, hooks, mode). */
  options: Record<string, any> | null;
  /** Makes `setPermissionMode` fail or hang, as a process that is not listening would. */
  permissionModeBehaviour: 'ok' | 'reject' | 'hang';
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    calls: [],
    onInterrupt: null,
    onClose: null,
    prompts: [],
    controls: [],
    queries: 0,
    options: null,
    permissionModeBehaviour: 'ok',
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    script.queries += 1;
    script.options = options as Record<string, any>;
    void (async () => {
      for await (const message of prompt) { script.prompts.push(message as Record<string, any>); }
      released = true;
      script.calls.push('release');
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => { script.calls.push('interrupt'); script.onInterrupt?.(); },
      close: () => { script.calls.push('close'); (script.onClose ?? script.end)(); },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      setPermissionMode: async (mode: string) => {
        if (script.permissionModeBehaviour === 'reject') {
          throw new Error('mode not allowed');
        }
        if (script.permissionModeBehaviour === 'hang') {
          await new Promise(() => {});
        }
        script.controls.push(`permission:${mode}`);
      },
      setModel: async (model?: string) => { script.controls.push(`model:${model}`); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: {
    script: Scripted;
    sent: NormalizedMessage[];
    done: Promise<unknown>;
    /** Sends another message on the same session, as the websocket does with a fresh run's writer. */
    sendAgain: (command: string, extraOptions?: Record<string, unknown>) => { sent: NormalizedMessage[]; done: Promise<unknown> };
  }) => Promise<void>,
  runOptions: Record<string, unknown> = {},
  contextOverrides: Partial<ProviderRuntimeContext> = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
    ...contextOverrides,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...runOptions }, writer as never, context);
    const sendAgain = (command: string, extraOptions: Record<string, unknown> = {}) => {
      const sentAgain: NormalizedMessage[] = [];
      const nextWriter = { send: (message: NormalizedMessage) => { sentAgain.push(message); }, userId: null };
      return {
        sent: sentAgain,
        done: queryClaudeSDK(command, { sessionId: SESSION_ID, cwd, ...runOptions, ...extraOptions }, nextWriter as never, context),
      };
    };
    await runTest({ script, sent, done, sendAgain });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });
// What a resumed CLI emits before it reads the new prompt when the transcript
// holds a task notification it has not delivered yet: a turn of its own, with
// no model call, stamped with the origin (captured from claude 2.1.280).
const notificationTurnResult = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', session_id: NATIVE_ID, result: '', duration_ms: 1, num_turns: 0,
  origin: { kind: 'task-notification' }, ...extra,
});

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('a notification the resumed CLI works through before the prompt does not end the turn', async () => {
  await withRun(async ({ script, sent }) => {
    // The next message after a held run resumes the session in a new process,
    // which first reports the old process's background shell as stopped and
    // closes that out as a turn of its own — before reading the prompt.
    script.emit(taskNotification('old1', 'toolu_old', 'stopped'));
    script.emit(init());
    script.emit(notificationTurnResult());
    script.emit(init());
    script.emit(assistantText('Here is the answer'));
    await waitFor(() => sent.some((message) => message.kind === 'text'));

    assert.equal(sent.filter((message) => message.kind === 'complete').length, 0, 'the reply is still streaming');
    assert.equal(script.released(), false, 'stdin stays open while the prompt\'s turn runs');

    script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    await waitFor(() => script.released());
  });
});

test('background work a turn starts after a drained notification is held', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(taskNotification('old1', 'toolu_old', 'stopped'));
    script.emit(init());
    script.emit(notificationTurnResult());
    // "The dev server died, restart it."
    script.emit(init());
    script.emit(toolUse('toolu_dev', 'Bash', { command: 'npm run dev', run_in_background: true }));
    script.emit(taskStarted('b1', 'toolu_dev', 'local_bash'));
    script.emit(ack('toolu_dev', 'Command running in background with ID: b1.', { backgroundTaskId: 'b1' }));
    script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    await settle();

    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.released(), false, 'the restarted dev server outlives the turn that started it');

    // Its report comes back in a turn with the same origin, now after this
    // turn completed: that one still ends the hold.
    script.emit(taskNotification('b1', 'toolu_dev', 'completed'));
    script.emit(notificationTurnResult({ num_turns: 1, result: 'The dev server exited.' }));
    await waitFor(() => script.released());
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a new turn stops the tasks the held process still has going before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second is the user's next message.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    // (An edit: a plain message would be pushed into the held process instead.)
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-1' }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-1' }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stopping a run mid-turn stops the background agent it launched before letting the process go', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    await waitFor(() => listClaudeSDKBackgroundWork().length === 1);

    // The user presses Stop while the turn is still going. Interrupting the
    // turn and closing stdin leaves the CLI waiting on the agent, so it would
    // keep running — and writing files — after the UI has called it stopped.
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(script.stopped, ['a1'], 'the agent is told to stop');
    await settle();
    assert.equal(script.released(), true, 'and the process is then let go');
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('stopping a run held for its background agent stops the agent before letting the process go', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(script.released(), false, 'the process is held for its agent');

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(script.stopped, ['a1'], 'the agent is told to stop');
    await settle();
    assert.equal(script.released(), true, 'and the process is then let go');
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a stopped run is still let go when stopping its background agent throws', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: throwingStop,
  };

  try {
    const run = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await settle();
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    await waitFor(() => listClaudeSDKBackgroundWork().length === 1);

    // Stopping the agent is best effort; it must not leave the process up or
    // report the user's Stop as failed.
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await settle();
    assert.equal(script.released(), true, 'the process is let go anyway');

    script.end();
    await run;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** Two runs on one session, each with its own scripted CLI, sharing one writer. */
async function withTwoRuns(
  runTest: (context: {
    first: ReturnType<typeof createScriptedQuery>;
    second: ReturnType<typeof createScriptedQuery>;
    sent: NormalizedMessage[];
    startFirst: () => Promise<unknown>;
    /** `extra` overrides the run's options; `{ resumeAnchorId: undefined }` makes it a plain message rather than an edit. */
    startSecond: (extra?: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  try {
    await runTest({
      first,
      second,
      sent,
      startFirst: () => queryClaudeSDK('start a job', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery }),
      // An edit rewinds the conversation to an earlier row, so it cannot be
      // handed to the held process: it takes the session over. (A plain
      // message is pushed into the held process instead, see the tests below.)
      startSecond: (extra = {}) => queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'anchor-1', ...extra }, writer as never, { ...context, createQuery: second.createQuery }),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Drives the first run to a held turn end with one backgrounded command outstanding. */
async function holdForBackgroundCommand(script: Scripted, sent: NormalizedMessage[]): Promise<void> {
  script.emit(init());
  script.emit(toolUse('toolu_bg', 'Bash', { command: 'sleep 120', run_in_background: true }));
  script.emit(taskStarted('b1', 'toolu_bg', 'local_bash'));
  script.emit(ack('toolu_bg', 'Command running in background with ID: b1', { backgroundTaskId: 'b1' }));
  script.emit(result());
  await waitFor(() => sent.some((message) => message.kind === 'complete'));
}

test('a held process relaying its last task reads busy from the settle to the relay turn\'s result', async () => {
  await withRun(async ({ script, sent }) => {
    await holdForBackgroundCommand(script, sent);
    assert.equal(hasActiveHeldTurn(SESSION_ID), false, 'between turns the background work alone marks the session');

    // The task settles. The tracker lets go of it at once, but the CLI is
    // about to run a turn to relay it, so the session must not read idle in
    // the gap before that turn's first message arrives.
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    await settle();
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(hasActiveHeldTurn(SESSION_ID), true, 'busy from the settle');
    assert.deepEqual(listActiveHeldTurns().map((turn) => turn.sessionId), [SESSION_ID]);

    script.emit(assistantText('The job finished.'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), true, 'busy through the relay');

    script.emit(result());
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), false, 'idle once the relay turn ends');
    assert.deepEqual(listActiveHeldTurns(), []);
    assert.equal(script.released(), true);
  });
});

test('a stopped task starts no relay turn, so it does not mark the session busy', async () => {
  await withRun(async ({ script, sent }) => {
    await holdForBackgroundCommand(script, sent);
    script.emit(taskNotification('b1', 'toolu_bg', 'stopped'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), false);
  });
});

test('a follow-up turn no task notification announced also marks the held session busy', async () => {
  await withRun(async ({ script }) => {
    // Monitor reports no task, so the hold rests on the static rule, and the
    // turn it pushes later arrives with no settle in front of it.
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), false);

    script.emit(assistantText('The log printed an error.'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), true);

    script.emit(result());
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), false);
  });
});

test('a held process that exits mid-turn no longer marks the session busy', async () => {
  await withRun(async ({ script, sent, done }) => {
    await holdForBackgroundCommand(script, sent);
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), true);
    script.end();
    await done;
    assert.equal(hasActiveHeldTurn(SESSION_ID), false);
  });
});

test('a new turn sent while the held process relays waits for that turn to end before taking over', async () => {
  await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await settle();
    await holdForBackgroundCommand(first.script, sent);
    first.script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    first.script.emit(assistantText('Relaying the job result.'));
    await settle();

    let secondCreated = false;
    const createSecond = second.createQuery;
    second.createQuery = (options) => { secondCreated = true; return createSecond(options); };
    const secondRun = startSecond();
    await settle();
    await settle();
    assert.equal(first.script.released(), false, 'the relaying process keeps its stdin');
    assert.equal(secondCreated, false, 'the new process is not started mid-turn');
    assert.deepEqual(first.script.calls, [], 'and the relay is not interrupted');

    first.script.emit(result());
    await waitFor(() => secondCreated);
    assert.equal(first.script.released(), true, 'released once its turn is over');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
  });
});

test('a relay turn that outlasts the wait is interrupted before its stdin is closed', async () => {
  const previous = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  process.env.CLAUDE_HELD_TURN_WAIT_MS = '1000';
  try {
    await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
      const firstRun = startFirst();
      await settle();
      await holdForBackgroundCommand(first.script, sent);
      first.script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
      first.script.emit(assistantText('Relaying, slowly.'));
      await settle();
      // An interrupted turn ends with its `result`, as the CLI's does.
      first.script.onInterrupt = () => { first.script.emit(result()); };

      // What the old process had been asked by the time the new one starts:
      // the release is done by then, and the supersede's own interrupt (sent
      // after stdin has ended, so dropped) has not happened yet.
      let callsAtTakeover: string[] | null = null;
      const createSecond = second.createQuery;
      second.createQuery = (options) => { callsAtTakeover = [...first.script.calls]; return createSecond(options); };
      const secondRun = startSecond();
      await waitFor(() => first.script.released());
      await waitFor(() => callsAtTakeover !== null);
      // Interrupted once, by the wait. The release does not interrupt again.
      assert.deepEqual(callsAtTakeover!.filter((call) => call === 'interrupt'), ['interrupt']);

      first.script.end();
      await firstRun;
      second.script.emit(init());
      second.script.emit(result());
      second.script.end();
      await secondRun;
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = previous;
    }
  }
});

test('a relay turn that ignores the interrupt has its process closed', async () => {
  const previous = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  process.env.CLAUDE_HELD_TURN_WAIT_MS = '1000';
  try {
    await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
      const firstRun = startFirst();
      await settle();
      await holdForBackgroundCommand(first.script, sent);
      first.script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
      first.script.emit(assistantText('Relaying, and never stopping.'));
      await settle();

      const secondRun = startSecond();
      // The wait's timers do not hold the event loop open, so poll for them.
      await waitFor(() => first.script.calls.includes('close'));
      await firstRun;
      assert.deepEqual(first.script.calls.slice(0, 2), ['interrupt', 'close']);
      assert.equal(hasActiveHeldTurn(SESSION_ID), false);

      second.script.emit(init());
      second.script.emit(result());
      second.script.end();
      await secondRun;
      assert.equal(second.script.released(), true, 'the new turn ran');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = previous;
    }
  }
});

test('a new turn interrupts the held process before taking over, for a turn the run has not seen start', async () => {
  await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await settle();
    await holdForBackgroundCommand(first.script, sent);
    // The CLI has started a turn of its own (a Monitor event, say) but has
    // written nothing yet, so the run cannot know the session is busy.
    assert.equal(hasActiveHeldTurn(SESSION_ID), false);

    // The release happens before the new process is created; the supersede's
    // interrupt comes after it, once stdin has ended, and is dropped by the
    // SDK. So the interrupt that counts is one already sent at creation.
    let callsAtTakeover: string[] | null = null;
    const createSecond = second.createQuery;
    second.createQuery = (options) => { callsAtTakeover = [...first.script.calls]; return createSecond(options); };
    const secondRun = startSecond();
    await waitFor(() => first.script.released());
    await waitFor(() => callsAtTakeover !== null);
    assert.ok(callsAtTakeover!.includes('interrupt'), 'the unseen turn is interrupted before the new process starts');
    assert.deepEqual(first.script.stopped, ['b1']);

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
  });
});

test('a closed held process gets to exit before the new turn starts', async () => {
  const previous = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  process.env.CLAUDE_HELD_TURN_WAIT_MS = '1000';
  try {
    await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
      const firstRun = startFirst();
      await settle();
      await holdForBackgroundCommand(first.script, sent);
      first.script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
      first.script.emit(assistantText('Relaying, and never stopping.'));
      await settle();
      // The process takes a while to go after it is closed, as a CLI that is
      // SIGTERMed with a tool still running does.
      let exitNow: () => void = () => {};
      first.script.onClose = () => { exitNow = () => first.script.end(); };

      let secondCreated = false;
      const createSecond = second.createQuery;
      second.createQuery = (options) => { secondCreated = true; return createSecond(options); };
      const secondRun = startSecond();
      await waitFor(() => first.script.calls.includes('close'));
      await settle();
      await settle();
      assert.equal(secondCreated, false, 'the new process waits for the old one to exit');

      exitNow();
      await firstRun;
      await waitFor(() => secondCreated);
      second.script.emit(init());
      second.script.emit(result());
      second.script.end();
      await secondRun;
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = previous;
    }
  }
});

test('the held-turn wait is clamped to what a timer can honour', () => {
  const previous = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  const read = (value: string | undefined) => {
    if (value === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = value;
    }
    return readHeldTurnWaitMs();
  };
  try {
    assert.equal(read(undefined), 120_000);
    assert.equal(read(''), 120_000);
    assert.equal(read('abc'), 120_000);
    assert.equal(read('0'), 120_000);
    assert.equal(read('-5'), 120_000, 'a negative wait is not a wait');
    assert.equal(read('Infinity'), 120_000);
    assert.equal(read('50'), 1_000, 'raised to the floor');
    assert.equal(read('3e6'), 3_000_000, 'exponent notation reads as the number it is');
    assert.equal(read('99999999999'), 2_147_483_647, 'held below the timer overflow');
    assert.equal(read('300000'), 300_000);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = previous;
    }
  }
});

/**
 * A message sent while background agents run goes into the process that holds
 * them, as a turn of its own. Starting a new process instead stopped every
 * outstanding task first (upstream #1325), which is how sending "status?" to a
 * session with two reviewers running ended both.
 */
const launchBackgroundAgent = (script: Scripted) => {
  script.emit(init());
  script.emit(toolUse('toolu_agent', 'Agent', { description: 'Review the diff', prompt: 'Review', run_in_background: true }));
  script.emit(taskStarted('agent1', 'toolu_agent', 'local_agent'));
  script.emit(ack('toolu_agent', 'Async agent launched. agentId: agent1', { status: 'async_launched', agentId: 'agent1' }));
  script.emit(result());
};

test('a message sent while a background agent runs goes to the held process and stops nothing', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(script.released(), false);

    const again = sendAgain('status?');
    await waitFor(() => script.prompts.length === 2);

    assert.equal(script.prompts[1].message.content, 'status?');
    assert.equal(script.prompts[1].origin?.kind, 'human');
    assert.deepEqual(script.stopped, [], 'the agent keeps running');
    assert.equal(script.calls.includes('interrupt'), false);
    assert.equal(script.calls.includes('release'), false, 'the process is not released');
    assert.equal(script.calls.includes('close'), false);

    script.emit(assistantText('Both reviewers are still running.'));
    script.emit(result());
    await again.done;

    // The pushed turn answers on its own run's writer and reports its own end.
    assert.ok(again.sent.some((message) => message.kind === 'text' && message.content === 'Both reviewers are still running.'));
    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1, 'the first run is not completed twice');
    assert.equal(sent.some((message) => message.kind === 'text' && message.content === 'Both reviewers are still running.'), false);
    // The agent is still outstanding, so the process stays held for it.
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['agent1']]);
    assert.equal(script.released(), false);
  });
});

test('a pushed turn that was the last thing the process was held for completes on its own result and then releases it', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('anything running?');
    await waitFor(() => script.prompts.length === 2);

    // The agent reports back: the CLI relays it in a turn of its own, stamped
    // with the origin the resumed CLI stamps task-notification turns with. That
    // result is not the end of the pushed message.
    script.emit(taskNotification('agent1', 'toolu_agent', 'completed'));
    script.emit(notificationTurnResult());
    await settle();
    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 0, 'the relay does not end the pushed turn');
    assert.equal(script.released(), false);

    // The pushed message's own turn.
    script.emit(assistantText('Nothing.'));
    script.emit(result());
    await again.done;

    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 1);
    await waitFor(() => script.released());
    assert.deepEqual(script.stopped, []);
  });
});

test('a message sent during a relay turn waits for it, then goes to the same process', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    // A second reviewer, so the process stays held after the first one reports.
    script.emit(toolUse('toolu_agent2', 'Agent', { description: 'Review the tests', prompt: 'Review', run_in_background: true }));
    script.emit(taskStarted('agent2', 'toolu_agent2', 'local_agent'));
    script.emit(ack('toolu_agent2', 'Async agent launched. agentId: agent2', { status: 'async_launched', agentId: 'agent2' }));
    await settle();

    // The first reviewer reports back: the held process starts a turn to relay it.
    script.emit(taskNotification('agent1', 'toolu_agent', 'completed'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), true);

    const again = sendAgain('thanks');
    await settle();
    assert.equal(script.prompts.length, 1, 'not pushed while the relay turn is mid-flight');

    script.emit(assistantText('The first review finished.'));
    script.emit(result());
    await waitFor(() => script.prompts.length === 2);
    assert.equal(script.prompts[1].message.content, 'thanks');
    assert.equal(script.calls.includes('interrupt'), false);
    assert.deepEqual(script.stopped, []);

    script.emit(assistantText('You are welcome.'));
    script.emit(result());
    await again.done;
    assert.equal(script.released(), false, 'the second reviewer still holds the process');
  });
});

test('a message pushed into the held process carries the composer\'s permission mode', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('now edit files', { permissionMode: 'acceptEdits' });
    await waitFor(() => script.prompts.length === 2);
    assert.deepEqual(script.controls, ['permission:acceptEdits']);

    script.emit(result());
    await again.done;
  });
});

test('a mode that would skip the owner is not forced onto a process started without the interaction hook', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('go full auto', { permissionMode: 'auto' });
    await waitFor(() => script.prompts.length === 2);
    assert.deepEqual(script.controls, [], 'it keeps asking, which is the safe side');

    script.emit(result());
    await again.done;
  });
});

/**
 * A compaction rewrites the context, and no assistant message states what is
 * left of it: the boundary does. Without that the meter kept the size from
 * before the compaction, and the turn's `result` — which bills the summary
 * request — would have published a bigger figure still.
 */
test('a compaction publishes the context it left behind as the token budget', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({
      type: 'system', subtype: 'compact_boundary', session_id: NATIVE_ID,
      compact_metadata: { trigger: 'manual', pre_tokens: 335_000, post_tokens: 10_000, duration_ms: 1_000 },
    });
    script.emit({
      type: 'result', subtype: 'success', session_id: NATIVE_ID, result: '', duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 340_000, output_tokens: 9_000 },
    });
    await settle();

    const budgets = sent
      .filter((message) => message.kind === 'status' && message.text === 'token_budget')
      .map((message) => (message as { tokenBudget?: { used?: number } }).tokenBudget?.used);
    assert.deepEqual(budgets, [10_000]);
  });
});

test('a compaction in progress says so on the activity indicator, not only in the transcript', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({ type: 'system', subtype: 'status', session_id: NATIVE_ID, status: 'compacting' });
    script.emit(result());
    await settle();

    const statuses = sent
      .filter((message) => message.kind === 'status' && message.text !== 'token_budget')
      .map((message) => (message as { text?: string }).text);
    assert.deepEqual(statuses, ['Compacting conversation…']);
  });
});

/**
 * What a message pushed into a held process must still get right: the mode the
 * process is in *now* decides what is allowed, Stop ends a message that is
 * waiting, a process that has let go of stdin is not waited on, and the pushed
 * turn ends cleanly however the process does.
 */
const launchTwoAgents = (script: Scripted) => {
  launchBackgroundAgent(script);
  script.emit(toolUse('toolu_agent2', 'Agent', { description: 'Review the tests', prompt: 'Review', run_in_background: true }));
  script.emit(taskStarted('agent2', 'toolu_agent2', 'local_agent'));
  script.emit(ack('toolu_agent2', 'Async agent launched. agentId: agent2', { status: 'async_launched', agentId: 'agent2' }));
};

test('a mode switched to while agents run is the mode that decides what is allowed', { timeout: 20_000 }, async () => {
  // Launched with Bypass, so canUseTool used to wave everything through for the
  // life of the process, whatever the user picked afterwards.
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('now ask me before running anything', { permissionMode: 'default' });
    await waitFor(() => script.prompts.length === 2);
    assert.deepEqual(script.controls, ['permission:default']);

    const pending = script.options!.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'toolu_bash' });
    const request = again.sent.find((message) => message.kind === 'permission_request');
    assert.ok(request?.requestId, 'the owner is asked, on the run the message belongs to');
    resolveToolApproval(request.requestId as string, { allow: true });
    assert.equal((await pending).behavior, 'allow');

    script.emit(result());
    await again.done;
  }, { permissionMode: 'bypassPermissions' });
});

test('a switch the held process cannot take is said in the conversation, and the message still goes', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    // Launched in the default mode, so it has no interaction hook: Auto would
    // answer its own questions.
    const again = sendAgain('go full auto', { permissionMode: 'auto' });
    await waitFor(() => script.prompts.length === 2);

    assert.deepEqual(script.controls, []);
    const notice = again.sent.find((message) => message.kind === 'error');
    assert.match(String(notice?.content), /instead of switching to auto mode/);

    script.emit(result());
    await again.done;
  });
});

test('a switch the process refuses, or never answers, is said too, and does not hold the message up', { timeout: 30_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    script.permissionModeBehaviour = 'reject';
    const again = sendAgain('plan it', { permissionMode: 'plan' });
    await waitFor(() => script.prompts.length === 2);
    assert.match(String(again.sent.find((message) => message.kind === 'error')?.content), /refused the switch to plan mode/);

    script.emit(result());
    await again.done;
  });
});

test('Stop pressed while a message waits for a relay turn ends it, and starts no process of its own', { timeout: 30_000 }, async () => {
  const previous = process.env.CLAUDE_HELD_TURN_WAIT_MS;
  process.env.CLAUDE_HELD_TURN_WAIT_MS = '1000';
  try {
    await withRun(async ({ script, sendAgain }) => {
      launchTwoAgents(script);
      await settle();
      script.emit(taskNotification('agent1', 'toolu_agent', 'completed'));
      await settle();
      assert.equal(hasActiveHeldTurn(SESSION_ID), true);

      const again = sendAgain('thanks');
      await settle();
      assert.equal(script.prompts.length, 1, 'waiting for the relay');

      assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
      script.end();
      await again.done;

      assert.equal(script.queries, 1, 'the cancelled message did not start a process');
      assert.equal(script.prompts.some((prompt) => prompt.message?.content === 'thanks'), false);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_HELD_TURN_WAIT_MS;
    } else {
      process.env.CLAUDE_HELD_TURN_WAIT_MS = previous;
    }
  }
});

test('a relay turn that starts while the message is being prepared is waited for, not pushed into', { timeout: 20_000 }, async () => {
  let lookups = 0;
  let releaseModelLookup: () => void = () => {};
  const modelLookup = new Promise<void>((resolve) => { releaseModelLookup = resolve; });
  await withRun(async ({ script, sendAgain }) => {
    launchTwoAgents(script);
    await settle();

    const again = sendAgain('thanks');
    await settle();
    // The agent reports back while the message is still being prepared.
    script.emit(taskNotification('agent1', 'toolu_agent', 'completed'));
    await settle();
    assert.equal(hasActiveHeldTurn(SESSION_ID), true);
    releaseModelLookup();
    await settle();
    assert.equal(script.prompts.length, 1, 'not folded into the relay turn');

    script.emit(assistantText('The first review finished.'));
    script.emit(notificationTurnResult());
    await waitFor(() => script.prompts.length === 2);
    assert.equal(script.prompts[1].message.content, 'thanks');

    script.emit(assistantText('You are welcome.'));
    script.emit(result());
    await again.done;
  }, {}, {
    resolveResumeModel: async () => {
      // The first turn's own lookup answers at once; the one made for the
      // message pushed later waits for the test.
      lookups += 1;
      if (lookups > 1) {
        await modelLookup;
      }
      return undefined;
    },
  });
});

test('a process that has let go of stdin is not waited on: the message goes the ordinary way at once', { timeout: 20_000 }, async () => {
  await withTwoRuns(async ({ first, second, sent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await settle();
    await holdForBackgroundCommand(first.script, sent);
    // The user stops the last task: nothing is outstanding, so the hold ends and
    // stdin is released, though the process has not exited yet.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'b1'), true);
    first.script.emit(taskNotification('b1', 'toolu_bg', 'stopped'));
    await waitFor(() => first.script.released());

    // A mode switch on a process that is not reading would never be answered.
    first.script.permissionModeBehaviour = 'hang';
    let secondCreated = false;
    const createSecond = second.createQuery;
    second.createQuery = (options) => { secondCreated = true; return createSecond(options); };
    const secondRun = startSecond({ resumeAnchorId: undefined, permissionMode: 'acceptEdits' });
    await waitFor(() => secondCreated);
    assert.deepEqual(first.script.controls, [], 'no control request was sent to a process that is not reading');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
  });
});

test('the pushed turn ends with its own complete when the process exits during it', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('status?');
    await waitFor(() => script.prompts.length === 2);
    script.end();
    await again.done;

    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('Stop during a pushed turn ends it once, on the run it belongs to', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('status?');
    await waitFor(() => script.prompts.length === 2);
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.end();
    await again.done;

    assert.equal(script.queries, 1);
    assert.ok(again.sent.filter((message) => message.kind === 'complete').length <= 1, 'at most one complete');
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1, 'the first run is not completed again');
  });
});

test('a steer into a pushed turn defers its complete to the follow-up result', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('status?');
    await waitFor(() => script.prompts.length === 2);
    const steered = await steerClaudeSDKSession(SESSION_ID, 'and the tests?');
    assert.ok(steered?.uuid, 'a pushed turn is steerable');
    await waitFor(() => script.prompts.length === 3);

    // The CLI never folded the steer, so the first result ends the turn it was
    // pushed onto and the steer runs as one of its own.
    script.emit(result());
    await settle();
    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 0);

    script.emit(result());
    await again.done;
    assert.equal(again.sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('two messages in a row each go to the held process, one after the other', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const first = sendAgain('one');
    await waitFor(() => script.prompts.length === 2);
    script.emit(assistantText('first answer'));
    script.emit(result());
    await first.done;

    const second = sendAgain('two');
    await waitFor(() => script.prompts.length === 3);
    script.emit(assistantText('second answer'));
    script.emit(result());
    await second.done;

    assert.equal(script.queries, 1, 'one process served all three');
    assert.deepEqual(script.stopped, []);
    assert.equal(first.sent.filter((message) => message.kind === 'complete').length, 1);
    assert.equal(second.sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

/**
 * The mode a pushed message moves the held process to is the one a new process
 * would start in, and an approved plan never brings back a mode the user has
 * left since.
 */
const SKIP_PERMISSIONS = { toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true } };

test('"Skip permissions" moves the held process to bypass, as a new process would start', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    const again = sendAgain('status?', { permissionMode: 'default' });
    await waitFor(() => script.prompts.length === 2);
    assert.deepEqual(script.controls, ['permission:bypassPermissions'], 'not downgraded to asking for every command');

    script.emit(result());
    await again.done;
  }, SKIP_PERMISSIONS);
});

/** Approves the ExitPlanMode the main thread (or, with `agentID`, a subagent) calls, and returns canUseTool's answer. */
const approvePlan = async (script: Scripted, sent: NormalizedMessage[], toolUseID: string, agentID?: string) => {
  const pending = script.options!.canUseTool(
    'ExitPlanMode',
    { plan: 'Do the thing' },
    { signal: new AbortController().signal, toolUseID, ...(agentID ? { agentID } : {}) },
  );
  await waitFor(() => sent.some((message) => message.kind === 'permission_request' && (message as { input?: unknown }).input !== undefined));
  const request = sent.filter((message) => message.kind === 'permission_request').at(-1);
  resolveToolApproval(request!.requestId as string, { allow: true });
  return pending;
};

test('a plan approved after a message switched the mode returns to that mode, not the one before', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchBackgroundAgent(script);
    await settle();

    // Planned on the way to Auto, then the user picked Default for the next message.
    const again = sendAgain('ask me first from now on', { permissionMode: 'default' });
    await waitFor(() => script.prompts.length === 2);

    // The model plans on its own in the pushed turn; the owner approves.
    const answer = await approvePlan(script, again.sent, 'toolu_exit_later');
    assert.deepEqual(answer.updatedPermissions, [{ type: 'setMode', mode: 'default', destination: 'session' }]);

    script.emit(result());
    await again.done;
  }, { permissionMode: 'plan', planReturnMode: 'auto' });
});

test('a subagent\'s approved plan leaves the session\'s mode alone', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();

    const answer = await approvePlan(script, sent, 'toolu_sub_exit', 'agent-7');
    assert.equal(answer.behavior, 'allow');
    assert.equal(answer.updatedPermissions, undefined);

    script.emit(result());
  }, { permissionMode: 'plan', planReturnMode: 'acceptEdits' });
});

test('the interaction hook outlasts the CLI\'s ten-minute default, and a hook the CLI gave up on asks again', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();

    const matcher = script.options!.hooks.PreToolUse[0];
    assert.equal(matcher.timeout, 24 * 60 * 60);

    const giveUp = new AbortController();
    const hookAnswer = matcher.hooks[0]({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, 'toolu_ask', { signal: giveUp.signal });
    await waitFor(() => sent.some((message) => message.kind === 'permission_request'));
    giveUp.abort();
    await hookAnswer;
    await settle();

    // The CLI goes on without the hook's answer and asks canUseTool for the same tool use.
    const pending = script.options!.canUseTool('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'toolu_ask' });
    await waitFor(() => sent.filter((message) => message.kind === 'permission_request').length === 2);
    const second = sent.filter((message) => message.kind === 'permission_request')[1];
    resolveToolApproval(second.requestId as string, { allow: true });
    assert.equal((await pending).behavior, 'allow', 'the owner answers; nobody answered no for them');

    script.emit(result());
  }, { permissionMode: 'auto' });
});

test('Stop whose interrupt fails still ends a message waiting for a relay turn', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sendAgain }) => {
    launchTwoAgents(script);
    await settle();
    script.emit(taskNotification('agent1', 'toolu_agent', 'completed'));
    await settle();

    const again = sendAgain('thanks');
    await settle();
    script.onInterrupt = () => { throw new Error('not listening'); };
    // The websocket completes the run as stopped whatever the runtime says.
    assert.equal(await abortClaudeSDKSession(SESSION_ID), false);
    script.onInterrupt = null;

    script.emit(assistantText('The first review finished.'));
    script.emit(notificationTurnResult());
    await again.done;
    assert.equal(script.prompts.some((prompt) => prompt.message?.content === 'thanks'), false, 'not pushed into a run that was stopped');
  });
});

test('a compaction that ends clears its label, and one that failed says why', { timeout: 20_000 }, async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit({ type: 'system', subtype: 'status', session_id: NATIVE_ID, status: 'compacting' });
    script.emit({ type: 'system', subtype: 'status', session_id: NATIVE_ID, status: null, compact_result: 'failed', compact_error: 'Conversation too long' });
    script.emit(result());
    await settle();

    const statuses = sent
      .filter((message) => message.kind === 'status' && message.text !== 'token_budget')
      .map((message) => (message as { text?: string }).text);
    assert.deepEqual(statuses, ['Compacting conversation…', '']);
    assert.ok(sent.some((message) => message.kind === 'error' && message.content === 'Compacting the conversation failed: Conversation too long'));
  });
});

test('a message sent with the default model switches a held process back to it', { timeout: 20_000 }, async () => {
  // With ANTHROPIC_MODEL set, "Default" leaves the model flag off.
  const previous = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = 'claude-from-env';
  try {
    await withRun(async ({ script, sendAgain }) => {
      launchBackgroundAgent(script);
      await settle();

      const again = sendAgain('cheaper now', { model: CLAUDE_PREDEFINED_MODELS.DEFAULT });
      await waitFor(() => script.prompts.length === 2);
      assert.deepEqual(script.controls, ['model:undefined']);

      script.emit(result());
      await again.done;
    }, { model: 'opus' });
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previous;
    }
  }
});
