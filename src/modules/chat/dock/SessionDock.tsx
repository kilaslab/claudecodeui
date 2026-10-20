import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DockChecklist } from '@/modules/chat/dock/DockChecklist';
import { DockSubagentRow } from '@/modules/chat/dock/DockSubagentRow';
import { SESSION_DOCK_ELEMENT_ID } from '@/shared/constants';
import { cn } from '@/shared/utils';
import type { ChatMessage, SessionChecklist, SessionRoster } from '@/shared/types';

/** Finished rows listed before "Show more"; a long session has dozens, and the running ones always show. */
const FINISHED_VISIBLE_LIMIT = 8;

/** How many more finished rows each "Show more" lists, so a long history is never drawn (and redrawn on every streamed token) all at once. */
const FINISHED_PAGE_SIZE = 20;

type SessionDockProps = {
  roster: SessionRoster;
  checklist: SessionChecklist | null;
  /** `column` sits beside the transcript; `sheet` floats over it, for a chat area too narrow to share. */
  layout: 'column' | 'sheet';
  /** The session `chat.stop-task` names; null before one exists. */
  sessionId: string | null;
  sendMessage: (message: unknown) => boolean;
  onReveal: (message: ChatMessage) => void;
  onLoadAll: () => void;
  onClose: () => void;
};

/**
 * Rendered by chat's ChatInterface beside the transcript: the session's
 * checklist and its subagents in one card that floats on the right, where the
 * transcript's scrolling and its own sticky headers cannot cover it. As a sheet
 * it behaves as the modal it looks like: it takes focus, Escape closes it
 * ahead of the transcript's Escape-to-stop, closing it hands focus back to
 * where it was, and showing a row in the transcript closes it so the row can
 * be seen. Opened from DockCapsules; closing it never stops anything.
 *
 * Memoized, with stable row handlers: the chat view re-renders on every
 * keystroke and streamed token, and the dock only needs to when its rows do.
 */
export const SessionDock = memo(function SessionDock({ roster, checklist, layout, sessionId, sendMessage, onReveal, onLoadAll, onClose }: SessionDockProps) {
  const { t } = useTranslation('chat');
  const isSheet = layout === 'sheet';
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // How many finished rows are listed beyond none: grows a page at a time.
  const [finishedLimit, setFinishedLimit] = useState(FINISHED_VISIBLE_LIMIT);
  // The wall clock the running rows count their elapsed time against; it only
  // ticks while something runs.
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = roster.running.length > 0;

  useEffect(() => {
    if (!hasRunning) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  useEffect(() => {
    if (!isSheet) {
      return undefined;
    }
    // Focus goes back where it came from (the capsule that opened the sheet)
    // when the sheet closes, rather than falling to the page.
    const openedFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    // On the window, in the capture phase, like the agent inspector's: ahead of
    // the transcript's document-level Escape, which would stop the running turn.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      // Only when nothing else took focus meanwhile: a removed sheet leaves it on the page.
      const isFocusLost = !document.activeElement || document.activeElement === document.body;
      if (isFocusLost && openedFrom?.isConnected) {
        openedFrom.focus();
      }
    };
  }, [isSheet, onClose]);

  const finished = roster.finished.slice(0, finishedLimit);
  const hiddenFinished = roster.finished.length - finished.length;
  // A sheet covers what a row would show, so acting on a row dismisses it.
  const revealRow = useCallback((message: ChatMessage) => {
    onReveal(message);
    if (isSheet) {
      onClose();
    }
  }, [isSheet, onClose, onReveal]);
  const loadAllRows = useCallback(() => {
    onLoadAll();
    if (isSheet) {
      onClose();
    }
  }, [isSheet, onClose, onLoadAll]);
  const rowProps = { sessionId, sendMessage, onReveal: revealRow, onLoadAll: loadAllRows };

  return (
    <>
      {isSheet && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/20"
        />
      )}
      <aside
        id={SESSION_DOCK_ELEMENT_ID}
        aria-label={t('dock.title', 'Tasks and subagents')}
        role={isSheet ? 'dialog' : undefined}
        aria-modal={isSheet ? true : undefined}
        // The sheet clears the status bar and home indicator of an installed
        // app, and the quick-settings handle that sits on the right edge.
        style={isSheet ? { top: 'max(0.75rem, env(safe-area-inset-top))', bottom: 'max(0.75rem, env(safe-area-inset-bottom))' } : undefined}
        className={cn(
          'flex flex-col',
          isSheet
            ? 'fixed right-12 z-40 w-[min(22rem,calc(100vw-4.5rem))]'
            : 'w-80 flex-shrink-0 py-3 pr-10',
        )}
      >
        <div className={cn('flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground', isSheet ? 'shadow-lg' : 'shadow-sm')}>
          <div className="flex items-center justify-between gap-2 border-b border-border/60 py-1 pl-3 pr-1.5">
            <h2 className="text-xs font-medium text-muted-foreground">{t('dock.title', 'Tasks and subagents')}</h2>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label={t('dock.close', 'Close')}
              title={t('dock.close', 'Close')}
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {checklist && <DockChecklist checklist={checklist} />}

            {(roster.running.length > 0 || roster.finished.length > 0) && (
              <section
                aria-label={t('dock.subagents.title', 'Subagents')}
                className={checklist ? 'border-t border-border/60 px-1.5 pb-2 pt-2.5' : 'px-1.5 pb-2 pt-2.5'}
              >
                <h3 className="px-1.5 pb-1 text-sm font-medium text-foreground">{t('dock.subagents.title', 'Subagents')}</h3>

                {roster.running.length > 0 && (
                  <>
                    <p className="px-1.5 pb-0.5 pt-1 text-xs text-muted-foreground">
                      {t('dock.subagents.running', 'Running')} <span className="tabular-nums">{roster.running.length}</span>
                    </p>
                    <ul>
                      {roster.running.map((entry) => <DockSubagentRow key={entry.key} entry={entry} now={now} {...rowProps} />)}
                    </ul>
                  </>
                )}

                {roster.finished.length > 0 && (
                  <>
                    <p className="px-1.5 pb-0.5 pt-2 text-xs text-muted-foreground">
                      {t('dock.subagents.finished', 'Finished')} <span className="tabular-nums">{roster.finished.length}</span>
                    </p>
                    <ul>
                      {/* A finished row has no clock: it does not redraw each second. */}
                      {finished.map((entry) => <DockSubagentRow key={entry.key} entry={entry} now={0} {...rowProps} />)}
                    </ul>
                    {hiddenFinished > 0 && (
                      <button
                        type="button"
                        onClick={() => setFinishedLimit((limit) => limit + FINISHED_PAGE_SIZE)}
                        className="mx-1.5 mt-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('dock.subagents.showMore', { count: Math.min(hiddenFinished, FINISHED_PAGE_SIZE), defaultValue: 'Show {{count}} more' })}
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      </aside>
    </>
  );
});
