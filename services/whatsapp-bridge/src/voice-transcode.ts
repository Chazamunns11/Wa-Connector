/**
 * Voice-note transcoder (docs/superpowers/plans/2026-10-17-voice-notes.md,
 * Task 2) — turns an audio attachment that isn't ogg/opus into the ogg/opus
 * WhatsApp plays as a voice note, plus its duration and waveform.
 *
 * Buffer in, buffer out. The bytes were already fetched (SSRF-guarded),
 * sniffed and size-checked by media-fetch.ts; ffmpeg never sees a URL. It
 * reads one private temp file this module wrote (a 0700 directory, a 0600
 * file), with the demuxer named explicitly and `-protocol_whitelist file`, so
 * neither probing nor a playlist-style input can reach anywhere else. Files
 * rather than pipes because the mp4/mov demuxer needs to seek and there are
 * two outputs (the ogg and the 2 kHz PCM for duration + waveform, both from
 * the same run). The directory is removed in `finally` on every path.
 *
 * Output is bounded: `-t 900` (before `-i`) caps a note at 15 minutes, and
 * both outputs are `stat`ed against their caps before either is read.
 *
 * `-map 0:a:0` makes ffmpeg fail when the input has no audio stream, and
 * `-vn` drops any video, so a WebM video can never become a "voice note".
 *
 * The ffmpeg runner is injected: unit tests use a fake, the integration test
 * and main.ts use `realFfmpegRunner`. Nothing here logs; ffmpeg's stderr is
 * drained and discarded (it can echo file metadata).
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOggOpus, type SniffedMime } from "./media.js";

export const VOICE_TRANSCODE_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT_TRANSCODES = 2;
/** Longest voice note we make: ffmpeg stops reading input after this (`-t` before `-i`). */
export const MAX_VOICE_NOTE_SECONDS = 900;
/** Sample rate of the mono s16le side output used for duration + waveform. */
export const PCM_RATE = 2000;
/** Largest PCM side output a capped run can produce; anything bigger is refused before it is read. */
const MAX_PCM_BYTES = MAX_VOICE_NOTE_SECONDS * PCM_RATE * 2;

export type FfmpegRunResult = { kind: "exited"; code: number } | { kind: "timeout" } | { kind: "spawn_failed" };
export type FfmpegRunner = (args: readonly string[], opts: { timeoutMs: number }) => Promise<FfmpegRunResult>;

/** Spawns ffmpeg with no stdin/stdout, drains and discards stderr, SIGKILLs at `timeoutMs`. */
export const realFfmpegRunner: FfmpegRunner = (args, { timeoutMs }) =>
  new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: FfmpegRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn("ffmpeg", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stderr?.resume();
    child.on("error", () => finish({ kind: "spawn_failed" }));
    child.on("close", (code) => finish(timedOut ? { kind: "timeout" } : { kind: "exited", code: code ?? -1 }));
  });

export type InputDemuxer = "matroska" | "mp3" | "mov" | "wav" | "ogg";

/** Paths go to ffmpeg as `file:` URLs so a name can never be read as another protocol or an option. */
export function ffmpegArgs(inputFormat: InputDemuxer, inPath: string, oggPath: string, pcmPath: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file",
    "-t", String(MAX_VOICE_NOTE_SECONDS), "-f", inputFormat, "-i", `file:${inPath}`,
    "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-ac", "1", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", `file:${oggPath}`,
    "-map", "0:a:0", "-ac", "1", "-ar", String(PCM_RATE), "-f", "s16le", `file:${pcmPath}`,
  ];
}

/** The ffmpeg demuxer for a sniffed audio type; null for anything that isn't audio we transcode. */
export function demuxerFor(mime: SniffedMime): InputDemuxer | null {
  switch (mime) {
    case "audio/webm":
      return "matroska";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
      return "mov";
    case "audio/wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    default:
      return null;
  }
}

/** Per-bar peak of |s16le sample|, scaled 0–100. Bars past the end of a very short clip are 0. */
export function waveformFromPcm(pcm: Buffer, bars = 64): Uint8Array {
  const out = new Uint8Array(bars);
  const samples = Math.floor(pcm.length / 2);
  for (let bar = 0; bar < bars; bar++) {
    const start = Math.floor((bar * samples) / bars);
    const end = Math.floor(((bar + 1) * samples) / bars);
    let peak = 0;
    for (let s = start; s < end; s++) {
      const v = Math.abs(pcm.readInt16LE(s * 2));
      if (v > peak) peak = v;
    }
    out[bar] = Math.min(100, Math.round((peak / 32768) * 100));
  }
  return out;
}

export type TranscodeResult =
  | { ok: true; buffer: Buffer; seconds: number; waveform: Uint8Array }
  | { ok: false; reason: "too_large" | "unsupported" | "busy" | "unavailable" | "timeout" | "ffmpeg_failed" | "bad_output" };

export type TranscodeFailureReason = Extract<TranscodeResult, { ok: false }>["reason"];

let activeTranscodes = 0;

export async function transcodeToVoiceNote(
  input: Buffer,
  mime: SniffedMime,
  opts: {
    maxInputBytes: number;
    run: FfmpegRunner;
    timeoutMs?: number;
    tmpRoot?: string;
    /** Test seam: how outputs are read once their size has been checked. */
    readOutput?: (filePath: string) => Promise<Buffer>;
  }
): Promise<TranscodeResult> {
  if (input.length > opts.maxInputBytes) return { ok: false, reason: "too_large" };
  const demuxer = demuxerFor(mime);
  if (demuxer === null) return { ok: false, reason: "unsupported" };
  if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) return { ok: false, reason: "busy" };

  activeTranscodes += 1;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(opts.tmpRoot ?? tmpdir(), "wa-voice-"));
    await chmod(dir, 0o700);
    const inPath = path.join(dir, "in");
    const oggPath = path.join(dir, "out.ogg");
    const pcmPath = path.join(dir, "out.pcm");
    await writeFile(inPath, input, { mode: 0o600, flag: "wx" });

    const ran = await opts.run(ffmpegArgs(demuxer, inPath, oggPath, pcmPath), {
      timeoutMs: opts.timeoutMs ?? VOICE_TRANSCODE_TIMEOUT_MS,
    });
    if (ran.kind === "spawn_failed") return { ok: false, reason: "unavailable" };
    if (ran.kind === "timeout") return { ok: false, reason: "timeout" };
    if (ran.code !== 0) return { ok: false, reason: "ffmpeg_failed" };

    // Sizes first, so an oversized output is never pulled into memory.
    let oggSize: number;
    let pcmSize: number;
    try {
      [oggSize, pcmSize] = await Promise.all([stat(oggPath).then((st) => st.size), stat(pcmPath).then((st) => st.size)]);
    } catch {
      return { ok: false, reason: "bad_output" };
    }
    if (oggSize === 0 || oggSize > opts.maxInputBytes || pcmSize === 0 || pcmSize > MAX_PCM_BYTES) {
      return { ok: false, reason: "bad_output" };
    }

    const read = opts.readOutput ?? readFile;
    let ogg: Buffer;
    let pcm: Buffer;
    try {
      [ogg, pcm] = await Promise.all([read(oggPath), read(pcmPath)]);
    } catch {
      return { ok: false, reason: "bad_output" };
    }
    if (!isOggOpus(ogg)) return { ok: false, reason: "bad_output" };

    return {
      ok: true,
      buffer: ogg,
      seconds: Math.max(1, Math.ceil(pcmSize / 2 / PCM_RATE)),
      waveform: waveformFromPcm(pcm),
    };
  } finally {
    activeTranscodes -= 1;
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** True iff ffmpeg runs AND can encode libopus — one 0.1 s silent encode to nowhere. */
export async function probeFfmpeg(run: FfmpegRunner): Promise<boolean> {
  const result = await run(
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.1", "-c:a", "libopus", "-f", "null", "-"],
    { timeoutMs: VOICE_TRANSCODE_TIMEOUT_MS }
  );
  return result.kind === "exited" && result.code === 0;
}
