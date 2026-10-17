/**
 * src/voice-transcode.ts against the REAL ffmpeg — runs only when ffmpeg is
 * on PATH (it is not in CI; every other transcoder test uses a fake runner).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOggOpus, sniffMime } from "../src/media.js";
import { probeFfmpeg, realFfmpegRunner, transcodeToVoiceNote } from "../src/voice-transcode.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

if (!hasFfmpeg) {
  test.skip("ffmpeg not on PATH");
} else {
  test("integration: probeFfmpeg finds ffmpeg with libopus", async () => {
    assert.equal(await probeFfmpeg(realFfmpegRunner), true);
  });

  for (const [label, file, codecArgs] of [
    ["webm/opus", "in.webm", ["-c:a", "libopus", "-f", "webm"]],
    ["mp3", "in.mp3", ["-c:a", "libmp3lame", "-f", "mp3"]],
  ] as const) {
    test(`integration: 2s of ${label} becomes a 2s ogg/opus voice note`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "voice-transcode-it-"));
      try {
        const src = path.join(dir, file);
        const gen = spawnSync("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...codecArgs, src,
        ]);
        assert.equal(gen.status, 0, "fixture generation");
        const input = await readFile(src);
        const mime = sniffMime(input);
        assert.ok(mime);
        const result = await transcodeToVoiceNote(input, mime, { maxInputBytes: 16 * 1024 * 1024, run: realFfmpegRunner });
        assert.equal(result.ok, true, JSON.stringify(result.ok ? "" : result));
        if (!result.ok) return;
        assert.ok(isOggOpus(result.buffer));
        assert.equal(result.seconds, 2);
        assert.equal(result.waveform.length, 64);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("integration: a 16 minute recording is too_long, not truncated to 15", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-transcode-it-"));
    try {
      const src = path.join(dir, "long.mp3");
      const gen = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=960",
        "-ac", "1", "-ar", "8000", "-c:a", "libmp3lame", "-b:a", "8k", "-f", "mp3", src,
      ]);
      assert.equal(gen.status, 0, "fixture generation");
      const input = await readFile(src);
      // A generous timeout: this checks the cap, not speed (15 min of audio takes ~7 s to encode here).
      const result = await transcodeToVoiceNote(input, "audio/mpeg", {
        maxInputBytes: 16 * 1024 * 1024,
        run: realFfmpegRunner,
        timeoutMs: 60_000,
      });
      assert.deepEqual(result, { ok: false, reason: "too_long" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("integration: realFfmpegRunner kills ffmpeg at the timeout", async () => {
    const started = Date.now();
    const result = await realFfmpegRunner(
      ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-f", "null", "-"],
      { timeoutMs: 50 }
    );
    assert.deepEqual(result, { kind: "timeout" });
    assert.ok(Date.now() - started < 5_000, "killed, not run to completion");
  });

  test("integration: a video-only webm never becomes a voice note", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-transcode-it-"));
    try {
      const src = path.join(dir, "video.webm");
      const gen = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
        "-c:v", "libvpx", "-f", "webm", src,
      ]);
      if (gen.status !== 0) {
        t.skip("no libvpx");
        return;
      }
      const input = await readFile(src);
      const result = await transcodeToVoiceNote(input, "audio/webm", { maxInputBytes: 16 * 1024 * 1024, run: realFfmpegRunner });
      assert.deepEqual(result, { ok: false, reason: "ffmpeg_failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
