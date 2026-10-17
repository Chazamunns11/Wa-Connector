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

  test("integration: a video-only webm never becomes a voice note", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "voice-transcode-it-"));
    try {
      const src = path.join(dir, "video.webm");
      const gen = spawnSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5",
        "-c:v", "libvpx", "-f", "webm", src,
      ]);
      if (gen.status !== 0) return; // no libvpx in this ffmpeg build — nothing to check
      const input = await readFile(src);
      const result = await transcodeToVoiceNote(input, "audio/webm", { maxInputBytes: 16 * 1024 * 1024, run: realFfmpegRunner });
      assert.deepEqual(result, { ok: false, reason: "ffmpeg_failed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
