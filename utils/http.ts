const UA = "job-agent-bot/1.0 (+personal job search agent)";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
  attempts = 2
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/xml, application/xml, text/html;q=0.9, */*;q=0.8",
          ...(init.headers ?? {}),
        },
      });
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await Bun.sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<string> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return await res.text();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
  "#8217": "’",
  "#8216": "‘",
  "#8220": "“",
  "#8221": "”",
  "#8211": "–",
  "#8212": "—",
  "#8230": "…",
};

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    const mapped = ENTITIES[code] ?? ENTITIES[code.toLowerCase()];
    if (mapped) return mapped;
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const n = Number.parseInt(code.slice(2), 16);
      if (Number.isFinite(n)) return String.fromCodePoint(n);
    } else if (code.startsWith("#")) {
      const n = Number.parseInt(code.slice(1), 10);
      if (Number.isFinite(n)) return String.fromCodePoint(n);
    }
    return m;
  });
}

export function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function absoluteUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractEmails(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
  const ignore = /(example\.com|sentry\.io|wixpress|\.png|\.jpg|\.webp|\.svg)/i;
  return [...new Set(matches.map((m) => m.toLowerCase()))].filter((e) => !ignore.test(e)).slice(0, 10);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function daysAgo(date: Date | string): number {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return Number.POSITIVE_INFINITY;
  return (Date.now() - d.getTime()) / 86_400_000;
}

export function isoDate(date: Date | string): string | null {
  const d = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
