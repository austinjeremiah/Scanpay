import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function shortCode(len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
