# Push notification sender — UAT5 ENH-510

The server half of push. The app registers devices and stores their
preferences; this decides a notification is due and sends it. Neither does
anything alone.

**This is the project's first Cloud Functions deployment.** It is a separate
deploy from hosting and needs Cloud Scheduler and Cloud Build enabled — the CLI
asks on first run.

## Layout

| File | |
|---|---|
| `index.js` | wiring only — schedules and triggers, no logic |
| `jobs.js` | the four time-based scenarios |
| `triggers.js` | the three event-based ones |
| `lib/push.js` | who to send to, how, and pruning dead tokens |
| `lib/time.js` | Asia/Kolkata date arithmetic |

## What runs when

| Function | Trigger | Sends to |
|---|---|---|
| `classReminders` | every 5 min | the batch's teacher **and the families of its students**, each at their own lead time |
| `ownerDailyDigest` | 07:00 | owners and administrators |
| `attendanceNudge` | hourly | the teacher, 45+ min after a class ended unmarked |
| `attendanceEveningSweep` | 20:00 | owners, one summary of what is still missing |
| `feeReminders` | 09:00 | guardians — due within 3 days, and overdue |
| `payrollReminder` | 1st, 10:00 | owners and administrators, if no run exists |
| `holidayReminders` | 18:00 | everyone, the day **before** a closure |
| `eventReminders` | 18:00 | everyone, three days before a scheduled programme |
| `onPaymentRecorded` | `payments` created | the guardian |
| `onAdmissionCreated` | `admissions` created | staff at that branch |
| `onAdmissionStatusChanged` | `admissions` updated | staff, plus the family on approved / enrolled / rejected |
| `onSessionStatusChanged` | `classSessions` updated | the batch's families and teacher, on cancelled or postponed |
| `onAnnouncementPosted` | `notifications` created | everyone subscribed |

Thirteen functions. Every scenario listed in ENH-510 has a handler.

All schedules are `Asia/Kolkata`. Region is `asia-south1`, matching Firestore's
own location — confirmed from the live project, not guessed.

## Three rules the code enforces

1. **Honour `categories`.** A device that unticked Fees is never sent one.
2. **Prune what FCM rejects.** An unpruned dead token is a permanent failed
   send on every subsequent run.
3. **Write the in-app row too.** Push is a delivery channel, not the record —
   `deliver()` does both so nobody has to remember.

Data-only payloads, never `notification`: a `notification` payload makes the
browser draw the banner itself and ignore `firebase-messaging-sw.js`, losing the
icon, the collapse tag and the deep link.

Nothing throws. A thrown error makes Cloud Functions retry, which for a
notification means sending it twice — worse than not sending it. Failures are
logged; the next run is the retry.

## Testing

```bash
npm install
npm run serve          # emulator — needs Java, which this machine lacks
```

**What has been verified**, 2026-08-08:

- All 13 functions load and export cleanly.
- `lib/time.js` and the reminder-window arithmetic: 27 assertions, all passing —
  including the UTC trap (21:00 IST is still "yesterday" in UTC, which is the
  whole reason that file exists) and proof each window fires exactly once.
- Every field these jobs read exists on live data, with the shapes assumed:
  `days` really is `['Mon','Tue',…]`, times really are `HH:MM`.
- A dry run of the class matcher against the real batches: on a Monday it fires
  at 16:00 for the 16:30 class and 18:00 for the 18:30 class, once each.

**What has NOT been verified:** no function has executed against a database,
emulated or real. Java is not installed, so the Firestore emulator cannot start.
The Firestore reads, the FCM calls and the token pruning are unexercised.

## Before the first deploy

- Install Java and run the emulator, or accept that first contact is production.
- `firebase deploy --only functions` — separate from hosting.
- Watch `firebase functions:log` over the first evening. `classReminders` is the
  one to watch: it runs 288 times a day, and it is the only job whose cost
  scales with the clock rather than with activity.

⚠ If the 5-minute cadence in `index.js` is ever changed, the window in
`jobs.js` must change with it or reminders arrive twice or not at all.

## Known limitation

**Mobile only.** `natyam-admin` has no manifest and no service worker, so a
desktop browser signed into the Admin app cannot receive push. ENH-510 mentions
desktop browsers; the mobile app does run in a desktop browser and can, so the
gap is the Admin surface specifically. Closing it is a port of
`push.service.js`, `firebase-messaging-sw.js` and the settings panel — the
sender needs no changes, since it targets subscriptions rather than apps.
