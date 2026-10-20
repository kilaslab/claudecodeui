import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { KeyboardEvent, RefObject } from 'react';

import type { Project, SlashCommand } from '@/shared/types';

/**
 * Enter or Tab pressed inside the menu's 150 ms filter debounce acts on the
 * text typed so far, not on the stale menu: the list still held every command,
 * most-used first, so a fast typist ran the project's favourite instead of the
 * command they typed. (upstream #1560)
 */

const jsonResponse = (payload: unknown) => ({ ok: true, json: async () => payload });

const listCommands = vi.fn();
const listSkills = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    commands: { list: (...args: unknown[]) => listCommands(...args) },
    providers: { skills: (...args: unknown[]) => listSkills(...args) },
  },
}));

const { useSlashCommands } = await import('@/modules/chat/hooks/useSlashCommands');

const project: Project = {
  projectId: 'triage-repo',
  displayName: 'triage-repo',
  fullPath: '/home/triage/work/triage-repo',
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const command = (name: string) => ({
  name,
  description: `Runs ${name}`,
  namespace: 'project',
  path: `.claude/commands/${name.slice(1)}.md`,
});

const setUp = async () => {
  const setInputCalls: string[] = [];
  const executedCommands: SlashCommand[] = [];
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  const textareaRef = { current: textarea } as RefObject<HTMLTextAreaElement>;

  const { result } = renderHook(() =>
    useSlashCommands({
      selectedProject: project,
      provider: 'claude',
      input: '',
      setInput: (value) => {
        setInputCalls.push(value as string);
      },
      textareaRef,
      onExecuteCommand: (picked) => {
        executedCommands.push(picked);
      },
    }),
  );

  await waitFor(() => assert.equal(result.current.slashCommandsCount, 2));
  return { result, setInputCalls, executedCommands };
};

const typeSlashText = (result: { current: ReturnType<typeof useSlashCommands> }, text: string) => {
  act(() => {
    result.current.handleCommandInputChange(text, text.length);
  });
};

beforeEach(() => {
  localStorage.clear();
  // `/deploy` is the project's most-used command, so it heads the unfiltered menu.
  localStorage.setItem('command_history_triage-repo', JSON.stringify({ '/deploy': 12 }));
  listCommands.mockReset();
  listSkills.mockReset();
  listCommands.mockResolvedValue(jsonResponse({ builtIn: [], custom: [command('/deploy'), command('/review')] }));
  listSkills.mockResolvedValue(jsonResponse({ success: true, data: { skills: [] } }));
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('slash command menu keys inside the filter debounce', () => {
  it('runs the command that was typed, not the first entry of the unfiltered menu', async () => {
    const { result, executedCommands } = await setUp();

    typeSlashText(result, '/review');
    // No time has passed: the menu still lists everything, `/deploy` first.
    assert.equal(result.current.filteredCommands[0]?.name, '/deploy');

    let handled = false;
    act(() => {
      handled = result.current.handleCommandMenuKeyDown(keyEvent('Enter'));
    });

    assert.equal(handled, true);
    assert.deepEqual(executedCommands.map((picked) => picked.name), ['/review']);
  });

  it('completes the typed command on Tab inside the debounce', async () => {
    const { result, setInputCalls, executedCommands } = await setUp();

    typeSlashText(result, '/rev');
    act(() => {
      result.current.handleCommandMenuKeyDown(keyEvent('Tab'));
    });

    assert.deepEqual(setInputCalls, ['/review ']);
    assert.deepEqual(executedCommands, []);
  });

  it('leaves Enter to the composer when nothing typed so far matches a command', async () => {
    const { result, executedCommands } = await setUp();

    typeSlashText(result, '/zzz');
    let handled = true;
    act(() => {
      handled = result.current.handleCommandMenuKeyDown(keyEvent('Enter'));
    });

    assert.equal(handled, false);
    assert.deepEqual(executedCommands, []);
  });

  it('still acts on the highlighted entry once the user has arrowed through the settled menu', async () => {
    const { result, executedCommands } = await setUp();

    typeSlashText(result, '/');
    await waitFor(() => assert.equal(result.current.commandQuery, ''));
    act(() => {
      result.current.handleCommandMenuKeyDown(keyEvent('ArrowDown'));
    });
    act(() => {
      result.current.handleCommandMenuKeyDown(keyEvent('ArrowDown'));
    });
    act(() => {
      result.current.handleCommandMenuKeyDown(keyEvent('Enter'));
    });

    assert.deepEqual(executedCommands.map((picked) => picked.name), ['/review']);
  });
});
