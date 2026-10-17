# Outbound voice notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An audio attachment sent from GHL that isn't ogg/opus arrives on WhatsApp as a voice note (`ptt: true`, with duration and waveform), by transcoding it to ogg/opus with ffmpeg on the bridge, and falls back to a plain audio send on any failure.

**Architecture:** Transcoding happens at dispatch, inside `drainQueue`'s attachment branch (`services/whatsapp-bridge/src/sessions.ts`), after `resolveOutboundAttachment` has fetched, sniffed and size-checked the bytes and before `pacer.recordSend()`. Held messages need no separate path: the app's release pass (`src/lib/ghl-held.ts`) resends the attachment URL through the bridge's normal `/send`, so a released voice note reaches the same dispatch branch and is transcoded there. The transcoder is a buffer-in, buffer-out function (`src/voice-transcode.ts`) with an injected ffmpeg runner. Tests use a fake runner, and one optional integration test runs the real ffmpeg when it's on PATH.

**Tech Stack:** Baileys 7.0.0-rc14 bridge on Node 24, `node:test` via `tsx --test`, ffmpeg (libopus) as a child process, Railway (Nixpacks/Railpack).

**Spec:** `docs/superpowers/specs/2026-10-17-voice-notes-and-message-events-design.md`. This plan covers only its "Outbound voice notes" section. Quoted replies, edits, reactions and deletes are a separate plan.

## Global Constraints

- Transcode only when GHL sends an audio attachment that **isn't ogg/opus**. Output is ogg/opus sent with `ptt: true`.
- ffmpeg runs as a child process with a **hard timeout of 10 seconds** (`VOICE_TRANSCODE_TIMEOUT_MS = 10_000`, a constant, not an env var) and an **input size cap of the existing `WA_MEDIA_MAX_AUDIO_BYTES`** (default 16777216).
- It **reads from a buffer, never a URL**. The fetch stays in `media-fetch.ts` (SSRF guard). ffmpeg only ever gets a private temp file the bridge wrote, with the demuxer named explicitly and `-protocol_whitelist file`.
- **Any failure falls back to today's behaviour (send as an audio file), never to a failed message.** For types that are refused today (webm, wav), see Task 1's table.
- Flag **`WA_VOICE_TRANSCODE_ENABLED`, default off** until ffmpeg is in the image. With it off, outbound media behaves exactly as today, except for the m4a fix in Task 1.
- Oversized input is refused **before ffmpeg runs**.
- Bridge tests run on Node 24: `PATH=/root/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test` in `services/whatsapp-bridge`. CI has no ffmpeg, so every test except the optional integration test uses the fake runner.
- Never log audio bytes, ffmpeg's stderr (it can echo file metadata) or the attachment URL. Log tenant id, message id, sniffed mime, outcome and elapsed ms only.

## Review Focus

1. **A recording made in Safari or the GHL iPhone app (AAC in an MP4 container, `ftyp` brand `M4A `)** sniffs today as `video/mp4` and goes out as a *video*. It must be recognised as audio, transcoded when the flag is on, and sent as an audio file when it's off. Test in Task 1.
2. **Flag on, ffmpeg missing from the image** (wrong builder, or a deploy before Task 4). Every voice note must still send as an audio file, with one warning at boot and no per-message error spam. Tests in Tasks 2 and 3.
3. **A hostile file that sniffs as allowed audio** but carries demuxer tricks (an HLS or concat payload after a valid header). ffmpeg must never open a URL or a second file. Test (an args assertion) in Task 2.
4. **The socket drops during the up-to-10-second transcode.** The row must fail as *not dispatched* (`dispatchAttempted: false`, safe to reissue). Today it would be "uncertain". Test in Task 3.
5. **A timeout or SIGKILL leaving temp files behind**, which slowly fills the container disk. The temp directory must be removed on every exit path. Test in Task 2.

---

### Task 1: Recognise the audio formats GHL can send, and the voice-note send shape

**Files:**
- Modify: `services/whatsapp-bridge/src/media.ts` (`SniffedMime`, `sniffMime`, `ALLOWED_MIME_TYPES`, `extensionForMime`, `mapMimeToBaileysShape`, `buildBaileysMediaContent`)
- Test: `services/whatsapp-bridge/test/media.test.ts`

**Interfaces:**
- Produces:
  - `SniffedMime` gains `"audio/webm" | "audio/mp4" | "audio/wav"`.
  - `sniffMime`: EBML magic `1A 45 DF A3` → `audio/webm`; `RIFF....WAVE` → `audio/wav`; `ftyp` whose major brand (bytes 8–12) is `M4A `, `M4B ` or `M4P ` → `audio/mp4`; any other `ftyp` stays `video/mp4`.
  - `isOggOpus(bytes: Buffer): boolean`: `OggS` at 0 and `OpusHead` at offset 28 (first page).
  - `mapMimeToBaileysShape(mime: SniffedMime | null, opts?: { bytes?: Buffer; voiceTranscode?: boolean }): BaileysMediaMapping | null`. `BaileysMediaMapping` gains `transcodeCandidate?: boolean`.
  - `buildBaileysMediaContent` accepts `resolved.seconds?: number` and `resolved.waveform?: Uint8Array`. When `ptt` is true it sends `mimetype: "audio/ogg; codecs=opus"` and passes `seconds`/`waveform` through when present.

Mapping (flag = `voiceTranscode`):

| Sniffed | Flag off | Flag on |
|---|---|---|
| `audio/ogg` + OpusHead | audio, `ptt: true` (today) | same, no transcode |
| `audio/ogg` without OpusHead (Vorbis) | audio, `ptt: false` | candidate; fallback audio `ptt: false` |
| `audio/mpeg` | audio, `ptt: false` (today) | candidate; fallback audio `ptt: false` |
| `audio/mp4` (m4a) | audio, `ptt: false` (was video) | candidate; fallback audio `ptt: false` |
| `audio/webm`, `audio/wav` | `null`: refused (today) | candidate; fallback `document` (`voice-note.webm` / `.wav`) |

- [ ] **Step 1: Write failing tests** in `test/media.test.ts`:
  - `sniffMime` on the header bytes: an EBML header → `"audio/webm"`; `RIFF\0\0\0\0WAVE` → `"audio/wav"`; `\0\0\0\x20ftypM4A ` → `"audio/mp4"` (Review Focus 1); `\0\0\0\x20ftypisom` → `"video/mp4"` (real video unchanged).
  - `isOggOpus`: an Ogg page with `OpusHead` at 28 → true; `OggS` with `\x01vorbis` at 28 → false.
  - `mapMimeToBaileysShape("audio/webm", { voiceTranscode: false })` → `null`; with `voiceTranscode: true` → `{ kind: "document", transcodeCandidate: true }`.
  - `mapMimeToBaileysShape("audio/mp4")` → `{ kind: "audio", ptt: false }`.
  - `mapMimeToBaileysShape("audio/ogg", { bytes: vorbisBytes })` → `{ kind: "audio", ptt: false }`; with opus bytes → `{ kind: "audio", ptt: true }`.
  - `buildBaileysMediaContent({ kind: "audio", mimetype: "audio/ogg", buffer, ptt: true, seconds: 7, waveform })` deep-equals `{ audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 7, waveform }`.
- [ ] **Step 2: Run** `PATH=/root/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH npm test` in `services/whatsapp-bridge`. Expect the new tests to FAIL (unknown mime values, no `isOggOpus` export).
- [ ] **Step 3: Implement** in `src/media.ts`. Keep the file Baileys-import-free. `extensionForMime` gets `webm`, `m4a`, `wav`. The inbound path shares the allowlist (`media-capture.ts`). Inbound webm/wav/m4a becoming storable is intended and harmless. Say so in the allowlist comment.
- [ ] **Step 4: Run** the bridge tests and `npm run typecheck`. Expect PASS, including the existing `media.test.ts` and `inbound-media.test.ts` cases unchanged.
- [ ] **Step 5: Commit** `bridge: sniff webm, wav and m4a audio; voice-note send shape`.

### Task 2: The transcoder, its flag and the ffmpeg probe

**Files:**
- Create: `services/whatsapp-bridge/src/voice-transcode.ts`
- Modify: `services/whatsapp-bridge/src/config.ts` (`voiceTranscodeEnabled`), `services/whatsapp-bridge/.env.example`
- Test: `services/whatsapp-bridge/test/voice-transcode.test.ts`, `services/whatsapp-bridge/test/voice-transcode.integration.test.ts`, `services/whatsapp-bridge/test/config.test.ts`

**Interfaces:**
- Consumes: Task 1's `SniffedMime`, `isOggOpus`, `sniffMime`.
- Produces (all exported from `src/voice-transcode.ts`):
  - `VOICE_TRANSCODE_TIMEOUT_MS = 10_000`, `MAX_CONCURRENT_TRANSCODES = 2`.
  - `type FfmpegRunResult = { kind: "exited"; code: number } | { kind: "timeout" } | { kind: "spawn_failed" }`
  - `type FfmpegRunner = (args: readonly string[], opts: { timeoutMs: number }) => Promise<FfmpegRunResult>`
  - `realFfmpegRunner: FfmpegRunner`: `spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })`. stderr is drained and discarded. `SIGKILL` at `timeoutMs`, with an `.unref()`'d timer. `ENOENT` → `spawn_failed`.
  - `ffmpegArgs(inputFormat: "matroska" | "mp3" | "mov" | "wav" | "ogg", inPath: string, oggPath: string, pcmPath: string): string[]`. Pinned order: `-hide_banner -nostdin -loglevel error -protocol_whitelist file -f <inputFormat> -i <inPath> -map 0:a:0 -vn -map_metadata -1 -ac 1 -ar 48000 -c:a libopus -b:a 32k -application voip -f ogg <oggPath> -map 0:a:0 -ac 1 -ar 8000 -f s16le <pcmPath>`.
  - `demuxerFor(mime: SniffedMime): "matroska" | "mp3" | "mov" | "wav" | "ogg" | null`
  - `waveformFromPcm(pcm: Buffer, bars?: number /* 64 */): Uint8Array`: per-bar peak of |s16|, scaled 0–100.
  - `type TranscodeResult = { ok: true; buffer: Buffer; seconds: number; waveform: Uint8Array } | { ok: false; reason: "too_large" | "unsupported" | "busy" | "unavailable" | "timeout" | "ffmpeg_failed" | "bad_output" }`
  - `transcodeToVoiceNote(input: Buffer, mime: SniffedMime, opts: { maxInputBytes: number; run: FfmpegRunner; timeoutMs?: number; tmpRoot?: string }): Promise<TranscodeResult>`. Order: size check (`too_large`, no spawn) → `demuxerFor` (`unsupported`) → concurrency (`busy`, no spawn) → `mkdtemp` under `tmpRoot ?? os.tmpdir()` with mode 0700 → write `in` (0600) → run → read both outputs → validate (the ogg must pass `isOggOpus`, must be non-empty and must be ≤ `maxInputBytes`, else `bad_output`) → `rm -rf` the directory in `finally`. `seconds = max(1, ceil(pcm.length / 2 / 8000))`.
  - `probeFfmpeg(run: FfmpegRunner): Promise<boolean>`: runs `-hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=mono -t 0.1 -c:a libopus -f null -`. True iff it exits 0 (this proves both ffmpeg and libopus).
  - `BridgeConfig.voiceTranscodeEnabled: boolean` ← `boolWithDefault("WA_VOICE_TRANSCODE_ENABLED", false)`.

- [ ] **Step 1: Write failing tests** in `test/voice-transcode.test.ts`. They use a fake runner that records args and writes fixture outputs to the paths in its args.
  - `transcode: oversized input is refused before ffmpeg runs`: input of `maxInputBytes + 1` → `{ ok: false, reason: "too_large" }`, runner call count 0.
  - `transcode: a webm input becomes ogg/opus with duration and waveform`: the fake writes an OpusHead Ogg page and 16000 bytes of PCM → `ok: true`, `isOggOpus(buffer)`, `seconds === 1`, `waveform.length === 64`.
  - `transcode: timeout falls back`: the fake returns `{ kind: "timeout" }` → `reason: "timeout"`, and the temp dir under an injected `tmpRoot` is empty afterwards (Review Focus 5).
  - `transcode: corrupt input falls back`: the fake exits 1 → `reason: "ffmpeg_failed"`, temp dir empty.
  - `transcode: ffmpeg missing`: the fake returns `spawn_failed` → `reason: "unavailable"`.
  - `transcode: output that isn't ogg/opus is rejected`: the fake writes MP3 bytes → `reason: "bad_output"`.
  - `transcode: a third concurrent call is busy, not queued`: two calls held on a gate, the third → `reason: "busy"` with no third spawn.
  - `ffmpegArgs: input is a named demuxer on a local file, protocols limited to file` (Review Focus 3): the args contain `-protocol_whitelist file` before `-i`, `-f matroska` immediately before `-i`, `-nostdin`, and no arg matches `/^[a-z]+:\/\//`.
  - `waveformFromPcm`: silence → all 0; full-scale square wave → all 100.
  - `probeFfmpeg`: exit 0 → true; `spawn_failed` → false.
  - In `test/config.test.ts`: `WA_VOICE_TRANSCODE_ENABLED` unset → false; `"true"` → true; `"yes"` → throws (strict boolean, like the media flags).
- [ ] **Step 2: Write the optional integration test** `test/voice-transcode.integration.test.ts`. It runs only when `spawnSync("ffmpeg", ["-version"]).status === 0`, and otherwise calls `test.skip("ffmpeg not on PATH")`. It generates 2 s of webm/opus and 2 s of mp3 with `ffmpeg -f lavfi -i sine=...` into a temp dir, runs `transcodeToVoiceNote(..., { run: realFfmpegRunner })` on each, and asserts `ok`, `isOggOpus` and `seconds === 2`.
- [ ] **Step 3: Run** the bridge tests. Expect FAIL (no module).
- [ ] **Step 4: Implement** `src/voice-transcode.ts` and the config field. In `.env.example`, add `WA_VOICE_TRANSCODE_ENABLED=false` under the media block, with a comment that it needs ffmpeg with libopus in the image (Task 4) and is checked at boot.
- [ ] **Step 5: Run** the bridge tests and `npm run typecheck`. Expect PASS. The integration test runs here (ffmpeg 6.1 with libopus is on this machine) and skips in CI.
- [ ] **Step 6: Commit** `bridge: ffmpeg voice-note transcoder behind WA_VOICE_TRANSCODE_ENABLED`.

### Task 3: Transcode at dispatch, before `recordSend`

**Files:**
- Modify: `services/whatsapp-bridge/src/media-fetch.ts` (`resolveOutboundAttachment` options and result), `services/whatsapp-bridge/src/sessions.ts` (constructor, `drainQueue` attachment branch at the `resolveOutboundAttachment` call, about lines 1497–1528), `services/whatsapp-bridge/src/main.ts` (boot probe and wiring)
- Test: new `services/whatsapp-bridge/test/sessions-voice-note.test.ts` (harness modelled on `test/groups.test.ts`'s `makeHarness`), `services/whatsapp-bridge/test/media-fetch.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `type ResolvedOutboundAttachment = Extract<ResolveOutboundAttachmentResult, { ok: true }>` (exported), and `type TranscodeFailureReason = Extract<TranscodeResult, { ok: false }>["reason"]` (exported from `voice-transcode.ts`).
  - `resolveOutboundAttachment(url, opts & { voiceTranscode?: boolean })`. The ok result gains `transcodeCandidate?: boolean` (from the Task 1 mapping, with the sniffed bytes passed so ogg/Vorbis is detected). A transcode candidate is always capped at `caps.audio`, even when its fallback kind is `document`. Over the cap → `too_large_for_type` (the existing "attachment exceeds the size limit for its type" refusal), so the spec's "oversized input is refused before ffmpeg runs" holds for webm too.
  - `prepareOutboundAudio(resolved: ResolvedOutboundAttachment, deps: { transcode: (buf: Buffer, mime: SniffedMime) => Promise<TranscodeResult> }): Promise<{ content: ResolvedOutboundAttachment & { seconds?: number; waveform?: Uint8Array }; outcome: "transcoded" | "not_needed" | TranscodeFailureReason }>` in `media-fetch.ts`. On `ok`, it returns `{ kind: "audio", mimetype: "audio/ogg", ptt: true, buffer, seconds, waveform }`. On any failure, it returns `resolved` unchanged (the fallback shape from Task 1's table).
  - `SessionManager` constructor gains a 6th optional parameter `mediaDeps: { resolveAttachment?: typeof resolveOutboundAttachment; transcode?: ((buf: Buffer, mime: SniffedMime) => Promise<TranscodeResult>) | null } = {}`. `null` or absent `transcode` means transcoding is off. `main.ts` passes `transcode` only when `config.voiceTranscodeEnabled && await probeFfmpeg(realFfmpegRunner)`. Otherwise it logs once: `voice transcode enabled but ffmpeg with libopus was not found — voice notes will send as audio files` (Review Focus 2).

- [ ] **Step 1: Write failing tests** in `test/sessions-voice-note.test.ts`. They inject a fake `resolveAttachment` (no network) and a fake `transcode`:
  - `drain: an mp3 attachment is transcoded and sent as a voice note`: `sent[0].content` has `ptt: true`, `mimetype: "audio/ogg; codecs=opus"` and `seconds`. `markMessageSent` is called, and `pacer.sentTodayCount() === 1`.
  - `drain: transcode is called before recordSend`: the fake transcode records `pacer.sentTodayCount()` at call time → 0.
  - `drain: a transcode timeout sends the original as an audio file`: `content` is `{ audio, mimetype: "audio/mpeg", ptt: false }`, and the row is sent, not failed.
  - `drain: a webm whose transcode fails goes as a document, never failed`: `content.document` is set, and `fileName === "voice-note.webm"`.
  - `drain: transcode off (no mediaDeps.transcode) leaves mp3 exactly as today`: `ptt: false`, transcode never called (Review Focus 2).
  - `drain: genuine ogg/opus is not transcoded`: transcode call count 0, `ptt: true`.
  - `drain: the socket drops during the transcode`: the fake transcode sets `session.status = "disconnected"` before resolving → `markMessageFailed(id, "session disconnected before sending — not dispatched", false)` and `sent.length === 0` (Review Focus 4).
  - `drain: a held message released by the app reaches the same branch`: accept via `manager.sendAttachment(...)`, which is the entry point `src/lib/ghl-held.ts` uses through `/send`, then drain → transcode called once.
  - In `test/media-fetch.test.ts`: `resolveOutboundAttachment` against the existing loopback fixture serving webm bytes → `{ ok: true, kind: "document", transcodeCandidate: true }` with `voiceTranscode: true`, and `{ ok: false, reason: "unsupported_type" }` without it. With `caps.audio = 100` and 200 bytes of webm → `{ ok: false, reason: "too_large_for_type" }`, even though `caps.document` is larger.
- [ ] **Step 2: Run** the bridge tests. Expect FAIL.
- [ ] **Step 3: Implement.** In `drainQueue`, after a successful resolve: if `resolved.transcodeCandidate && this.transcode`, call `prepareOutboundAudio`, then re-check `session.sock === sock && session.status === "connected"` (the same check and reason string as the typing branch), then `buildBaileysMediaContent`. Log one info line `{ coachId, messageId, mime, outcome, ms }`. `resolveOutboundAttachment` is called through `this.mediaDeps.resolveAttachment ?? resolveOutboundAttachment`, with `voiceTranscode: this.transcode !== null`.
- [ ] **Step 4: Run** the bridge tests and `npm run typecheck`. Expect PASS. The existing `groups.test.ts` and `sessions-*.test.ts` are unchanged (the new constructor parameter is optional).
- [ ] **Step 5: Commit** `bridge: send non-opus audio from GHL as voice notes`.

### Task 4: ffmpeg in the Railway image, docs and the real-device check

**Files:**
- Create: `services/whatsapp-bridge/nixpacks.toml`, `services/whatsapp-bridge/railpack.json`
- Modify: `services/whatsapp-bridge/README.md` ("Run" section and a new "Voice notes" section), `docs/GO-LIVE-FOUNDATION.md` (Railway variables), `docs/superpowers/specs/2026-10-17-voice-notes-and-message-events-design.md` (answer open question 2), `docs/superpowers/plans/2026-10-16-competitor-gap-roadmap.md` (voice notes line)
- Test: `services/whatsapp-bridge/test/deploy-config.test.ts`

**Interfaces:**
- Produces: `nixpacks.toml` = `[phases.setup]` with `aptPkgs = ["...", "ffmpeg"]` (`"..."` keeps Nixpacks' defaults). `railpack.json` = `{ "$schema": "https://schema.railpack.com", "deploy": { "aptPackages": ["ffmpeg"] } }`. The repo has no Dockerfile, and the README describes a Nixpacks build with root `services/whatsapp-bridge`. Both files are shipped because a newer Railway service may build with Railpack. Each builder ignores the other's file.

- [ ] **Step 1: Write a failing test** `deploy-config.test.ts`: `nixpacks.toml` matches `/aptPkgs\s*=\s*\[\s*"\.\.\.",\s*"ffmpeg"\s*\]/`, and `railpack.json` parses with `deploy.aptPackages` containing `"ffmpeg"`.
- [ ] **Step 2: Run**. Expect FAIL. Add both files. Run again. Expect PASS.
- [ ] **Step 3: Docs.** In the README: the flag, the boot probe line, the 10-second timeout, the input cap and the fallback table from Task 1. Flip order: deploy with the flag off → confirm `ffmpeg -version` in a Railway shell → set `WA_VOICE_TRANSCODE_ENABLED=true` → redeploy → check that the boot log has no probe warning. Add the variable to `docs/GO-LIVE-FOUNDATION.md`'s Railway list. Correct the roadmap line ("Other formats go as plain audio files" is wrong for webm, which is refused today).
- [ ] **Step 4: Manual check on a test number (Charlie, not CI).** Record a voice note in GHL Conversations in Chrome and in Safari/the GHL iPhone app, and send it. Note the `mime` in the bridge's `voice transcode` log line, and write it into the spec as the answer to open question 2. If the Safari recording logs `video/mp4`, add its `ftyp` brand to Task 1's audio brand list. On the receiving phone, confirm it plays as a voice note with duration and waveform. Also open an **inbound** voice note in GHL (web and mobile app): it arrives as "Voice note received on WhatsApp" with a signed `.ogg` link. Record whether GHL's player plays it in place. If it doesn't, raise an inbound mp3-transcode follow-up rather than fixing it here.
- [ ] **Step 5: Commit** `deploy: ffmpeg in the bridge image; voice-note docs`.
