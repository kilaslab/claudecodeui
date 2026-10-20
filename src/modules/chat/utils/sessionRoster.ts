import {
  describeWorkflowAgent,
  findCurrentWorkflowAgent,
  ownBackgroundTasks,
  readBackgroundTaskId,
  readBackgroundTaskStatus,
} from '@/modules/chat/utils/backgroundTasks';
import { parseToolPayload } from '@/modules/chat/utils/messageTransforms';
import { parseWorkflowMeta } from '@/modules/chat/utils/workflowScriptMeta';
import type {
  BackgroundTaskSummary,
  ChatMessage,
  SessionChecklist,
  SessionRoster,
  SessionRosterEntry,
  SessionRosterKind,
  TodoItem,
} from '@/shared/types';

/** The input of a launch row as an object, whatever form the provider stored it in. */
function readLaunchInput(message: ChatMessage): Record<string, unknown> {
  const input = parseToolPayload(message.toolInput);
  return input && typeof input === 'object' ? input as Record<string, unknown> : {};
}

function readKind(message: ChatMessage): SessionRosterKind {
  if (message.toolName === 'Workflow' || message.workflow) {
    return 'workflow';
  }
  return message.toolName === 'Bash' ? 'command' : 'agent';
}

function readKindOfTask(taskType: string): SessionRosterKind {
  if (taskType === 'local_workflow') {
    return 'workflow';
  }
  return taskType === 'local_bash' ? 'command' : 'agent';
}

/**
 * The one-line description the launch was given. A workflow's is in the
 * script's `meta` header, not in the tool input, and the run's first summary
 * restates it.
 */
function readLaunchDescription(message: ChatMessage, input: Record<string, unknown>): string {
  if (message.workflow?.description) {
    return message.workflow.description;
  }
  if (typeof input.description === 'string' && input.description) {
    return input.description;
  }
  return typeof input.script === 'string' ? parseWorkflowMeta(input.script).description ?? '' : '';
}

/** What the row calls the work: the workflow's name, the agent's description, the command line. */
function readName(message: ChatMessage, kind: SessionRosterKind, input: Record<string, unknown>): string {
  const live = message.taskStatus;
  if (kind === 'workflow') {
    return message.workflow?.name || live?.workflowName || '';
  }
  if (kind === 'command') {
    const command = typeof input.command === 'string' ? input.command : '';
    return live?.description || (typeof input.description === 'string' ? input.description : '') || command;
  }
  return message.subagent?.description || live?.description || (typeof input.description === 'string' ? input.description : '');
}

function readProgress(message: ChatMessage, kind: SessionRosterKind, name: string, launchDescription: string): SessionRosterEntry['progress'] {
  const live = message.taskStatus;
  const progress: SessionRosterEntry['progress'] = {};

  if (live?.usage) {
    progress.toolUses = live.usage.toolUses;
  }

  if (live?.agents?.length) {
    progress.agentsTotal = live.agents.length;
    progress.agentsFinished = live.agents.filter((agent) => agent.state === 'done' || agent.state === 'failed').length;
    const current = findCurrentWorkflowAgent(live.agents);
    if (current) {
      progress.currentAgent = describeWorkflowAgent(current);
    }
  } else if (message.workflow && message.workflow.agentCounts.total > 0) {
    progress.agentsTotal = message.workflow.agentCounts.total;
    progress.agentsFinished = message.workflow.agentCounts.completed + message.workflow.agentCounts.failed;
  }

  // The CLI's own summary, unless it only restates what the row already says.
  if (live?.summary && live.summary !== launchDescription && live.summary !== name) {
    progress.summary = live.summary;
  }

  if (kind === 'agent' && message.subagentActivity?.length) {
    const lastTool = [...message.subagentActivity].reverse().find((entry) => entry.kind === 'tool');
    if (lastTool?.toolName) {
      progress.lastTool = lastTool.toolName;
    }
  }

  return progress;
}

function readStartedAt(message: ChatMessage): number | null {
  const time = new Date(message.timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

function readAgentId(message: ChatMessage): string | undefined {
  const acknowledged = (message.toolResult?.toolUseResult as { agentId?: unknown } | undefined)?.agentId;
  const id = message.subagent?.id ?? acknowledged;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * The session's subagents, workflows and background commands, as the dock
 * lists them: what is still going (in transcript order) and what has settled
 * (newest first).
 *
 * Read from the loaded transcript rows, which carry the live word on each task;
 * a running task whose launch row is not loaded — a page not fetched yet, or an
 * agent's own child — is listed from the activity map so it can still be seen
 * and stopped.
 *
 * Used by chat's SessionDock and DockCapsules, which must agree on the counts.
 */
export function buildSessionRoster(messages: ChatMessage[], tasks: BackgroundTaskSummary[] | undefined): SessionRoster {
  const running: SessionRosterEntry[] = [];
  const finished: SessionRosterEntry[] = [];
  const knownToolIds = new Set<string>();

  for (const message of messages) {
    if (!message.isToolUse || !message.toolId) {
      continue;
    }
    const status = readBackgroundTaskStatus(message);
    if (!status) {
      continue;
    }
    knownToolIds.add(message.toolId);

    const kind = readKind(message);
    const input = readLaunchInput(message);
    const name = readName(message, kind, input);
    const entry: SessionRosterEntry = {
      key: message.toolId,
      kind,
      name,
      status,
      progress: readProgress(message, kind, name, readLaunchDescription(message, input)),
      startedAt: readStartedAt(message),
      taskId: readBackgroundTaskId(message),
      agentId: kind === 'command' ? undefined : readAgentId(message),
      message,
    };
    (status === 'running' ? running : finished).push(entry);
  }

  for (const task of ownBackgroundTasks(tasks ?? [])) {
    if (knownToolIds.has(task.toolUseId)) {
      continue;
    }
    running.push({
      key: task.toolUseId || task.taskId,
      kind: readKindOfTask(task.taskType),
      name: task.workflowName ?? task.description,
      status: 'running',
      progress: {},
      startedAt: Number.isFinite(task.startedAt) ? task.startedAt : null,
      taskId: task.taskId,
      ...(task.nested ? { nested: true } : {}),
    });
  }

  finished.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  return { running, finished };
}

/**
 * The checklist the agent is working through: the latest one it wrote (every
 * provider's running checklist normalizes onto the `TodoWrite` row), or null
 * when it has written none or an empty one.
 *
 * Used by chat's SessionDock and DockCapsules.
 */
export function readSessionChecklist(messages: ChatMessage[]): SessionChecklist | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.isToolUse || message.toolName !== 'TodoWrite') {
      continue;
    }

    const input = readLaunchInput(message);
    const todos = Array.isArray(input.todos)
      ? input.todos.filter((todo): todo is TodoItem => Boolean(todo) && typeof (todo as TodoItem).content === 'string')
      : [];
    if (todos.length === 0) {
      return null;
    }

    return {
      todos,
      completed: todos.filter((todo) => todo.status === 'completed').length,
      total: todos.length,
      active: todos.find((todo) => todo.status === 'in_progress') ?? null,
    };
  }
  return null;
}
