import type { ToolDefinition } from "../ai/client";
import { log } from "../logger";
import {
  addFact,
  addFeedback,
  addPipelineEvent,
  deleteFacts,
  getOpportunity,
  getProfile,
  getSetting,
  listFacts,
  listOpportunities,
  setOpportunityStatus,
  setProfile,
  type Opportunity,
} from "../memory/db";
import { ingestMemory, memoryStats, recall } from "../memory/rag";
import { runDiscovery } from "../discovery/pipeline";
import { digestEntries } from "../discovery/digest";
import { scoreOpportunities } from "../discovery/score";
import { schedulerState } from "../discovery/scheduler";
import { getUserSearchProfile } from "../discovery/profile";
import { findContacts, contactLine } from "../actions/contacts";
import { scanCareerPage } from "../actions/careers";
import { deliverOutreach, draftOutreach, formatDraft, type Channel } from "../actions/email";
import { draftFollowUps, pipelineText, dueFollowUps } from "../actions/pipeline";
import { isDryRun, runtimeMinFit, runtimeTopN } from "../runtime/settings";
import type { ProgressReporter } from "../telegram/progress";

export type ToolContext = {
  chatId: number;
  reporter: ProgressReporter;
  runId: string;
};

export type ToolResult = { content: string };

export type AgentTool = ToolDefinition & {
  label: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = Number(args[key]);
  return Number.isFinite(v) ? v : undefined;
}

function objArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function requireId(args: Record<string, unknown>): number {
  const id = numArg(args, "opportunityId") ?? numArg(args, "id");
  if (id === undefined) throw new Error("opportunityId is required");
  return id;
}

function formatOpportunity(o: Opportunity): string {
  const bits = [`#${o.id}`, o.company, `— ${o.role}`, o.score ? `· ${Math.round(o.score)}/100` : ""]
    .filter(Boolean)
    .join(" ");
  return `${bits}\n  ${o.funding_event ?? o.why ?? ""}\n  ${o.url}\n  status: ${o.status} · source: ${o.source}`;
}

const rememberFact: AgentTool = {
  type: "function",
  function: {
    name: "remember_fact",
    description:
      "Store a durable fact about the user (skill, preference, experience, constraint, goal, project, location, industry). Use this whenever the user reveals something that should shape future job searches.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "One of: preference, skill, experience, project, goal, constraint, location, industry, role, tone" },
        key: { type: "string", description: "Short label, e.g. 'remote', 'preferred_stack', 'dealbreaker'" },
        value: { type: "string", description: "The fact itself" },
      },
      required: ["kind", "key", "value"],
    },
  },
  label: () => "Saving to memory",
  async run(args, ctx) {
    const kind = str(args, "kind") ?? "preference";
    const key = str(args, "key") ?? "note";
    const value = str(args, "value");
    if (!value) throw new Error("value is required");
    addFact(ctx.chatId, kind, key, value, "telegram");
    ingestMemory(ctx.chatId, `fact:${kind}`, `${key}: ${value}`);
    return { content: `Saved ${kind}/${key}.` };
  },
};

const updateProfile: AgentTool = {
  type: "function",
  function: {
    name: "update_profile",
    description:
      "Merge structured profile fields (role, roles, skills, locations, industries, seniority, stage, remote, exclude, salary, name). Use for lasting preferences.",
    parameters: {
      type: "object",
      properties: {
        profile: { type: "object", description: "Key/value profile fields to merge" },
      },
      required: ["profile"],
    },
  },
  label: () => "Updating profile",
  async run(args, ctx) {
    const patch = objArg(args, "profile");
    if (!patch) throw new Error("profile object is required");
    const current = getProfile(ctx.chatId);
    const merged = { ...current, ...patch };
    setProfile(ctx.chatId, merged);
    ingestMemory(ctx.chatId, "profile", JSON.stringify(merged));
    return { content: `Profile updated: ${Object.keys(patch).join(", ")}` };
  },
};

const getProfileTool: AgentTool = {
  type: "function",
  function: {
    name: "get_profile",
    description: "Read the user's structured profile, saved facts, and the derived search profile.",
    parameters: { type: "object", properties: {} },
  },
  label: () => "Reading your profile",
  async run(_args, ctx) {
    const profile = getProfile(ctx.chatId);
    const facts = listFacts(ctx.chatId).slice(0, 30);
    const derived = getUserSearchProfile(ctx.chatId);
    return {
      content: [
        `Profile: ${JSON.stringify(profile)}`,
        `Derived: ${derived.summary || "(empty)"}`,
        `Facts:\n${facts.map((f) => `• [${f.kind}] ${f.key}: ${f.value}`).join("\n") || "(none)"}`,
      ].join("\n"),
    };
  },
};

const recallMemory: AgentTool = {
  type: "function",
  function: {
    name: "recall_memory",
    description: "Semantic search over the user's stored documents, notes, and conversation memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        k: { type: "number" },
      },
      required: ["query"],
    },
  },
  label: () => "Recalling memory",
  async run(args, ctx) {
    const query = str(args, "query");
    if (!query) throw new Error("query is required");
    const k = Math.min(numArg(args, "k") ?? 5, 10);
    const results = recall(ctx.chatId, query, k);
    if (!results.length) return { content: "No matching memories." };
    return {
      content: results
        .map((r, i) => `${i + 1}. (${r.score.toFixed(2)}) ${r.source}: ${r.text.slice(0, 500)}`)
        .join("\n\n"),
    };
  },
};

const memoryStatsTool: AgentTool = {
  type: "function",
  function: {
    name: "memory_stats",
    description: "Report how much memory is stored for the user.",
    parameters: { type: "object", properties: {} },
  },
  label: () => "Checking memory",
  async run(_args, ctx) {
    const stats = memoryStats(ctx.chatId);
    const facts = listFacts(ctx.chatId).length;
    return { content: `Chunks: ${stats.chunks} · Facts: ${facts} · Sources: ${JSON.stringify(stats.sources)}` };
  },
};

const discoverJobs: AgentTool = {
  type: "function",
  function: {
    name: "discover_jobs",
    description:
      "Run a fresh discovery sweep across configured sources (YC, HN, Product Hunt, TechCrunch, Remotive, RemoteOK, GitHub, RSS), dedupe, score against the user's profile, and return the best new opportunities.",
    parameters: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Optional source names (yc, hackernews, remotive, remoteok, github, techcrunch, producthunt). Omit for all.",
        },
        limit: { type: "number" },
      },
    },
  },
  label: () => "Discovering startups",
  async run(args, ctx) {
    const sources = Array.isArray(args.sources) ? args.sources.map(String) : undefined;
    const limit = numArg(args, "limit");
    const result = await runDiscovery({ chatId: ctx.chatId, reporter: ctx.reporter, sources, limit });
    const top = digestEntries(result.scored, runtimeMinFit(), runtimeTopN());
    ctx.reporter.note(`Discovery: ${result.inserted} new of ${result.scanned} seen`);

    const lines = [
      `Scanned ${result.scanned}, inserted ${result.inserted} new, ${result.duplicates} duplicates.`,
      result.errors.length ? `Source errors: ${result.errors.join(" | ")}` : "",
      "",
      top.length ? "Top matches:" : "No matches above threshold.",
      ...top.map((s) => formatOpportunity(s.opportunity)),
    ].filter(Boolean);
    return { content: lines.join("\n") };
  },
};

const listOpportunitiesTool: AgentTool = {
  type: "function",
  function: {
    name: "list_opportunities",
    description: "List stored opportunities, optionally filtered by status or minimum score.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        minScore: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  label: () => "Listing opportunities",
  async run(args, ctx) {
    const rows = listOpportunities(ctx.chatId, {
      status: str(args, "status"),
      minScore: numArg(args, "minScore"),
      limit: Math.min(numArg(args, "limit") ?? 10, 20),
    });
    if (!rows.length) return { content: "No opportunities stored yet. Run discover_jobs." };
    return { content: rows.map(formatOpportunity).join("\n\n") };
  },
};

const scoreOpportunitiesTool: AgentTool = {
  type: "function",
  function: {
    name: "score_opportunities",
    description: "Re-score specific stored opportunities against the user's profile.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "number" } } },
    },
  },
  label: () => "Scoring fit",
  async run(args, ctx) {
    const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isFinite) : [];
    const candidates = ids.length
      ? ids.map((id) => getOpportunity(ctx.chatId, id)).filter((o): o is Opportunity => !!o)
      : listOpportunities(ctx.chatId, { limit: 20 });
    const scored = await scoreOpportunities(ctx.chatId, candidates, ctx.reporter);
    return {
      content: scored
        .slice(0, 15)
        .map((s) => `#${s.opportunity.id} ${s.opportunity.company}: ${Math.round(s.score)}/100 — ${s.rationale}`)
        .join("\n"),
    };
  },
};

const findContactsTool: AgentTool = {
  type: "function",
  function: {
    name: "find_contacts",
    description: "Find likely contact emails for a company/opportunity by reading its website and using common patterns.",
    parameters: {
      type: "object",
      properties: { opportunityId: { type: "number" } },
      required: ["opportunityId"],
    },
  },
  label: () => "Finding contacts",
  async run(args, ctx) {
    const opp = getOpportunity(ctx.chatId, requireId(args));
    if (!opp) throw new Error("Opportunity not found");
    const contacts = await findContacts(opp);
    if (!contacts.length) return { content: `No contacts found for ${opp.company}. Ask the user for an email.` };
    return {
      content: [`Contacts for ${opp.company}:`, ...contacts.map((c) => `• ${contactLine(c)}`)].join("\n"),
    };
  },
};

const careerPageTool: AgentTool = {
  type: "function",
  function: {
    name: "scan_career_page",
    description:
      "Fetch a company's careers/jobs page and extract open roles and contact emails. Use this when the user asks what a company is hiring for.",
    parameters: {
      type: "object",
      properties: { opportunityId: { type: "number" } },
      required: ["opportunityId"],
    },
  },
  label: () => "Scanning career page",
  async run(args, ctx) {
    const opp = getOpportunity(ctx.chatId, requireId(args));
    if (!opp) throw new Error("Opportunity not found");
    const result = await scanCareerPage(opp);
    if (!result) return { content: `No careers page found for ${opp.company}.` };
    return {
      content: [
        `Career page: ${result.page}`,
        result.jobs.length ? "Open roles:" : "No roles parsed.",
        ...result.jobs.map((j) => `• ${j.title} — ${j.url}`),
        result.emails.length ? `Emails: ${result.emails.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

const draftOutreachTool: AgentTool = {  type: "function",
  function: {
    name: "draft_outreach",
    description:
      "Draft a personalized outreach message for an opportunity in the user's tone. If no email is given, it finds a likely contact automatically.",
    parameters: {
      type: "object",
      properties: {
        opportunityId: { type: "number" },
        channel: { type: "string", enum: ["email", "linkedin"] },
        contactEmail: { type: "string" },
        contactName: { type: "string" },
      },
      required: ["opportunityId"],
    },
  },
  label: () => "Drafting outreach",
  async run(args, ctx) {
    const opp = getOpportunity(ctx.chatId, requireId(args));
    if (!opp) throw new Error("Opportunity not found");

    let email = str(args, "contactEmail");
    let name = str(args, "contactName");
    if (!email) {
      const contacts = await findContacts(opp);
      const best = contacts[0];
      if (!best) throw new Error(`No contact email found for ${opp.company}; ask the user for one.`);
      email = best.email;
      name = name ?? best.name;
    }

    const outreach = await draftOutreach(
      ctx.chatId,
      opp,
      { email, name, confidence: 1, source: "agent" },
      { channel: (str(args, "channel") as Channel) ?? "email", runId: ctx.runId }
    );
    return {
      content: `Draft #${outreach.id} created (not sent).\n\n${formatDraft(outreach, opp)}`,
    };
  },
};

const sendOutreachTool: AgentTool = {
  type: "function",
  function: {
    name: "send_outreach",
    description:
      "Send a previously drafted outreach message. Respects DRY_RUN: when dry-run is on, nothing is sent and a preview is returned.",
    parameters: {
      type: "object",
      properties: { outreachId: { type: "number" } },
      required: ["outreachId"],
    },
  },
  label: () => "Sending outreach",
  async run(args, ctx) {
    const id = numArg(args, "outreachId");
    if (id === undefined) throw new Error("outreachId is required");
    if (!isDryRun() && getSetting("auto_send") !== "1") {
      return {
        content: `Auto-send is disabled for safety. Draft #${id} is ready — use the Send button on the draft, or /send ${id}, to confirm.`,
      };
    }
    const result = await deliverOutreach(ctx.chatId, id);
    if (!result.sent) {
      return {
        content: `Not sent. ${result.reason ?? ""}\n\n${formatDraft(result.outreach)}`,
      };
    }
    return { content: `Sent #${id} to ${result.outreach.to_email}.` };
  },
};

const pipelineTool: AgentTool = {
  type: "function",
  function: {
    name: "get_pipeline",
    description: "Show the current job-search pipeline grouped by stage.",
    parameters: { type: "object", properties: {} },
  },
  label: () => "Reading pipeline",
  async run(_args, ctx) {
    return { content: pipelineText(ctx.chatId) };
  },
};

const markOpportunityTool: AgentTool = {
  type: "function",
  function: {
    name: "mark_opportunity",
    description: "Move an opportunity to a pipeline status: new, shortlisted, drafted, contacted, replied, interview, rejected, skipped, archived.",
    parameters: {
      type: "object",
      properties: {
        opportunityId: { type: "number" },
        status: { type: "string" },
        note: { type: "string" },
      },
      required: ["opportunityId", "status"],
    },
  },
  label: () => "Updating pipeline",
  async run(args, ctx) {
    const id = requireId(args);
    const status = str(args, "status");
    if (!status) throw new Error("status is required");
    const allowed = ["new", "shortlisted", "drafted", "contacted", "replied", "interview", "rejected", "skipped", "archived"];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(", ")}`);
    setOpportunityStatus(ctx.chatId, id, status as Opportunity["status"]);
    addPipelineEvent(ctx.chatId, id, status, str(args, "note"));
    return { content: `Opportunity #${id} -> ${status}.` };
  },
};

const followUpsTool: AgentTool = {
  type: "function",
  function: {
    name: "follow_ups",
    description: "List or draft follow-ups that are due based on the configured cadence.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "draft"] } },
    },
  },
  label: () => "Checking follow-ups",
  async run(args, ctx) {
    const action = str(args, "action") ?? "list";
    if (action === "draft") {
      const drafts = await draftFollowUps(ctx.chatId);
      if (!drafts.length) return { content: "No follow-ups due." };
      return { content: drafts.map((d) => formatDraft(d)).join("\n\n---\n\n") };
    }
    const due = dueFollowUps(ctx.chatId);
    if (!due.length) return { content: "No follow-ups due." };
    return {
      content: due.map((d) => `#${d.id} ${d.to_email} — ${d.subject} (sent ${d.sent_at})`).join("\n"),
    };
  },
};

const schedulerTool: AgentTool = {
  type: "function",
  function: {
    name: "scheduler_info",
    description: "Report the discovery schedule, next run time, and paused state.",
    parameters: { type: "object", properties: {} },
  },
  label: () => "Checking schedule",
  async run() {
    const state = schedulerState();
    return {
      content: `Cron: ${state.cron} (${state.timezone})\nNext run: ${state.nextRunAt ?? "not armed"}\nLast run: ${state.lastRunAt ?? "never"}\nPaused: ${state.paused}`,
    };
  },
};

const forgetTool: AgentTool = {
  type: "function",
  function: {
    name: "forget",
    description: "Remove saved facts and memory chunks matching a topic.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
  label: () => "Forgetting",
  async run(args, ctx) {
    const topic = str(args, "topic");
    if (!topic) throw new Error("topic is required");
    const removed = deleteFacts(ctx.chatId, topic);
    return { content: `Removed ${removed} matching fact(s) and memory chunks.` };
  },
};

const feedbackTool: AgentTool = {
  type: "function",
  function: {
    name: "record_feedback",
    description: "Record whether an opportunity is a good or bad fit; this tunes future scoring.",
    parameters: {
      type: "object",
      properties: {
        opportunityId: { type: "number" },
        signal: { type: "string", enum: ["up", "down"] },
      },
      required: ["opportunityId", "signal"],
    },
  },
  label: () => "Recording feedback",
  async run(args, ctx) {
    const id = requireId(args);
    const signal = str(args, "signal");
    if (signal !== "up" && signal !== "down") throw new Error("signal must be up or down");
    addFeedback(ctx.chatId, id, signal);
    if (signal === "up") setOpportunityStatus(ctx.chatId, id, "shortlisted");
    log.info("feedback.recorded", { chatId: ctx.chatId, id, signal });
    return { content: `Recorded ${signal} for #${id}.` };
  },
};

export const agentTools: AgentTool[] = [
  rememberFact,
  updateProfile,
  getProfileTool,
  recallMemory,
  memoryStatsTool,
  discoverJobs,
  listOpportunitiesTool,
  scoreOpportunitiesTool,
  findContactsTool,
  careerPageTool,
  draftOutreachTool,
  sendOutreachTool,
  pipelineTool,
  markOpportunityTool,
  followUpsTool,
  schedulerTool,
  forgetTool,
  feedbackTool,
];

export const toolDefinitions: ToolDefinition[] = agentTools.map(({ type, function: fn }) => ({
  type,
  function: fn,
}));

export function findTool(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.function.name === name);
}
