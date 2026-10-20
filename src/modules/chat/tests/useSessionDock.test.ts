import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionDock } from '@/modules/chat/hooks/useSessionDock';
import { SESSION_DOCK_COLUMN_MIN_WIDTH } from '@/shared/constants';

/**
 * The dock sits beside the chat only where the chat area has room for both, and
 * the room is the chat area's, which a docked editor can shrink without the
 * window changing.
 */

type ObserverRecord = { callback: ResizeObserverCallback; disconnected: boolean };
const observers: ObserverRecord[] = [];

class FakeResizeObserver {
  private record: ObserverRecord;

  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, disconnected: false };
    observers.push(this.record);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    this.record.disconnected = true;
  }
}

const rowOfWidth = (width: number) => ({ current: { getBoundingClientRect: () => ({ width }) } as unknown as HTMLElement });
const resizeTo = (width: number) => {
  act(() => {
    for (const { callback, disconnected } of observers) {
      if (!disconnected) {
        callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      }
    }
  });
};

describe('useSessionDock', () => {
  beforeEach(() => {
    observers.length = 0;
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is a column where the chat area is wide enough, and a sheet where it is not', () => {
    const wide = rowOfWidth(SESSION_DOCK_COLUMN_MIN_WIDTH);
    const narrow = rowOfWidth(SESSION_DOCK_COLUMN_MIN_WIDTH - 1);
    expect(renderHook(() => useSessionDock(wide)).result.current.layout).toBe('column');
    expect(renderHook(() => useSessionDock(narrow)).result.current.layout).toBe('sheet');
  });

  it('follows the chat area as it is resized, whatever the window does', () => {
    // The row element is the component's own, one for its whole life.
    const row = rowOfWidth(1200);
    const { result } = renderHook(() => useSessionDock(row));
    expect(result.current.layout).toBe('column');

    resizeTo(500);
    expect(result.current.layout).toBe('sheet');
    resizeTo(1000);
    expect(result.current.layout).toBe('column');
  });

  it('assumes the dock fits where nothing can measure', () => {
    vi.stubGlobal('ResizeObserver', undefined);

    const row = rowOfWidth(300);
    expect(renderHook(() => useSessionDock(row)).result.current.layout).toBe('column');
  });

  it('remembers the column being open, and never restores the sheet', () => {
    const wideRow = rowOfWidth(1200);
    const column = renderHook(() => useSessionDock(wideRow));
    act(() => column.result.current.toggle());
    expect(column.result.current.isOpen).toBe(true);
    expect(localStorage.getItem('chat.sessionDock.open')).toBe('true');
    column.unmount();

    // The next visit, in a chat area too narrow for the column: the sheet starts
    // closed even though the column was left open, and opening it leaves no trace.
    const narrowRow = rowOfWidth(400);
    const sheet = renderHook(() => useSessionDock(narrowRow));
    expect(sheet.result.current.layout).toBe('sheet');
    expect(sheet.result.current.isOpen).toBe(false);
    act(() => sheet.result.current.toggle());
    expect(sheet.result.current.isOpen).toBe(true);
    act(() => sheet.result.current.close());
    expect(sheet.result.current.isOpen).toBe(false);
    expect(localStorage.getItem('chat.sessionDock.open')).toBe('true');
  });

  it('stops watching when it goes away', () => {
    const row = rowOfWidth(1200);
    const { unmount } = renderHook(() => useSessionDock(row));
    expect(observers.filter((observer) => !observer.disconnected)).toHaveLength(1);

    unmount();

    expect(observers.filter((observer) => !observer.disconnected)).toHaveLength(0);
  });
});
