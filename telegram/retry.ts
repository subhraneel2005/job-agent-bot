import { GrammyError } from "grammy";
import { log } from "../logger";

export function retryAfterMs(error: unknown): number | null {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const retry = (error.parameters as { retry_after?: number } | undefined)?.retry_after;
      return (retry ?? 1) * 1000 + 250;
    }
  }
  return null;
}

export function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

export function isMessageGone(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    (/message to edit not found/i.test(error.description) ||
      /message can't be edited/i.test(error.description) ||
      /message is too old/i.test(error.description))
  );
}

export function isParseError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    /parse entities|can't parse|unsupported start tag|unclosed|can't find end/i.test(error.description)
  );
}

export function isTransient(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return error.error_code === 429 || error.error_code >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && /fetch failed|network|ECONN/i.test(error.message));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; label?: string } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const wait = retryAfterMs(error) ?? (isTransient(error) ? Math.min(1000 * 2 ** i, 8000) : null);
      if (wait === null || i === attempts - 1) throw error;
      log.warn("telegram.retry", { label: opts.label, attempt: i + 1, waitMs: wait });
      await Bun.sleep(wait);
    }
  }
  throw lastError;
}
