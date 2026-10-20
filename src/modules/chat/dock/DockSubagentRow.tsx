import { memo } from 'react';
import type { TFunction } from 'i18next';
import { Maximize2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAgentInspector } from '@/modules/chat/context/AgentInspectorContext';
import { SubagentGlyph } from '@/modules/chat/dock/SubagentGlyph';
import { formatTaskDuration } from '@/modules/chat/utils/backgroundTasks';
import { cn } from '@/shared/utils';
import type { ChatMessage, SessionRosterEntry } from '@/shared/types';

type DockSubagentRowProps = {
  entry: SessionRosterEntry;
  /** The wall clock a running row counts its elapsed time against. */
  now: number;
  /** The session `chat.stop-task` names; null before one exists. */
  sessionId: string | null;
  /** The chat websocket's send, for stopping a task. */
  sendMessage: (message: unknown) => boolean;
  /** Brings the launch row into view; the pane's session state owns how, since the row may be outside the window. */
  onReveal: (message: ChatMessage) => void;
  /** Loads the rest of the transcript, for a task whose launch row is not loaded yet. */
  onLoadAll: () => void;
};

/** What a row says about how far its work has got, in words. */
function describeProgress(entry: SessionRosterEntry, t: TFunction): string {
  const { progress } = entry;
  if (progress.agentsTotal) {
    const base = t('dock.subagents.agentsProgress', {
      finished: progress.agentsFinished ?? 0,
      count: progress.agentsTotal,
      defaultValue_one: '{{finished}} of {{count}} agent',
      defaultValue_other: '{{finished}} of {{count}} agents',
    });
    return progress.currentAgent ? `${base}, ${t('dock.subagents.on', { name: progress.currentAgent, defaultValue: 'on {{name}}' })}` : base;
  }
  if (progress.summary) {
    return progress.summary;
  }
  if (progress.toolUses !== undefined) {
    const base = t('dock.subagents.toolsUsed', {
      count: progress.toolUses,
      defaultValue_one: '{{count}} tool',
      defaultValue_other: '{{count}} tools',
    });
    return entry.status === 'running' && progress.lastTool
      ? `${base}, ${t('dock.subagents.now', { tool: progress.lastTool, defaultValue: 'now {{tool}}' })}`
      : base;
  }
  return progress.lastTool && entry.status === 'running'
    ? t('dock.subagents.now', { tool: progress.lastTool, defaultValue: 'now {{tool}}' })
    : '';
}

const ICON_BUTTON_CLASS = 'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Rendered by chat's SessionDock: one subagent, workflow or background command.
 * Clicking it brings its card into view; hovering (or focusing) it offers to
 * inspect the agent and, while it runs, to stop it. Stopping is its own icon,
 * never the row, so a stray click cannot end someone's work.
 */
export const DockSubagentRow = memo(({ entry, now, sessionId, sendMessage, onReveal, onLoadAll }: DockSubagentRowProps) => {
  const { t } = useTranslation('chat');
  const inspector = useAgentInspector();
  const isRunning = entry.status === 'running';
  const kindLabel = entry.kind === 'workflow'
    ? t('common:workflow.title', 'Workflow')
    : entry.kind === 'command'
      ? t('common:workflow.backgroundCommand', 'Command')
      : '';
  const name = entry.name || t('dock.subagents.unnamed', 'Agent');
  const detail = [kindLabel, describeProgress(entry, t)].filter(Boolean).join(', ');
  const elapsed = isRunning && entry.startedAt !== null ? formatTaskDuration(Math.max(0, now - entry.startedAt)) : '';
  const outcome = entry.status === 'failed'
    ? t('dock.subagents.failed', 'Failed')
    : entry.status === 'stopped'
      ? t('dock.subagents.stopped', 'Stopped')
      : '';
  const canInspect = Boolean(inspector && sessionId && entry.agentId);
  const canStop = Boolean(isRunning && sessionId && entry.taskId);

  const body = (
    <>
      <SubagentGlyph seed={entry.key} running={isRunning} className="mt-0.5" />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
          {(elapsed || outcome) && (
            <span className={cn('flex-shrink-0 text-xs tabular-nums', entry.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
              {elapsed || outcome}
            </span>
          )}
        </span>
        {detail && <span className="block truncate text-xs text-muted-foreground" title={detail}>{detail}</span>}
      </span>
    </>
  );
  // On a narrow screen or without hover the app keeps hover-revealed icons on
  // show (see the mobile rules in index.css), so the row keeps room for them.
  const bodyClass = cn(
    'flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left',
    (canInspect || canStop) && 'max-md:pr-16 [@media(hover:none)]:pr-16',
  );

  return (
    <li className="group relative">
      {entry.message ? (
        <button
          type="button"
          onClick={() => onReveal(entry.message as ChatMessage)}
          className={cn(bodyClass, 'w-full transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
        >
          {body}
        </button>
      ) : entry.nested ? (
        // Launched by one of the session's agents: its row is in that agent's
        // transcript, so no page of this one will ever hold it.
        <div className={bodyClass} title={t('common:workflow.taskOfAgent', 'Launched by one of this session\'s agents')}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={onLoadAll}
          title={t('common:workflow.taskRowNotLoaded', 'Launched earlier in this conversation; click to load it')}
          className={cn(bodyClass, 'w-full transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
        >
          {body}
        </button>
      )}

      {(canInspect || canStop) && (
        // Hidden icons take no taps: on a laptop with a touchscreen a tap on
        // the end of a row would otherwise land on an invisible Stop.
        <div className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-card/95 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          {canInspect && (
            <button
              type="button"
              aria-label={t('dock.subagents.inspect', { name, defaultValue: 'Inspect {{name}}' })}
              title={t('common:agentInspector.inspect', 'Inspect agent')}
              onClick={() => inspector?.inspectAgent({
                sessionId: sessionId as string,
                agentId: entry.agentId as string,
                title: name,
                isRunning,
              })}
              className={ICON_BUTTON_CLASS}
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
          {canStop && (
            <button
              type="button"
              aria-label={t('dock.subagents.stop', { name, defaultValue: 'Stop {{name}}' })}
              title={t('dock.subagents.stopTitle', 'Stop')}
              onClick={() => sendMessage({ type: 'chat.stop-task', sessionId, taskId: entry.taskId })}
              className={cn(ICON_BUTTON_CLASS, 'hover:text-red-600 dark:hover:text-red-400')}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}
        </div>
      )}
    </li>
  );
});
DockSubagentRow.displayName = 'DockSubagentRow';
