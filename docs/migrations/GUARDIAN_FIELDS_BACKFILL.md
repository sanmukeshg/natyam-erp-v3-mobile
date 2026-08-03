# Guardian Fields Backfill — Attendance, Certificates, Invoices, Payments

**Utility:** `js/migrations/guardianFieldsBackfillMigration.js`, exporting `backfillGuardianFields()`
**Related:** [PARENT_STUDENT_PORTAL_MILESTONE.md](PARENT_STUDENT_PORTAL_MILESTONE.md) (Milestone P1), `firestore.rules`' `isGuardianOfRecord()`

## Purpose

Milestone P2 gave the Parent/Student Portal guardian read access to Attendance, Certificates, Invoices and Payments, by writing `guardianPhone`/`guardianEmail` directly onto each new record going forward (see `attendance.service.js#postRegister()`, `certificates.service.js#issue()`, `fees.service.js#createInvoice()`, and `ledger.repository.firestore.js#postPayment()`). **Records that already existed before that change do not have these fields**, and a guardian cannot see that older history in the portal until this utility has been run once.

**This is not part of normal application operation.** There is no button, menu entry, or route for it anywhere in the app. It is invoked once, deliberately, from the browser DevTools console by someone who understands what it does — see Migration Steps below.

## Preconditions

- **The Milestone P2 `firestore.rules` changes must already be published** — the four collections' new `isGuardianOfRecord()` read branch. This utility writes through the same repositories the live app uses (`attendance$`, `certificates$`, `invoices$`, `payments$`), bound by the same rules for every other operation it performs, though the actual field-write itself uses each repository's `bulkSetGuardianFields()` (a `writeBatch`, not the normal `update()` path — see Design Notes).
- **You must be signed in as an Administrator** — reading every student (including archived ones) and writing across four collections at this scale is not something any other role is expected to do.
- **Run this when Firestore usage has headroom.** It reads every student once, then every attendance/certificate/invoice/payment record once each, and writes back only the ones that actually need it. At this school's current scale that's inexpensive, but this project has hit its Spark-plan daily quota more than once in one evening from restore attempts alone — don't run this back-to-back with a restore or another heavy operation.

## Migration Steps

1. Open the live application, signed in as an Administrator.
2. Open the browser's DevTools console.
3. **Dry run first** — reports what *would* change, writes nothing:
   ```js
   const { backfillGuardianFields } = await import('/js/migrations/guardianFieldsBackfillMigration.js');
   const preview = await backfillGuardianFields({ dryRun: true });
   console.table(preview.collections);
   ```
4. **Review the dry-run report.** `needingUpdate` per collection is how many records will actually be written; `skippedNoStudent` is a record whose `studentId` no longer resolves to any student at all (a hard-deleted student, most likely) — those are left untouched, since there's no guardian contact to write.
5. **Run it for real:**
   ```js
   const report = await backfillGuardianFields({ dryRun: false });
   console.table(report.collections);
   ```
6. **Read the report** and confirm `updated` matches `needingUpdate` from the dry run for each collection. A single audit log entry (`entity: 'GuardianFieldsBackfill', action: 'run'`) is written summarizing the whole run — visible in Settings → Audit.
7. Sign in as a real guardian (or use the Rules Playground) and confirm their child's older Attendance/Certificates/Fees history is now visible in the portal, not just records created after Milestone P2 shipped.

### Re-running

Safe to run again, any time. A record whose `guardianPhone`/`guardianEmail` already match the current student record is skipped (not rewritten) — so re-running after this has already been done once is cheap and mostly a no-op. Re-running **after correcting a family's phone number or email** in Settings → Students picks up that correction across all of that student's historical records the next time it runs.

## Design Notes

- **One read of every student** (`students$.all({ includeDeleted: true })` — including archived students, since a student who later became inactive can still have real attendance/certificate/invoice/payment history a guardian should be able to see) builds a single `studentId → {guardianPhone, guardianEmail}` map, used for all four collections rather than re-queried per record.
- **Writes go through each repository's `bulkSetGuardianFields()`** — chunked `writeBatch` field-only updates (450 documents per batch, mirroring `replaceAll()`'s own chunking), not each repository's normal `update()` called once per record. This is a deliberate, narrow exception to routing every write through the same per-record path the live app uses: a per-record `update()` (each with its own audit-row write) across potentially thousands of documents would repeat the exact Firestore-quota exhaustion a restore's own per-record writes already caused once this session. The Firestore SDK usage for this still lives entirely inside the repository files, not this migration file — "no Firestore SDK usage outside Repository classes" holds.
- **Every collection is isolated** — a failure reading or writing one (attendance, say) is caught and reported in that collection's own `failures` array; it does not stop certificates/invoices/payments from still being attempted.

## Expected Output

`backfillGuardianFields()` resolves to:

```js
{
  dryRun: false,
  collections: {
    attendance:   { totalRecords: 500, needingUpdate: 500, updated: 500, skippedNoStudent: 0, failures: [] },
    certificates: { totalRecords: 12,  needingUpdate: 12,  updated: 12,  skippedNoStudent: 0, failures: [] },
    invoices:     { totalRecords: 126, needingUpdate: 126, updated: 126, skippedNoStudent: 0, failures: [] },
    payments:     { totalRecords: 103, needingUpdate: 103, updated: 103, skippedNoStudent: 0, failures: [] }
  },
  totalUpdated: 741,
  durationMs: 2140
}
```

## Rollback Considerations

- **This only adds two fields to existing documents — it never removes, replaces, or restructures anything else on them.** There is no meaningful "undo" beyond re-running the underlying student data correction and this utility again if a guardian contact was wrong at the time it ran.
- If a family's guardian contact was incorrect when this ran (so the wrong phone/email got backfilled onto their child's history), correct it in Settings → Students and re-run this utility — see Re-running above.

## Known Limitations

- **No UI.** By design — this is DevTools-console-only, for a deliberate, understood, one-time action.
- **No partial-record repair beyond re-running.** A record whose `studentId` doesn't resolve to any student (`skippedNoStudent`) stays without guardian fields permanently — there is nothing to backfill it from.
