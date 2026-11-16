import type { Opportunity } from "../memory/db";
import { absoluteUrl, domainFromUrl, extractEmails, fetchText, stripHtml } from "../utils/http";

export type CareerPageResult = {
  page: string;
  jobs: { title: string; url: string }[];
  emails: string[];
};

function baseUrl(opp: Opportunity): string | null {
  if (opp.raw) {
    try {
      const raw = JSON.parse(opp.raw) as Record<string, unknown>;
      for (const key of ["website", "url"]) {
        if (typeof raw[key] === "string" && /^https?:\/\//.test(raw[key] as string)) {
          return raw[key] as string;
        }
      }
    } catch {
    }
  }
  if (/^https?:\/\//.test(opp.url)) {
    const domain = domainFromUrl(opp.url);
    if (domain && !/news\.ycombinator|remoteok|remotive|github|techcrunch|producthunt/.test(domain)) {
      return `https://${domain}`;
    }
  }
  return null;
}

function titleFromAnchor(html: string, href: string): string {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<a[^>]+href=["']${escaped}["'][^>]*>([\\s\\S]*?)</a>`, "i");
  const match = html.match(re);
  if (match?.[1]) {
    const text = stripHtml(match[1])
      .replace(/apply for (this )?position/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 3 && text.length < 120) return text;
  }
  try {
    const path = new URL(href).pathname;
    const last = path.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Open role";
  }
}

export async function scanCareerPage(opp: Opportunity): Promise<CareerPageResult | null> {
  const base = baseUrl(opp);
  if (!base) return null;

  const candidates = [`${base.replace(/\/+$/, "")}/careers`, `${base.replace(/\/+$/, "")}/jobs`, base];
  for (const page of candidates) {
    let html: string;
    try {
      html = await fetchText(page, {}, 12_000);
    } catch {
      continue;
    }

    const jobs: { title: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
      const href = match[1] ?? "";
      const full = absoluteUrl(page, href);
      if (!full) continue;
      if (!/job|career|position|opening|role|apply/i.test(full)) continue;
      if (full === page || seen.has(full)) continue;
      try {
        const path = new URL(full).pathname.toLowerCase().replace(/\/+$/, "");
        if (/^\/(careers?|jobs?|openings?|positions?|work-with-us|join-us)$/.test(path)) continue;
      } catch {
        continue;
      }
      const title = titleFromAnchor(html, href);
      if (/^(careers?|jobs?|open roles?|openings?|join us|work with us)$/i.test(title)) continue;
      seen.add(full);
      jobs.push({ title, url: full });
      if (jobs.length >= 12) break;
    }

    const emails = extractEmails(`${html}\n${stripHtml(html)}`);
    if (jobs.length || emails.length) return { page, jobs, emails };
  }
  return null;
}
