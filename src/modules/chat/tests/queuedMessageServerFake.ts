type StoredQueued = { content: string; options?: Record<string, unknown>; attachments: unknown[] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * A `fetch` that answers the queued-message endpoints the way the server does:
 * an append is joined onto what is stored with a blank line, attachments in
 * order, the latest send options. Every other request answers `[]`. Used by
 * chat's composerSendModes and composerQueuedMessageSent tests.
 */
export function createQueuedMessageServerFetch() {
  const queued = new Map<string, StoredQueued>();

  const fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const scope = String(body.scope ?? '');

    if (path.endsWith('/api/user/drafts/queued-message')) {
      if (method === 'POST') {
        const message = body.queuedMessage as StoredQueued;
        const waiting = queued.get(scope);
        const queuedMessage: StoredQueued = waiting
          ? {
              content: [waiting.content, message.content].filter((part) => part.trim()).join('\n\n'),
              options: message.options ?? waiting.options,
              attachments: [...waiting.attachments, ...(message.attachments ?? [])],
            }
          : { content: message.content, options: message.options, attachments: message.attachments ?? [] };
        queued.set(scope, queuedMessage);
        return json({ success: true, queuedMessage, appended: Boolean(waiting) });
      }
      if (method === 'DELETE') {
        queued.delete(scope);
        return json({ success: true });
      }
    }

    return json([]);
  };

  return { fetch, queued };
}
