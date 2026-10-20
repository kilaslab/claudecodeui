import { memo } from 'react';
import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SESSION_DOCK_ELEMENT_ID } from '@/shared/constants';
import { cn } from '@/shared/utils';
import type { SessionChecklist, SessionRoster } from '@/shared/types';

type DockCapsulesProps = {
  roster: SessionRoster;
  checklist: SessionChecklist | null;
  isOpen: boolean;
  onToggle: () => void;
  /** True while the activity tab hangs over the composer; the row leaves it room so the two never overlap. */
  leavesRoomForActivity: boolean;
};

const CAPSULE_CLASS = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-foreground/85 shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Rendered by chat's ChatInterface above the composer: one small pill for the
 * checklist and one for the subagents, always in view while the session has
 * any. Each says where things stand and opens the dock where they are listed.
 * Nothing in them stops anything.
 */
export const DockCapsules = memo(({ roster, checklist, isOpen, onToggle, leavesRoomForActivity }: DockCapsulesProps) => {
  const { t } = useTranslation('chat');
  const runningCount = roster.running.length;
  const totalCount = runningCount + roster.finished.length;

  if (!checklist && totalCount === 0) {
    return null;
  }

  // "Subagents" only when every entry is one: workflows and commands run in the
  // background too, and the count would otherwise name them wrongly.
  const onlyAgents = [...roster.running, ...roster.finished].every((entry) => entry.kind === 'agent');
  const subagentsLabel = runningCount > 0
    ? onlyAgents
      ? t('dock.capsule.subagentsRunning', { count: runningCount, defaultValue_one: '{{count}} subagent running', defaultValue_other: '{{count}} subagents running' })
      : t('dock.capsule.tasksRunning', { count: runningCount, defaultValue_one: '{{count}} background task running', defaultValue_other: '{{count}} background tasks running' })
    : onlyAgents
      ? t('dock.capsule.subagentsFinished', { count: totalCount, defaultValue_one: '{{count}} subagent finished', defaultValue_other: '{{count}} subagents finished' })
      : t('dock.capsule.tasksFinished', { count: totalCount, defaultValue_one: '{{count}} background task finished', defaultValue_other: '{{count}} background tasks finished' });

  return (
    <div className={cn('flex-shrink-0 px-2 pb-1.5 sm:px-4', leavesRoomForActivity && 'pb-10')}>
      <div className="mx-auto flex max-w-[54.25rem] flex-wrap items-center gap-1.5">
        {checklist && (
          <button
            type="button"
            aria-pressed={isOpen}
            aria-controls={isOpen ? SESSION_DOCK_ELEMENT_ID : undefined}
            onClick={onToggle}
            title={checklist.active ? checklist.active.activeForm || checklist.active.content : undefined}
            className={cn(CAPSULE_CLASS, isOpen && 'bg-muted')}
          >
            <ListChecks className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{t('dock.capsule.tasks', 'Tasks')}</span>
            <span className="tabular-nums text-muted-foreground">{checklist.completed}/{checklist.total}</span>
          </button>
        )}
        {totalCount > 0 && (
          <button
            type="button"
            aria-pressed={isOpen}
            aria-controls={isOpen ? SESSION_DOCK_ELEMENT_ID : undefined}
            onClick={onToggle}
            className={cn(CAPSULE_CLASS, isOpen && 'bg-muted')}
          >
            <span
              aria-hidden="true"
              className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', runningCount > 0 ? 'bg-violet-500 motion-safe:animate-pulse dark:bg-violet-400' : 'bg-muted-foreground/50')}
            />
            <span className="truncate">{subagentsLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
});
DockCapsules.displayName = 'DockCapsules';
