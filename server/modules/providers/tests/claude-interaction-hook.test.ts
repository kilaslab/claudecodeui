import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK, resolveToolApproval } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * AskUserQuestion and ExitPlanMode need the owner's answer. In 'auto' and
 * 'bypassPermissions' the CLI never calls `canUseTool`, so the runtime routes
 * them through a PreToolUse hook, which runs before permission-mode handling.
 * The other modes keep `canUseTool` as their only approval path.
 */

type HookCallback = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, any>>;
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID?: string }) => Promise<Record<string, any>>;
type CapturedOptions = {
  hooks?: { PreToolUse?: Array<{ matcher: string; hooks: HookCallback[] }> };
  canUseTool?: CanUseTool;
  disallowedTools?: string[];
  permissionMode?: string;
};

/**
 * Starts a turn whose scripted SDK stream stays open until `finish` is called,
 * and returns the options every `createQuery` attempt received.
 */
async function startTurn(
  permissionMode: string,
  { rejectHooks = false, rejectInitialization = false, planReturnMode }: { rejectHooks?: boolean; rejectInitialization?: boolean; planReturnMode?: string } = {},
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-interaction-hook-'));
  const sent: NormalizedMessage[] = [];
  const attempts: CapturedOptions[] = [];
  const closed: boolean[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: ({ prompt, options }) => {
      attempts.push(options as CapturedOptions);
      if (rejectHooks && options.hooks) {
        throw new Error('hooks not supported');
      }
      void (async () => { for await (const _message of prompt) { /* read */ } })();
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'native-hook-session' };
        await finished;
        yield { type: 'result', subtype: 'success', session_id: 'native-hook-session', result: 'ok', duration_ms: 1, num_turns: 1 };
      })();
      const attempt = closed.push(false) - 1;
      // The SDK answers `query()` at once and reports a rejected initialize
      // request (hooks included) only through `initializationResult()`.
      const initialization = rejectInitialization && options.hooks
        ? Promise.reject(new Error('initialize failed'))
        : Promise.resolve({});
      return Object.assign(stream, {
        interrupt: async () => {},
        initializationResult: () => initialization,
        close: () => { closed[attempt] = true; },
      });
    },
  };

  const run = queryClaudeSDK('hello', { sessionId: `app-hook-${Math.random()}`, cwd, permissionMode, ...(planReturnMode ? { planReturnMode } : {}) }, { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null } as never, context);
  for (let attempt = 0; attempt < 200 && attempts.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    sent,
    attempts,
    closed,
    async end() {
      finish();
      await run;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

const preToolUseHook = (options: CapturedOptions) => {
  const entry = options.hooks?.PreToolUse?.[0];
  assert.ok(entry, 'a PreToolUse hook is registered');
  return entry;
};

for (const mode of ['bypassPermissions', 'auto']) {
  test(`AskUserQuestion is answered by the owner through the hook in ${mode} mode`, async () => {
    const turn = await startTurn(mode);
    try {
      const entry = preToolUseHook(turn.attempts[0]);
      assert.equal(entry.matcher, 'AskUserQuestion|ExitPlanMode');

      const question = { questions: [{ question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] };
      const pending = entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: question }, 'toolu_1', { signal: new AbortController().signal });

      const request = turn.sent.find((message) => message.kind === 'permission_request');
      assert.ok(request?.requestId, 'the owner is asked');
      assert.equal(request.toolName, 'AskUserQuestion');

      const answered = { ...question, answers: { 'Which database?': 'Postgres' } };
      resolveToolApproval(request.requestId, { allow: true, updatedInput: answered });
      assert.deepEqual(await pending, {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: answered },
      });
    } finally {
      await turn.end();
    }
  });
}

test('a denied ExitPlanMode is denied by the hook with the owner\'s reason', async () => {
  const turn = await startTurn('bypassPermissions');
  try {
    const entry = preToolUseHook(turn.attempts[0]);
    const pending = entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do it' } }, 'toolu_2', { signal: new AbortController().signal });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    assert.ok(request?.requestId);
    resolveToolApproval(request.requestId, { allow: false, message: 'Keep planning' });
    assert.deepEqual(await pending, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Keep planning' },
    });
  } finally {
    await turn.end();
  }
});

test('the hook leaves other tools to the normal permission flow', async () => {
  const turn = await startTurn('bypassPermissions');
  try {
    const entry = preToolUseHook(turn.attempts[0]);
    const output = await entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'toolu_3', { signal: new AbortController().signal });
    assert.deepEqual(output, {});
    assert.equal(turn.sent.some((message) => message.kind === 'permission_request'), false);
  } finally {
    await turn.end();
  }
});

for (const mode of ['default', 'plan']) {
  test(`AskUserQuestion asks the owner exactly once in ${mode} mode`, async () => {
    const turn = await startTurn(mode);
    try {
      const options = turn.attempts[0];
      assert.equal(options.hooks?.PreToolUse, undefined, 'no PreToolUse hook outside the modes that skip canUseTool');
      assert.ok(options.canUseTool);

      // What the CLI does for one invocation: matching PreToolUse hooks (none
      // here), then the permission step, which calls `canUseTool`.
      const question = { questions: [{ question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] };
      const pending = options.canUseTool('AskUserQuestion', question, { signal: new AbortController().signal });

      const requests = turn.sent.filter((message) => message.kind === 'permission_request');
      assert.equal(requests.length, 1);
      const answered = { ...question, answers: { 'Which database?': 'Postgres' } };
      resolveToolApproval(requests[0].requestId, { allow: true, updatedInput: answered });
      assert.deepEqual(await pending, { behavior: 'allow', updatedInput: answered });
      assert.equal(turn.sent.filter((message) => message.kind === 'permission_request').length, 1);
    } finally {
      await turn.end();
    }
  });
}

test('without hook support, modes that skip canUseTool disallow interaction-required tools', async () => {
  const turn = await startTurn('bypassPermissions', { rejectHooks: true });
  try {
    assert.equal(turn.attempts.length, 2);
    const retry = turn.attempts[1];
    assert.equal(retry.hooks, undefined);
    assert.ok(retry.disallowedTools?.includes('AskUserQuestion'));
    assert.ok(retry.disallowedTools?.includes('ExitPlanMode'));
  } finally {
    await turn.end();
  }
});

test('without hook support, default mode keeps asking through canUseTool', async () => {
  const turn = await startTurn('default', { rejectHooks: true });
  try {
    const retry = turn.attempts[1];
    assert.equal(retry.disallowedTools?.includes('AskUserQuestion') ?? false, false);
  } finally {
    await turn.end();
  }
});

test('a rejected initialization closes the hooked query and retries without hooks', async () => {
  const turn = await startTurn('bypassPermissions', { rejectInitialization: true });
  try {
    for (let attempt = 0; attempt < 200 && turn.attempts.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(turn.attempts.length, 2);
    assert.deepEqual(turn.closed, [true, false]);
    const retry = turn.attempts[1];
    assert.equal(retry.hooks, undefined);
    assert.ok(retry.disallowedTools?.includes('AskUserQuestion'));
    assert.ok(retry.disallowedTools?.includes('ExitPlanMode'));
  } finally {
    await turn.end();
  }
});

/**
 * A plan approved in plan mode hands the run to the mode the composer returns
 * to (`planReturnMode`). Without it the CLI falls back to the mode the run
 * started in — `default`, because the run started in plan — so a composer that
 * shows Auto still asked for approval on every command until the next message.
 */
const PLAN = { plan: 'Do it' };
const setMode = (mode: string) => [{ type: 'setMode', mode, destination: 'session' }];

test('an approved ExitPlanMode moves the run to the mode the composer returns to', async () => {
  const turn = await startTurn('plan', { planReturnMode: 'acceptEdits' });
  try {
    const options = turn.attempts[0];
    assert.equal(options.hooks?.PreToolUse, undefined, 'acceptEdits still reaches canUseTool, so no hook');

    const pending = options.canUseTool!('ExitPlanMode', PLAN, { signal: new AbortController().signal, toolUseID: 'toolu_plan' });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    assert.ok(request?.requestId);
    resolveToolApproval(request.requestId, { allow: true });

    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: PLAN, updatedPermissions: setMode('acceptEdits') });
  } finally {
    await turn.end();
  }
});

test('a plan approved on the way to auto asks the owner once, through the hook and canUseTool together', async () => {
  const turn = await startTurn('plan', { planReturnMode: 'auto' });
  try {
    const options = turn.attempts[0];
    const entry = preToolUseHook(options);

    // What the CLI does for one invocation in plan mode: the PreToolUse hook,
    // then the permission step, which calls canUseTool for the same tool use.
    const viaHook = entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: PLAN }, 'toolu_plan', { signal: new AbortController().signal });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    assert.ok(request?.requestId);
    resolveToolApproval(request.requestId, { allow: true });
    assert.equal((await viaHook).hookSpecificOutput?.permissionDecision, 'allow');

    const viaPermissionStep = await options.canUseTool!('ExitPlanMode', PLAN, { signal: new AbortController().signal, toolUseID: 'toolu_plan' });

    assert.equal(turn.sent.filter((message) => message.kind === 'permission_request').length, 1, 'asked once');
    assert.deepEqual(viaPermissionStep, { behavior: 'allow', updatedInput: PLAN, updatedPermissions: setMode('auto') });
  } finally {
    await turn.end();
  }
});

test('AskUserQuestion after a plan is approved into auto still reaches the owner', async () => {
  // The CLI stops calling canUseTool once the run is in auto mode, so the
  // question has to be caught by the hook the plan-mode run registered.
  const turn = await startTurn('plan', { planReturnMode: 'bypassPermissions' });
  try {
    const entry = preToolUseHook(turn.attempts[0]);
    const question = { questions: [{ question: 'Which database?', options: [{ label: 'SQLite' }] }] };
    const pending = entry.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: question }, 'toolu_q', { signal: new AbortController().signal });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    assert.equal(request?.toolName, 'AskUserQuestion');
    resolveToolApproval(request!.requestId as string, { allow: true, updatedInput: question });
    assert.equal((await pending).hookSpecificOutput?.permissionDecision, 'allow');
  } finally {
    await turn.end();
  }
});

test('a plan mode run with no return mode, or a return mode on another mode, keeps the plain allow', async () => {
  for (const [mode, planReturnMode] of [['plan', undefined], ['default', 'auto']] as const) {
    const turn = await startTurn(mode, planReturnMode ? { planReturnMode } : {});
    try {
      const pending = turn.attempts[0].canUseTool!('ExitPlanMode', PLAN, { signal: new AbortController().signal, toolUseID: 'toolu_plan' });
      const request = turn.sent.find((message) => message.kind === 'permission_request');
      resolveToolApproval(request!.requestId as string, { allow: true });
      assert.deepEqual(await pending, { behavior: 'allow', updatedInput: PLAN });
    } finally {
      await turn.end();
    }
  }
});

test('a return mode that is not one of the composer modes is ignored', async () => {
  const turn = await startTurn('plan', { planReturnMode: 'plan' });
  try {
    const pending = turn.attempts[0].canUseTool!('ExitPlanMode', PLAN, { signal: new AbortController().signal, toolUseID: 'toolu_plan' });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    resolveToolApproval(request!.requestId as string, { allow: true });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: PLAN });
  } finally {
    await turn.end();
  }
});

test('without hook support a plan is not moved into a mode that would skip the owner', async () => {
  const turn = await startTurn('plan', { planReturnMode: 'auto', rejectHooks: true });
  try {
    const retry = turn.attempts[1];
    assert.equal(retry.hooks, undefined);
    const pending = retry.canUseTool!('ExitPlanMode', PLAN, { signal: new AbortController().signal, toolUseID: 'toolu_plan' });
    const request = turn.sent.find((message) => message.kind === 'permission_request');
    resolveToolApproval(request!.requestId as string, { allow: true });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: PLAN });
  } finally {
    await turn.end();
  }
});
