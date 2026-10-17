# Missed calls and read receipts: real-device check (manual, Charlie)

Not run in CI. Do this after migration 0010 is applied. Both parts use a spare
number and a sandbox GHL sub-account, never a customer's.

## Missed calls

Set `WA_MISSED_CALLS_ENABLED=true` on the bridge (Railway) and redeploy. Call
the spare number from a second phone.

| # | Do this | Expect |
| --- | --- | --- |
| 1 | Ring and don't answer | One "Missed WhatsApp call" message in the GHL conversation |
| 2 | Ring and answer on the phone | No message |
| 3 | Decline the call | One message |
| 3b | Ring and decline it on the coach's phone (the spare number's own handset) | One message, on the caller's contact (not on the coach's own number) |
| 4 | Ring five times in a row | One message (limit is one per caller per 10 minutes) |
| 5 | Make a video call and don't answer | One "Missed WhatsApp video call" message |
| 6 | With the bridge offline, ring the number, then bring the bridge back | Record what happens (see below) |
| 7 | Turn the app's cron off (or keep the bridge's row unprocessed) for more than 6 hours, then let it run | No GHL message for that call: it is closed as `missed_call_stale` |

For check 6: the bridge only logs a call it saw ring (an `offer`). Record
whether Baileys replays the `offer` after reconnecting (its `offline: true`
path). If it does not, calls that ring while the bridge is offline are not
logged, and that goes in the docs as a known gap.

## Read receipts

Set `WA_READ_RECEIPTS_ENABLED=true` on the bridge (Railway) and
`GHL_READ_RECEIPTS_ENABLED=true` on the app (Vercel), in the sandbox
sub-account only. The app reports on its cron pass, so allow a few minutes.

| # | Do this | Expect |
| --- | --- | --- |
| 1 | Send a message from GHL to the spare number's contact; read it on the contact's phone | GHL shows delivered, then read |
| 2 | Check that GHL's message status endpoint accepts `read` | Record yes or no. If it refuses, leave `GHL_READ_RECEIPTS_ENABLED` off and note the response |
| 3 | Use a contact with read receipts turned off | Delivered only, never read |
| 4 | Send to a group | No receipts recorded (one-to-one only) |

If GHL answers a `read` status with a 401, the app retries it on the next
pass. Any other 4xx is final and the row is marked "GHL refused read status".

## Record the results

| Check | Result |
| --- | --- |
| Missed calls 1 to 5 (and 3b) as expected | |
| Offline call: Baileys replays `offer`? | |
| GHL accepts `read`? | |
| Read-receipts-off contact shows delivered only | |
