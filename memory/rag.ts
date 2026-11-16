import { config } from "../config";
import { log } from "../logger";
import { insertChunk, insertDocument, listChunks } from "./db";

const STOPWORDS = new Set(
  `a an and are as at be been but by for from had has have he her his i if in into is it its me my no not of on or our she so that the their them then there these they this to was we were will with you your`.split(
    /\s+/
  )
);

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#.\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function embed(text: string): number[] {
  const dims = config.memory.ragDimensions;
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  const bump = (term: string, weight: number) => {
    const idx = hashToken(term) % dims;
    const sign = hashToken(term + "#sign") % 2 === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i]!, 1);
    if (i + 1 < tokens.length) bump(`${tokens[i]}_${tokens[i + 1]}`, 0.5);
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function chunkText(text: string): string[] {
  const size = config.memory.ragChunkChars;
  const overlap = Math.min(config.memory.ragChunkOverlap, size - 20);
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (boundary > size * 0.5) end = start + boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function ingestDocument(chatId: number, filename: string, mime: string | null, text: string) {
  const docId = insertDocument(chatId, filename, mime, text);
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    insertChunk(chatId, `doc:${filename}`, chunk, embed(chunk), docId);
  }
  log.info("memory.ingest_document", { chatId, filename, chars: text.length, chunks: chunks.length });
  return { documentId: docId, chunks: chunks.length, chars: text.length };
}

export function ingestMemory(chatId: number, source: string, text: string) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    insertChunk(chatId, source, chunk, embed(chunk));
  }
  return chunks.length;
}

export type Recall = { text: string; source: string; score: number };

export function recall(chatId: number, query: string, k = config.memory.recallK): Recall[] {
  const q = embed(query);
  const rows = listChunks(chatId);
  const scored: Recall[] = [];
  for (const row of rows) {
    let vec: number[];
    try {
      vec = JSON.parse(row.embedding) as number[];
    } catch {
      continue;
    }
    const score = cosine(q, vec);
    if (score > 0.01) scored.push({ text: row.text, source: row.source, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function memoryStats(chatId: number) {
  const rows = listChunks(chatId);
  const sources = new Map<string, number>();
  for (const r of rows) sources.set(r.source, (sources.get(r.source) ?? 0) + 1);
  return {
    chunks: rows.length,
    sources: Object.fromEntries(sources),
  };
}
