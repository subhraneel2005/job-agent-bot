import { chatCompletion, type ChatMessage, type ContentPart } from "../ai/client";
import { config } from "../config";
import { log, serializeError } from "../logger";
import { getProfile, listFacts } from "../memory/db";
import { recall } from "../memory/rag";
import { getUserSearchProfile } from "../discovery/profile";
import { isDryRun, runtimeCron } from "../runtime/settings";
import type { ProgressReporter } from "../telegram/progress";
import { findTool, toolDefinitions } from "./tools";

type SessionMessage = { role: "user" | "assistant"; content: string };
const sessions = new Map<number, SessionMessage[]>();

export function clearSession(chatId: number) {
  sessions.delete(chatId);
}

export function sessionSize(chatId: number): number {
  return sessions.get(chatId)?.length ?? 0;
}

function systemPrompt(chatId: number, userText: string): string {
  const profile = getUserSearchProfile(chatId);
  const rawProfile = getProfile(chatId);
  const facts = listFacts(chatId)
    .slice(0, 24)
    .map((f) => `- [${f.kind}] ${f.key}: ${f.value}`)
    .join("\n");
  const memories = recall(chatId, userText || profile.summary, 4)
    .map((m) => `- ${m.text.slice(0, 400)}`)
    .join("\n");

  const now = new Intl.DateTimeFormat("en-IN", {
    timeZone: config.timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());

  return `You are the user's personal autonomous job-hunting agent, controlled entirely through Telegram.

Core loop: know me -> find relevant companies -> take job-search actions for me.
You are not a job scraper; you use persistent memory about the user to judge fit and act.

Current time: ${now} (${config.timezone}).
Discovery sources: Y Combinator, Hacker News, Product Hunt, TechCrunch/funding news, Remotive, Remote OK, GitHub, career pages, RSS.
Discovery cadence: ${runtimeCron()} in ${config.timezone}.
Email sending: ${isDryRun() ? "DRY_RUN is ON (nothing is actually sent)" : "DRY_RUN is OFF"}.

USER PROFILE (structured)
${JSON.stringify(rawProfile)}

DERIVED SEARCH PROFILE
${profile.summary || "(nothing learned yet)"}

SAVED FACTS
${facts || "(none yet)"}

RELEVANT MEMORIES
${memories || "(none yet)"}

RULES
- Answer first. No preamble, no filler, no restating the question.
- Keep normal replies under 100 words. Go longer only for a draft or when asked.
- Format for Telegram: **bold**, _italic_, \`code\`, - bullets, 1. numbered, > quote, [label](url).
- Never use # headings, Markdown tables, or --- rules.
- At most one emoji in the whole message, preferably none.
- One idea per line. Never send a wall of text.
- When the user reveals a durable preference, experience, or constraint, call remember_fact.
- Use tools instead of guessing. Never invent companies, funding, contacts, or sent emails.
- Only say an email was sent if the send tool reported success.
- Prefer drafting first, then ask for confirmation. Never auto-send when DRY_RUN is off unless the user explicitly confirmed.
- When discovery returns nothing, say so plainly and mention failed sources.`;
}

export type AgentInput = {
  chatId: number;
  text: string;
  reporter: ProgressReporter;
  runId: string;
  imageDataUrl?: string;
};

export async function runAgent(input: AgentInput): Promise<string> {
  const { chatId, reporter, runId } = input;
  const history = sessions.get(chatId) ?? [];

  const userContent: string | ContentPart[] = input.imageDataUrl
    ? [
        { type: "text", text: input.text || "What is in this image? Extract any job or company details." },
        { type: "image_url", image_url: { url: input.imageDataUrl } },
      ]
    : input.text;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(chatId, input.text) },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    { role: "user", content: userContent },
  ];

  let finalText = "";
  const ctx = { chatId, reporter, runId };

  for (let step = 0; step < config.maxAgentSteps; step++) {
    const { message } = await chatCompletion({
      messages,
      tools: toolDefinitions,
      temperature: 0.4,
      maxTokens: 4096,
      session: `telegram-${chatId}`,
    });

    if (message.tool_calls?.length) {
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });

      for (const call of message.tool_calls) {
        const tool = findTool(call.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }

        let resultContent: string;
        if (!tool) {
          resultContent = `Unknown tool: ${call.function.name}`;
        } else {
          const stepId = reporter.addStep(tool.label(args));
          try {
            const result = await tool.run(args, ctx);
            resultContent = result.content;
            reporter.completeStep(stepId);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            reporter.failStep(stepId, messageText.slice(0, 60));
            resultContent = `Tool error: ${messageText}`;
            log.warn("agent.tool_failed", { tool: call.function.name, ...serializeError(error) });
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultContent.slice(0, 6000),
        });
      }
      continue;
    }

    finalText = typeof message.content === "string" ? message.content.trim() : "";
    break;
  }

  if (!finalText) {
    finalText =
      "I ran out of steps before finishing. Partial results are above — ask me to continue, or narrow the request.";
  }

  const nextHistory: SessionMessage[] = [
    ...history,
    { role: "user" as const, content: input.text },
    { role: "assistant" as const, content: finalText },
  ].slice(-20);
  sessions.set(chatId, nextHistory);

  log.info("agent.complete", { chatId, runId, chars: finalText.length });
  return finalText;
}
