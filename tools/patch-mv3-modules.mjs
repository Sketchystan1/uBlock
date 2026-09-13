#!/usr/bin/env node
/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/*******************************************************************************

    Apply MV3 fix-ups to the built package that can only be made to the output.

    Two transforms, both against the BUILD OUTPUT and never the source tree: the
    port must not modify a single upstream file, so that the unattended merge from
    upstream can never conflict. Transforming the copy is the same approach the
    port already takes for the manifest.

    1. Rewrite dynamic `import()` in the service worker's module graph.

    Dynamic import is unconditionally forbidden in a ServiceWorkerGlobalScope
    (Blink: `WorkerModulatorImpl::IsDynamicImportForbidden`), and uBO's five
    reachable call sites all swallow the resulting rejection -- so the failures
    are silent. The worst of them leaves uBO with an empty scriptlet resource
    table, which makes every `+js(...)` filter quietly do nothing.

    Each `import(...)` becomes `self.uBO_dynamicImport(...)`, which
    `platform/chromium-mv3/mv3-shims.js` defines and
    `platform/chromium-mv3/mv3-post.js` populates. Specifiers that are not
    registered there reject with an explanatory error instead of failing mutely.

    `tools/verify-mv3-package.mjs` asserts that no dynamic `import()` survives in
    the shipped package, so if upstream adds a call site this transform does not
    reach, the build fails rather than regressing silently.

    2. Alias `chrome.browserAction` to `chrome.action` for extension pages.

    `webext.js` reads `chrome.browserAction` at module-eval time; MV3 renamed the
    manifest key to `action`, so it is undefined in every extension page (the
    service worker aliases it in `mv3-shims.js`, but pages have no such shim). The
    read throws and aborts the module graph of every page importing webext.js. See
    the injection site below for the full explanation.

    Usage: node tools/patch-mv3-modules.mjs [--dir <package-dir>]

**/

import fs from 'node:fs';
import path from 'node:path';

/******************************************************************************/

const args = new Map();
for ( let i = 2; i < process.argv.length; i += 2 ) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i+1]);
}

const pkgDir = path.resolve(args.get('dir') || 'dist/build/uBlock0.chromium-mv3');

if ( fs.existsSync(pkgDir) === false ) {
    console.error(`*** patch-mv3-modules: no package at ${pkgDir}`);
    process.exit(1);
}

/******************************************************************************/

const reStaticImport =
    /(?:^|\n)[ \t]*(?:import|export)[^;\n]*?from[ \t]+["']([^"']+)["']|(?:^|\n)[ \t]*import[ \t]+["']([^"']+)["']/g;

// Walk the static import graph from a set of entry points, returning every
// package-relative path reached.
function moduleGraph(entries) {
    const seen = new Set();
    const stack = entries.slice();
    while ( stack.length !== 0 ) {
        const rel = stack.pop();
        if ( seen.has(rel) ) { continue; }
        const abs = path.join(pkgDir, rel);
        if ( fs.existsSync(abs) === false ) { continue; }
        seen.add(rel);
        const src = fs.readFileSync(abs, 'utf8');
        reStaticImport.lastIndex = 0;
        let match;
        while ( (match = reStaticImport.exec(src)) !== null ) {
            const spec = match[1] || match[2];
            if ( spec.startsWith('.') === false ) { continue; }
            stack.push(
                path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
            );
        }
    }
    return seen;
}

/******************************************************************************/

const swGraph = moduleGraph([ 'js/sw.js' ]);

// Every script an extension PAGE loads, and everything those pull in. A file in
// both graphs must not be rewritten: `self.uBO_dynamicImport` exists only in the
// service worker, so a page loading the rewritten file would throw instead.
const pageGraph = (( ) => {
    const entries = [];
    for ( const name of fs.readdirSync(pkgDir) ) {
        if ( name.endsWith('.html') === false ) { continue; }
        const html = fs.readFileSync(path.join(pkgDir, name), 'utf8');
        for ( const match of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g) ) {
            entries.push(match[1].replace(/^\//, ''));
        }
    }
    return moduleGraph(entries);
})();

/******************************************************************************/

// Alias `chrome.browserAction` to `chrome.action` for extension PAGE contexts.
//
// `platform/chromium/webext.js` builds its promisified `webext` object at
// module-evaluation time, reading `chrome.browserAction` directly (its
// `browserAction:` block passes it to `promisifyNoFail`). MV3 renamed the
// `browser_action` manifest key to `action`, so `chrome.browserAction` is
// `undefined` in every context that has not aliased it. The service worker
// aliases it in `mv3-shims.js` before uBO evaluates; a PAGE has no equivalent
// shim, so the read throws a TypeError at module scope.
//
// Because `webext.js` sits in the static import graph of `broadcast.js` and
// `cachestorage.js`, that throw aborts the whole module graph of any page which
// imports them -- Filter lists (3p-filters), My filters (1p-filters), Support and
// the logger among them. The page's own script never runs, so the pane loads
// blank even though the service worker answers its messages normally.
//
// Prepend the same alias to the built webext.js: it is the single choke point,
// and as a module its first statement runs before the offending read. Guarded and
// idempotent -- a no-op in the service worker, where the alias is already set, and
// on a re-run of this script.

{
    const rel = 'js/webext.js';
    const abs = path.join(pkgDir, rel);
    const marker = 'uBO MV3 page-context browserAction alias';
    if ( pageGraph.has(rel) === false ) {
        console.log(
            `*** patch-mv3-modules: ${rel} is not page-reachable; ` +
            `skipping the chrome.browserAction alias`
        );
    } else if ( fs.existsSync(abs) === false ) {
        console.error(
            `*** patch-mv3-modules: ${rel} missing; cannot inject the ` +
            `chrome.browserAction alias`
        );
        process.exit(1);
    } else {
        const src = fs.readFileSync(abs, 'utf8');
        if ( src.includes(marker) ) {
            console.log(`*** patch-mv3-modules: ${rel} already has the browserAction alias`);
        } else {
            const shim = [
                `// [${marker}] webext.js reads chrome.browserAction at`,
                `// module-eval time. MV3 renamed browser_action -> action, so it is undefined`,
                `// in every extension page (the service worker aliases it in mv3-shims.js).`,
                `// Without this the read throws and aborts the importing page's module graph.`,
                `if ( typeof chrome !== 'undefined' && chrome.browserAction === undefined && chrome.action !== undefined ) {`,
                `    chrome.browserAction = chrome.action;`,
                `}`,
                ``,
                ``,
            ].join('\n');
            fs.writeFileSync(abs, shim + src);
            console.log(
                `*** patch-mv3-modules: ${rel} prepended chrome.browserAction ` +
                `alias for page contexts`
            );
        }
    }
}

/******************************************************************************/

// `import(` but not `foo.import(`, `myimport(` or `import.meta`.
const reDynamicImport = /(^|[^.\w$])import\s*\(/g;

// The port's own service worker modules are excluded. The match above is
// deliberately not comment- or string-aware -- a real parser would be overkill
// for upstream's handful of call sites -- and these three files necessarily
// discuss the construct in prose and quote it in an error message. They are
// written against this constraint, so there is nothing here to rewrite.
const PORT_OWN_MODULES = new Set([
    'js/sw.js',
    'js/mv3-shims.js',
    'js/mv3-post.js',
]);

const rewritten = [];
const conflicts = [];

for ( const rel of [ ...swGraph ].sort() ) {
    if ( PORT_OWN_MODULES.has(rel) ) { continue; }
    const abs = path.join(pkgDir, rel);
    const before = fs.readFileSync(abs, 'utf8');
    if ( reDynamicImport.test(before) === false ) { continue; }
    reDynamicImport.lastIndex = 0;
    if ( pageGraph.has(rel) ) {
        conflicts.push(rel);
        continue;
    }
    const after = before.replace(reDynamicImport, '$1self.uBO_dynamicImport(');
    const count = (before.match(reDynamicImport) || []).length;
    reDynamicImport.lastIndex = 0;
    fs.writeFileSync(abs, after);
    rewritten.push({ rel, count });
}

/******************************************************************************/

for ( const rel of conflicts ) {
    console.error(
        `*** patch-mv3-modules: ${rel} uses dynamic import() and is loaded by ` +
        `both the service worker and an extension page.`
    );
    console.error(
        `    Rewriting it would break the page, since self.uBO_dynamicImport ` +
        `exists only in the service worker.`
    );
    console.error(
        `    Resolve this by hand -- e.g. give the page a shim of its own, or ` +
        `have mv3-post.js patch the specific function.`
    );
}

let total = 0;
for ( const { rel, count } of rewritten ) {
    console.log(`*** patch-mv3-modules: ${rel} (${count} call site${count === 1 ? '' : 's'})`);
    total += count;
}
console.log(
    `*** patch-mv3-modules: rewrote ${total} dynamic import() call site(s) ` +
    `across ${rewritten.length} file(s); ${swGraph.size} modules in the ` +
    `service worker graph`
);

if ( conflicts.length !== 0 ) { process.exit(1); }

// A build that rewrites nothing is suspicious: upstream has had these call
// sites for a long time, and losing them silently would mean the transform has
// stopped matching. verify-mv3-package.mjs is the real gate, but say so here.
if ( total === 0 ) {
    console.log(
        `*** patch-mv3-modules: WARNING -- no call sites found. If upstream ` +
        `really has no dynamic import() left, remove this step; otherwise the ` +
        `pattern has drifted.`
    );
}
