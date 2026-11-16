import { fetchJson, isoDate } from "../../utils/http";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type YcCompany = {
  id: number;
  name: string;
  slug: string;
  website: string;
  oneLiner: string;
  teamSize: number;
  url: string;
  batch: string;
  tags: string[];
  industries: string[];
  locations: string[];
  status: string;
};

type YcResponse = {
  companies: YcCompany[];
  page: number;
  totalPages: number;
};

function candidateBatches(now = new Date()): string[] {
  const y = now.getUTCFullYear();
  return [`F${y}`, `S${y}`, `W${y}`, `X${y - 1}`, `F${y - 1}`, `S${y - 1}`, `W${y - 1}`];
}

export const ycSource: SourceAdapter = {
  name: "yc",
  label: "Y Combinator",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const batches: { batch: string; companies: YcCompany[] }[] = [];
    for (const batch of candidateBatches()) {
      if (batches.length >= 3) break;
      try {
        const data = await fetchJson<YcResponse>(
          `https://api.ycombinator.com/v0.1/companies?batch=${batch}`
        );
        if (data.companies?.length) batches.push({ batch, companies: data.companies });
      } catch {
      }
    }

    const keywords = ctx.profile.keywords.map((k) => k.toLowerCase());
    const exclude = ctx.profile.exclude.map((k) => k.toLowerCase());
    const today = isoDate(new Date()) ?? undefined;

    const scored: { opp: RawOpportunity; hits: number }[] = [];
    for (const { batch, companies } of batches) {
      for (const c of companies) {
        if (c.status && c.status !== "Active") continue;
        const haystack = [c.name, c.oneLiner, ...(c.tags ?? []), ...(c.industries ?? [])]
          .join(" ")
          .toLowerCase();
        if (exclude.some((e) => haystack.includes(e))) continue;
        const hits = keywords.filter((k) => haystack.includes(k)).length;
        scored.push({
          hits,
          opp: {
            company: c.name,
            role: "various",
            url: `https://www.ycombinator.com/companies/${c.slug}/jobs`,
            source: "yc",
            stage: batch,
            launchDate: today,
            signalDate: today,
            hiring: true,
            why: `YC ${batch}${c.oneLiner ? ` · ${c.oneLiner}` : ""}`.slice(0, 160),
            location: c.locations?.[0],
            tags: c.tags,
            raw: {
              batch,
              oneLiner: c.oneLiner,
              teamSize: c.teamSize,
              website: c.website,
              industries: c.industries,
              locations: c.locations,
            },
          },
        });
      }
    }

    const withHits = scored.filter((s) => s.hits > 0);
    const pool = withHits.length >= Math.min(ctx.limit, 5) ? withHits : scored;
    return pool
      .sort((a, b) => b.hits - a.hits)
      .slice(0, ctx.limit)
      .map((s) => s.opp);
  },
};
