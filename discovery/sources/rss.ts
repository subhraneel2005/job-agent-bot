import { XMLParser } from "fast-xml-parser";
import { log } from "../../logger";
import { fetchText, isoDate, normalizeWhitespace, stripHtml } from "../../utils/http";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

export type FeedSpec = {
  name: string;
  label: string;
  url: string;
  kind: "funding" | "launch" | "news";
};

type FeedItem = Record<string, unknown>;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
    if (typeof obj["@_href"] === "string") return obj["@_href"];
  }
  return "";
}

function linkOf(item: FeedItem): string {
  const raw = item.link;
  if (Array.isArray(raw)) {
    const alternate = raw.find((l) => (l as Record<string, unknown>)?.["@_rel"] === "alternate");
    return text(alternate ?? raw[0]);
  }
  return text(raw);
}

function dateOf(item: FeedItem): string | undefined {
  for (const key of ["pubDate", "published", "updated", "dc:date", "date"]) {
    const value = text(item[key]);
    if (value) {
      const iso = isoDate(value);
      if (iso) return iso;
    }
  }
  return undefined;
}

function itemsOf(doc: Record<string, unknown>): FeedItem[] {
  const rss = doc.rss as { channel?: { item?: FeedItem | FeedItem[] } } | undefined;
  const rssItems = rss?.channel?.item;
  if (rssItems) return Array.isArray(rssItems) ? rssItems : [rssItems];

  const feed = doc.feed as { entry?: FeedItem | FeedItem[] } | undefined;
  const atomItems = feed?.entry;
  if (atomItems) return Array.isArray(atomItems) ? atomItems : [atomItems];

  const rdf = doc["rdf:RDF"] as { item?: FeedItem | FeedItem[] } | undefined;
  const rdfItems = rdf?.item;
  if (rdfItems) return Array.isArray(rdfItems) ? rdfItems : [rdfItems];

  return [];
}

function extractCompany(title: string, kind: FeedSpec["kind"]): string {
  const clean = normalizeWhitespace(title);
  const funding = clean.match(/^(.{2,60}?)\s+(?:raises?|raised|lands?|secures?|closes?|closes?|nabs?|picks up|announces|scores?)\b/i);
  if (funding?.[1]) return funding[1].replace(/[,:\-–—]$/, "").trim();
  if (kind === "launch") {
    const launch = clean.match(/^(.{2,60}?)\s+[–—-]\s+/);
    if (launch?.[1]) return launch[1].trim();
  }
  const first = clean.split(/[:\-–—|]/)[0] ?? clean;
  return first.slice(0, 50).trim();
}

function signalOf(title: string, kind: FeedSpec["kind"]) {
  const funding = title.match(
    /((?:raises?|raised|secures?|closes?|lands?|nabs?)\s+(?:an?\s+)?(?:\$|€|£)?[\d.,]+\s*(?:m|bn|b|million|billion)?(?:\s+[a-z\-]+)?(?:\s+(?:seed|series\s+[a-d]|pre-seed|round))?)/i
  );
  const launch = /launch|introduc|unveil|debut|ships?/i.test(title);
  const hiring = /hiring|jobs|join our team|careers/i.test(title);
  return {
    fundingEvent: funding?.[1]?.trim(),
    launch: kind === "launch" || launch,
    hiring,
  };
}

export function createRssSource(feeds: FeedSpec[]): SourceAdapter {
  return {
    name: "rss",
    label: "News & launches",
    async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
      const out: RawOpportunity[] = [];
      for (const feed of feeds) {
        if (out.length >= ctx.limit) break;
        try {
          const xml = await fetchText(feed.url, { headers: { Accept: "application/rss+xml, application/atom+xml, text/xml" } });
          const doc = parser.parse(xml) as Record<string, unknown>;
          const items = itemsOf(doc).slice(0, ctx.limit);

          for (const item of items) {
            if (out.length >= ctx.limit) break;
            const title = stripHtml(text(item.title));
            const url = linkOf(item);
            if (!title || !url) continue;

            const company = extractCompany(title, feed.kind);
            if (!company || company.length < 2) continue;

            const signals = signalOf(title, feed.kind);
            const description = stripHtml(text(item.description) || text(item.summary) || text(item.content));
            const signalDate = dateOf(item);

            out.push({
              company,
              role: "various",
              url,
              source: feed.name,
              stage: signals.fundingEvent?.match(/series\s+[a-d]|seed|pre-seed/i)?.[0],
              fundingEvent: signals.fundingEvent,
              fundingDate: signals.fundingEvent ? signalDate : undefined,
              launchDate: signals.launch ? signalDate : undefined,
              hiring: signals.hiring,
              why: title.slice(0, 160),
              signalDate,
              raw: {
                feed: feed.name,
                title,
                excerpt: description.slice(0, 500),
              },
            });
          }
        } catch (error) {
          log.warn("rss.feed_failed", { feed: feed.name, error: String(error) });
        }
      }
      return out.filter((o) => !o.company.startsWith("__feed_error__"));
    },
  };
}
