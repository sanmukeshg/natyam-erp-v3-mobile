/**
 * Static import checker.
 *
 * This app has no build step, so nothing validates the module graph before a
 * browser hits it — a mistyped path or a name trimmed out of repositories.js
 * only surfaces as a runtime SyntaxError on the page that needed it. During
 * the migration that is exactly the class of breakage worth catching between
 * modules rather than after, so this walks every local import (static and
 * dynamic) reachable from js/app.js and reports:
 *
 *   - imports pointing at files that do not exist
 *   - named imports the target module does not actually export
 *   - files present in js/ that nothing reaches (dead weight from a copy)
 *
 * Run:  node tools/verify-imports.cjs
 * Exits non-zero if anything in the first two categories is found.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'js', 'app.js');

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Collect `export` names a module provides, including `export ... from` re-exports. */
function exportsOf(src) {
    const names = new Set();
    let m;

    const named = /export\s*\{([^}]*)\}/g;
    while ((m = named.exec(src))) {
        m[1].split(',').forEach((part) => {
            const piece = part.trim();
            if (!piece) return;
            const as = piece.split(/\s+as\s+/);
            names.add((as[1] || as[0]).trim());
        });
    }

    const decl = /export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g;
    while ((m = decl.exec(src))) names.add(m[1]);

    if (/export\s+default/.test(src)) names.add('default');
    if (/export\s*\*\s*from/.test(src)) names.add('*');   // star re-export: can't resolve statically

    return names;
}

/** Every local import in a file: { spec, names[], isDefault, star }. */
function importsOf(src) {
    const out = [];

    // import ... from '...'   /   export ... from '...'
    const re = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
        const clause = m[1].trim();
        const spec = m[2];
        if (!spec.startsWith('.')) continue;

        const names = [];
        let isDefault = false;
        let star = false;

        if (/^\*/.test(clause) || /\*\s+as\s+/.test(clause)) star = true;

        const braced = clause.match(/\{([^}]*)\}/);
        if (braced) {
            braced[1].split(',').forEach((part) => {
                const piece = part.trim();
                if (!piece) return;
                names.push(piece.split(/\s+as\s+/)[0].trim());
            });
        }
        const bare = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z0-9_$]+/, '').replace(/,/g, '').trim();
        if (bare && !bare.startsWith('{')) isDefault = true;

        out.push({ spec, names, isDefault, star });
    }

    // bare side-effect import '...'
    const side = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
    while ((m = side.exec(src))) out.push({ spec: m[1], names: [], isDefault: false, star: false });

    // dynamic import('...')
    const dyn = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(src))) out.push({ spec: m[1], names: [], isDefault: false, star: false, dynamic: true });

    return out;
}

const visited = new Map();   // abs -> exports Set
const problems = [];

function load(abs) {
    if (visited.has(abs)) return visited.get(abs);
    if (!fs.existsSync(abs)) { visited.set(abs, null); return null; }
    const src = fs.readFileSync(abs, 'utf8');
    const ex = exportsOf(src);
    visited.set(abs, ex);

    for (const imp of importsOf(src)) {
        const target = path.resolve(path.dirname(abs), imp.spec);
        const targetExports = load(target);

        if (targetExports === null) {
            problems.push(`MISSING FILE  ${rel(abs)}\n    imports "${imp.spec}" -> ${rel(target)} (does not exist)`);
            continue;
        }
        if (targetExports.has('*')) continue;   // star re-export, can't verify names

        for (const name of imp.names) {
            if (!targetExports.has(name)) {
                problems.push(`MISSING EXPORT  ${rel(target)}\n    does not export "${name}" (imported by ${rel(abs)})`);
            }
        }
        if (imp.isDefault && !targetExports.has('default')) {
            problems.push(`MISSING DEFAULT  ${rel(target)}\n    has no default export (imported by ${rel(abs)})`);
        }
    }
    return ex;
}

if (!fs.existsSync(ENTRY)) {
    console.error('No entry point at js/app.js');
    process.exit(1);
}
load(ENTRY);

// Anything under js/ that the graph never reached.
const reached = new Set([...visited.keys()].filter((k) => visited.get(k) !== null).map(rel));
const onDisk = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.js')) onDisk.push(rel(p));
    }
})(path.join(ROOT, 'js'));
const orphans = onDisk.filter((f) => !reached.has(f)).sort();

console.log(`Reached ${reached.size} module(s) from js/app.js.`);

if (orphans.length) {
    console.log(`\nUNREACHED (${orphans.length}) — copied but nothing imports them:`);
    orphans.forEach((f) => console.log('  ' + f));
}

if (problems.length) {
    console.log(`\n${problems.length} PROBLEM(S):\n`);
    problems.forEach((p) => console.log(p + '\n'));
    process.exit(1);
}
console.log('\nAll local imports resolve, and every named import exists.');
