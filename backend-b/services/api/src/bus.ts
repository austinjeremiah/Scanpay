import { EventEmitter } from 'node:events';
import type { SseEvent } from '@scanpay/shared';

const emitter = new EventEmitter();
emitter.setMaxListeners(1000);

export const channel = {
  merchant: (chainId: number, merchantId: string) => `merchant:${chainId}:${merchantId.toLowerCase()}`,
  intent: (chainId: number, intentId: string) => `intent:${chainId}:${intentId.toLowerCase()}`,
  invoice: (shortCode: string) => `invoice:${shortCode}`,
  request: (requestId: string) => `request:${requestId}`,
};

export function publish(ch: string, ev: SseEvent) {
  emitter.emit(ch, ev);
}

export function subscribe(ch: string, fn: (ev: SseEvent) => void): () => void {
  emitter.on(ch, fn);
  return () => emitter.off(ch, fn);
}
