'use client';
import { useEffect, useRef } from 'react';
import type { SseEvent } from './shared';
import { ENV } from './env';

const TYPES = ['intent.updated', 'payment.settled', 'invoice.updated', 'invoice_request.created', 'merchant.updated'] as const;

/** Subscribe to one API stream path, e.g. `/v1/intents/10143/0x…/stream`. Pass null to disconnect. */
export function useSse(path: string | null, onEvent: (ev: SseEvent) => void, onReconnect?: () => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const re = useRef(onReconnect);
  re.current = onReconnect;
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(`${ENV.API_URL}${path}`);
    const handler = (type: string) => (m: MessageEvent) => {
      try {
        const data = JSON.parse(m.data);
        cb.current({ type, ...data } as SseEvent);
      } catch { /* ignore malformed frame */ }
    };
    TYPES.forEach((t) => es.addEventListener(t, handler(t) as EventListener));
    es.onopen = () => re.current?.(); // resync via REST after (re)connect
    return () => es.close();
  }, [path]);
}
