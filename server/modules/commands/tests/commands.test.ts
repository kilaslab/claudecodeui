import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

async function withCommandsServer<T>(
  run: (post: (route: string, body: Record<string, unknown>, expectedStatus?: number) => Promise<Record<string, unknown>>) => Promise<T>,
  sessionModels: Record<string, string> = {},
): Promise<T> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    // Only Claude compacts: its CLI owns the `/compact` command.
    supportsCompaction: (provider: string) => provider === 'claude',
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    return await run(async (route, body, expectedStatus = 200) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, expectedStatus);
      return await response.json() as Record<string, unknown>;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return withCommandsServer((post) => post('execute', { commandName, context, ...extra }), sessionModels);
}

async function listCommands(provider?: string): Promise<{ builtIn: Array<{ name: string }> }> {
  return withCommandsServer((post) => post('list', provider ? { provider } : {})) as never;
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('/compact is offered to Claude and left out for providers that cannot compact', async () => {
  const names = async (provider?: string) => (await listCommands(provider)).builtIn.map((command) => command.name);

  assert.ok((await names('claude')).includes('/compact'));
  assert.ok((await names()).includes('/compact'), 'a client that names no provider gets the full list');
  assert.equal((await names('codex')).includes('/compact'), false);
  assert.equal((await names('cursor')).includes('/compact'), false);
  assert.ok((await names('codex')).includes('/help'), 'the other built-ins stay');
});

test('/compact asks the client to compact, passing the instructions typed after it', async () => {
  const plain = await executeCommand('/compact', { provider: 'claude' });
  assert.equal(plain.type, 'builtin');
  assert.equal(plain.action, 'compact');
  assert.deepEqual(plain.data, { instructions: '' });

  const focused = await executeCommand('/compact', { provider: 'claude' }, {}, { rawArgs: 'keep the API decisions' });
  assert.deepEqual(focused.data, { instructions: 'keep the API decisions' });
});

test('/help lists /compact among the built-ins', async () => {
  const help = await executeCommand('/help', { provider: 'claude' });
  const data = help.data as { commands: Array<{ name: string }> };
  assert.ok(data.commands.some((command) => command.name === '/compact'));
});

test('/help and /compact are for the providers that can compact, and no others', async () => {
  const codexHelp = await executeCommand('/help', { provider: 'codex' });
  const listed = (codexHelp.data as { commands: Array<{ name: string }> }).commands.map((command) => command.name);
  assert.equal(listed.includes('/compact'), false);
  assert.ok(listed.includes('/models'));
  assert.equal(JSON.stringify(codexHelp.data).includes('### /compact'), false, 'nor does the help text describe it');

  const refused = await withCommandsServer((post) => post('execute', { commandName: '/compact', context: { provider: 'codex' } }, 500));
  assert.match(String(refused.message), /cannot compact/);
});
