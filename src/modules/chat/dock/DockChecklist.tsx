import { memo } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { SessionChecklist } from '@/shared/types';

/**
 * Rendered by chat's SessionDock: the checklist the agent is working through,
 * with how far along it is. The same list the transcript's checklist card draws,
 * kept in view while the transcript scrolls.
 */
export const DockChecklist = memo(({ checklist }: { checklist: SessionChecklist }) => {
  const { t } = useTranslation('chat');
  const percent = Math.round((checklist.completed / checklist.total) * 100);

  return (
    <section aria-label={t('dock.tasks.title', 'Tasks')} className="px-3 pb-3 pt-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t('dock.tasks.title', 'Tasks')}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('dock.tasks.progress', { done: checklist.completed, total: checklist.total, defaultValue: '{{done}} of {{total}} done' })}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={t('dock.tasks.title', 'Tasks')}
        aria-valuemin={0}
        aria-valuemax={checklist.total}
        aria-valuenow={checklist.completed}
        className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>

      <ul className="mt-2.5 max-h-64 space-y-1.5 overflow-y-auto pr-1">
        {checklist.todos.map((todo, index) => {
          const status = todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending';
          return (
            <li key={todo.id ?? `${todo.content}-${index}`} data-status={status} className="flex items-start gap-2 text-sm leading-snug">
              <span
                aria-hidden="true"
                className={cn(
                  'mt-[3px] flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border',
                  status === 'completed' && 'border-foreground/60 bg-foreground/60 text-background',
                  status === 'in_progress' && 'border-foreground/70',
                  status === 'pending' && 'border-muted-foreground/50',
                )}
              >
                {status === 'completed' && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                {status === 'in_progress' && <span className="h-1.5 w-1.5 rounded-full bg-foreground/70 motion-safe:animate-pulse" />}
              </span>
              <span className={cn('min-w-0 break-words', status === 'completed' ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'text-foreground')}>
                {status === 'in_progress' ? todo.activeForm || todo.content : todo.content}
              </span>
              <span className="sr-only">
                {status === 'completed'
                  ? t('dock.tasks.statusDone', 'Done')
                  : status === 'in_progress'
                    ? t('dock.tasks.statusActive', 'In progress')
                    : t('dock.tasks.statusPending', 'Not started')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
DockChecklist.displayName = 'DockChecklist';
