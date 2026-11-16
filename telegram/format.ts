const MAX = 4096;

export function chunkMessage(text: string, limit = MAX): string[] {
  if (!text) return [""];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf(" ")
    );
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const segmenter =
  typeof Intl.Segmenter !== "undefined"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function limitEmojis(text: string, max = 1): string {
  let seen = 0;
  let out = "";
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) {
        seen++;
        if (seen > max) continue;
      }
      out += segment;
    }
    return out;
  }
  for (const char of [...text]) {
    if (/\p{Extended_Pictographic}/u.test(char)) {
      seen++;
      if (seen > max) continue;
    }
    out += char;
  }
  return out;
}

function inline(raw: string): string {
  const placeholders: string[] = [];
  const hold = (html: string) => {
    const index = placeholders.length;
    placeholders.push(html);
    return `\u0000I${index}\u0000`;
  };

  let text = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      hold(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
  );

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");

  return text.replace(/\u0000I(\d+)\u0000/g, (_match, index: string) => placeholders[Number(index)] ?? "");
}

export function renderHtml(input: string): string {
  const text = limitEmojis(input, 1);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const codeBlocks: string[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let inQuote = false;

  const flushQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  const emitCode = () => {
    codeBlocks.push(`<pre>${escapeHtml(codeBuffer.join("\n"))}</pre>`);
    out.push(`\u0000B${codeBlocks.length - 1}\u0000`);
    codeBuffer = [];
  };

  for (const line of lines) {
    if (inCode) {
      if (/^\s*```/.test(line)) {
        inCode = false;
        emitCode();
      } else {
        codeBuffer.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushQuote();
      inCode = true;
      continue;
    }

    if (!line.trim()) {
      flushQuote();
      out.push("");
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flushQuote();
      out.push(`<b>${inline(heading[1] ?? "")}</b>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushQuote();
      out.push("──────────");
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(inline(quote[1] ?? ""));
      continue;
    }

    flushQuote();

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`);
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      out.push(`${numbered[1] ?? ""}${numbered[2]}. ${inline(numbered[3] ?? "")}`);
      continue;
    }

    const table = line.match(/^\s*\|(.+)\|\s*$/);
    if (table) {
      const rawCells = (table[1] ?? "").split("|").map((cell) => cell.trim());
      if (rawCells.every((cell) => !cell || /^:?-{2,}:?$/.test(cell))) continue;
      const cells = rawCells.filter((cell) => cell && !/^:?-{2,}:?$/.test(cell));
      if (cells.length) {
        out.push(cells.map((cell) => inline(cell)).join(" · "));
        continue;
      }
    }

    out.push(inline(line));
  }

  if (inCode && codeBuffer.length) emitCode();
  flushQuote();

  const html = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return html.replace(/\u0000B(\d+)\u0000/g, (_match, index: string) => codeBlocks[Number(index)] ?? "");
}

export function plainFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
