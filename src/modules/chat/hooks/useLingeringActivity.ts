import { useEffect, useMemo, useState } from 'react';

import type { SessionActivity } from '@/shared/types';

/** How long an ended activity stays on screen; every flip shorter than this (a poll and an idle ack disagreeing, a turn handing over to its background work) is never drawn as hide-then-show. */
const ACTIVITY_LINGER_MS = 700;

type SeenActivity = { sessionId: string | null; activity: SessionActivity };

/**
 * Keeps the last activity on screen for a moment after it disappears, so an
 * entry that is removed and re-added within the linger never reaches the
 * indicator as a hide followed by a show. The lingering copy cannot be
 * interrupted: there is nothing left to stop.
 *
 * Used by chat's ChatInterface for the activity indicator above the composer
 * and the transcript padding that reserves its space, so both stay in step.
 */
export function useLingeringActivity(
  activity: SessionActivity | null,
  sessionId: string | null,
  lingerMs: number = ACTIVITY_LINGER_MS,
): SessionActivity | null {
  // The activity that was last live and the session it belonged to. It has to
  // outlive the map entry it came from, and it is updated while rendering (not
  // in an effect) so the first render after the entry vanishes already shows it.
  const [lastSeen, setLastSeen] = useState<SeenActivity | null>(null);
  // The activity whose linger has run out, so it is not shown again. A returning
  // entry is a new object, so one that expired never matches a later one.
  const [expiredActivity, setExpiredActivity] = useState<SessionActivity | null>(null);

  if (activity && lastSeen?.activity !== activity) {
    setLastSeen({ sessionId, activity });
  }

  useEffect(() => {
    if (activity || !lastSeen) {
      return;
    }
    const ended = lastSeen.activity;
    const timer = setTimeout(() => setExpiredActivity(ended), lingerMs);
    return () => clearTimeout(timer);
  }, [activity, lastSeen, lingerMs]);

  // One stable object per ended activity: the indicator re-syncs on identity.
  const lingeringCopy = useMemo(
    () => (lastSeen ? { ...lastSeen.activity, canInterrupt: false } : null),
    [lastSeen],
  );

  if (activity) {
    return activity;
  }
  if (!lastSeen || lastSeen.sessionId !== sessionId || expiredActivity === lastSeen.activity) {
    return null;
  }
  return lingeringCopy;
}
