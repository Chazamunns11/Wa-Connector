/**
 * src/voice-transcode.ts — the ffmpeg voice-note transcoder, driven by a FAKE
 * runner (CI has no ffmpeg). The fake records the args it was given and
 * writes fixture outputs to the ogg/pcm paths in those args, exactly where
 * the real ffmpeg would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOggOpus } from "../src/media.js";
import {
  MAX_CONCURRENT_TRANSCODES,
  MAX_VOICE_NOTE_SECONDS,
  PCM_RATE,
  VOICE_TRANSCODE_TIMEOUT_MS,
  ffmpegArgs,
  probeFfmpeg,
  transcodeToVoiceNote,
  waveformFromPcm,
  type FfmpegRunResult,
  type FfmpegRunner,
} from "../src/voice-transcode.js";

/** A minimal first Ogg page carrying an Opus id header — enough for isOggOpus. */
function oggOpusFixture(): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "ascii");
  header[26] = 1; // one segment in the table
  return Buffer.concat([header, Buffer.from([19]), Buffer.from("OpusHead", "ascii"), Buffer.alloc(11)]);
}

const WEBM_INPUT = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
const MP3_BYTES = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(64)]);

/** One second of silent PCM at PCM_RATE. */
const ONE_SECOND_PCM = 2 * 2000;

/** ffmpegArgs passes paths as `file:` URLs; the fake writes to the bare path. */
function fromFileUrl(arg: string): string {
  assert.ok(arg.startsWith("file:"), arg);
  return arg.slice("file:".length);
}

/** Paths ffmpegArgs puts in the args: the ogg output follows `-f ogg`, the pcm output is last. */
function outputPaths(args: readonly string[]): { ogg: string; pcm: string } {
  const oggFlag = args.findIndex((a, i) => a === "-f" && args[i + 1] === "ogg");
  return { ogg: fromFileUrl(args[oggFlag + 2]!), pcm: fromFileUrl(args[args.length - 1]!) };
}

interface FakeRunner {
  run: FfmpegRunner;
  calls: string[][];
}

function fakeRunner(
  behave: (args: readonly string[]) => Promise<FfmpegRunResult> = async (args) => {
    const { ogg, pcm } = outputPaths(args);
    await writeFile(ogg, oggOpusFixture());
    await writeFile(pcm, Buffer.alloc(ONE_SECOND_PCM));
    return { kind: "exited", code: 0 };
  }
): FakeRunner {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return behave(args);
    },
  };
}

async function withTmpRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "voice-transcode-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("constants: 10s hard timeout, two concurrent transcodes, 15 minute cap, 2 kHz pcm", () => {
  assert.equal(VOICE_TRANSCODE_TIMEOUT_MS, 10_000);
  assert.equal(MAX_CONCURRENT_TRANSCODES, 2);
  assert.equal(MAX_VOICE_NOTE_SECONDS, 900);
  assert.equal(PCM_RATE, 2000);
  assert.equal(ONE_SECOND_PCM, PCM_RATE * 2);
});

test("transcode: oversized input is refused before ffmpeg runs", async () => {
  const fake = fakeRunner();
  const result = await transcodeToVoiceNote(Buffer.alloc(101), "audio/webm", { maxInputBytes: 100, run: fake.run });
  assert.deepEqual(result, { ok: false, reason: "too_large" });
  assert.equal(fake.calls.length, 0);
});

test("transcode: a webm input becomes ogg/opus with duration and waveform", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner();
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(isOggOpus(result.buffer));
    assert.equal(result.seconds, 1);
    assert.equal(result.waveform.length, 64);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]![fake.calls[0]!.indexOf("-i") - 1], "matroska");
    assert.deepEqual(await readdir(root), [], "temp dir removed after success");
  });
});

test("transcode: the runner gets the hard timeout", async () => {
  await withTmpRoot(async (root) => {
    let seenTimeout = -1;
    const fake = fakeRunner();
    const run: FfmpegRunner = (args, opts) => {
      seenTimeout = opts.timeoutMs;
      return fake.run(args, opts);
    };
    await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run, tmpRoot: root });
    assert.equal(seenTimeout, VOICE_TRANSCODE_TIMEOUT_MS);
  });
});

test("transcode: the input file is written privately and is the bytes we were given", async () => {
  await withTmpRoot(async (root) => {
    let inMode = 0;
    let dirMode = 0;
    let inBytes: Buffer | null = null;
    const fake = fakeRunner(async (args) => {
      const inPath = fromFileUrl(args[args.indexOf("-i") + 1]!);
      inMode = (await stat(inPath)).mode & 0o777;
      dirMode = (await stat(path.dirname(inPath))).mode & 0o777;
      inBytes = await readFile(inPath);
      return { kind: "exited", code: 1 };
    });
    await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.equal(inMode, 0o600);
    assert.equal(dirMode, 0o700);
    assert.deepEqual(inBytes, WEBM_INPUT);
  });
});

test("transcode: timeout falls back", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async () => ({ kind: "timeout" }));
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.deepEqual(result, { ok: false, reason: "timeout" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: corrupt input falls back", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async () => ({ kind: "exited", code: 1 }));
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.deepEqual(result, { ok: false, reason: "ffmpeg_failed" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: ffmpeg missing", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async () => ({ kind: "spawn_failed" }));
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: output that isn't ogg/opus is rejected", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async (args) => {
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, MP3_BYTES);
      await writeFile(pcm, Buffer.alloc(ONE_SECOND_PCM));
      return { kind: "exited", code: 0 };
    });
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.deepEqual(result, { ok: false, reason: "bad_output" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: missing or oversized output is rejected", async () => {
  await withTmpRoot(async (root) => {
    const noOutput = fakeRunner(async () => ({ kind: "exited", code: 0 }));
    const r1 = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: noOutput.run, tmpRoot: root });
    assert.deepEqual(r1, { ok: false, reason: "bad_output" });

    const tooBig = fakeRunner(async (args) => {
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, Buffer.concat([oggOpusFixture(), Buffer.alloc(WEBM_INPUT.length)]));
      await writeFile(pcm, Buffer.alloc(ONE_SECOND_PCM));
      return { kind: "exited", code: 0 };
    });
    const r2 = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: WEBM_INPUT.length, run: tooBig.run, tmpRoot: root });
    assert.deepEqual(r2, { ok: false, reason: "bad_output" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: an oversized pcm output is refused without ever being read", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async (args) => {
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, oggOpusFixture());
      await writeFile(pcm, Buffer.alloc(MAX_VOICE_NOTE_SECONDS * PCM_RATE * 2 + 1));
      return { kind: "exited", code: 0 };
    });
    const read: string[] = [];
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", {
      maxInputBytes: 1024 * 1024,
      run: fake.run,
      tmpRoot: root,
      readOutput: async (p) => {
        read.push(p);
        return readFile(p);
      },
    });
    assert.deepEqual(result, { ok: false, reason: "bad_output" });
    assert.deepEqual(read, [], "no output is read once a size check fails");
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: a pcm output at exactly the 15 minute cap is accepted", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async (args) => {
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, oggOpusFixture());
      await writeFile(pcm, Buffer.alloc(MAX_VOICE_NOTE_SECONDS * PCM_RATE * 2));
      return { kind: "exited", code: 0 };
    });
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.seconds, MAX_VOICE_NOTE_SECONDS);
  });
});

test("transcode: an empty pcm output is rejected", async () => {
  await withTmpRoot(async (root) => {
    const fake = fakeRunner(async (args) => {
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, oggOpusFixture());
      await writeFile(pcm, Buffer.alloc(0));
      return { kind: "exited", code: 0 };
    });
    const result = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root });
    assert.deepEqual(result, { ok: false, reason: "bad_output" });
    assert.deepEqual(await readdir(root), []);
  });
});

test("transcode: a type with no audio demuxer is unsupported, ffmpeg never runs", async () => {
  const fake = fakeRunner();
  const result = await transcodeToVoiceNote(Buffer.alloc(10), "image/png", { maxInputBytes: 100, run: fake.run });
  assert.deepEqual(result, { ok: false, reason: "unsupported" });
  assert.equal(fake.calls.length, 0);
});

test("transcode: a third concurrent call is busy, not queued", async () => {
  await withTmpRoot(async (root) => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let entered = 0;
    let bothEntered!: () => void;
    const bothIn = new Promise<void>((resolve) => (bothEntered = resolve));
    const fake = fakeRunner(async (args) => {
      entered += 1;
      if (entered === 2) bothEntered();
      await gate;
      const { ogg, pcm } = outputPaths(args);
      await writeFile(ogg, oggOpusFixture());
      await writeFile(pcm, Buffer.alloc(ONE_SECOND_PCM));
      return { kind: "exited", code: 0 };
    });
    const opts = { maxInputBytes: 1024 * 1024, run: fake.run, tmpRoot: root };
    const first = transcodeToVoiceNote(WEBM_INPUT, "audio/webm", opts);
    const second = transcodeToVoiceNote(WEBM_INPUT, "audio/webm", opts);
    await bothIn;
    const third = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", opts);
    assert.deepEqual(third, { ok: false, reason: "busy" });
    assert.equal(fake.calls.length, 2, "no third spawn");
    open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    // Slots are released afterwards.
    const after = await transcodeToVoiceNote(WEBM_INPUT, "audio/webm", opts);
    assert.equal(after.ok, true);
  });
});

test("ffmpegArgs: input is a named demuxer on a local file, protocols limited to file", () => {
  const args = ffmpegArgs("matroska", "/tmp/x/in", "/tmp/x/out.ogg", "/tmp/x/out.pcm");
  const i = args.indexOf("-i");
  const whitelist = args.indexOf("-protocol_whitelist");
  assert.ok(whitelist >= 0 && whitelist < i);
  assert.equal(args[whitelist + 1], "file");
  const cap = args.indexOf("-t");
  assert.ok(cap >= 0 && cap < i, "-t is an input option, before -i");
  assert.equal(args[cap + 1], "900");
  assert.equal(args[i - 2], "-f");
  assert.equal(args[i - 1], "matroska");
  assert.ok(args.includes("-nostdin"));
  assert.ok(args.includes("-vn"));
  for (const arg of args) assert.doesNotMatch(arg, /^[a-z]+:\/\//);
  assert.deepEqual(args, [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file",
    "-t", "900", "-f", "matroska", "-i", "file:/tmp/x/in",
    "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-ac", "1", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "file:/tmp/x/out.ogg",
    "-map", "0:a:0", "-ac", "1", "-ar", "2000", "-f", "s16le", "file:/tmp/x/out.pcm",
  ]);
});

test("waveformFromPcm: silence is all 0, a full-scale square wave is all 100", () => {
  const silence = waveformFromPcm(Buffer.alloc(ONE_SECOND_PCM));
  assert.equal(silence.length, 64);
  assert.ok(silence.every((v) => v === 0));

  const square = Buffer.alloc(ONE_SECOND_PCM);
  for (let s = 0; s < square.length / 2; s++) square.writeInt16LE(s % 2 === 0 ? 32767 : -32768, s * 2);
  const loud = waveformFromPcm(square);
  assert.equal(loud.length, 64);
  assert.ok(loud.every((v) => v === 100));

  assert.equal(waveformFromPcm(Buffer.alloc(0)).length, 64, "empty pcm still yields 64 bars");
});

test("probeFfmpeg: exit 0 -> true; spawn_failed -> false", async () => {
  const ok = fakeRunner(async () => ({ kind: "exited", code: 0 }));
  assert.equal(await probeFfmpeg(ok.run), true);
  assert.ok(ok.calls[0]!.includes("libopus"));
  assert.ok(ok.calls[0]!.includes("anullsrc=r=48000:cl=mono"));
  assert.equal(await probeFfmpeg(fakeRunner(async () => ({ kind: "spawn_failed" })).run), false);
  assert.equal(await probeFfmpeg(fakeRunner(async () => ({ kind: "exited", code: 1 })).run), false);
});
