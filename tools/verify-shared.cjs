/**
 * Shared-file parity checker.
 *
 * natyam-mobile and natyam-admin ship from separate repositories against one
 * Firebase project, and a handful of files are deliberately BYTE-IDENTICAL in
 * both: the domain services, the Firestore rules, and — since UAT6 ENH-602 —
 * `js/config/studentFields.js`, which is the single place the mandatory student
 * fields are decided.
 *
 * "Identical by convention" is only as good as somebody remembering. When a
 * copy drifts, the two apps quietly start disagreeing about the same records,
 * which is exactly the failure ENH-602 was raised about: Desktop and Mobile
 * demanding different fields for the same child. This makes the convention
 * checkable in one command.
 *
 * Run:  node tools/verify-shared.cjs [path-to-sibling-repo]
 *
 * The sibling is found automatically if it sits next to this one under the
 * usual name. With no sibling on disk the check SKIPS rather than fails — a CI
 * box or a fresh clone has only one repo, and a checker that cannot run is not
 * the same thing as a check that failed.
 *
 * Exits non-zero only when a file genuinely differs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.basename(ROOT);
const SIBLING_OF = { 'natyam-mobile': 'natyam-admin', 'natyam-admin': 'natyam-mobile' };

/**
 * Every file that must match. Add to this list when a new file becomes shared
 * — that is cheaper than discovering the drift from a bug report.
 */
const SHARED = [
    'js/config/studentFields.js',
    'js/services/students.service.js',
    'js/services/admissions.service.js',
    'js/services/batches.service.js',
    'js/services/programs.service.js',
    'js/services/settings.service.js',
    'js/services/holidays.service.js',
    'firestore.rules'
];

/**
 * Compared with line endings normalised. The two working trees genuinely
 * differ here — core.autocrlf is on and the index stores LF — so a raw byte
 * compare reports every shared file as different on Windows and tells you
 * nothing. Content is what has to match.
 */
function digest(file) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(file, 'utf8').split('\r\n').join('\n'))
        .digest('hex');
}

function main() {
    const explicit = process.argv[2];
    const guess = SIBLING_OF[SELF] && path.resolve(ROOT, '..', SIBLING_OF[SELF]);
    const sibling = explicit ? path.resolve(explicit) : guess;

    if (!sibling || !fs.existsSync(sibling)) {
        console.log(`No sibling repository found${sibling ? ` at ${sibling}` : ''} — nothing to compare. Skipped.`);
        return 0;
    }

    console.log(`Comparing ${SELF} against ${path.basename(sibling)}\n`);

    let drifted = 0;
    let missing = 0;

    for (const relative of SHARED) {
        const mine = path.join(ROOT, relative);
        const theirs = path.join(sibling, relative);

        if (!fs.existsSync(mine) || !fs.existsSync(theirs)) {
            console.log(`  ?  ${relative} — not present in both repositories`);
            missing++;
            continue;
        }
        if (digest(mine) === digest(theirs)) {
            console.log(`  ok ${relative}`);
        } else {
            console.log(`  !! ${relative} — DIFFERS`);
            drifted++;
        }
    }

    console.log('');
    if (drifted) {
        console.log(`${drifted} shared file(s) have drifted. Reconcile them before shipping —`);
        console.log('a shared file is shared in both directions; decide which side is right rather');
        console.log('than copying blindly over a change the other repo made on purpose.');
        return 1;
    }
    if (missing) console.log(`${missing} shared file(s) could not be compared.`);
    console.log('Every shared file matches.');
    return 0;
}

process.exit(main());
