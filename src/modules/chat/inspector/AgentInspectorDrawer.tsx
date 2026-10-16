import { Fragment, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, X } from 'lucide-react';

import type { AgentInspectorTarget, DiffLine, Project, SubagentActivity } from '@/shared/types';
import { api, readApiJson } from '@/shared/api';
import { useAgentTimelinePoll } from '@/modules/chat/hooks/useAgentTimelinePoll';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { SubagentTimeline } from '@/modules/chat/tools/SubagentTimeline';

/** What either agent route answers at `detail=full`: a subagent's read, or a workflow agent's, which adds a status and a result. */
type InspectedAgentRead = {
  agent: { id: string; type?: string; description?: string; label?: string; model?: string; status?: string };
  prompt?: string;
  result?: string;
  activity: SubagentActivity[];
  activityCount: number;
};

type AgentInspectorDrawerProps = {
  /** The agents opened, outermost first; the last one is shown. */
  stack: AgentInspectorTarget[];
  onOpenChild: (target: AgentInspectorTarget) => void;
  onBackTo: (index: number) => void;
  onClose: () => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
};

/** One labelled part of the inspected run. */
function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The agent inspector: one agent's whole run in a panel beside the transcript
 * — what it was asked, every step, what it returned — re-read while the agent
 * runs, with the agents it spawned opening in turn behind a breadcrumb.
 *
 * Rendered by chat's AgentInspectorProvider, which owns the stack of opened
 * agents. Escape closes it, ahead of the transcript's own Escape-to-stop.
 */
export function AgentInspectorDrawer({
  stack,
  onOpenChild,
  onBackTo,
  onClose,
  createDiff,
  onFileOpen,
  selectedProject,
}: AgentInspectorDrawerProps) {
  const { t } = useTranslation();
  const current = stack[stack.length - 1];

  const loaded = useAgentTimelinePoll<InspectedAgentRead>({
    key: `${current.sessionId}/${current.runId ?? ''}/${current.agentId}`,
    read: async () => (await readApiJson<{ data: InspectedAgentRead }>(
      current.runId
        ? await api.workflowAgentActivity(current.sessionId, current.runId, current.agentId, 'full')
        : await api.subagentActivity(current.sessionId, current.agentId, 'full'),
    )).data,
    keepPolling: current.isRunning,
    // A workflow agent's journal can settle it before the card hears of it.
    isSettled: (read) => Boolean(read.agent.status && read.agent.status !== 'running'),
  });

  useEffect(() => {
    // On the window, in the capture phase, so it runs before the transcript's
    // document-level Escape handler, which would stop the running turn; that
    // handler leaves an event alone once it has been handled.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);

  const read = loaded && 'data' in loaded ? loaded.data : null;
  const prompt = read?.prompt;
  const result = current.result ?? read?.result;
  const details = [read?.agent.type, read?.agent.model].filter(Boolean).join(' · ');

  const openChild = (agentId: string, title: string) => onOpenChild({
    sessionId: current.sessionId,
    agentId,
    title,
    isRunning: current.isRunning,
  });

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('agentInspector.dialog', 'Agent: {{title}}', { title: current.title })}
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl"
      >
        <header className="flex items-start gap-2 border-b border-border px-4 py-3">
          <Bot className="mt-0.5 h-4 w-4 flex-shrink-0 text-purple-500 dark:text-purple-400" />
          <nav aria-label={t('agentInspector.breadcrumb', 'Agents')} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
            {stack.map((entry, index) => (
              <Fragment key={`${entry.runId ?? ''}/${entry.agentId}`}>
                {index > 0 && <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" aria-hidden />}
                {index < stack.length - 1 ? (
                  <button
                    type="button"
                    onClick={() => onBackTo(index)}
                    className="max-w-64 truncate text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {entry.title}
                  </button>
                ) : (
                  <span className="max-w-80 truncate font-medium text-foreground">{entry.title}</span>
                )}
              </Fragment>
            ))}
          </nav>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agentInspector.close', 'Close')}
            className="flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {details && <div className="text-[11px] text-muted-foreground/70">{details}</div>}

          {prompt && (
            <InspectorSection title={t('agentInspector.task', 'Task')}>
              <div className="whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/40 p-2 text-xs text-muted-foreground">
                {prompt}
              </div>
            </InspectorSection>
          )}

          <InspectorSection title={t('agentInspector.steps', 'Steps')}>
            {!loaded ? (
              <div className="text-[11px] text-muted-foreground/60">{t('workflow.agentTimelineLoading', 'Reading the agent\'s steps…')}</div>
            ) : 'error' in loaded ? (
              <div className="text-[11px] text-muted-foreground/60">
                {t('workflow.agentTimelineUnavailable', 'Steps unavailable: {{reason}}', { reason: loaded.error })}
              </div>
            ) : loaded.data.activity.length === 0 ? (
              <div className="text-[11px] text-muted-foreground/60">{t('workflow.agentTimelineEmpty', 'Nothing recorded yet')}</div>
            ) : (
              <SubagentTimeline
                activity={loaded.data.activity}
                activityCount={loaded.data.activityCount}
                onFileOpen={onFileOpen}
                createDiff={createDiff}
                selectedProject={selectedProject}
                onInspectAgent={openChild}
              />
            )}
          </InspectorSection>

          {result && (
            <InspectorSection title={t('agentInspector.result', 'Result')}>
              <div className="rounded border border-border/40 bg-muted/30 p-2">
                <MarkdownContent content={result} className="prose prose-sm max-w-none dark:prose-invert" />
              </div>
            </InspectorSection>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
