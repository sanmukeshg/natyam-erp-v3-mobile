# Push notifications — what exists, and what still has to be built

UAT5 ENH-510. The client half is implemented and deployed with the app. **No
notification can be delivered yet**, because nothing sends one. This document is
the contract the sender has to meet.

## What is built

| Piece | File | Does |
|---|---|---|
| Capability check | `js/services/push.service.js` → `pushSupport()` | Reports whether this browser can do push, and which requirement is missing when it cannot |
| Enable / disable | `push.service.js` → `enablePush()` / `disablePush()` | Asks permission, gets an FCM token, stores or deletes the subscription |
| Preferences | `push.service.js` → `updatePushPreferences()` | Categories and class-reminder lead time, per device |
| Storage | `js/data/pushSubscriptions.repository.firestore.js` | One document per device, keyed by FCM token |
| Background handler | `firebase-messaging-sw.js` | Draws the banner, and focuses an existing tab on tap |
| Foreground handler | `push.service.js` → `listenInForeground()` | Raises an in-app toast instead of a banner |
| Settings UI | `js/modules/mobile/profile.page.js` | "Notifications on this device" |
| Rules | `firestore.rules` → `/pushSubscriptions` | Read/write only your own token; no listing for anyone |

## Two things must happen before anything is delivered

### 1. A VAPID key

Firebase Console → Project settings → Cloud Messaging → **Web Push
certificates** → Generate key pair. Paste the public key into `vapidKey` in
`js/config/firebase.config.js`.

Until then `pushSupport()` reports `configured: false` and the settings screen
says push is not set up for this school. That is deliberate — there is no point
offering a switch while there is nothing to send.

### 2. A sender

Cloud Functions on the `natyam-erp` project (Blaze, already enabled). It needs
scheduled functions for the time-based reminders and Firestore triggers for the
event-based ones.

## The subscription document

`pushSubscriptions/{fcmToken}`

```js
{
  userId:    'someone@example.com',  // the users doc id — an EMAIL
  userName:  'Surekha A',
  role:      'teacher_reception',    // null for a guardian
  branchId:  'BRN-KDP',              // active branch at the time, or null
  staffId:   'STF-SUREKHA',          // the staff record, or null — see below
  categories: ['classes', 'fees'],   // which kinds this device wants
  leadMinutes: 30,                   // how early a class reminder arrives
  enabled:   true,
  userAgent: '…',
  updatedAt: '2026-08-07T…'
}
```

**`staffId` is the one field a class reminder cannot work without.** A batch
stores `teacherId`, which is a *staff* document id (`STF-SUREKHA`), while
`userId` here is an email. The two id spaces are joined by the staff record's
`email` field and nowhere else — see UAT5 ENH-512. A sender matching batches to
people must use `staffId`, never `userId`.

## What the sender should send

Use a **data-only** payload, not `notification`. A `notification` payload makes
the browser draw the banner itself and ignore `firebase-messaging-sw.js`, which
means losing the icon, the collapse tag and the deep link.

```js
{
  token: '<the document id>',
  data: {
    title: 'Class in 30 minutes',
    body:  'Kondapur Senior Batch, 18:30',
    link:  '/#/timetable',      // where tapping lands
    tag:   'class-BAT-KDP-SR-2026-08-07',  // repeats collapse onto each other
    category: 'classes'
  }
}
```

`tag` matters more than it looks. Three overdue-fee reminders for one invoice
should replace one another rather than stack into a wall of identical banners.

## The scenarios ENH-510 asks for

| Category | Trigger | Recipients |
|---|---|---|
| `classes` | Scheduled, `leadMinutes` before a session | Subscriptions whose `staffId` matches `batch.teacherId`; owners get a daily digest |
| `attendance` | Scheduled, after a class ends with no register | The batch's `staffId`, then owners if still missing |
| `fees` | Scheduled for due/overdue; Firestore trigger on payment | Guardian subscriptions matched by `userId` = `student.guardianEmail` |
| `admissions` | Firestore trigger on `/admissions` create and status change | Staff with `admission.view`; the applicant on their own application |
| `finance` | Scheduled payroll reminder | `role in ['administrator','owner_accountant']` |
| `announcements` | Firestore trigger on an announcement | Everyone subscribed to the category |

## Rules for the sender to respect

- **Honour `categories`.** A device that unticked Fees must not be sent one.
- **Delete tokens FCM rejects.** An `unregistered` or `invalid-argument` response
  means the app was uninstalled or the token rotated. A token nobody prunes is a
  permanent failed send on every run.
- **Do not read this collection from a client.** The rules deliberately forbid
  listing it; a Cloud Function bypasses rules with admin credentials, which is
  the only correct place for that power.
- **Write the in-app notification too.** Push is a delivery channel, not the
  record. `notifications.service.js` owns what the bell shows, and a push
  without a matching in-app row is a notification that vanishes when dismissed.

## Testing without a sender

Firebase Console → Messaging → Create campaign → Firebase Notification
messages → "Send test message", pasting a token from `pushSubscriptions`. That
path uses a `notification` payload, so the banner comes from the browser rather
than from `firebase-messaging-sw.js` — enough to prove the token and the
permission work, not enough to prove the deep link does.
