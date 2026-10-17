# Voice notes: real-device check (manual, Charlie)

Not run in CI (CI has no ffmpeg). Do this on a test number after the flip
order in `services/whatsapp-bridge/README.md` ("Voice notes") is done:
ffmpeg present, `WA_VOICE_TRANSCODE_ENABLED=true`, redeployed, no probe warning
in the boot log.

## Outbound

1. In GHL Conversations in **Chrome**, record a voice note and send it to the
   test number.
2. Repeat in **Safari** or the **GHL iPhone app**.
3. For each, find the bridge log line `outbound attachment` for your test
   message in Railway (one per attachment sent) and note `sniffedMime`, `kind`
   and `ptt`. If it was transcoded, the line `outbound voice note prepared`
   just before it gives the `outcome`. (Log lines carry no audio, no file name
   and no URL.)
4. On the receiving phone, confirm it shows as a voice note with a duration
   and a waveform, and plays.
5. Write the two `sniffedMime` values into open question 2 of
   `2026-10-17-voice-notes-and-message-events-design.md`.
6. If `sniffedMime` is `video/mp4`, note `ftypBrand` and add it to the m4a
   brand list (`M4A_MAJOR_BRANDS` in `services/whatsapp-bridge/src/media.ts`):
   the recording is being treated as a video and sent wrongly. Without the
   log, download the file from GHL and run `xxd file | head -1`: the brand is
   the 4 characters right after `ftyp` (bytes 8 to 11).
7. Also send an mp3 and confirm the same voice-note result. If anything fails,
   the message still arrives as an audio file (or a document for webm/wav);
   note the `outcome` value.

## Inbound

1. From the test phone, send a voice note to the connected number.
2. In GHL, open the conversation on **web** and in the **mobile app**. It
   arrives as "Voice note received on WhatsApp" with a signed `.ogg` link.
3. Record whether GHL's player plays it in place. If it does not, raise an
   inbound mp3-transcode follow-up. Do not fix it as part of this work.

## Record the results

| Check | Chrome | Safari / iPhone |
| --- | --- | --- |
| Outbound `sniffedMime` (and `ftypBrand`) | | |
| Outbound `outcome` | | |
| Shows as voice note with waveform | | |
| Inbound plays in GHL (web / mobile) | | |
