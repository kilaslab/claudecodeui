import { useCallback, useState } from 'react';

import { safeLocalStorage } from '@/modules/chat/utils/chatStorage';

const SESSION_DOCK_OPEN_KEY = 'chat.sessionDock.open';

/**
 * Whether the right-hand dock of tasks and subagents is open, remembered
 * across sessions and reloads: opening it is a choice about the layout of the
 * screen, not about one conversation.
 *
 * Used by chat's ChatInterface, which renders the dock and the capsules that open it.
 */
export function useSessionDockOpen(): [boolean, (open: boolean) => void] {
  // The remembered choice; the dock stays closed until the user opens it, so a
  // new subagent never narrows the transcript on its own.
  const [isOpen, setIsOpen] = useState(() => safeLocalStorage.getItem(SESSION_DOCK_OPEN_KEY) === 'true');

  const setOpen = useCallback((open: boolean) => {
    setIsOpen(open);
    safeLocalStorage.setItem(SESSION_DOCK_OPEN_KEY, String(open));
  }, []);

  return [isOpen, setOpen];
}
