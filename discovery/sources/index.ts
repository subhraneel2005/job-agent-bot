import { config } from "../../config";
import { domainFromUrl } from "../../utils/http";
import type { SourceAdapter } from "../types";
import { createRssSource, type FeedSpec } from "./rss";
import { githubSource } from "./github";
import { hackerNewsSource } from "./hn";
import { remotiveSource } from "./remotive";
import { remoteOkSource } from "./remoteok";
import { ycSource } from "./yc";
import { webSearchSource } from "./web";

export const DEFAULT_FEEDS: FeedSpec[] = [
  { name: "techcrunch", label: "TechCrunch", url: "https://techcrunch.com/feed/", kind: "funding" },
  { name: "crunchbase", label: "Crunchbase News", url: "https://news.crunchbase.com/feed/", kind: "funding" },
  { name: "producthunt", label: "Product Hunt", url: "https://www.producthunt.com/feed", kind: "launch" },
  { name: "hnrss", label: "HN hiring RSS", url: "https://hnrss.org/newest?q=hiring", kind: "news" },
];

function extraFeeds(): FeedSpec[] {
  return config.discovery.webSearchRss.map((url, i) => ({
    name: `rss${i + 1}`,
    label: domainFromUrl(url) ?? `RSS ${i + 1}`,
    url,
    kind: "news" as const,
  }));
}

export function allFeeds(): FeedSpec[] {
  return [...DEFAULT_FEEDS, ...extraFeeds()];
}

const baseAdapters: SourceAdapter[] = [
  ycSource,
  hackerNewsSource,
  remotiveSource,
  remoteOkSource,
  githubSource,
  webSearchSource,
];

export const SOURCE_CATALOG: { name: string; label: string; kind: "source" | "feed" }[] = [
  ...baseAdapters.map((a) => ({ name: a.name, label: a.label, kind: "source" as const })),
  ...allFeeds().map((f) => ({ name: f.name, label: f.label, kind: "feed" as const })),
];

export function getAdapters(selected: string[] = config.discovery.sources): SourceAdapter[] {
  const want = selected.length ? new Set(selected) : null;
  const adapters = baseAdapters.filter((a) => !want || want.has(a.name));
  const feeds = allFeeds().filter((f) => !want || want.has("rss") || want.has(f.name));
  if (feeds.length) adapters.push(createRssSource(feeds));
  return adapters;
}

export function selectedSourceNames(selected: string[] = config.discovery.sources): string[] {
  if (!selected.length) return SOURCE_CATALOG.map((s) => s.name);
  return SOURCE_CATALOG.filter((s) => selected.includes(s.name) || (s.kind === "feed" && selected.includes("rss"))).map(
    (s) => s.name
  );
}
