import { createContext, useContext } from 'react';

import type { AgentInspectorTarget } from '@/shared/types';

/** What a card can ask of the agent inspector of the transcript it is drawn in. */
export type AgentInspectorContextValue = {
  /** Opens the inspector on one agent, replacing whatever it showed. */
  inspectAgent: (target: AgentInspectorTarget) => void;
};

/** Provided by chat's AgentInspectorProvider; null outside one. */
export const AgentInspectorContext = createContext<AgentInspectorContextValue | null>(null);

/**
 * The inspector of the transcript a card is drawn in, or null outside one (an
 * exported transcript, a test): a card then offers no Inspect button. Used by
 * chat's SubagentPanel, WorkflowPanel and DockSubagentRow.
 */
export function useAgentInspector(): AgentInspectorContextValue | null {
  return useContext(AgentInspectorContext);
}
