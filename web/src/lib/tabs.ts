import { signal } from '@preact/signals';
import { uuid } from './random';

export const passive = signal(false);

type Msg = { t: 'hello'; id: string } | { t: 'here'; id: string } | { t: 'claim'; id: string };

const me = uuid();
const TAKEOVER = 'mahiear.takeover';
let channel: BroadcastChannel | null = null;
let onPassive: () => void = () => undefined;

export function initTabs(becamePassive: () => void): Promise<void> {
  onPassive = becamePassive;
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve();
  channel = new BroadcastChannel('mahiear');
  channel.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    if (!m || m.id === me) return;
    if (m.t === 'hello' && !passive.value) post({ t: 'here', id: me });
    if (m.t === 'claim' && !passive.value) {
      passive.value = true;
      onPassive();
    }
  };
  let forced = false;
  try {
    forced = sessionStorage.getItem(TAKEOVER) === '1';
    sessionStorage.removeItem(TAKEOVER);
  } catch {
    forced = false;
  }
  if (forced) {
    post({ t: 'claim', id: me });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const answer = (ev: MessageEvent<Msg>) => {
      if (ev.data?.t === 'here' && ev.data.id !== me) passive.value = true;
    };
    channel!.addEventListener('message', answer);
    post({ t: 'hello', id: me });
    setTimeout(() => {
      channel?.removeEventListener('message', answer);
      resolve();
    }, 250);
  });
}

function post(m: Msg): void {
  try {
    channel?.postMessage(m);
  } catch {
    return;
  }
}

export function takeOver(): void {
  try {
    sessionStorage.setItem(TAKEOVER, '1');
  } catch {
    post({ t: 'claim', id: me });
  }
  location.reload();
}
