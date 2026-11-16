import { config } from "../config";
import { log } from "../logger";
import {
  getOpportunity,
  upsertOpportunity,
  type Opportunity,
} from "../memory/db";
import { daysAgo, isoDate } from "../utils/http";
import type { ProgressReporter } from "../telegram/progress";
import { getUserSearchProfile } from "./profile";
import { scoreOpportunities, type ScoredOpportunity } from "./score";
import { getAdapters } from "./sources";
import { scanCareerPage } from "../actions/careers";
import { runtimeSources } from "../runtime/settings";
import type { DiscoverySourceResult, RawOpportunity } from "./types";

export type DiscoveryResult = {
  scanned: number;
  inserted: number;
  duplicates: number;
  errors: string[];
  perSource: DiscoverySourceResult[];
  opportunities: Opportunity[];
  scored: ScoredOpportunity[];
};

function isFresh(opp: RawOpportunity, freshnessDays: number): boolean {
  if (!opp.signalDate) return true;
  return daysAgo(opp.signalDate) <= freshnessDays;
}

function hasWebsite(opp: Opportunity): boolean {
  if (!opp.raw) return false;
  try {
    const raw = JSON.parse(opp.raw) as Record<string, unknown>;
    return typeof raw.website === "string" && /^https?:\/\//.test(raw.website);
  } catch {
    return false;
  }
}

function titleFor(source: string): string {
  const labels: Record<string, string> = {
    yc: "Y Combinator",
    hackernews: "Hacker News",
    remotive: "Remotive",
    remoteok: "Remote OK",
    github: "GitHub",
    rss: "news & launches",
  };
  return labels[source] ?? source;
}

export async function runDiscovery(opts: {
  chatId: number;
  sources?: string[];
  reporter?: ProgressReporter;
  limit?: number;
  freshnessDays?: number;
  score?: boolean;
}): Promise<DiscoveryResult> {
  const profile = getUserSearchProfile(opts.chatId);
  const sourceNames = opts.sources ?? runtimeSources();
  const adapters = sourceNames.includes("__none__") ? [] : getAdapters(sourceNames);
  const freshnessDays = opts.freshnessDays ?? config.discovery.freshnessDays;
  const limit = opts.limit ?? config.discovery.maxPerSource;

  const perSource: DiscoverySourceResult[] = [];
  const errors: string[] = [];
  const gathered: RawOpportunity[] = [];
  const seen = new Set<string>();

  for (const adapter of adapters) {
    const stepId = opts.reporter?.addStep(`Searching ${adapter.label}…`);
    let count = 0;
    try {
      const found = await adapter.discover({ chatId: opts.chatId, profile, limit, freshnessDays });
      for (const opp of found) {
        if (!isFresh(opp, freshnessDays)) continue;
        const key = `${opp.company.toLowerCase()}|${(opp.role ?? "").toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        gathered.push(opp);
        count++;
      }
      perSource.push({ name: adapter.name, label: adapter.label, count });
      if (stepId !== undefined) opts.reporter?.completeStep(stepId, `${count} found`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      perSource.push({ name: adapter.name, label: adapter.label, count: 0, error: message });
      errors.push(`${adapter.label}: ${message}`);
      if (stepId !== undefined) opts.reporter?.failStep(stepId, "failed");
      log.warn("discovery.source_failed", { source: adapter.name, error: message });
    }
  }

  const opportunities: Opportunity[] = [];
  let duplicates = 0;
  for (const raw of gathered) {
    const result = upsertOpportunity(opts.chatId, {
      company: raw.company,
      role: raw.role,
      url: raw.url,
      source: raw.source,
      stage: raw.stage,
      fundingEvent: raw.fundingEvent,
      fundingDate: raw.fundingDate,
      launchDate: raw.launchDate,
      hiring: raw.hiring,
      why: raw.why,
      raw: raw.raw,
      signalDate: raw.signalDate,
    });
    if (!result) continue;
    if (!result.inserted) {
      duplicates++;
      continue;
    }
    const row = getOpportunity(opts.chatId, result.id);
    if (row) opportunities.push(row);
  }

  const careerCandidates = opportunities
    .filter((o) => o.role === "various" && hasWebsite(o))
    .slice(0, config.discovery.careerScanLimit);

  if (careerCandidates.length) {
    const stepId = opts.reporter?.addStep("Scanning company career pages…");
    const today = isoDate(new Date()) ?? undefined;
    const scans = await Promise.allSettled(
      careerCandidates.map(async (opp) => ({ opp, page: await scanCareerPage(opp) }))
    );
    let rolesFound = 0;
    for (const scan of scans) {
      if (scan.status !== "fulfilled" || !scan.value.page) continue;
      const { opp, page } = scan.value;
      for (const job of page.jobs.slice(0, 4)) {
        const result = upsertOpportunity(opts.chatId, {
          company: opp.company,
          role: job.title,
          url: job.url,
          source: "careers",
          stage: opp.stage ?? undefined,
          hiring: true,
          why: `Live role from ${opp.company}'s careers page`,
          signalDate: today,
          raw: { page: page.page, company: opp.company },
        });
        if (result?.inserted) {
          const row = getOpportunity(opts.chatId, result.id);
          if (row) {
            opportunities.push(row);
            rolesFound++;
          }
        }
      }
    }
    if (stepId !== undefined) opts.reporter?.completeStep(stepId, `${rolesFound} live roles`);
  }

  let scored: ScoredOpportunity[] = [];
  if (opts.score !== false) {
    scored = await scoreOpportunities(opts.chatId, opportunities, opts.reporter);
  }

  log.info("discovery.complete", {
    chatId: opts.chatId,
    scanned: gathered.length,
    inserted: opportunities.length,
    duplicates,
    errors: errors.length,
  });

  return {
    scanned: gathered.length,
    inserted: opportunities.length,
    duplicates,
    errors,
    perSource,
    opportunities,
    scored,
  };
}

export function sourceSummary(result: DiscoveryResult): string {
  return result.perSource
    .map((s) => `${s.error ? "[fail]" : "[ok]"} ${s.label}: ${s.count}`)
    .join(" · ");
}

export { titleFor };
