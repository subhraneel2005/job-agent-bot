import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { log } from "../logger";

export type WhisperStatus = {
  available: boolean;
  bin: string;
  model: string;
  reason?: string;
};

function resolveBin(name: string): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null;
  return Bun.which(name);
}

export function whisperCppStatus(): WhisperStatus {
  const bin = resolveBin(config.stt.whisperBin);
  const model = config.stt.whisperModel;
  if (!bin) {
    return { available: false, bin: config.stt.whisperBin, model, reason: `binary "${config.stt.whisperBin}" not found` };
  }
  if (!existsSync(model)) {
    return { available: false, bin, model, reason: `model not found at ${model}` };
  }
  return { available: true, bin, model };
}

export function isWhisperCppAvailable(): boolean {
  return whisperCppStatus().available;
}

async function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(`could not run ${bin}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      return;
    }
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`${bin} exited ${code}: ${(stderr || stdout).slice(-500).trim()}`);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export function cleanTranscript(text: string): string {
  return text
    .replace(/\[(BLANK_AUDIO|MUSIC|SOUND|APPLAUSE|INAUDIBLE)\]/gi, " ")
    .replace(/\((music|applause|silence)\)/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extensionFor(filename: string): string {
  const match = filename.toLowerCase().match(/\.(ogg|oga|opus|mp3|m4a|aac|wav|webm|mp4|flac)$/);
  return match ? `.${match[1]}` : ".ogg";
}

export async function transcribeWithWhisperCpp(
  bytes: Uint8Array,
  filename = "voice.ogg"
): Promise<string> {
  const status = whisperCppStatus();
  if (!status.available) {
    throw new Error(
      `${status.reason}. Install whisper.cpp (brew install whisper-cpp) and download the base.en model to ${status.model}.`
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "job-agent-stt-"));
  const started = Date.now();
  try {
    const input = join(dir, `input${extensionFor(filename)}`);
    const wav = join(dir, "audio.wav");
    const outBase = join(dir, "transcript");
    writeFileSync(input, bytes);

    await runCommand(
      config.stt.ffmpegBin,
      ["-nostdin", "-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
      config.stt.timeoutMs
    );

    await runCommand(
      status.bin,
      [
        "-m",
        status.model,
        "-f",
        wav,
        "-l",
        config.stt.whisperLang,
        "-t",
        String(config.stt.whisperThreads),
        "-nt",
        "-otxt",
        "-np",
        "-of",
        outBase,
      ],
      config.stt.timeoutMs
    );

    const txtPath = `${outBase}.txt`;
    if (!existsSync(txtPath)) throw new Error("whisper.cpp produced no transcript file");
    const transcript = cleanTranscript(readFileSync(txtPath, "utf8"));
    if (!transcript) throw new Error("no speech detected in the audio");

    log.info("stt.whispercpp", {
      ms: Date.now() - started,
      bytes: bytes.length,
      chars: transcript.length,
      model: status.model,
    });
    return transcript;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
