# Voice notes: real-device check (manual, Charlie)

Not run in CI (CI has no ffmpeg). Do this on a test number after the flip
order in `services/whatsapp-bridge/README.md` ("Voice notes") is done:
ffmpeg present, `WA_VOICE_TRANSCODE_ENABLED=true`, redeployed, no probe warning
in the boot log.

## Outbound

1. In GHL Conversations in **Chrome**, record a voice note and send it to the
   test number.
2. Repeat in **Safari** or the **GHL iPhone app**.
3. For each, find the bridge log line `outbound voice note prepared` in Railway
   and note `mime` and `outcome`. (Log lines carry no audio and no URL.)
4. On the receiving phone, confirm it shows as a voice note with a duration
   and a waveform, and plays.
5. Write the two `mime` values into open question 2 of
   `2026-10-17-voice-notes-and-message-events-design.md`.
6. If the Safari recording logs `video/mp4`, add its `ftyp` brand to the audio
   brand list in `sniffMime` (`services/whatsapp-bridge/src/media.ts`), since
   it is being treated as a video and refused or sent wrongly.
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
| Outbound `mime` | | |
| Outbound `outcome` | | |
| Shows as voice note with waveform | | |
| Inbound plays in GHL (web / mobile) | | |
