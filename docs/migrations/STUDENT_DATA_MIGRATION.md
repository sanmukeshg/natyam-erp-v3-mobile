# Student Data Migration — IndexedDB → Cloud Firestore

**Utility:** `js/migrations/studentDataMigration.js`, exporting `migrateStudentsToFirestore()`
**Related:** [STUDENT_MODULE_MIGRATION.md](STUDENT_MODULE_MIGRATION.md) (the code-level migration this data migration follows), [ADR-014](../architecture/adr/ADR-014-Firebase-Authentication-and-Firestore.md)

## Purpose

Milestone 3 moved the Students *module* to Cloud Firestore, but Firestore's `students` collection starts empty — nothing was copied automatically. This is a **one-time utility** to carry a school's real, existing student records out of a browser's local IndexedDB and into Firestore, so that data doesn't have to be typed back in by hand.

**This is not part of normal application operation.** There is no button, menu entry, or route for it anywhere in the app. It is invoked once, deliberately, from the browser DevTools console by someone who understands what it does — see Migration Steps below.

## Preconditions

- **You must run this from the browser that actually holds the real data.** IndexedDB is private to one browser profile on one device. If the school's real student records were entered through the pre-Firestore version of the app on, say, the front-desk computer, this must be run *from that computer's browser*, not from any other device — no other device has that IndexedDB data to read.
- **You must be signed in as an Administrator or Teacher & Reception account** before running this — `firestore.rules` requires `student.edit` (which both those roles hold) to create or update a `students` document, and the migration writes through the same repository the live app uses, so it is bound by the same rules.
- **`firestore.rules` must already be published**, including the `students` collection rules from Milestone 3 — otherwise every write in this migration will fail with a permissions error.
- **Run it once per browser/device that holds real data.** If a school's students are split across two devices' local databases (e.g. two branches that were never synced), run this once from each, since each only sees its own IndexedDB.

## Migration Steps

1. Open the live application in the browser that holds the real data, and sign in as an Administrator (or Teacher & Reception).
2. Open the browser's DevTools console.
3. **Dry run first** — validates everything and reports what *would* happen, writes nothing:
   ```js
   const { migrateStudentsToFirestore } = await import('/js/migrations/studentDataMigration.js');
   const preview = await migrateStudentsToFirestore({ dryRun: true });
   console.table(preview);
   console.log(preview.validationFailures);
   ```
4. **Review the dry-run report.** If `validationFailures` is non-empty, decide whether to fix that data in the app first (edit the record so it passes validation, e.g. a missing guardian phone) and re-run the dry run, or accept that those specific records will not migrate.
5. **Run it for real:**
   ```js
   const report = await migrateStudentsToFirestore({ dryRun: false });
   console.table(report);
   ```
6. **Read the report** (see Expected Output below) and confirm `migrated` matches what you expected. A single audit log entry (`entity: 'Student', action: 'migrateFromIndexedDB'`) is written summarizing the run — visible in Settings → Audit.
7. Spot-check a handful of migrated students in the app itself: their `admissionNo` should be unchanged, they should have a new `studentCode`, and their history (creation date) should look right.

### Re-running after a partial or failed attempt

The utility is safe to run again. Records already present in Firestore (matched by `admissionNo`) are skipped by default, not duplicated — running it twice with `{ overwrite: false }` (the default) is a no-op for anything that already migrated successfully the first time. Only records that failed or were never attempted will be (re)migrated.

### Overwriting an already-migrated record

Not done by default — "never overwrite unless explicitly requested" is enforced by the `overwrite` option being `false` unless you pass it:
```js
const report = await migrateStudentsToFirestore({ overwrite: true });
```
When `overwrite: true`, a legacy record whose `admissionNo` matches an existing Firestore student **updates** that Firestore document (through the normal `students$.update()` path) instead of being skipped — counted separately in the report as `overwritten`, not `migrated`. The existing Firestore document's `createdAt`/`createdBy` are preserved (an update never touches them); every other field, including `admissionNo`, is replaced with the IndexedDB source's values.

## Validation Process

Before any record is written, in this order:

1. **Duplicate check by `admissionNo`** against a single snapshot of all existing Firestore students taken at the start of the run (not one query per record). A match is skipped (or updated, if `overwrite: true`).
2. **Duplicate `studentCode` check** — only relevant if the source record already carries a `studentCode` (a retry of a partially-completed prior run; a genuine first migration never has this, since IndexedDB records never had the field). If that code is already in use by a *different* student in Firestore, the record fails validation rather than silently colliding.
3. **Required-field validation** — reuses `students$.validate()`, the exact same rule the live app enforces on every create/edit: name, branch, a recognised level, a guardian phone number, and a date of birth that isn't in the future.
4. **Firestore write** — the actual `addDoc`/`updateDoc` call. A failure here (network, permissions, quota) is caught and logged separately from a validation failure, since it means different things: validation failures are data problems to fix; write failures are usually transient or environmental.

**A failure at any stage logs that one record and continues with the rest of the batch — the run never stops early.**

## Expected Output

`migrateStudentsToFirestore()` resolves to a report object:

```js
{
  totalIndexedDb: 132,        // every record read from IndexedDB, including archived students
  migrated: 118,               // newly created in Firestore
  overwritten: 0,               // updated an existing Firestore record (only when overwrite: true)
  skippedDuplicates: 9,         // admissionNo already existed in Firestore; left untouched
  validationFailures: [         // required-field or duplicate-code problems — nothing written
    { id: 'STU-...', admissionNo: 'NAT/ADM/25/0031', name: 'Example Name', reason: 'A guardian contact number is required.' }
  ],
  writeFailures: [               // validation passed but the Firestore write itself failed
    { id: 'STU-...', admissionNo: 'NAT/ADM/25/0088', name: 'Example Name', reason: '...' }
  ],
  durationMs: 4213,
  dryRun: false,
  overwrite: false
}
```

`totalIndexedDb` should always equal `migrated + overwritten + skippedDuplicates + validationFailures.length + writeFailures.length`. If it doesn't, something in a future edit to this file broke that invariant — treat it as a bug.

## Rollback Considerations

- **This utility only writes to Firestore — it never modifies or deletes anything in IndexedDB.** The original local data is completely untouched by running it, at any point, in either direction. There is nothing to "undo" on the IndexedDB side.
- **To undo a Firestore-side migration**, the created/updated Firestore documents would need to be deleted or reverted by hand (Firebase Console, or a small one-off script) — this utility does not currently include an "undo" mode. Given it never overwrites by default and every write is a fresh document, the safest rollback for a bad *first* run is simply deleting the Firestore documents it created (identifiable by the audit log entry's timestamp and the run's reported count) and re-running once the underlying issue is fixed.
- **If `overwrite: true` was used** and it changed records incorrectly, there is no automatic revert — this is precisely why `overwrite` defaults to `false` and why a dry run is strongly recommended before any real, and especially any `overwrite: true`, run.

## Known Limitations

- **No UI.** By design — this is DevTools-console-only, for a deliberate, understood, one-time action, not a feature end users discover.
- **Per-browser, not centralized.** Because it reads local IndexedDB, it must be run from every device that holds real data separately; there is no way to migrate "everything, everywhere" in one invocation.
- **No partial-record repair.** A record that fails validation is reported, not auto-corrected — fixing it means editing the source data (in the pre-migration app, or directly) and re-running, not passing a repair flag to this utility.
- **`studentCode` is generated in IndexedDB-scan order, not any particular meaningful order** (e.g. not by original `createdAt`). Two different migration runs across two different devices will not produce the same `STU000001, STU000002, …` assignment for the "same" students in relative terms — code numbers are simply the next available sequence value at the moment each record is written, nothing more.

### Update (Milestone 5) — cross-database writes resolved, atomicity still not restored

The paragraph below described this project's state through Milestone 4. As of Milestone 5 (see [ADMISSIONS_MODULE_MIGRATION.md §4/§8/§9](ADMISSIONS_MODULE_MIGRATION.md)), Admissions has also moved to Cloud Firestore — `admissions.service.js`'s `enrolApplicant()` now writes both the student and the admission update to **the same database** (Firestore), not two different ones. The single-transaction guarantee was **not** automatically restored by that alone, though: the two writes remain two sequential calls rather than one atomic transaction, because doing so properly requires either a new cross-repository transaction primitive or a Service touching the Firestore SDK directly — the latter would break the "Firebase SDK isolated to Repositories/Providers" rule this architecture has held since ADR-014. This is recorded as a named future enhancement in `ADMISSIONS_MODULE_MIGRATION.md` §8, not implemented as a side effect of either migration.

<details>
<summary>Original note (Milestone 3, superseded above — kept for history)</summary>

`admissions.service.js`'s `enrolApplicant()` now writes a student to **Firestore** and updates the corresponding admission record in **IndexedDB**, in two separate steps rather than one atomic transaction (see [STUDENT_MODULE_MIGRATION.md §4/§9](STUDENT_MODULE_MIGRATION.md)). This is an **approved, temporary state**, not an oversight:

- **Admissions** → IndexedDB (unmigrated)
- **Students** → Cloud Firestore (migrated, Milestone 3)

The two modules will share one database again once Admissions itself migrates to Firestore in a future milestone, at which point the original single-transaction guarantee can be restored. **This is not being solved in the current milestone** — it is documented here, and in the Student Management migration record, so it is tracked and understood rather than rediscovered as a surprise later.

</details>
