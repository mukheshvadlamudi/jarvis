import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz';

/** Short, URL-safe, sortable-enough id with a type prefix, e.g. `t_k3m9x2qa`. */
export function newId(prefix: string, length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug || 'task';
  const cut = slug.slice(0, max + 1);
  const at = cut.lastIndexOf('-');
  return (at > max * 0.5 ? cut.slice(0, at) : slug.slice(0, max)).replace(/-+$/g, '') || 'task';
}
