import { describe, expect, it } from 'vitest';

import { visibleCountToReveal } from '@/modules/chat/hooks/useChatSessionState';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';

describe('visibleCountToReveal', () => {
  it('keeps the window when the row is already inside it', () => {
    // 942 rows, window of 100: row 900 has 42 rows after it, itself included.
    expect(visibleCountToReveal(942, 900, 100)).toBe(100);
  });

  it('widens the window to the row plus a page of context when it is not', () => {
    // Row 106 of 942 needs 836 rows shown; a page more gives it some context above.
    expect(visibleCountToReveal(942, 106, 100)).toBe(836 + SESSION_MESSAGES_PAGE_SIZE);
  });
});
