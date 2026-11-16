import { config } from "../config";
import { log } from "../logger";
import { isWhisperCppAvailable, transcribeWithWhisperCpp, whisperCppStatus } from "../stt/whispercpp";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

export type CompletionResult = {
  message: AssistantMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

function endpoint(path: string): string {
  return `${config.opencode.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  session?: string;
}): Promise<CompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.opencode.timeoutMs);
  const body: Record<string, unknown> = {
    model: config.opencode.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  try {
    const res = await fetch(endpoint("chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.opencode.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "job-agent-bot/1.0",
        "x-opencode-session": opts.session ?? "job-agent-bot",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`AI API ${res.status}: ${raw.slice(0, 500)}`);
    }

    let data: {
      choices?: { message?: AssistantMessage }[];
      usage?: CompletionResult["usage"];
    };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`AI API returned invalid JSON: ${raw.slice(0, 300)}`);
    }

    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("AI API returned no message");
    return { message, usage: data.usage };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`AI request timed out after ${config.opencode.timeoutMs}ms`);
    }
    log.error("ai.request_failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatText(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; json?: boolean; session?: string } = {}
): Promise<string> {
  const { message } = await chatCompletion({ messages, ...opts });
  return typeof message.content === "string" ? message.content : "";
}

function parseTranscript(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { text?: string };
    if (data.text?.trim()) return data.text.trim();
  } catch {
    if (raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  }
  return null;
}

export async function transcribeAudio(file: Blob, filename = "voice.ogg"): Promise<string> {
  const provider = config.stt.provider;
  const localProviders = new Set(["whispercpp", "whisper", "local", "auto"]);
  const apiProviders = new Set(["api", "openai", "auto"]);
  if (!localProviders.has(provider) && !apiProviders.has(provider)) {
    throw new Error(`Unknown STT_PROVIDER "${provider}". Use whispercpp, api, or auto.`);
  }

  const failures: string[] = [];

  if (localProviders.has(provider)) {
    if (isWhisperCppAvailable()) {
      try {
        return await transcribeWithWhisperCpp(new Uint8Array(await file.arrayBuffer()), filename);
      } catch (error) {
        failures.push(`whisper.cpp: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      failures.push(`whisper.cpp: ${whisperCppStatus().reason}`);
    }
    if (provider !== "auto") {
      throw new Error(
        `Local transcription failed (${failures.join("; ")}). Check WHISPER_CPP_BIN and WHISPER_CPP_MODEL.`
      );
    }
  }

  const attempts: { url: string; key: string; model: string; label: string }[] = [];
  if (config.stt.apiUrl && config.stt.apiKey) {
    attempts.push({ url: config.stt.apiUrl, key: config.stt.apiKey, model: config.stt.model, label: "STT API" });
  }
  if (config.opencode.apiKey) {
    attempts.push({
      url: endpoint("audio/transcriptions"),
      key: config.opencode.apiKey,
      model: config.opencode.sttModel,
      label: "OpenCode audio",
    });
  }
  if (!attempts.length) {
    throw new Error(
      `Transcription failed (${failures.join("; ")}). No API fallback configured — install whisper.cpp and the base.en model, or set OPENAI_API_KEY / STT_API_URL + STT_API_KEY.`
    );
  }

  for (const attempt of attempts) {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("model", attempt.model);

    try {
      const res = await fetch(attempt.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${attempt.key}`,
          "x-opencode-session": "job-agent-stt",
        },
        body: form,
      });
      const raw = await res.text();
      if (!res.ok) {
        failures.push(`${attempt.label}: ${res.status}`);
        continue;
      }
      const transcript = parseTranscript(raw);
      if (transcript) return transcript;
      failures.push(`${attempt.label}: empty transcript`);
    } catch (error) {
      failures.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Transcription failed (${failures.join("; ")}).`);
}
