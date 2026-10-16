import { Fragment, memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, MessageSquareText } from 'lucide-react';

import type { DiffLine, Project, SubagentActivity } from '@/shared/types';
import { cn } from '@/shared/utils';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';

type SubagentTimelineProps = {
  activity: SubagentActivity[];
  /** Total entries the agent recorded, which exceeds `activity` when a long run was truncated for transport. */
  activityCount?: number;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
  /** Opens an agent this run spawned; when absent, such calls draw as plain tool calls. */
  onInspectAgent?: (agentId: string, title: string) => void;
};

/** What a spawned agent is called: the description its call gave it, else its preset. */
function describeSpawnedAgent(toolInput: unknown): string {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as { description?: unknown; subagent_type?: unknown };
  if (typeof input.description === 'string' && input.description) {
    return input.description;
  }
  return typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'Agent';
}

/**
 * How many timeline entries are drawn before the "show more" step. A single
 * entry can expand into a diff viewer, so an agent with a long run would
 * otherwise mount hundreds of tool renderers the moment it is opened.
 */
const INITIALLY_RENDERED_ACTIVITIES = 25;

/** One prose or reasoning entry from the agent's own narration. */
const SubagentNote = memo(({ activity }: { activity: SubagentActivity }) => {
  const isThinking = activity.kind === 'thinking';
  const Icon = isThinking ? Brain : MessageSquareText;

  return (
    <div className="flex gap-2 py-1">
      <Icon className={cn('mt-0.5 h-3 w-3 flex-shrink-0', isThinking ? 'text-muted-foreground/50' : 'text-muted-foreground/70')} />
      <div
        className={cn(
          'min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed',
          isThinking ? 'italic text-muted-foreground/70' : 'text-muted-foreground',
        )}
      >
        {activity.content}
      </div>
    </div>
  );
});
SubagentNote.displayName = 'SubagentNote';

/**
 * Rendered by SubagentPanel and WorkflowPanel for an agent's recorded
 * timeline — tool calls through the same router the main thread uses, prose
 * and reasoning as notes — with a "show more" step for long runs and a note
 * for the entries the backend left out of a truncated one.
 *
 * Only mount it while its panel is open: a run of a hundred tools is a
 * hundred tool renderers.
 */
export const SubagentTimeline = memo(({ activity, activityCount, onFileOpen, createDiff, selectedProject, onInspectAgent }: SubagentTimelineProps) => {
  const { t } = useTranslation();
  const isExporting = useIsExportingTranscript();
  // Raised by the "show more" step so a long run can be inspected in full
  // without paying for it up front.
  const [renderLimit, setRenderLimit] = useState(INITIALLY_RENDERED_ACTIVITIES);
  const effectiveRenderLimit = isExporting ? Number.POSITIVE_INFINITY : renderLimit;

  // The backend truncates very long timelines for transport; say so rather
  // than implying the agent stopped where the list does.
  const untransmittedCount = Math.max(0, (activityCount ?? activity.length) - activity.length);
  const visibleEntries = activity.slice(0, effectiveRenderLimit);
  const hiddenCount = activity.length - visibleEntries.length;

  return (
    <>
      {visibleEntries.length > 0 && (
        <div className="border-l border-border/60 pl-2">
          {visibleEntries.map((entry, index) => (
            entry.kind === 'tool' ? (
              <Fragment key={entry.toolId ?? `activity-${index}`}>
                {/* Rendered through the same router the main thread uses, so a
                    subagent's shell command or diff looks exactly like one the
                    top-level agent ran. */}
                <ToolRenderer
                  toolName={entry.toolName || 'UnknownTool'}
                  toolInput={entry.toolInput}
                  toolResult={entry.toolResult}
                  toolId={entry.toolId}
                  mode="input"
                  onFileOpen={onFileOpen}
                  createDiff={createDiff}
                  selectedProject={selectedProject}
                />
                {entry.childAgentId && onInspectAgent && (
                  <button
                    type="button"
                    onClick={() => {
                      if (entry.childAgentId) {
                        onInspectAgent(entry.childAgentId, describeSpawnedAgent(entry.toolInput));
                      }
                    }}
                    aria-label={t('agentInspector.openAgentNamed', 'Open agent: {{title}}', { title: describeSpawnedAgent(entry.toolInput) })}
                    className="mb-1 ml-5 text-[11px] text-purple-600 hover:underline dark:text-purple-300"
                  >
                    {t('agentInspector.openAgent', 'Open agent')}
                  </button>
                )}
              </Fragment>
            ) : (
              <SubagentNote key={`activity-${index}`} activity={entry} />
            )
          ))}
        </div>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setRenderLimit((previous) => previous + INITIALLY_RENDERED_ACTIVITIES * 4)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? 'step' : 'steps'}
        </button>
      )}

      {untransmittedCount > 0 && hiddenCount === 0 && (
        <div className="text-[11px] text-muted-foreground/60">
          {untransmittedCount} earlier {untransmittedCount === 1 ? 'step is' : 'steps are'} not included
        </div>
      )}
    </>
  );
});
SubagentTimeline.displayName = 'SubagentTimeline';
