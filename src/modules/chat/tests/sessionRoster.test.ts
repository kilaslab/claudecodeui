import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { buildSessionRoster, readSessionChecklist } from '@/modules/chat/utils/sessionRoster';
import type { BackgroundTaskSummary, ChatMessage } from '@/shared/types';

/**
 * What the right-hand dock lists: the session's subagents, workflows and
 * background commands — running first, then what finished — and its current
 * checklist. Both are read from the transcript rows (and the activity map for
 * tasks whose rows are not loaded), the same sources the old floating chips used.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 10, minute)).toISOString();

const agentRow = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  isToolUse: true,
  toolName: 'Agent',
  toolId: id,
  timestamp: at(1),
  isSubagentContainer: true,
  toolInput: { description: `Review ${id}`, prompt: 'Review it', run_in_background: true },
  subagent: { id: `agent-${id}`, description: `Review ${id}`, type: 'general-purpose', status: 'running' },
  ...overrides,
});

const checklistRow = (todos: Array<{ content: string; status: string }>, timestamp = at(2)): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'TodoWrite', toolId: `todo-${timestamp}`, timestamp, toolInput: { todos },
});

describe('buildSessionRoster', () => {
  it('lists a running subagent with what it is doing and how many tools it has used', () => {
    const roster = buildSessionRoster([
      agentRow('a', {
        taskStatus: { status: 'running', taskId: 'task-a', usage: { totalTokens: 10, toolUses: 34, durationMs: 1000 } },
        subagentActivity: [{ kind: 'tool', toolName: 'Read' }, { kind: 'tool', toolName: 'Bash' }],
      }),
    ], undefined);

    assert.equal(roster.running.length, 1);
    assert.equal(roster.finished.length, 0);
    assert.deepEqual(
      { kind: roster.running[0].kind, name: roster.running[0].name, taskId: roster.running[0].taskId, agentId: roster.running[0].agentId },
      { kind: 'agent', name: 'Review a', taskId: 'task-a', agentId: 'agent-a' },
    );
    assert.equal(roster.running[0].progress.toolUses, 34);
    assert.equal(roster.running[0].progress.lastTool, 'Bash');
  });

  it('puts agents that settled under finished, newest first, and keeps failures and stops apart', () => {
    const roster = buildSessionRoster([
      agentRow('old', { timestamp: at(1), subagent: { id: 'agent-old', description: 'Old', status: 'completed' } }),
      agentRow('bad', { timestamp: at(3), subagent: { id: 'agent-bad', description: 'Bad', status: 'failed' } }),
      agentRow('stopped', { timestamp: at(2), subagent: { id: 'agent-stopped', description: 'Stopped', status: 'stopped' } }),
      agentRow('live', { timestamp: at(4) }),
    ], undefined);

    assert.deepEqual(roster.running.map((entry) => entry.name), ['Review live']);
    assert.deepEqual(roster.finished.map((entry) => [entry.name, entry.status]), [
      ['Bad', 'failed'],
      ['Stopped', 'stopped'],
      ['Old', 'completed'],
    ]);
  });

  it('shows a foreground agent that is still working, though no task ever named it', () => {
    const roster = buildSessionRoster([
      agentRow('fg', { toolInput: { description: 'Look around', prompt: 'x' }, subagent: { id: 'agent-fg', description: 'Look around', status: 'running' } }),
    ], undefined);

    assert.deepEqual(roster.running.map((entry) => entry.name), ['Look around']);
    assert.equal(roster.running[0].taskId, undefined, 'nothing to stop by id');
  });

  it('lists a task from the activity map whose launch row is not loaded, and not twice when it is', () => {
    const tasks: BackgroundTaskSummary[] = [
      { taskId: 'task-a', toolUseId: 'a', taskType: 'local_agent', description: 'Review a', startedAt: 5 },
      { taskId: 'task-z', toolUseId: 'z', taskType: 'local_workflow', description: 'Audit', workflowName: 'frontend-audit', startedAt: 6 },
      { taskId: 'task-n', toolUseId: 'n', taskType: 'local_bash', description: 'sleep', startedAt: 7, nested: true },
    ];
    const roster = buildSessionRoster([
      agentRow('a', { taskStatus: { status: 'running', taskId: 'task-a' } }),
    ], tasks);

    assert.deepEqual(roster.running.map((entry) => entry.taskId), ['task-a', 'task-z']);
    assert.equal(roster.running[1].kind, 'workflow');
    assert.equal(roster.running[1].name, 'frontend-audit');
    assert.equal(roster.running[1].message, undefined, 'no row to reveal');
  });

  it('is empty for a session that never launched anything', () => {
    const roster = buildSessionRoster([{ type: 'user', content: 'hi', timestamp: at(0) }], undefined);

    assert.deepEqual(roster, { running: [], finished: [] });
  });
});

describe('readSessionChecklist', () => {
  it('reads the latest checklist with its progress and the step in flight', () => {
    const checklist = readSessionChecklist([
      checklistRow([{ content: 'Old plan', status: 'pending' }], at(1)),
      checklistRow([
        { content: 'Set up', status: 'completed' },
        { content: 'Build', status: 'in_progress' },
        { content: 'Ship', status: 'pending' },
      ], at(5)),
    ]);

    assert.equal(checklist?.total, 3);
    assert.equal(checklist?.completed, 1);
    assert.equal(checklist?.active?.content, 'Build');
    assert.deepEqual(checklist?.todos.map((todo) => todo.content), ['Set up', 'Build', 'Ship']);
  });

  it('reads a checklist whose input arrived as JSON text', () => {
    const row = checklistRow([]);
    row.toolInput = JSON.stringify({ todos: [{ content: 'One', status: 'completed' }] });

    assert.equal(readSessionChecklist([row])?.completed, 1);
  });

  it('follows the task tracker a live turn streams, on top of the last whole list', () => {
    // The history reader rewrites TaskCreate/TaskUpdate onto TodoWrite
    // snapshots; a live turn's calls arrive raw until the history is read again.
    const taskCall = (toolName: string, toolId: string, toolInput: Record<string, unknown>, toolUseResult?: unknown): ChatMessage => ({
      type: 'assistant', isToolUse: true, toolName, toolId, timestamp: at(6), toolInput,
      ...(toolUseResult ? { toolResult: { content: 'ok', isError: false, toolUseResult } } : {}),
    });
    const snapshot = checklistRow([], at(5));
    snapshot.toolInput = { todos: [{ id: '1', content: 'Set up', status: 'in_progress' }] };

    const checklist = readSessionChecklist([
      snapshot,
      taskCall('TaskUpdate', 'toolu_u1', { taskId: '1', status: 'completed' }),
      taskCall('TaskCreate', 'toolu_c2', { subject: 'Build', activeForm: 'Building' }, { task: { id: '2', subject: 'Build' } }),
      taskCall('TaskUpdate', 'toolu_u2', { taskId: '2', status: 'in_progress' }),
    ]);

    assert.deepEqual(checklist?.todos.map((todo) => [todo.content, todo.status]), [['Set up', 'completed'], ['Build', 'in_progress']]);
    assert.equal(checklist?.completed, 1);
    assert.equal(checklist?.active?.activeForm, 'Building');
  });

  it('reads a checklist the task tracker built without any whole list', () => {
    const checklist = readSessionChecklist([{
      type: 'assistant', isToolUse: true, toolName: 'TaskCreate', toolId: 'toolu_c1', timestamp: at(1),
      toolInput: { subject: 'Write the tests' },
    }]);

    assert.deepEqual(checklist?.todos.map((todo) => [todo.content, todo.status]), [['Write the tests', 'pending']]);
  });

  it('is absent when there is none or it is empty', () => {
    assert.equal(readSessionChecklist([{ type: 'user', content: 'hi', timestamp: at(0) }]), null);
    assert.equal(readSessionChecklist([checklistRow([])]), null);
  });
});
