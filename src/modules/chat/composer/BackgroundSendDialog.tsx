import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { BackgroundSendChoice, BackgroundSendPrompt } from '@/shared/types';

type BackgroundSendDialogProps = {
  prompt: BackgroundSendPrompt | null;
  onResolve: (choice: BackgroundSendChoice) => void;
};

/**
 * Rendered by chat's ChatComposer when an edit of an earlier message is sent to
 * a session whose background work is still running. The edit replaces the
 * process that work runs in, which stops it, so the choices are to send the
 * edit anyway or cancel (and edit once the work finishes). An ordinary message
 * never asks: it goes to that process and the work keeps running.
 *
 * Cancel comes first in the DOM so Dialog's open-focus lands on it: an Enter
 * pressed right after the send that opened the prompt (a double Enter, a key
 * repeat) cancels instead of stopping the work. Esc and a click outside also
 * cancel. Sending anyway takes a deliberate click or Tab.
 */
export default function BackgroundSendDialog({ prompt, onResolve }: BackgroundSendDialogProps) {
  const { t } = useTranslation('chat');

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          onResolve('cancel');
        }
      }}
    >
      <DialogContent aria-describedby="background-send-dialog-description" className="p-5">
        <DialogTitle className="not-sr-only text-base font-semibold text-foreground">
          {t('claudeStatus.backgroundTask.prompt.title', {
            defaultValue: 'This session still has background work running',
          })}
        </DialogTitle>

        {prompt && prompt.work.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground/90">
            {prompt.work.map((item, index) => (
              <li key={`${index}-${item}`} className="break-words">{item}</li>
            ))}
          </ul>
        )}

        <p id="background-send-dialog-description" className="mt-3 text-sm text-muted-foreground">
          {t('claudeStatus.backgroundTask.prompt.description', {
            defaultValue: 'Editing a message replaces the conversation from that point and stops that work; anything it has not reported yet is lost. To keep it, cancel and edit once the work finishes.',
          })}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onResolve('cancel')}>
            {t('claudeStatus.backgroundTask.prompt.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="button" variant="destructive" onClick={() => onResolve('send')}>
            {t('claudeStatus.backgroundTask.prompt.sendAnyway', { defaultValue: 'Send anyway' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
