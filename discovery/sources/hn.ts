import { fetchJson, isoDate, stripHtml } from "../../utils/http";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type AlgoliaStory = {
  objectID: string;
  title: string;
  created_at: string;
};

type AlgoliaItem = {
  id: number;
  created_at: string;
  children?: AlgoliaChild[];
};

type AlgoliaChild = {
  id: number;
  created_at: string;
  text?: string;
  author?: string;
};

export const hackerNewsSource: SourceAdapter = {
  name: "hackernews",
  label: "Hacker News",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const search = await fetchJson<{ hits: AlgoliaStory[] }>(
      "https://hn.algolia.com/api/v1/search_by_date?query=Ask%20HN%3A%20Who%20is%20hiring&tags=story&hitsPerPage=8"
    );
    const story = search.hits.find((h) => /who is hiring/i.test(h.title));
    if (!story) return [];

    const thread = await fetchJson<AlgoliaItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
    const children = (thread.children ?? []).filter((c) => c.text && c.text.length > 20);
    const out: RawOpportunity[] = [];
    const threadDate = isoDate(thread.created_at) ?? isoDate(new Date()) ?? undefined;

    for (const child of children) {
      if (out.length >= ctx.limit) break;
      const text = stripHtml(child.text ?? "");
      if (!text) continue;
      const firstLine = text.split("\n")[0] ?? "";
      const parts = firstLine.split("|").map((p) => p.trim());
      const company = (parts[0] ?? "").replace(/\(.*?\)/g, "").trim();
      if (!company || company.length < 2 || company.length > 60) continue;

      const role = (parts[1] ?? "").trim() || "various";
      const location = (parts[2] ?? "").trim();
      const remote = /remote/i.test(firstLine);

      out.push({
        company,
        role: role.slice(0, 90),
        url: `https://news.ycombinator.com/item?id=${child.id}`,
        source: "hackernews",
        hiring: true,
        why: `HN Who is hiring${remote ? " · remote" : location ? ` · ${location}` : ""}`,
        location: location || undefined,
        signalDate: isoDate(child.created_at) ?? threadDate,
        raw: { author: child.author, created_at: child.created_at, excerpt: text.slice(0, 500) },
      });
    }
    return out;
  },
};
