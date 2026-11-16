import { chatText } from "../ai/client";
import { config } from "../config";
import { feedbackCounts, listFacts, updateOpportunityScore, type Opportunity } from "../memory/db";
import { recall } from "../memory/rag";
import { daysAgo } from "../utils/http";
import { getUserSearchProfile } from "../discovery/profile";
import type { ProgressReporter } from "../telegram/progress";

export type ScoredOpportunity = { opportunity: Opportunity; score: number; rationale: string };

function rawOf(opp: Opportunity): Record<string, unknown> {
  if (!opp.raw) return {};
  try {
    return JSON.parse(opp.raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function oppHaystack(opp: Opportunity): string {
  const raw = rawOf(opp);
  const extras = [
    raw.description,
    raw.oneLiner,
    raw.excerpt,
    raw.description,
    Array.isArray(raw.tags) ? raw.tags.join(" ") : undefined,
    Array.isArray(raw.industries) ? raw.industries.join(" ") : undefined,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  return [opp.company, opp.role, opp.stage, opp.funding_event, opp.why, extras].join(" ").toLowerCase();
}

const SOURCE_WEIGHT: Record<string, number> = {
  yc: 6,
  hackernews: 4,
  techcrunch: 4,
  producthunt: 3,
  remotive: 3,
  remoteok: 3,
  github: 1,
};

export function heuristicScore(chatId: number, opp: Opportunity): { score: number; rationale: string } {
  const profile = getUserSearchProfile(chatId);
  const haystack = oppHaystack(opp);
  const feedback = feedbackCounts(chatId);

  let score = 28;
  const reasons: string[] = [];

  const skillHits = profile.skills.filter((s) => haystack.includes(s.toLowerCase()));
  if (skillHits.length) {
    score += Math.min(skillHits.length * 7, 24);
    reasons.push(`skills match: ${skillHits.slice(0, 3).join(", ")}`);
  }

  const roleHits = profile.roles.filter((r) => haystack.includes(r.toLowerCase()));
  if (roleHits.length) {
    score += Math.min(roleHits.length * 8, 20);
    reasons.push(`role fit: ${roleHits.slice(0, 2).join(", ")}`);
  }

  const industryHits = profile.industries.filter((i) => haystack.includes(i.toLowerCase()));
  if (industryHits.length) {
    score += Math.min(industryHits.length * 5, 10);
    reasons.push(`industry: ${industryHits.slice(0, 2).join(", ")}`);
  }

  const excluded = profile.exclude.filter((e) => haystack.includes(e.toLowerCase()));
  if (excluded.length) {
    score -= 30;
    reasons.push(`matches dealbreaker: ${excluded.slice(0, 2).join(", ")}`);
  }

  if (opp.hiring) {
    score += 8;
    reasons.push("actively hiring");
  }
  if (opp.funding_event) {
    score += 10;
    reasons.push(opp.funding_event);
  }
  if (opp.launch_date) {
    score += 6;
    reasons.push("recent launch");
  }

  const recent = opp.signal_date ? daysAgo(opp.signal_date) : 30;
  if (recent <= 7) {
    score += 8;
    reasons.push("fresh signal");
  } else if (recent <= config.discovery.freshnessDays) {
    score += 4;
  }

  score += SOURCE_WEIGHT[opp.source] ?? 0;
  if (opp.status === "shortlisted") {
    score += 8;
    reasons.push("saved/watchlist");
  }
  score += Math.max(-8, Math.min(4, feedback.up - feedback.down));

  if (profile.locations.length) {
    const locationHit = profile.locations.some((l) => haystack.includes(l.toLowerCase()));
    if (locationHit) reasons.push("location match");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    rationale: reasons.length ? reasons.join(" · ") : "General relevance",
  };
}

type LlmScore = { id: number; score: number; rationale: string };

function parseScores(text: string): LlmScore[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[0]) as { scores?: unknown };
    if (!Array.isArray(data.scores)) return [];
    return data.scores
      .map((s) => {
        const rec = s as Record<string, unknown>;
        const id = Number(rec.id);
        const score = Number(rec.score);
        const rationale = typeof rec.rationale === "string" ? rec.rationale : "";
        if (!Number.isFinite(id) || !Number.isFinite(score)) return null;
        return { id, score: Math.max(0, Math.min(100, score)), rationale };
      })
      .filter((s): s is LlmScore => s !== null);
  } catch {
    return [];
  }
}

export async function scoreOpportunities(
  chatId: number,
  opportunities: Opportunity[],
  reporter?: ProgressReporter,
  useLlm = true
): Promise<ScoredOpportunity[]> {
  if (!opportunities.length) return [];

  const stepId = reporter?.addStep("Scoring fit against your profile…");
  const profile = getUserSearchProfile(chatId);
  const facts = listFacts(chatId)
    .slice(0, 20)
    .map((f) => `${f.kind}/${f.key}: ${f.value}`);
  const memories = recall(chatId, `${profile.summary} job preference fit`, 5).map((m) => m.text);

  const base = new Map<number, ScoredOpportunity>();
  for (const opp of opportunities) {
    const { score, rationale } = heuristicScore(chatId, opp);
    base.set(opp.id, { opportunity: opp, score, rationale });
  }

  if (useLlm && config.opencode.apiKey) {
    const top = [...base.values()].sort((a, b) => b.score - a.score).slice(0, 12);
    try {
      const list = top
        .map((s, i) => {
          const o = s.opportunity;
          return `${i + 1}. id=${o.id} | ${o.company} | ${o.role} | ${o.stage ?? "-"} | ${o.funding_event ?? "-"} | ${(o.why ?? "").slice(0, 180)}`;
        })
        .join("\n");

      const response = await chatText(
        [
          {
            role: "system",
            content:
              "You are a precise job-fit scorer. Score each opportunity 0-100 against the candidate's profile, preferences, and memories. Be skeptical: a job is only high-scoring if the candidate would realistically want it. Return ONLY JSON.",
          },
          {
            role: "user",
            content: `CANDIDATE PROFILE\n${profile.summary}\n\nFACTS\n${facts.join("\n")}\n\nRELEVANT MEMORIES\n${memories.join("\n")}\n\nOPPORTUNITIES\n${list}\n\nReturn JSON: {"scores":[{"id":<id>,"score":<0-100>,"rationale":"<=20 words"}]}`,
          },
        ],
        { json: true, temperature: 0.2, maxTokens: 2500, session: `scoring-${chatId}` }
      );

      for (const s of parseScores(response)) {
        const existing = base.get(s.id);
        if (existing) {
          existing.score = s.score;
          existing.rationale = s.rationale || existing.rationale;
        }
      }
      reporter?.note(`Scored ${top.length} candidates with AI`);
    } catch {
      reporter?.note("AI scoring unavailable — using heuristic ranking");
    }
  }

  const scored = [...base.values()].sort((a, b) => b.score - a.score);
  for (const s of scored) {
    updateOpportunityScore(chatId, s.opportunity.id, s.score, s.rationale);
  }
  if (stepId !== undefined) reporter?.completeStep(stepId, `${scored.length} scored`);
  return scored;
}
