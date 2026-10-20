import { memo } from 'react';
import { FoldVerticalIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';

type CompactButtonProps = {
  onCompact: () => void;
  /** True while a response is running: the compaction would only wait behind it. */
  disabled: boolean;
};

/**
 * Rendered by chat's ChatComposer beside the context meter, for providers
 * whose runtime can compact (the capability matrix says which). Summarizes the
 * conversation to free up context; the same thing `/compact` does.
 */
function CompactButton({ onCompact, disabled }: CompactButtonProps) {
  const { t } = useTranslation('chat');
  const label = t('input.compact.label', { defaultValue: 'Compact' });

  return (
    <PromptInputButton
      tooltip={{ content: t('input.compact.tooltip', { defaultValue: 'Summarize the conversation to free up context' }) }}
      aria-label={label}
      onClick={onCompact}
      disabled={disabled}
    >
      <FoldVerticalIcon />
    </PromptInputButton>
  );
}

export default memo(CompactButton);
