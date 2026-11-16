import type { Api } from "grammy";
import { log } from "../logger";
import { chunkMessage, plainFromHtml, renderHtml } from "./format";
import { isMessageGone, isMessageNotModified, isParseError, withRetry } from "./retry";

type StepStatus = "pending" | "active" | "done" | "failed";
type Step = { id: number; label: string; status: StepStatus; detail?: string };

const ICONS: Record<StepStatus, string> = {
  pending: "○",
  active: "◐",
  done: "●",
  failed: "×",
};

const MIN_EDIT_MS = 1100;

export class ProgressReporter {
  private steps: Step[] = [];
  private notes: string[] = [];
  private messageId: number | null = null;
  private nextStepId = 1;
  private lastEditAt = 0;
  private lastRendered = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private editing = false;
  private closed = false;

  constructor(
    private api: Api,
    private chatId: number,
    private title = "Working…"
  ) {}

  async start(): Promise<void> {
    this.startTyping();
    try {
      const msg = await withRetry(
        () => this.api.sendMessage(this.chatId, this.render(), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
        { label: "progress.start" }
      );
      this.messageId = msg.message_id;
      this.lastRendered = this.render();
      this.lastEditAt = Date.now();
    } catch (error) {
      log.warn("progress.start_failed", { chatId: this.chatId, error: String(error) });
    }
  }

  setTitle(title: string) {
    this.title = title;
    this.scheduleFlush();
  }

  addStep(label: string): number {
    const id = this.nextStepId++;
    this.steps.push({ id, label, status: "active" });
    this.scheduleFlush();
    return id;
  }

  completeStep(id: number, detail?: string) {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = "done";
    if (detail) step.detail = detail;
    this.scheduleFlush();
  }

  failStep(id: number, detail?: string) {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = "failed";
    if (detail) step.detail = detail;
    this.scheduleFlush();
  }

  updateStep(id: number, label: string) {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    step.label = label;
    this.scheduleFlush();
  }

  note(text: string) {
    this.notes.push(text);
    if (this.notes.length > 6) this.notes.shift();
    this.scheduleFlush();
  }

  private render(): string {
    const lines: string[] = [`<b>${escapeInline(this.title)}</b>`];
    const visible = this.steps.slice(-10);
    for (const step of visible) {
      const detail = step.detail ? ` — ${escapeInline(step.detail)}` : "";
      lines.push(`${ICONS[step.status]} ${escapeInline(step.label)}${detail}`);
    }
    if (this.notes.length) {
      lines.push("");
      for (const note of this.notes) lines.push(`<i>› ${escapeInline(note)}</i>`);
    }
    if (!this.steps.length && !this.notes.length) lines.push("◐ Working…");
    return lines.join("\n");
  }

  private scheduleFlush() {
    if (this.closed) return;
    if (this.flushTimer) return;
    const wait = Math.max(0, MIN_EDIT_MS - (Date.now() - this.lastEditAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush() {
    if (this.closed || this.editing) {
      if (this.editing) this.scheduleFlush();
      return;
    }
    const rendered = this.render();
    if (rendered === this.lastRendered) return;
    this.editing = true;
    try {
      if (this.messageId === null) {
        const msg = await withRetry(
          () => this.api.sendMessage(this.chatId, rendered, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
          { label: "progress.send" }
        );
        this.messageId = msg.message_id;
      } else {
        await this.edit(rendered);
      }
      this.lastRendered = rendered;
      this.lastEditAt = Date.now();
    } catch (error) {
      log.debug("progress.flush_failed", { error: String(error) });
    } finally {
      this.editing = false;
    }
  }

  private async edit(html: string) {
    if (this.messageId === null) return;
    try {
      await withRetry(
        () =>
          this.api.editMessageText(this.chatId, this.messageId!, html, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
        { label: "progress.edit" }
      );
    } catch (error) {
      if (isMessageNotModified(error)) return;
      if (isParseError(error)) {
        await withRetry(
          () =>
            this.api.editMessageText(this.chatId, this.messageId!, plainFromHtml(html), {
              link_preview_options: { is_disabled: true },
            }),
          { label: "progress.edit_plain" }
        );
        return;
      }
      if (isMessageGone(error)) {
        const msg = await withRetry(
          () => this.api.sendMessage(this.chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
          { label: "progress.resend" }
        );
        this.messageId = msg.message_id;
        return;
      }
      throw error;
    }
  }

  private startTyping() {
    const ping = () => {
      this.api.sendChatAction(this.chatId, "typing").catch(() => {});
    };
    ping();
    this.typingTimer = setInterval(ping, 4500);
  }

  private stopTimers() {
    if (this.typingTimer) clearInterval(this.typingTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.typingTimer = null;
    this.flushTimer = null;
  }

  async finish(finalText: string): Promise<void> {
    this.closed = true;
    this.stopTimers();
    await this.replace(finalText);
  }

  async fail(finalText: string): Promise<void> {
    this.closed = true;
    this.stopTimers();
    await this.replace(finalText);
  }

  private async replace(finalText: string) {
    if (!finalText) {
      const html = this.render();
      if (this.messageId !== null) {
        await this.edit(html);
      } else {
        await this.send(html);
      }
      return;
    }

    const chunks = chunkMessage(finalText);
    const first = renderHtml(chunks[0] ?? "");
    if (this.messageId !== null) {
      try {
        await this.edit(first);
      } catch (error) {
        log.warn("progress.replace_failed", { error: String(error) });
        await this.send(first);
      }
    } else {
      await this.send(first);
    }
    for (const chunk of chunks.slice(1)) {
      await this.send(renderHtml(chunk));
    }
  }

  private async send(html: string) {
    try {
      await withRetry(
        () =>
          this.api.sendMessage(this.chatId, html, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
        { label: "progress.final_send" }
      );
    } catch (error) {
      log.error("progress.final_send_failed", { chatId: this.chatId, error: String(error) });
      if (isParseError(error)) {
        try {
          await this.api.sendMessage(this.chatId, plainFromHtml(html), {
            link_preview_options: { is_disabled: true },
          });
        } catch (plainError) {
          log.error("progress.final_send_plain_failed", { chatId: this.chatId, error: String(plainError) });
        }
      }
    }
  }
}

function escapeInline(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
