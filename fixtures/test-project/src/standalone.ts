export function validateZipCode(zip: string): boolean {
  const zipRegex = /^\d{5}(-\d{4})?$/;
  return zipRegex.test(zip.trim());
}

export function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `hash_${Math.abs(hash)}`;
}

export function parseQueryString(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  const clean = query.startsWith('?') ? query.slice(1) : query;
  if (!clean) return result;

  const pairs = clean.split('&');
  for (const pair of pairs) {
    const [key, val] = pair.split('=');
    if (key) {
      result[decodeURIComponent(key)] = decodeURIComponent(val || '');
    }
  }
  return result;
}
