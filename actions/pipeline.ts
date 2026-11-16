import { config } from "../config";
import {
  db,
  getOpportunity,
  listPipeline,
  type Outreach,
} from "../memory/db";
import { draftOutreach, type Channel } from "./email";

export function pipelineText(chatId: number): string {
  const rows = listPipeline(chatId);
  if (!rows.length) return "No opportunities in the pipeline yet. Run `/discover` to start.";
  const order = ["interview", "replied", "contacted", "drafted", "shortlisted", "new"];
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.status) ?? [];
    list.push(row);
    grouped.set(row.status, list);
  }
  const lines: string[] = ["**Pipeline**"];
  for (const status of order) {
    const list = grouped.get(status);
    if (!list?.length) continue;
    lines.push("", `__${status.toUpperCase()}__`);
    for (const row of list.slice(0, 6)) {
      const score = row.score ? ` · ${Math.round(row.score)}` : "";
      const outreach = row.outreach_count ? ` · ${row.outreach_count} outreach` : "";
      lines.push(`• ${row.company} — ${row.role}${score}${outreach}`);
    }
  }
  return lines.join("\n");
}

export function dueFollowUps(chatId: number, day = config.followUpDays[0] ?? 4): Outreach[] {
  const rows = db
    .query(
      `SELECT * FROM outreach o
       WHERE o.chat_id = ? AND o.status = 'sent'
         AND o.sent_at <= datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1 FROM outreach n
           WHERE n.opportunity_id = o.opportunity_id
             AND n.channel = o.channel
             AND n.id > o.id
         )
       ORDER BY o.sent_at ASC
       LIMIT 10`
    )
    .all(chatId, `-${day} days`) as Outreach[];
  return rows;
}

export async function draftFollowUps(chatId: number): Promise<Outreach[]> {
  const due = dueFollowUps(chatId);
  const drafts: Outreach[] = [];
  for (const previous of due) {
    if (!previous.opportunity_id) continue;
    const opp = getOpportunity(chatId, previous.opportunity_id);
    if (!opp) continue;
    const draft = await draftOutreach(
      chatId,
      opp,
      {
        email: previous.to_email,
        name: previous.to_name ?? undefined,
        confidence: 1,
        source: "follow-up",
      },
      { channel: previous.channel as Channel, followUpOf: previous }
    );
    drafts.push(draft);
  }
  return drafts;
}

export function weeklySummary(chatId: number): string {
  const counts = db
    .query(
      `SELECT status, COUNT(*) as n FROM opportunities
       WHERE chat_id = ? AND created_at >= datetime('now', '-7 days')
       GROUP BY status`
    )
    .all(chatId) as { status: string; n: number }[];
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const outreach = db
    .query(
      `SELECT status, COUNT(*) as n FROM outreach
       WHERE chat_id = ? AND created_at >= datetime('now', '-7 days')
       GROUP BY status`
    )
    .all(chatId) as { status: string; n: number }[];
  const sent = outreach.find((o) => o.status === "sent")?.n ?? 0;
  const drafts = outreach.find((o) => o.status === "draft")?.n ?? 0;
  const byStatus = counts.map((c) => `${c.status}: ${c.n}`).join(" · ") || "none";
  return [
    "**This week**",
    `• ${total} opportunities discovered (${byStatus})`,
    `• ${drafts} outreach drafts · ${sent} sent`,
    `• Follow-ups due: ${dueFollowUps(chatId).length}`,
  ].join("\n");
}
