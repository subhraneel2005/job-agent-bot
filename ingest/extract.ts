import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type Extracted = { text: string; format: string; pages?: number };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function csvToText(text: string, maxRows = 300): string {
  const rows = parseCsv(text).slice(0, maxRows);
  if (!rows.length) return text;
  const header = rows[0]!;
  return rows
    .slice(1)
    .map((r) => header.map((h, i) => `${h}: ${r[i] ?? ""}`).join(" | "))
    .join("\n");
}

export async function extractDocument(
  buffer: Uint8Array,
  filename?: string,
  mime?: string
): Promise<Extracted> {
  const name = (filename ?? "").toLowerCase();
  const type = (mime ?? "").toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(buffer);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: text.trim(), format: "pdf", pages: totalPages };
  }

  if (type.includes("wordprocessingml") || name.endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return { text: value.trim(), format: "docx" };
  }

  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

  if (type === "text/csv" || name.endsWith(".csv") || name.endsWith(".tsv")) {
    return { text: csvToText(decoded), format: "csv" };
  }

  const format = (name.split(".").pop() ?? type) || "text";
  return { text: decoded.trim(), format };
}

export function stripBinaryNoise(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}
