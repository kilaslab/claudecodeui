import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentInspectorContext } from '@/modules/chat/context/AgentInspectorContext';
import { DockCapsules } from '@/modules/chat/dock/DockCapsules';
import { SessionDock } from '@/modules/chat/dock/SessionDock';
import { buildSessionRoster, readSessionChecklist } from '@/modules/chat/utils/sessionRoster';
import type { BackgroundTaskSummary, ChatMessage } from '@/shared/types';

/**
 * The right-hand dock lists the session's checklist and its subagents,
 * workflows and background commands. These are the cases the floating chips
 * it replaced were held to — what each row says, what clicking it does, which
 * ones can be stopped — plus what the dock adds: finished rows and the checklist.
 */

// Every launch row below is stamped LAUNCHED_AT and the clock stands 65 s later,
// so a running row reads "1m 5s" whatever day the suite runs.
const LAUNCHED_AT = Date.parse('2026-08-21T10:32:10.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LAUNCHED_AT + 65_000);
});

afterEach(() => {
  vi.useRealTimers();
});

const toolRow = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-08-21T10:32:10.000Z',
  isToolUse: true,
  ...overrides,
});

type DockOptions = {
  messages: ChatMessage[];
  tasks?: BackgroundTaskSummary[];
  sendMessage?: (message: unknown) => boolean;
  onReveal?: (message: ChatMessage) => void;
  onLoadAll?: () => void;
  onClose?: () => void;
  inspectAgent?: (target: unknown) => void;
  layout?: 'column' | 'sheet';
};

const renderDock = ({ messages, tasks, sendMessage = () => true, onReveal = () => {}, onLoadAll = () => {}, onClose = () => {}, inspectAgent, layout = 'column' }: DockOptions) => {
  const dock = (
    <SessionDock
      roster={buildSessionRoster(messages, tasks)}
      checklist={readSessionChecklist(messages)}
      layout={layout}
      sessionId="session-1"
      sendMessage={sendMessage}
      onReveal={onReveal}
      onLoadAll={onLoadAll}
      onClose={onClose}
    />
  );
  return render(inspectAgent
    ? <AgentInspectorContext.Provider value={{ inspectAgent: inspectAgent as never }}>{dock}</AgentInspectorContext.Provider>
    : dock);
};

// Anchored: a row's own stop and inspect buttons carry its name too.
const rowByName = (name: RegExp) => screen.getByRole('button', { name: new RegExp(`^${name.source}`) });

describe('the dock\'s subagent rows', () => {
  it('lists a running workflow and a running agent with what each has got to, and a finished one apart', () => {
    renderDock({
      messages: [
        toolRow({ toolName: 'Read', toolId: 'toolu_read', toolInput: '{}' }),
        toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit', summary: 'Verify 3/6' } }),
        toolRow({
          toolName: 'Agent',
          toolId: 'toolu_agent_1',
          isSubagentContainer: true,
          taskStatus: { status: 'running', description: 'Survey the repo', usage: { totalTokens: 1, toolUses: 12, durationMs: 1 } },
        }),
        toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_2', taskStatus: { status: 'completed', workflowName: 'review-p1' } }),
      ],
    });

    expect(screen.getByText('Running').textContent).toBe('Running 2');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'frontend-architecture-audit1m 5sWorkflow, Verify 3/6',
      'Survey the repo1m 5s12 tools',
      'review-p1Workflow',
    ]);
    expect(screen.getByText('Finished').textContent).toBe('Finished 1');
  });

  it('says how many of a workflow\'s agents have finished and which one it is on', () => {
    renderDock({
      messages: [toolRow({
        toolName: 'Workflow',
        toolId: 'toolu_workflow_1',
        taskStatus: {
          status: 'running',
          workflowName: 'frontend-architecture-audit',
          summary: 'Evidence-based audit of the frontend',
          agents: [
            { index: 0, label: 'audit:chat', agentId: 'aa1e064cf8bd159d6', state: 'done', startedAt: 1 },
            { index: 1, label: 'audit:sidebar', agentId: 'a9cfe29aa8f2afcbf', state: 'running', startedAt: 2 },
            { index: 2, label: 'audit:files', agentId: 'ab89f2cde612a51b1', state: 'failed', startedAt: 3 },
            { index: 3, label: 'synthesize', state: 'queued' },
          ],
        },
      })],
    });

    expect(screen.getByText('Workflow, 2 of 4 agents, on audit:sidebar')).toBeTruthy();
  });

  it('counts one agent in the singular', () => {
    renderDock({
      messages: [toolRow({
        toolName: 'Workflow',
        toolId: 'toolu_workflow_1',
        taskStatus: { status: 'running', workflowName: 'audit', agents: [{ index: 0, label: 'only', agentId: 'a1', state: 'running' }] },
      })],
    });

    expect(screen.getByText('Workflow, 0 of 1 agent, on only')).toBeTruthy();
  });

  it('keeps a workflow the last history load left running, before any live event', () => {
    renderDock({
      messages: [toolRow({
        toolName: 'Workflow',
        toolId: 'toolu_workflow_1',
        workflow: {
          runId: 'wf_1',
          name: 'frontend-architecture-audit',
          status: 'running',
          agents: [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }],
          agentCounts: { total: 2, completed: 1, failed: 0, running: 1, stopped: 0 },
        },
      })],
    });

    expect(screen.getByText('Workflow, 1 of 2 agents')).toBeTruthy();
  });

  it('does not repeat the launch\'s description as progress', () => {
    renderDock({
      messages: [
        toolRow({
          toolName: 'Workflow',
          toolId: 'toolu_workflow_1',
          toolInput: JSON.stringify({ description: 'Evidence-based audit of the frontend', script: '' }),
          taskStatus: { status: 'running', workflowName: 'audit', summary: 'Evidence-based audit of the frontend' },
        }),
        toolRow({
          toolName: 'Agent',
          toolId: 'toolu_agent_1',
          isSubagentContainer: true,
          taskStatus: { status: 'running', description: 'Survey the repo', summary: 'Survey the repo' },
        }),
      ],
    });

    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['audit1m 5sWorkflow', 'Survey the repo1m 5s']);
  });

  it('knows the launch\'s description from the script\'s meta header when the input has none', () => {
    renderDock({
      messages: [toolRow({
        toolName: 'Workflow',
        toolId: 'toolu_workflow_1',
        toolInput: JSON.stringify({ script: "export const meta = {\n  name: 'audit',\n  description: 'Evidence-based audit of the frontend',\n}\nreturn 1" }),
        taskStatus: { status: 'running', workflowName: 'audit', summary: 'Evidence-based audit of the frontend' },
      })],
    });

    expect(screen.getByRole('listitem').textContent).toBe('audit1m 5sWorkflow');
  });

  it('keeps the whole progress text in the title when it is clipped', () => {
    const summary = 'Phase 2 of 6: three agents in sequence review the composer, the transcript and the sidebar for overflow';
    renderDock({
      messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit', summary } })],
    });

    const detail = screen.getByText(`Workflow, ${summary}`);
    expect(detail.className).toContain('truncate');
    expect(detail.title).toBe(`Workflow, ${summary}`);
  });

  it('asks the pane to reveal the task\'s row when its row is clicked', () => {
    // The row may be outside the visible window or in an unmounted lazy row,
    // so the dock cannot reach it with an element lookup of its own.
    const onReveal = vi.fn();
    const row = toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', workflowName: 'frontend-architecture-audit' } });
    renderDock({ messages: [row], onReveal });

    fireEvent.click(rowByName(/frontend-architecture-audit/));

    expect(onReveal).toHaveBeenCalledWith(row);
  });
});

describe('stopping from the dock', () => {
  it('stops a task over the websocket by the id its events or acknowledgement named, and never from the row itself', () => {
    const sendMessage = vi.fn((_frame: unknown) => true);
    renderDock({
      sendMessage,
      messages: [
        // Named by the live start event.
        toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', taskId: 'wxkj4kcvd', workflowName: 'audit' } }),
        // Named only by the launch acknowledgement: a real async agent's carries no `taskId`, its `agentId` is the task's id.
        toolRow({
          toolName: 'Agent',
          toolId: 'toolu_agent_1',
          subagent: { id: 'a1', description: 'Survey the repo', status: 'running' },
          toolResult: { content: '', isError: false, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' } },
        }),
        // A backgrounded command's acknowledgement spells it differently.
        toolRow({
          toolName: 'Bash',
          toolId: 'toolu_bash_1',
          taskStatus: { status: 'running', description: 'npm test' },
          toolResult: { content: '', isError: false, toolUseResult: { backgroundTaskId: 'b5xsbzu5k' } },
        }),
        // Nothing has named this one, so nothing can stop it.
        toolRow({ toolName: 'Agent', toolId: 'toolu_agent_2', subagent: { id: '', description: 'Unnamed', status: 'running' } }),
      ],
    });

    fireEvent.click(rowByName(/Survey the repo/));
    expect(sendMessage).not.toHaveBeenCalled();

    const stops = screen.getAllByRole('button', { name: /^Stop / });
    expect(stops).toHaveLength(3);
    stops.forEach((stop) => fireEvent.click(stop));

    expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'wxkj4kcvd' },
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'a1' },
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'b5xsbzu5k' },
    ]);
  });

  it('offers no stop for work that has finished', () => {
    renderDock({ messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'completed', taskId: 'wxkj4kcvd', workflowName: 'audit' } })] });

    expect(screen.queryByRole('button', { name: /^Stop / })).toBeNull();
  });

  it('opens an agent in the inspector from its row', () => {
    const inspectAgent = vi.fn();
    renderDock({
      inspectAgent,
      messages: [toolRow({ toolName: 'Agent', toolId: 'toolu_agent_1', subagent: { id: 'a1', description: 'Survey the repo', status: 'running' } })],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Inspect Survey the repo' }));

    expect(inspectAgent).toHaveBeenCalledWith({ sessionId: 'session-1', agentId: 'a1', title: 'Survey the repo', isRunning: true });
  });

  it('offers no inspector where there is none', () => {
    renderDock({ messages: [toolRow({ toolName: 'Agent', toolId: 'toolu_agent_1', subagent: { id: 'a1', description: 'Survey the repo', status: 'running' } })] });

    expect(screen.queryByRole('button', { name: /^Inspect / })).toBeNull();
  });
});

describe('the dock, for a task whose launch row is not loaded', () => {
  const tasks: BackgroundTaskSummary[] = [
    { taskId: 'wxkj4kcvd', toolUseId: 'toolu_workflow_1', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'audit', startedAt: LAUNCHED_AT },
    // Launched by one of the workflow's agents: its business, not the session's.
    { taskId: 'b5xsbzu5k', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: LAUNCHED_AT, nested: true },
  ];

  it('lists it from the activity map, loads the transcript on click, and can stop it', () => {
    const sendMessage = vi.fn(() => true);
    const onLoadAll = vi.fn();
    renderDock({ messages: [toolRow({ toolName: 'Read', toolId: 'toolu_read', toolInput: '{}' })], tasks, sendMessage, onLoadAll });

    const row = rowByName(/audit/);
    expect(row.title).toBe('Launched earlier in this conversation; click to load it');
    fireEvent.click(row);
    expect(onLoadAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Stop audit' }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'wxkj4kcvd' });
  });

  it('defers to the loaded row once the transcript has it, settled or not', () => {
    renderDock({
      messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'completed', taskId: 'wxkj4kcvd', workflowName: 'audit' } })],
      tasks,
    });

    // Finished, not running: a settled task must not come back from a poll that has not caught up.
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByText('Finished')).toBeTruthy();
  });

  it('lists a backgrounded command whose loaded launch row has no status of its own', () => {
    const sendMessage = vi.fn(() => true);
    renderDock({
      sendMessage,
      messages: [toolRow({
        toolName: 'Bash',
        toolId: 'toolu_bash_1',
        toolInput: JSON.stringify({ command: 'npm test', run_in_background: true }),
        toolResult: { content: '', isError: false, toolUseResult: { backgroundTaskId: 'b5xsbzu5k' } },
      })],
      tasks: [{ taskId: 'b5xsbzu5k', toolUseId: 'toolu_bash_1', taskType: 'local_bash', description: 'npm test', startedAt: LAUNCHED_AT }],
    });

    expect(screen.getByRole('listitem').textContent).toBe('npm test1m 5sCommand');
    fireEvent.click(screen.getByRole('button', { name: 'Stop npm test' }));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'b5xsbzu5k' });
  });

  it('draws a task one of the session\'s agents launched without offering to load a row it has none of', () => {
    const onLoadAll = vi.fn();
    renderDock({
      onLoadAll,
      messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'completed', taskId: 'wxkj4kcvd', workflowName: 'audit' } })],
      tasks: [{ taskId: 'b5xsbzu5k', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: LAUNCHED_AT, nested: true }],
    });

    const row = screen.getByTitle("Launched by one of this session's agents");
    expect(row.textContent).toBe('Sleep for 60 seconds1m 5sCommand');
    fireEvent.click(row);
    expect(onLoadAll).not.toHaveBeenCalled();
  });
});

describe('the dock\'s checklist and chrome', () => {
  const checklistMessage = toolRow({
    toolName: 'TodoWrite',
    toolId: 'toolu_todo',
    toolInput: { todos: [
      { content: 'Set up the branch', status: 'completed' },
      { content: 'Fix the indicator', activeForm: 'Fixing the indicator', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' },
    ] },
  });

  it('shows the checklist with its progress and the step in flight', () => {
    renderDock({ messages: [checklistMessage] });

    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
    expect(within(items[1]).getByText('Fixing the indicator')).toBeTruthy();
  });

  it('closes without stopping anything', () => {
    const onClose = vi.fn();
    const sendMessage = vi.fn(() => true);
    renderDock({
      onClose,
      sendMessage,
      messages: [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', taskId: 'w1', workflowName: 'audit' } })],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lists only the newest finished rows until asked for the rest', () => {
    const settled = Array.from({ length: 11 }, (_, index) => toolRow({
      toolName: 'Agent',
      toolId: `toolu_agent_${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 21, 10, index)).toISOString(),
      subagent: { id: `a${index}`, description: `Agent ${index}`, status: 'completed' },
    }));
    renderDock({ messages: settled });

    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(11);
  });

  it('lists a long history a page at a time, newest first', () => {
    const settled = Array.from({ length: 50 }, (_, index) => toolRow({
      toolName: 'Agent',
      toolId: `toolu_agent_${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 21, 10, index)).toISOString(),
      subagent: { id: `a${index}`, description: `Agent ${index}`, status: 'completed' },
    }));
    renderDock({ messages: settled });

    expect(screen.getAllByRole('listitem').map((row) => row.textContent).slice(0, 2)).toEqual(['Agent 49', 'Agent 48']);
    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(28);
    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
  });

  it('names how a finished row ended when it did not simply finish', () => {
    renderDock({
      messages: [
        toolRow({ toolName: 'Agent', toolId: 'toolu_failed', timestamp: '2026-08-21T10:32:12.000Z', subagent: { id: 'a1', description: 'Broke', status: 'failed' } }),
        toolRow({ toolName: 'Agent', toolId: 'toolu_stopped', timestamp: '2026-08-21T10:32:11.000Z', subagent: { id: 'a2', description: 'Halted', status: 'stopped' } }),
        toolRow({ toolName: 'Agent', toolId: 'toolu_done', subagent: { id: 'a3', description: 'Fine', status: 'completed' } }),
      ],
    });

    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['BrokeFailed', 'HaltedStopped', 'Fine']);
  });
});

describe('the dock capsules', () => {
  const running = toolRow({ toolName: 'Agent', toolId: 'toolu_agent_1', taskStatus: { status: 'running', description: 'Survey the repo' } });
  const other = toolRow({ toolName: 'Agent', toolId: 'toolu_agent_2', taskStatus: { status: 'running', description: 'Review the diff' } });
  const todo = toolRow({ toolName: 'TodoWrite', toolId: 'toolu_todo', toolInput: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] } });

  const renderCapsules = (messages: ChatMessage[], overrides: { isOpen?: boolean; onToggle?: () => void } = {}) => render(
    <DockCapsules
      roster={buildSessionRoster(messages, undefined)}
      checklist={readSessionChecklist(messages)}
      isOpen={overrides.isOpen ?? false}
      onToggle={overrides.onToggle ?? (() => {})}
      leavesRoomForActivity={false}
    />,
  );

  it('says how the checklist and the subagents stand', () => {
    renderCapsules([todo, running, other]);

    expect(screen.getAllByRole('button').map((capsule) => capsule.textContent)).toEqual(['Tasks1/2', '2 subagents running']);
  });

  it('counts one subagent in the singular and names background work that is not an agent', () => {
    const { unmount } = renderCapsules([running]);
    expect(screen.getByRole('button').textContent).toBe('1 subagent running');
    unmount();

    renderCapsules([toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', workflowName: 'audit' } })]);
    expect(screen.getByRole('button').textContent).toBe('1 background task running');
  });

  it('says finished once nothing runs, and renders nothing for a session with neither', () => {
    const { unmount } = renderCapsules([toolRow({ toolName: 'Agent', toolId: 'toolu_agent_1', subagent: { id: 'a1', description: 'Done', status: 'completed' } })]);
    expect(screen.getByRole('button').textContent).toBe('1 subagent finished');
    unmount();

    const empty = renderCapsules([{ type: 'user', content: 'hi', timestamp: '2026-08-21T10:32:10.000Z' }]);
    expect(empty.container.innerHTML).toBe('');
  });

  it('toggles the dock and reports whether it is open', () => {
    const onToggle = vi.fn();
    renderCapsules([todo], { isOpen: true, onToggle });

    const capsule = screen.getByRole('button');
    expect(capsule.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(capsule);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});


describe('the dock as a sheet', () => {
  const running = toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', taskId: 'w1', workflowName: 'audit' } });

  it('is a modal dialog that takes focus, while the column beside the chat is not', () => {
    const { unmount } = renderDock({ messages: [running], layout: 'sheet' });
    const sheet = screen.getByRole('dialog', { name: 'Tasks and subagents' });
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close' }));
    unmount();

    renderDock({ messages: [running], layout: 'column' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Tasks and subagents' })).toBeTruthy();
  });

  it('closes on Escape ahead of the transcript\'s own Escape handler, and only as a sheet', () => {
    const onClose = vi.fn();
    const laterHandler = vi.fn();
    document.addEventListener('keydown', laterHandler, { capture: true });
    const { unmount } = renderDock({ messages: [running], layout: 'sheet', onClose });

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(onClose).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    document.removeEventListener('keydown', laterHandler, { capture: true });
    unmount();

    const columnClose = vi.fn();
    renderDock({ messages: [running], layout: 'column', onClose: columnClose });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(columnClose).not.toHaveBeenCalled();
  });

  it('closes when a row is shown in the transcript, so the row can be seen', () => {
    const onClose = vi.fn();
    const onReveal = vi.fn();
    renderDock({ messages: [running], layout: 'sheet', onClose, onReveal });

    fireEvent.click(rowByName(/audit/));

    expect(onReveal).toHaveBeenCalledWith(running);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open in a column when a row is shown', () => {
    const onClose = vi.fn();
    renderDock({ messages: [running], layout: 'column', onClose });

    fireEvent.click(rowByName(/audit/));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the dock\'s clock', () => {
  it('counts a running row\'s time up each second, and stops counting when nothing runs', () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(LAUNCHED_AT + 65_000);
    const messages = [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'running', taskId: 'w1', workflowName: 'audit' } })];
    const view = render(
      <SessionDock roster={buildSessionRoster(messages, undefined)} checklist={null} layout="column" sessionId="session-1" sendMessage={() => true} onReveal={() => {}} onLoadAll={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('listitem').textContent).toContain('1m 5s');

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByRole('listitem').textContent).toContain('1m 8s');

    const finishedMessages = [toolRow({ toolName: 'Workflow', toolId: 'toolu_workflow_1', taskStatus: { status: 'completed', taskId: 'w1', workflowName: 'audit' } })];
    view.rerender(
      <SessionDock roster={buildSessionRoster(finishedMessages, undefined)} checklist={null} layout="column" sessionId="session-1" sendMessage={() => true} onReveal={() => {}} onLoadAll={() => {}} onClose={() => {}} />,
    );
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
