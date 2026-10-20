import { useCallback, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

import { useSessionDockOpen } from '@/modules/chat/hooks/useSessionDockOpen';
import { SESSION_DOCK_COLUMN_MIN_WIDTH } from '@/shared/constants';

/**
 * Where the right-hand dock sits and whether it is open.
 *
 * It sits where the chat area has room, not where the window does: an editor
 * docked beside the chat can leave it narrow in a wide window. The column is a
 * choice about the layout and is remembered; the sheet covers the chat, so it
 * is never restored and starts closed every time.
 *
 * Used by chat's ChatInterface, which owns the row element the width is read from.
 */
export function useSessionDock(chatRowRef: RefObject<HTMLElement>) {
  // The width of the chat area, measured; null until the first measurement (or
  // where nothing can measure), so the dock is assumed to fit.
  const [chatRowWidth, setChatRowWidth] = useState<number | null>(null);
  // Whether the dock is open as a column; remembered across sessions and reloads.
  const [isColumnOpen, setColumnOpen] = useSessionDockOpen();
  // Whether the dock is open as a sheet, for this visit only.
  const [isSheetOpen, setSheetOpen] = useState(false);

  useLayoutEffect(() => {
    const row = chatRowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    setChatRowWidth(row.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') {
        setChatRowWidth(width);
      }
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [chatRowRef]);

  const layout: 'column' | 'sheet' = chatRowWidth !== null && chatRowWidth < SESSION_DOCK_COLUMN_MIN_WIDTH ? 'sheet' : 'column';
  const isOpen = layout === 'sheet' ? isSheetOpen : isColumnOpen;
  const setOpen = layout === 'sheet' ? setSheetOpen : setColumnOpen;
  const toggle = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);

  return { layout, isOpen, toggle, close };
}
