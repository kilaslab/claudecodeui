import { useEffect, useRef, useState } from 'react';

/** How often a running agent's timeline is re-read while its card is open. */
const AGENT_TIMELINE_POLL_MS = 3_000;

/** What the last read returned — the data, or why there is none — and null until the first read lands. */
export type AgentTimelineRead<T> = { data: T } | { error: string } | null;

type AgentTimelineRequest<T> = {
  /** Identifies what is read; a new key starts over with a fresh read. */
  key: string;
  read: () => Promise<T>;
  /** Whether the card still has the agent running, which is what keeps it re-reading. */
  keepPolling: boolean;
  /** The data's own word that the agent has settled, which stops the re-reads early. */
  isSettled?: (data: T) => boolean;
};

/**
 * Reads an agent's timeline when its card opens, and re-reads it every few
 * seconds while the agent runs: an agent's own transcript is the only place
 * its progress lands before it reports back. Pass null while the card is
 * closed or has nothing to address.
 *
 * A read that fails after one has succeeded keeps the last timeline — what the
 * agent had done does not stop being true.
 *
 * Used by chat's WorkflowPanel (one agent of a workflow run) and SubagentPanel
 * (one subagent of the session).
 */
export function useAgentTimelinePoll<T>(request: AgentTimelineRequest<T> | null): AgentTimelineRead<T> {
  // The last read's outcome with the key it was read for: the card renders it
  // only while it still addresses that agent, so a settling agent keeps its
  // timeline on screen and a different one starts from nothing.
  const [loaded, setLoaded] = useState<{ key: string; read: AgentTimelineRead<T> } | null>(null);
  // The latest request, so the polling effect re-runs only when the key or the
  // polling changes. Updated by the effect below, which runs before it.
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  });

  const key = request?.key ?? null;
  const keepPolling = Boolean(request?.keepPolling);

  useEffect(() => {
    if (key === null) {
      return undefined;
    }

    let cancelled = false;
    let nextRead: ReturnType<typeof setTimeout> | undefined;

    const read = async () => {
      const current = requestRef.current;
      if (!current) {
        return;
      }
      let settled = false;
      try {
        const data = await current.read();
        if (cancelled) {
          return;
        }
        setLoaded({ key, read: { data } });
        settled = current.isSettled?.(data) ?? false;
      } catch (error) {
        if (cancelled) {
          return;
        }
        // A transcript is written a moment after the agent's start is
        // reported, so the first read of a fresh agent can miss it.
        setLoaded((previous) => previous?.key === key && previous.read && 'data' in previous.read
          ? previous
          : { key, read: { error: error instanceof Error ? error.message : String(error) } });
      }
      if (keepPolling && !settled && !cancelled) {
        nextRead = setTimeout(read, AGENT_TIMELINE_POLL_MS);
      }
    };
    void read();

    return () => {
      cancelled = true;
      clearTimeout(nextRead);
    };
  }, [key, keepPolling]);

  return loaded && loaded.key === key ? loaded.read : null;
}
