import { chatText } from "../ai/client";
import { config } from "../config";
import { log } from "../logger";
import {
  addPipelineEvent,
  createOutreach,
  getOutreach,
  listFacts,
  markOutreachFailed,
  markOutreachSent,
  setOpportunityStatus,
  updateOutreachContent,
  type Opportunity,
  type Outreach,
} from "../memory/db";
import { recall } from "../memory/rag";
import { getUserSearchProfile } from "../discovery/profile";
import { isDryRun } from "../runtime/settings";
import type { Contact } from "./contacts";

export type Channel = "email" | "linkedin";

function unescapeJsonString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractField(text: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s");
  const match = text.match(re);
  return match?.[1] !== undefined ? unescapeJsonString(match[1]) : null;
}

function fromParsed(value: unknown): { subject: string; body: string } | null {
  if (typeof value === "string") {
    try {
      return fromParsed(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.body !== "string" || !data.body.trim()) return null;
  return {
    subject: typeof data.subject === "string" ? data.subject : "Quick note",
    body: data.body.trim(),
  };
}

function parseDraft(text: string): { subject: string; body: string } {
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  try {
    const direct = fromParsed(JSON.parse(cleaned));
    if (direct) return direct;
  } catch {
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = fromParsed(JSON.parse(match[0]));
      if (parsed) return parsed;
    } catch {
    }
  }

  const body = extractField(cleaned, "body");
  if (body) {
    return { subject: extractField(cleaned, "subject") ?? "Quick note", body };
  }

  const lines = cleaned.split("\n");
  const first = lines[0]?.replace(/^(subject|subj):\s*/i, "").trim() || "Quick note";
  return { subject: first, body: lines.slice(1).join("\n").trim() || cleaned };
}

export async function draftOutreach(
  chatId: number,
  opp: Opportunity,
  contact: Contact,
  opts: { channel?: Channel; runId?: string; followUpOf?: Outreach } = {}
): Promise<Outreach> {
  const channel: Channel = opts.channel ?? "email";
  const profile = getUserSearchProfile(chatId);
  const facts = listFacts(chatId)
    .slice(0, 16)
    .map((f) => `${f.kind}/${f.key}: ${f.value}`)
    .join("\n");
  const toneSamples = recall(chatId, "writing style tone voice how I write", 3)
    .map((m) => m.text)
    .join("\n---\n");

  const candidate = [
    config.user.name ? `Name: ${config.user.name}` : "",
    config.user.email ? `Email: ${config.user.email}` : "",
    config.user.github ? `GitHub: ${config.user.github}` : "",
    config.user.linkedin ? `LinkedIn: ${config.user.linkedin}` : "",
    config.user.website ? `Website: ${config.user.website}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const followUp = opts.followUpOf
    ? `\nThis is a FOLLOW-UP to an earlier email. Earlier subject: "${opts.followUpOf.subject}". Keep it to 2-3 short sentences, no pressure, add one new specific reason to talk.\n`
    : "";

  const system =
    channel === "email"
      ? "You write cold outreach emails for a candidate. They must sound human, specific, and concise (120-170 words). No fluff, no buzzwords, no 'I hope this finds you well'. Match the candidate's tone from the samples. Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}"
      : "You write short LinkedIn DMs (under 90 words) for a candidate reaching out to a startup. Conversational, specific, no fluff. Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}";

  const user = `CANDIDATE
${candidate || "(name/links not configured)"}

PROFILE
${profile.summary}

FACTS
${facts || "(none yet)"}

HOW THE CANDIDATE WRITES (tone samples)
${toneSamples || "(no samples yet — write clean, direct, warm)"}

COMPANY / OPPORTUNITY
Company: ${opp.company}
Role: ${opp.role}
Source: ${opp.source}
Signal: ${opp.funding_event ?? opp.why ?? "fresh opportunity"}
Link: ${opp.url}

CONTACT
${contact.name ? `Name: ${contact.name}` : "Name: unknown"}
Email: ${contact.email}
${followUp}
Write the ${channel === "email" ? "email" : "DM"} now.`;

  let subject = `Quick note about ${opp.company}`;
  let body = "";
  try {
    const raw = await chatText(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, temperature: 0.6, maxTokens: 1600, session: `outreach-${chatId}` }
    );
    const parsed = parseDraft(raw);
    subject = parsed.subject;
    body = parsed.body;
  } catch (error) {
    log.warn("outreach.draft_llm_failed", { error: String(error) });
    body = `Hi${contact.name ? ` ${contact.name}` : ""},\n\nI came across ${opp.company} and wanted to reach out. ${opp.why ? `${opp.why}.` : ""} I'd love to learn more about what you're building and whether there's a fit.\n\nBest,\n${config.user.name || "—"}`;
  }

  const id = createOutreach({
    chatId,
    opportunityId: opp.id,
    channel,
    toEmail: contact.email,
    toName: contact.name,
    subject,
    body,
    runId: opts.runId,
  });
  if (opp.status === "new" || opp.status === "shortlisted") {
    setOpportunityStatus(chatId, opp.id, "drafted");
  }
  addPipelineEvent(
    chatId,
    opp.id,
    opts.followUpOf ? "follow_up_drafted" : "drafted",
    `${channel} to ${contact.email}`
  );
  const outreach = getOutreach(chatId, id);
  if (!outreach) throw new Error("Failed to store outreach draft");
  return outreach;
}

export function formatDraft(outreach: Outreach, opp?: Opportunity | null): string {
  const header = [
    `**Draft #${outreach.id}**${opp ? ` · ${opp.company} — ${opp.role}` : ""}`,
    `To: ${outreach.to_name ? `${outreach.to_name} <${outreach.to_email}>` : outreach.to_email}`,
    `Subject: ${outreach.subject}`,
    outreach.status !== "draft" ? `Status: ${outreach.status}` : "",
  ].filter(Boolean);
  return `${header.join("\n")}\n\n${outreach.body}`;
}

export async function reviseOutreach(
  chatId: number,
  outreachId: number,
  instruction: string
): Promise<Outreach> {
  const outreach = getOutreach(chatId, outreachId);
  if (!outreach) throw new Error(`Draft #${outreachId} not found`);

  const raw = await chatText(
    [
      {
        role: "system",
        content:
          "You revise outreach drafts. Apply the user's requested change while keeping the candidate's voice and the message concise. Return ONLY JSON: {\"subject\":\"...\",\"body\":\"...\"}",
      },
      {
        role: "user",
        content: `CURRENT SUBJECT\n${outreach.subject}\n\nCURRENT BODY\n${outreach.body}\n\nREQUESTED CHANGE\n${instruction}\n\nReturn the revised draft.`,
      },
    ],
    { json: true, temperature: 0.4, maxTokens: 1600, session: `outreach-${chatId}` }
  );

  const parsed = parseDraft(raw);
  const subject = parsed.subject && parsed.subject !== "Quick note" ? parsed.subject : outreach.subject;
  updateOutreachContent(chatId, outreachId, subject, parsed.body);
  const updated = getOutreach(chatId, outreachId);
  if (!updated) throw new Error("Failed to update draft");
  return updated;
}

async function sendViaResend(outreach: Outreach): Promise<{ ok: boolean; error?: string }> {  if (!config.email.resendApiKey) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [outreach.to_email],
        reply_to: config.email.replyTo || undefined,
        subject: outreach.subject,
        text: outreach.body,
      }),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${raw.slice(0, 300)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deliverOutreach(
  chatId: number,
  outreachId: number
): Promise<{ sent: boolean; reason?: string; outreach: Outreach }> {
  const outreach = getOutreach(chatId, outreachId);
  if (!outreach) throw new Error(`Outreach #${outreachId} not found`);
  if (outreach.status === "sent") return { sent: true, reason: "already sent", outreach };

  if (isDryRun()) {
    addPipelineEvent(chatId, outreach.opportunity_id, "dry_run", `would email ${outreach.to_email}`);
    return { sent: false, reason: "DRY_RUN is enabled — nothing was sent", outreach };
  }

  const result = await sendViaResend(outreach);
  if (!result.ok) {
    markOutreachFailed(chatId, outreach.id, result.error ?? "unknown error");
    return { sent: false, reason: result.error, outreach };
  }

  markOutreachSent(chatId, outreach.id);
  if (outreach.opportunity_id) {
    setOpportunityStatus(chatId, outreach.opportunity_id, "contacted");
    addPipelineEvent(chatId, outreach.opportunity_id, "sent", outreach.subject);
  }
  return { sent: true, outreach };
}
