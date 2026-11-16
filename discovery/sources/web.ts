import { XMLParser } from "fast-xml-parser";
import { decodeEntities, isoDate, normalizeWhitespace, stripHtml } from "../../utils/http";
import { queryForProfile } from "../profile";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type NewsItem = {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object" && typeof (value as Record<string, unknown>)["#text"] === "string") {
    return (value as Record<string, string>)["#text"]!;
  }
  return "";
}

function itemsOf(xml: string): NewsItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: NewsItem | NewsItem[] } } };
  const raw = doc.rss?.channel?.item;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function resolveBingUrl(link: string): string | null {
  try {
    const normalized = link.replaceAll("&amp;", "&");
    const url = new URL(normalized);
    const target = url.searchParams.get("url");
    if (target) return decodeURIComponent(target);
    return normalized;
  } catch {
    return null;
  }
}

const BAD_PREFIX =
  /startups?|companies|list|report|top \d+|best |funded|vc|investors|roundup|daily roundup|engineer|founder|investor|firm|company/i;
const SIGNAL = /(raises?|raised|lands?|secures?|closes?|nabs?|picks up|announces|launches?|introduc(es|ing)|is hiring|now hiring|hiring)\b/i;

function extractSignal(title: string): {
  company: string;
  fundingEvent?: string;
  launch: boolean;
  hiring: boolean;
} | null {
  const companyPattern =
    String.raw`^([A-Z][\w.&'’-]*(?:\s+(?:[A-Z][\w.&'’-]*|on|of|the|and|for|in|to|at)){0,4})\s+(${SIGNAL.source})`;
  const match = title.match(new RegExp(companyPattern));
  if (!match?.[1]) return null;
  const company = match[1].replace(/[,:\-–—]$/, "").trim();
  if (BAD_PREFIX.test(company) || company.split(/\s+/).length > 5) return null;
  const verb = match[2] ?? "";
  const rest = title.slice(match[0].length);
  return {
    company,
    fundingEvent: /raise|raised|secures|closes|lands|round|seed|series/i.test(verb)
      ? normalizeWhitespace(`${verb}${rest}`).slice(0, 90)
      : undefined,
    launch: /launch|introduc/i.test(verb),
    hiring: /hiring|jobs|careers/i.test(title),
  };
}

async function searchNews(query: string): Promise<NewsItem[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) throw new Error(`Bing News search failed (${res.status})`);
  return itemsOf(await res.text());
}

export const webSearchSource: SourceAdapter = {
  name: "web",
  label: "Web search",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const profileQuery = queryForProfile(ctx.profile).split(" ").slice(0, 3).join(" ");
    const focus = ctx.profile.industries[0] ?? ctx.profile.keywords[0] ?? profileQuery;
    const year = new Date().getFullYear();
    const queries = [
      `${focus} startup raises seed funding ${year}`,
      `${focus} startup raises series A ${year}`,
      `${focus} startup hiring engineers ${year}`,
    ];

    const items: NewsItem[] = [];
    for (const query of queries) {
      try {
        items.push(...(await searchNews(query)));
      } catch {
      }
    }
    if (!items.length) throw new Error("Web search returned no results");

    const out: RawOpportunity[] = [];
    const seen = new Set<string>();
    const seenCompany = new Set<string>();
    for (const item of items) {
      if (out.length >= ctx.limit) break;
      const title = stripHtml(decodeEntities(text(item.title)));
      const link = resolveBingUrl(text(item.link));
      if (!title || !link || seen.has(link)) continue;
      seen.add(link);

      const signal = extractSignal(title);
      if (!signal) continue;
      const companyKey = signal.company.toLowerCase();
      if (seenCompany.has(companyKey)) continue;
      seenCompany.add(companyKey);

      const signalDate = isoDate(text(item.pubDate)) ?? isoDate(new Date()) ?? undefined;
      out.push({
        company: signal.company,
        role: "various",
        url: link,
        source: "web",
        fundingEvent: signal.fundingEvent,
        launchDate: signal.launch ? signalDate : undefined,
        hiring: signal.hiring,
        why: title.slice(0, 160),
        signalDate,
        raw: {
          title,
          snippet: stripHtml(decodeEntities(text(item.description))).slice(0, 400),
          via: "bing-news",
        },
      });
    }
    return out;
  },
};
