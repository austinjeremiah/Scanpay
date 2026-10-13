'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { localCurrency } from './format';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** USD -> local fiat for display. `preferred` = invoice.fiat.currency when present. */
export function useFx(preferred?: string | null) {
  const [local, setLocal] = useState('USD');
  useEffect(() => setLocal(localCurrency()), []);
  const currency = preferred ?? local;
  const q = useQuery({
    queryKey: ['fx', currency],
    queryFn: () => api.fx(currency),
    staleTime: 10 * 60_000,
    enabled: currency !== 'USD',
    retry: 1,
  });
  return { currency, rate: currency === 'USD' ? 1 : q.data?.rate ?? null };
}

export const vibrate = (pattern: number | number[] = 60) => {
  try {
    navigator.vibrate?.(pattern);
  } catch { /* ignore */ }
};

/** true once mounted in the browser (avoids SSR/localStorage mismatches). */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}
