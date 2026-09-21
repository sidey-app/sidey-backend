// PostgREST's documented stages, in milliseconds. Never retain descriptions or
// unknown metrics: https://postgrest.org/en/stable/references/observability.html#server-timing-header
const stages = new Set(['jwt', 'parse', 'plan', 'transaction', 'response']);

export function parsePostgrestServerTiming(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x09\x20-\x7e]/.test(value)) return {};
  const parts = []; let start = 0, quoted = false, escaped = false;
  // Do not interpret commas inside an unknown metric's quoted description as
  // additional stages. Malformed quoted headers yield no measurements.
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (c === ',' && !quoted) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted || escaped) return {};
  parts.push(value.slice(start)); if (parts.length > 32) return {};
  const result = {}, seen = new Set();
  for (const part of parts) {
    const name = /^\s*([A-Za-z]+)\s*(?:;|$)/.exec(part)?.[1]?.toLowerCase();
    if (!stages.has(name)) continue;
    if (seen.has(name)) { delete result[name]; continue; }
    seen.add(name);
    // Accept the canonical PostgREST format only, without arbitrary parameters.
    const duration = /^\s*[A-Za-z]+\s*;\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/i.exec(part)?.[1];
    if (!duration || duration.length > 16) continue;
    const number = Number(duration);
    if (Number.isFinite(number) && number >= 0 && number <= 120000) result[name] = number;
  }
  return result;
}
