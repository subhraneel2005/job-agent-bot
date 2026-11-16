import { config } from "../config";
import { runtimeMinFit, runtimeTopN } from "../runtime/settings";
import type { ScoredOpportunity } from "./score";

export type InlineButton = { text: string; url?: string; callback_data?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

function clean(text: string, max = 180): string {
  return text.replace(/[*_`\[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function dateLabel(): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: config.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date());
}

export function digestEntries(
  scored: ScoredOpportunity[],
  minFit = runtimeMinFit(),
  topN = runtimeTopN()
) {
  const above = scored.filter((s) => s.score >= minFit);
  const pool = above.length ? above : scored.slice(0, Math.min(3, topN));
  return pool.slice(0, topN);
}

export function buildDigestText(scored: ScoredOpportunity[], opts: { errors?: string[] } = {}): string {
  const entries = digestEntries(scored);
  if (!entries.length) {
    const errs = opts.errors?.length ? `\n\nSources failed: ${opts.errors.join("; ")}` : "";
    return `**Morning digest · ${dateLabel()}**\n\nNo fresh matches today.${errs}`;
  }

  const lines: string[] = [
    `**Morning digest · ${dateLabel()}**`,
    `__${entries.length} pick${entries.length === 1 ? "" : "s"} from ${scored.length} signal${scored.length === 1 ? "" : "s"}__`,
    "",
  ];

  entries.forEach((entry, i) => {
    const o = entry.opportunity;
    const facts = [
      `${Math.round(entry.score)}/100`,
      o.stage ? clean(o.stage, 24) : "",
      o.funding_event ? clean(o.funding_event, 48) : "",
      o.hiring ? "hiring" : "",
    ].filter(Boolean);
    lines.push(`**${i + 1}. ${clean(o.company, 50)}** — ${clean(o.role, 60)}`);
    lines.push(facts.join(" · "));
    if (entry.rationale) lines.push(clean(entry.rationale, 110));
    lines.push(`[Open](${o.url}) · ${clean(o.source, 16)}`);
    lines.push("");
  });

  if (opts.errors?.length) {
    lines.push(`Sources failed: ${opts.errors.length} (see /status)`);
  }
  return lines.join("\n").trim();
}

export function digestKeyboard(scored: ScoredOpportunity[]): InlineKeyboard {
  const entries = digestEntries(scored);
  const rows: InlineButton[][] = [];
  for (const entry of entries) {
    const id = entry.opportunity.id;
    rows.push([
      { text: "Open", url: entry.opportunity.url },
      { text: "Draft", callback_data: `opp:draft:${id}` },
      { text: "Save", callback_data: `opp:save:${id}` },
    ]);
    rows.push([
      { text: "Good", callback_data: `fb:up:${id}` },
      { text: "Bad", callback_data: `fb:down:${id}` },
      { text: "Skip", callback_data: `opp:skip:${id}` },
    ]);
  }
  return { inline_keyboard: rows };
}
