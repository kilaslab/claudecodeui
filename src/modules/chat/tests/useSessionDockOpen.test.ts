import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionDockOpen } from '@/modules/chat/hooks/useSessionDockOpen';

/** The dock stays closed until the user opens it, and then stays as they left it. */
describe('useSessionDockOpen', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts closed, so a new subagent never narrows the transcript on its own', () => {
    const { result } = renderHook(() => useSessionDockOpen());

    expect(result.current[0]).toBe(false);
  });

  it('remembers the choice across mounts', () => {
    const first = renderHook(() => useSessionDockOpen());
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    first.unmount();

    const second = renderHook(() => useSessionDockOpen());
    expect(second.result.current[0]).toBe(true);

    act(() => second.result.current[1](false));
    const third = renderHook(() => useSessionDockOpen());
    expect(third.result.current[0]).toBe(false);
  });
});
