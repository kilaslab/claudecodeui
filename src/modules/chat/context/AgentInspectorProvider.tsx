import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { AgentInspectorTarget, DiffLine, Project } from '@/shared/types';
import { AgentInspectorContext } from '@/modules/chat/context/AgentInspectorContext';
import { useTranscriptSessionId } from '@/modules/chat/context/TranscriptSessionContext';
import { AgentInspectorDrawer } from '@/modules/chat/inspector/AgentInspectorDrawer';

type AgentInspectorProviderProps = {
  children: ReactNode;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
};

/**
 * Owns the agent inspector for one transcript: the agents opened, and the
 * drawer that shows the innermost of them. Mounted by chat's ChatInterface
 * around the message pane and the session dock, inside its TranscriptSessionContext.
 */
export function AgentInspectorProvider({ children, createDiff, onFileOpen, selectedProject }: AgentInspectorProviderProps) {
  const sessionId = useTranscriptSessionId();
  // The agents opened, outermost first: the last one is on screen, the
  // others are the breadcrumb back to it.
  const [stack, setStack] = useState<AgentInspectorTarget[]>([]);

  const inspectAgent = useCallback((target: AgentInspectorTarget) => setStack([target]), []);
  const openChild = useCallback((target: AgentInspectorTarget) => setStack((previous) => [...previous, target]), []);
  const backTo = useCallback((index: number) => setStack((previous) => previous.slice(0, index + 1)), []);
  const close = useCallback(() => setStack([]), []);
  const value = useMemo(() => ({ inspectAgent }), [inspectAgent]);

  // Agents opened in another chat stay out of this one, without a reset
  // effect: switching back shows them again until the inspector is closed.
  const visibleStack = stack.length > 0 && stack[0].sessionId === sessionId ? stack : null;

  return (
    <AgentInspectorContext.Provider value={value}>
      {children}
      {visibleStack && (
        <AgentInspectorDrawer
          stack={visibleStack}
          onOpenChild={openChild}
          onBackTo={backTo}
          onClose={close}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          selectedProject={selectedProject}
        />
      )}
    </AgentInspectorContext.Provider>
  );
}
