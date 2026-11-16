import { fetchJson, isoDate } from "../../utils/http";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type GhRepo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  created_at: string;
  pushed_at: string;
  stargazers_count: number;
  topics?: string[];
  owner: { login: string; type: string };
};

export const githubSource: SourceAdapter = {
  name: "github",
  label: "GitHub",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const since = isoDate(new Date(Date.now() - ctx.freshnessDays * 86_400_000)) ?? "2026-01-01";
    const keyword = ctx.profile.keywords[0] ?? "engineer";
    const q = `${keyword} hiring in:readme pushed:>=${since}`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(ctx.limit, 30)}`;

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const data = await fetchJson<{ items?: GhRepo[] }>(url, { headers });
    const repos = data.items ?? [];

    return repos
      .filter((repo) => repo.owner.type === "Organization" || repo.owner.type === "User")
      .slice(0, ctx.limit)
      .map((repo) => ({
        company: repo.owner.login,
        role: "engineering (repo signal)",
        url: repo.html_url,
        source: "github",
        hiring: /hiring|we're hiring|join us/i.test(`${repo.description ?? ""}`),
        why: `Active repo${repo.stargazers_count > 20 ? ` · ★${repo.stargazers_count}` : ""}`,
        signalDate: isoDate(repo.pushed_at) ?? undefined,
        tags: repo.topics,
        raw: {
          repo: repo.full_name,
          description: repo.description,
          stars: repo.stargazers_count,
          created_at: repo.created_at,
        },
      }));
  },
};
