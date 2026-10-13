'use client';

import { useEffect } from 'react';

/** Registers the (cache-free) service worker so both the landing page and the app are installable. */
export default function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
