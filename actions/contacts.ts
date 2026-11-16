import type { Opportunity } from "../memory/db";
import { domainFromUrl, extractEmails, fetchText, stripHtml } from "../utils/http";

export type Contact = {
  email: string;
  name?: string;
  role?: string;
  confidence: number;
  source: string;
};

function websiteOf(opp: Opportunity): string | null {
  if (!opp.raw) return null;
  try {
    const raw = JSON.parse(opp.raw) as Record<string, unknown>;
    for (const key of ["website", "url", "apply_url"]) {
      if (typeof raw[key] === "string" && /^https?:\/\//.test(raw[key] as string)) {
        return raw[key] as string;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function guessEmails(domain: string): Contact[] {
  const prefixes = ["careers", "jobs", "hiring", "hello", "founders", "team", "talent"];
  return prefixes.map((prefix, i) => ({
    email: `${prefix}@${domain}`,
    confidence: Math.max(0.15, 0.4 - i * 0.04),
    source: "pattern",
  }));
}

export async function findContacts(opp: Opportunity): Promise<Contact[]> {
  const results: Contact[] = [];
  const pages = new Set<string>();
  const website = websiteOf(opp);
  if (website) pages.add(website);
  if (/^https?:\/\//.test(opp.url) && !/news\.ycombinator|remoteok|remotive/.test(opp.url)) {
    pages.add(opp.url);
  }

  for (const page of pages) {
    try {
      const html = await fetchText(page, {}, 12_000);
      const visible = stripHtml(html);
      for (const email of extractEmails(`${html}\n${visible}`)) {
        results.push({ email, confidence: 0.8, source: page });
      }
      const mailto = [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => m[1]!.toLowerCase());
      for (const email of mailto) {
        if (email.includes("@")) results.push({ email, confidence: 0.9, source: `${page} (mailto)` });
      }
    } catch {
    }
  }

  const domain = domainFromUrl(website ?? opp.url);
  if (domain && !/news\.ycombinator|remoteok|remotive|github/.test(domain)) {
    results.push(...guessEmails(domain));
  }

  const deduped = new Map<string, Contact>();
  for (const contact of results) {
    const key = contact.email.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || existing.confidence < contact.confidence) deduped.set(key, contact);
  }

  return [...deduped.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

export function contactLine(contact: Contact): string {
  const bits = [contact.email];
  if (contact.name) bits.push(contact.name);
  bits.push(`${Math.round(contact.confidence * 100)}%`);
  return bits.join(" · ");
}
