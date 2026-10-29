import { signal } from '@preact/signals';
import { Button, Dialog } from './common';

interface Ask {
  title: string;
  text: string;
  ok: string;
  resolve: (v: boolean) => void;
}

const ask = signal<Ask | null>(null);

export function confirmAsk(title: string, text: string, ok: string): Promise<boolean> {
  ask.value?.resolve(false);
  return new Promise((resolve) => {
    ask.value = { title, text, ok, resolve };
  });
}

function close(v: boolean): void {
  const a = ask.value;
  ask.value = null;
  a?.resolve(v);
}

export function ConfirmHost() {
  const a = ask.value;
  return (
    <Dialog
      open={a !== null}
      title={a?.title ?? ''}
      onClose={() => close(false)}
      actions={
        <>
          <Button onClick={() => close(false)}>Отмена</Button>
          <Button variant="primary" onClick={() => close(true)}>
            {a?.ok ?? 'Да'}
          </Button>
        </>
      }
    >
      {a?.text}
    </Dialog>
  );
}
