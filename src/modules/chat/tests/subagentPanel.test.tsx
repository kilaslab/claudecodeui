import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import type { LiveTaskStatus, SubagentActivity, ToolResult } from '@/shared/types';

/**
 * A background agent's card used to show only its launch and "running": the
 * SDK streams little of its work, history re-reads only on a refresh, and the
 * card read nothing itself. While it is open and the agent runs, it now reads
 * the agent's own transcript every few seconds, and says how much the agent
 * has done so far.
 */

const AGENT_ID = 'a5c0ffee5c0ffee51';

// Each read answers with the next queued timeline; the last one repeats.
const { queuedReads, subagentActivity } = vi.hoisted(() => {
  const queuedReads: Array<{ activity: SubagentActivity[]; activityCount: number }> = [];
  const subagentActivity = vi.fn(async (_sessionId: string, agentId: string) => {
    const next = queuedReads.length > 1 ? queuedReads.shift()! : queuedReads[0];
    const data = { agent: { id: agentId }, prompt: 'List every package.', ...next };
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
  });
  return { queuedReads, subagentActivity };
});
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { subagentActivity },
}));

const { SubagentPanel } = await import('@/modules/chat/tools/SubagentPanel');

const asyncLaunch: ToolResult = {
  content: 'Async agent launched successfully.',
  isError: false,
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID },
};

const step = (content: string): SubagentActivity => ({ kind: 'text', content });

const renderPanel = (props: { taskStatus?: LiveTaskStatus; toolInput?: unknown; activity?: SubagentActivity[]; toolResult?: ToolResult }) => render(
  <TranscriptSessionContext.Provider value={{ sessionId: 'session-1' }}>
    <SubagentPanel
      toolInput={props.toolInput ?? { subagent_type: 'Explore', description: 'Survey the repo', prompt: 'List every package.' }}
      toolResult={props.toolResult ?? asyncLaunch}
      taskStatus={props.taskStatus}
      activity={props.activity}
      createDiff={() => []}
    />
  </TranscriptSessionContext.Provider>,
);

const openCard = () => fireEvent.click(screen.getByRole('button', { expanded: false }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  queuedReads.length = 0;
  subagentActivity.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

test('an open card reads a running agent\'s steps from its transcript, and again while it runs', async () => {
  queuedReads.push(
    { activity: [step('Reading the packages')], activityCount: 1 },
    { activity: [step('Reading the packages'), step('Found two packages')], activityCount: 2 },
  );
  renderPanel({ taskStatus: { status: 'running' } });

  openCard();
  assert.ok(await screen.findByText('Reading the packages'));
  assert.deepEqual(subagentActivity.mock.calls[0], ['session-1', AGENT_ID]);

  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  assert.ok(await screen.findByText('Found two packages'));
});

test('an agent that has finished is not read again', async () => {
  queuedReads.push({ activity: [step('unused')], activityCount: 1 });
  renderPanel({
    taskStatus: { status: 'completed' },
    toolResult: { ...asyncLaunch },
    activity: [step('What history already has')],
  });

  openCard();
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

  assert.equal(subagentActivity.mock.calls.length, 0);
  assert.ok(screen.getByText('What history already has'));
});

test('a running agent\'s card says how much it has done and what it did last', async () => {
  queuedReads.push({ activity: [], activityCount: 0 });
  renderPanel({
    taskStatus: { status: 'running', usage: { toolUses: 7, totalTokens: 12_000, durationMs: 65_000 } },
    activity: [{ kind: 'tool', toolId: 'toolu_1', toolName: 'Grep', toolInput: { pattern: 'useSidebar' } }],
  });

  // The latest tool shows on the closed card, so a glance tells what it is doing.
  assert.match(screen.getByRole('button', { expanded: false }).textContent ?? '', /Grep/);

  openCard();
  assert.ok(await screen.findByText(/7 tool uses · 1m 5s/));
});

test('a long task can be read in full', async () => {
  const prompt = Array.from({ length: 12 }, (_, line) => `Step ${line + 1} of the task.`).join('\n');
  renderPanel({ taskStatus: { status: 'completed' }, toolInput: { subagent_type: 'Explore', description: 'Survey', prompt } });

  openCard();
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

  assert.ok(screen.getByRole('button', { name: 'Show less' }));
  assert.match(screen.getByText(/Step 12 of the task\./).className, /^(?!.*line-clamp)/);
});
