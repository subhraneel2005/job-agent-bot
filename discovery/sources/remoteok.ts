import { fetchJson, isoDate, stripHtml } from "../../utils/http";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type RemoteOkJob = {
  id?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  url?: string;
  apply_url?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  description?: string;
};

export const remoteOkSource: SourceAdapter = {
  name: "remoteok",
  label: "Remote OK",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const data = await fetchJson<RemoteOkJob[]>("https://remoteok.com/api", {}, 25_000);
    const jobs = Array.isArray(data) ? data.filter((j) => j && j.company && j.position) : [];

    const terms = ctx.profile.keywords.length ? ctx.profile.keywords : ["engineer"];
    const scored = jobs
      .map((job) => {
        const haystack = [job.position, job.company, ...(job.tags ?? [])].join(" ").toLowerCase();
        const hits = terms.filter((t) => haystack.includes(t.toLowerCase())).length;
        return { job, hits };
      })
      .sort((a, b) => b.hits - a.hits);

    const top = scored.filter((s) => s.hits > 0).length >= 5 ? scored.filter((s) => s.hits > 0) : scored;

    return top.slice(0, ctx.limit).map(({ job }) => {
      const signalDate = job.date
        ? (isoDate(job.date) ?? undefined)
        : job.epoch
          ? (isoDate(new Date(job.epoch * 1000)) ?? undefined)
          : undefined;
      const salary =
        job.salary_min && job.salary_max
          ? ` · $${Math.round(job.salary_min / 1000)}k-$${Math.round(job.salary_max / 1000)}k`
          : "";
      return {
        company: job.company!,
        role: job.position!,
        url: job.url ?? job.apply_url ?? "https://remoteok.com",
        source: "remoteok",
        hiring: true,
        why: `Remote role${salary}`,
        location: job.location,
        tags: job.tags,
        signalDate,
        raw: {
          tags: job.tags,
          salary: salary.replace(/^ · /, ""),
          description: job.description ? stripHtml(job.description).slice(0, 500) : undefined,
        },
      };
    });
  },
};
