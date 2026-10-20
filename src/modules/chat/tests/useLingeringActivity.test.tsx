import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLingeringActivity } from '@/modules/chat/hooks/useLingeringActivity';
import type { SessionActivity } from '@/shared/types';

const LINGER_MS = 700;

const activity = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  statusText: null,
  canInterrupt: true,
  startedAt: 1_000,
  ...overrides,
});

describe('useLingeringActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the live activity unchanged', () => {
    const live = activity();
    const { result } = renderHook(() => useLingeringActivity(live, 's1', LINGER_MS));

    expect(result.current).toBe(live);
  });

  it('keeps showing the last activity, without Stop, while a gap is shorter than the linger', () => {
    const live = activity({ statusText: 'Working' });
    const { result, rerender } = renderHook(
      ({ current }) => useLingeringActivity(current, 's1', LINGER_MS),
      { initialProps: { current: live as SessionActivity | null } },
    );

    rerender({ current: null });
    expect(result.current).toMatchObject({ statusText: 'Working', canInterrupt: false });

    act(() => {
      vi.advanceTimersByTime(LINGER_MS - 1);
    });
    expect(result.current).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();
  });

  it('never reports a gap when the activity returns inside the linger', () => {
    const seen: Array<SessionActivity | null> = [];
    const { rerender } = renderHook(
      ({ current }) => {
        const shown = useLingeringActivity(current, 's1', LINGER_MS);
        seen.push(shown);
        return shown;
      },
      { initialProps: { current: activity() as SessionActivity | null } },
    );

    rerender({ current: null });
    act(() => {
      vi.advanceTimersByTime(LINGER_MS / 2);
    });
    rerender({ current: activity({ startedAt: 2_000 }) });
    act(() => {
      vi.advanceTimersByTime(LINGER_MS * 2);
    });

    expect(seen.every((entry) => entry !== null)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ startedAt: 2_000, canInterrupt: true });
  });

  it('does not carry one session\'s activity into another session', () => {
    const { result, rerender } = renderHook(
      ({ current, sessionId }) => useLingeringActivity(current, sessionId, LINGER_MS),
      { initialProps: { current: activity() as SessionActivity | null, sessionId: 's1' } },
    );

    rerender({ current: null, sessionId: 's2' });

    expect(result.current).toBeNull();
  });
});
