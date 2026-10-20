import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import CompactButton from '@/modules/chat/composer/CompactButton';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

/**
 * The context meter says how full the window is, not only how many tokens are
 * in it, and the button beside it compacts the conversation when it is filling
 * up (see composerCompact.test.ts for what pressing it sends).
 */

test('the meter shows how much of the context window is used', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 50_000, total: 200_000 }} />);

  assert.match(container.textContent ?? '', /25%/);
});

test('the meter shows no percentage for a running total, which is not the context in use', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 900_000, total: 200_000 }} measuresContext={false} />);

  assert.doesNotMatch(container.textContent ?? '', /%/);
});

test('the meter shows no percentage when the window is unknown', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 50_000 }} />);

  assert.doesNotMatch(container.textContent ?? '', /%/);
});

test('the meter caps the percentage at 100 for a window that was exceeded before compaction', () => {
  const { container } = render(<TokenUsageSummary usage={{ used: 300_000, total: 200_000 }} />);

  assert.match(container.textContent ?? '', /100%/);
});

test('the compact button compacts when pressed', () => {
  const onCompact = vi.fn();
  const { getByRole } = render(<CompactButton onCompact={onCompact} disabled={false} />);

  fireEvent.click(getByRole('button', { name: /compact/i }));

  // With no arguments: the handler takes optional instructions, and the click
  // event was once passed through as them, which threw before anything was sent.
  assert.deepEqual(onCompact.mock.calls, [[]]);
});

test('the compact button does nothing while a response is running', () => {
  const onCompact = vi.fn();
  const { getByRole } = render(<CompactButton onCompact={onCompact} disabled />);

  const button = getByRole('button', { name: /compact/i }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  fireEvent.click(button);
  assert.equal(onCompact.mock.calls.length, 0);
});
