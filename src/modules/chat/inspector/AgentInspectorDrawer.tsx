import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { AgentInspectorTarget, DiffLine, Project } from '@/shared/types';
import { AgentInspectorPanel } from '@/modules/chat/inspector/AgentInspectorPanel';

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

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('agentInspector.dialog', 'Agent: {{title}}', { title: current.title })}
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl"
      >
        <AgentInspectorPanel
          stack={stack}
          onOpenChild={onOpenChild}
          onBackTo={onBackTo}
          onClose={onClose}
          variant="drawer"
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          selectedProject={selectedProject}
        />
      </section>
    </div>,
    document.body,
  );
}
