import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import type { SubagentActivity } from '@/shared/types';

/**
 * An agent's card is a preview: the newest steps, each cut short, its task in
 * a few lines. The inspector opens one agent's whole run — what it was asked,
 * every step, what it returned — and the agents it spawned in turn, with a
 * breadcrumb back.
 */

const PARENT_ID = 'a1111111111111111';
const CHILD_ID = 'a2222222222222222';

// What the agent route answers for each agent id, at `detail=full`.
const { reads, subagentActivity, workflowAgentActivity } = vi.hoisted(() => {
  const reads = new Map<string, { agent: { id: string }; prompt?: string; activity: SubagentActivity[]; activityCount: number }>();
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  const subagentActivity = vi.fn(async (_sessionId: string, agentId: string, _detail?: string) => ok(reads.get(agentId)));
  const workflowAgentActivity = vi.fn(async (_sessionId: string, _runId: string, agentId: string, _detail?: string) => ok({
    agent: { id: agentId, label: 'audit:sidebar', status: 'completed' },
    prompt: 'You are the analysis step of a code-quality audit.',
    result: '{\n  "area": "sidebar"\n}',
    activity: [{ kind: 'text', content: 'One hook owns the sidebar.' }],
    activityCount: 1,
  }));
  return { reads, subagentActivity, workflowAgentActivity };
});
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { subagentActivity, workflowAgentActivity },
}));

const { SubagentPanel } = await import('@/modules/chat/tools/SubagentPanel');
const { AgentInspectorProvider } = await import('@/modules/chat/context/AgentInspectorProvider');

const renderCard = () => render(
  <TranscriptSessionContext.Provider value={{ sessionId: 'session-1' }}>
    <AgentInspectorProvider createDiff={() => []}>
      <SubagentPanel
        toolInput={{ subagent_type: 'Explore', description: 'Survey the repo', prompt: 'List every package.' }}
        toolResult={{ content: 'The repo has two packages.', isError: false, toolUseResult: { agentId: PARENT_ID } }}
        subagent={{ id: PARENT_ID, type: 'Explore', description: 'Survey the repo', status: 'completed' }}
        createDiff={() => []}
      />
    </AgentInspectorProvider>
  </TranscriptSessionContext.Provider>,
);

beforeEach(() => {
  reads.clear();
  subagentActivity.mockClear();
  reads.set(PARENT_ID, {
    agent: { id: PARENT_ID },
    prompt: 'List every package.\nThen read each one.',
    activity: [
      { kind: 'tool', toolId: 'toolu_child', toolName: 'Agent', toolInput: { description: 'Read the tests', prompt: 'Read every test.' }, childAgentId: CHILD_ID } as SubagentActivity,
      { kind: 'text', content: 'Two packages found.' },
    ],
    activityCount: 2,
  });
  reads.set(CHILD_ID, {
    agent: { id: CHILD_ID },
    prompt: 'Read every test.',
    activity: [{ kind: 'text', content: 'The tests cover both packages.' }],
    activityCount: 1,
  });
});

test('an agent card opens the inspector on the agent\'s whole run', async () => {
  renderCard();

  fireEvent.click(screen.getByRole('button', { name: 'Inspect agent' }));

  const inspector = await screen.findByRole('dialog', { name: /Survey the repo/ });
  assert.ok(await within(inspector).findByText('Two packages found.'));
  assert.ok(within(inspector).getByText(/Then read each one\./));
  assert.ok(within(inspector).getByText('The repo has two packages.'));
  assert.deepEqual(subagentActivity.mock.calls[0], ['session-1', PARENT_ID, 'full']);
});

test('an agent the run spawned opens in turn, and the breadcrumb leads back', async () => {
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect agent' }));
  const inspector = await screen.findByRole('dialog');

  fireEvent.click(await within(inspector).findByRole('button', { name: /Open agent: Read the tests/ }));
  assert.ok(await within(inspector).findByText('The tests cover both packages.'));
  assert.deepEqual(subagentActivity.mock.calls.at(-1), ['session-1', CHILD_ID, 'full']);

  fireEvent.click(within(inspector).getByRole('button', { name: 'Survey the repo' }));
  assert.ok(await within(inspector).findByText('Two packages found.'));
});

test('Escape closes the inspector', async () => {
  renderCard();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect agent' }));
  await screen.findByRole('dialog');

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(screen.queryByRole('dialog'), null);
});

test('a workflow agent opens in the inspector with what the script asked and what it returned', async () => {
  const { WorkflowPanel } = await import('@/modules/chat/tools/WorkflowPanel');
  render(
    <TranscriptSessionContext.Provider value={{ sessionId: 'session-1' }}>
      <AgentInspectorProvider createDiff={() => []}>
        <WorkflowPanel
          toolInput={JSON.stringify({ script: "export const meta = { name: 'frontend-audit' }", description: 'Audit the frontend' })}
          toolResult={{ content: 'Workflow launched in background.', isError: false, toolUseResult: { status: 'async_launched', taskId: 'wxkj4kcvd', taskType: 'local_workflow', runId: 'wf_16fbf852-274' } }}
          workflow={{
            runId: 'wf_16fbf852-274',
            name: 'frontend-audit',
            status: 'completed',
            agents: [{ id: 'aa1e064cf8bd159d6', label: 'audit:sidebar', phase: 'Audit', status: 'completed' }],
            agentCounts: { total: 1, completed: 1, failed: 0, running: 0, stopped: 0 },
          }}
          createDiff={() => []}
        />
      </AgentInspectorProvider>
    </TranscriptSessionContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { expanded: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect agent' }));

  const inspector = await screen.findByRole('dialog', { name: /audit:sidebar/ });
  assert.ok(await within(inspector).findByText('You are the analysis step of a code-quality audit.'));
  assert.ok(within(inspector).getByText('One hook owns the sidebar.'));
  assert.match(inspector.textContent ?? '', /"area": "sidebar"/);
  assert.deepEqual(workflowAgentActivity.mock.calls.at(-1), ['session-1', 'wf_16fbf852-274', 'aa1e064cf8bd159d6', 'full']);
});

test('a card outside an inspector offers no Inspect button', () => {
  render(
    <SubagentPanel
      toolInput={{ subagent_type: 'Explore', description: 'Survey the repo', prompt: 'List every package.' }}
      subagent={{ id: PARENT_ID, status: 'completed' }}
      createDiff={() => []}
    />,
  );

  assert.equal(screen.queryByRole('button', { name: 'Inspect agent' }), null);
});
