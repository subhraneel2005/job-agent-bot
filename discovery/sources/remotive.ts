import { fetchJson, isoDate, stripHtml } from "../../utils/http";
import { queryForProfile } from "../profile";
import type { AdapterContext, RawOpportunity, SourceAdapter } from "../types";

type RemotiveJob = {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
};

export const remotiveSource: SourceAdapter = {
  name: "remotive",
  label: "Remotive",
  async discover(ctx: AdapterContext): Promise<RawOpportunity[]> {
    const query = queryForProfile(ctx.profile).split(" ").slice(0, 2).join(" ");
    const url = `https://remotive.com/api/remote-jobs?limit=${Math.min(ctx.limit * 2, 50)}${query ? `&search=${encodeURIComponent(query)}` : ""}`;
    const data = await fetchJson<{ jobs?: RemotiveJob[] }>(url);
    const jobs = data.jobs ?? [];

    return jobs.slice(0, ctx.limit).map((job) => ({
      company: job.company_name,
      role: job.title,
      url: job.url,
      source: "remotive",
      hiring: true,
      why: `Hiring remotely${job.salary ? ` · ${job.salary}` : ""}`,
      location: job.candidate_required_location,
      tags: job.tags,
      signalDate: isoDate(job.publication_date) ?? undefined,
      raw: {
        category: job.category,
        job_type: job.job_type,
        salary: job.salary,
        description: stripHtml(job.description).slice(0, 600),
      },
    }));
  },
};
