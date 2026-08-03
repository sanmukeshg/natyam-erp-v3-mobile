# Admission Data Migration — IndexedDB → Cloud Firestore

**Utility:** `js/migrations/admissionDataMigration.js`, exporting `migrateAdmissionsToFirestore()`
**Related:** [ADMISSIONS_MODULE_MIGRATION.md](ADMISSIONS_MODULE_MIGRATION.md) (the code-level migration this data migration follows), [STUDENT_DATA_MIGRATION.md](STUDENT_DATA_MIGRATION.md) (the template this follows), [ADR-014](../architecture/adr/ADR-014-Firebase-Authentication-and-Firestore.md)

## Purpose

Milestone 5 moved the Admissions *module* to Cloud Firestore, but Firestore's `admissions` collection starts empty — nothing was copied automatically. This is a **one-time utility** to carry a school's real, existing application records out of a browser's local IndexedDB and into Firestore, so that data doesn't have to be typed back in by hand.

**This is not part of normal application operation.** There is no button, menu entry, or route for it anywhere in the app. It is invoked once, deliberately, from the browser DevTools console by someone who understands what it does — see Migration Steps below.

## Preconditions

- **You must run this from the browser that actually holds the real data.** IndexedDB is private to one browser profile on one device. If the school's real applications were entered through the pre-Firestore version of the app on, say, the front-desk computer, this must be run *from that computer's browser*, not from any other device.
- **You must be signed in as an Administrator or Teacher & Reception account** before running this — `firestore.rules` requires `admission.edit` (which both those roles hold) to create an `admissions` document, and the migration writes through the same repository the live app uses, so it is bound by the same rules.
- **`firestore.rules` must already be published**, including the `admissions` collection rules from Milestone 5 — otherwise every write in this migration will fail with a permissions error.
- **Run it once per browser/device that holds real data.** If a school's applications are split across two devices' local databases, run this once from each.

## Migration Steps

1. Open the live application in the browser that holds the real data, and sign in as an Administrator (or Teacher & Reception).
2. Open the browser's DevTools console.
3. **Dry run first** — validates everything and reports what *would* happen, writes nothing:
   ```js
   const { migrateAdmissionsToFirestore } = await import('/js/migrations/admissionDataMigration.js');
   const preview = await migrateAdmissionsToFirestore({ dryRun: true });
   console.table(preview);
   console.log(preview.validationFailures);
   ```
4. **Review the dry-run report.** If `validationFailures` is non-empty, decide whether to fix that data in the app first (e.g. a missing guardian phone) and re-run the dry run, or accept that those specific records will not migrate.
5. **Run it for real:**
   ```js
   const report = await migrateAdmissionsToFirestore({ dryRun: false });
   console.table(report);
   ```
6. **Read the report** (see Expected Output below) and confirm `migrated` matches what you expected. A single audit log entry (`entity: 'Admission', action: 'migrateFromIndexedDB'`) is written summarizing the run — visible in Settings → Audit.
7. Spot-check a handful of migrated applications in the app itself: their `applicationNo` and status should be unchanged, and their history (applied-on date) should look right.

### Re-running after a partial or failed attempt

The utility is safe to run again. Records already present in Firestore (matched by `applicationNo`) are skipped by default, not duplicated — running it twice with `{ overwrite: false }` (the default) is a no-op for anything that already migrated successfully the first time.

### Overwriting an already-migrated record

Not done by default:
```js
const report = await migrateAdmissionsToFirestore({ overwrite: true });
```
When `overwrite: true`, a legacy record whose `applicationNo` matches an existing Firestore admission **updates** that Firestore document (through the normal `admissions$.update()` path) instead of being skipped — counted separately in the report as `overwritten`, not `migrated`. The existing Firestore document's `createdAt`/`createdBy` are preserved; every other field is replaced with the IndexedDB source's values.

## Validation Process

Before any record is written, in this order:

1. **Duplicate check by `applicationNo`** against a single snapshot of all existing Firestore admissions taken at the start of the run (not one query per record). A match is skipped (or updated, if `overwrite: true`).
2. **Required-field validation** — reuses `admissions$.validate()`, the exact same rule the live app enforces on every create/edit: name, branch, guardian phone, and a recognised level.
3. **Firestore write** — the actual `addDoc`/`updateDoc` call. A failure here (network, permissions, quota) is caught and logged separately from a validation failure.

**A failure at any stage logs that one record and continues with the rest of the batch — the run never stops early.**

## Expected Output

`migrateAdmissionsToFirestore()` resolves to a report object:

```js
{
  totalIndexedDb: 214,          // every record read from IndexedDB, including rejected/archived applications
  migrated: 201,                 // newly created in Firestore
  overwritten: 0,                 // updated an existing Firestore record (only when overwrite: true)
  skippedDuplicates: 8,           // applicationNo already existed in Firestore; left untouched
  validationFailures: [           // required-field problems — nothing written
    { id: 'ADM-...', applicationNo: 'NAT/APP/25/0031', name: 'Example Name', reason: 'A parent or guardian contact number is required.' }
  ],
  writeFailures: [                 // validation passed but the Firestore write itself failed
    { id: 'ADM-...', applicationNo: 'NAT/APP/25/0088', name: 'Example Name', reason: '...' }
  ],
  durationMs: 3120,
  dryRun: false,
  overwrite: false
}
```

`totalIndexedDb` should always equal `migrated + overwritten + skippedDuplicates + validationFailures.length + writeFailures.length`.

## Rollback Considerations

- **This utility only writes to Firestore — it never modifies or deletes anything in IndexedDB.** The original local data is completely untouched by running it, at any point, in either direction.
- **To undo a Firestore-side migration**, the created/updated Firestore documents would need to be deleted or reverted by hand (Firebase Console, or a small one-off script) — this utility does not currently include an "undo" mode.
- **If `overwrite: true` was used** and it changed records incorrectly, there is no automatic revert — this is precisely why `overwrite` defaults to `false` and why a dry run is strongly recommended first.

## Known Limitations

- **No UI.** By design — this is DevTools-console-only.
- **Per-browser, not centralized.** Because it reads local IndexedDB, it must be run from every device that holds real data separately.
- **No partial-record repair.** A record that fails validation is reported, not auto-corrected.
- **Enrolled applications carry a `studentId` set by `enrolApplicant()` at the time they were enrolled — this is not remapped by this utility.** If the referenced student is separately carried over by `migrateStudentsToFirestore()` (Milestone 3's utility), that student gets a brand-new Firestore document id (per the Document Identifier Standard, `importLegacyRecord()` never reuses the old IndexedDB id) — the migrated admission's `studentId` still holds the *old* IndexedDB id, which no longer resolves to anything in Firestore. Confirmed by inspection that **nothing in the live application currently reads `studentId` back off an admission record** — it's written once at enrolment and never queried again — so this has no functional impact on the app today. It would matter only if a future feature follows this link (e.g. "open the student this application became" from the admissions screen); building a remap at that point would need to cross-reference the old and new student records by their unchanged `admissionNo`, since neither migration utility currently exposes an old-id → new-id map directly.
