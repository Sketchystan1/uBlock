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

    Six transforms, all against the BUILD OUTPUT and never the source tree:
    the port must not modify a single upstream file, so that the unattended
    merge from upstream can never conflict. Transforming the copy is the same
    approach the port already takes for the manifest.

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

    3. Generate the sharded scriptlet libraries: per world, one "shared" file
       (the near-universal dependencies, always injected when any call of
       that world fires), a small number of "shard" files holding the
       callable scriptlets plus their cluster-local dependencies, and one
       "launch" file which dispatches every call in payload order. Plus
       the manifest module `js/mv3-scriptlet-shards.js` mapping every
       function name to its file.

    No MV3 API executes a code string in either world: `eval()` inside
    anything `chrome.scripting` injects is blocked by that world's CSP,
    and a `<script>` element created by extension code is blocked too --
    by the page's CSP from the MAIN world, by the world's own (extension)
    CSP from the scripting API's ISOLATED world. The one CSP exemption
    MV2 enjoyed, for elements created by `chrome.tabs.executeScript`'s
    isolated world, died with that API. What extension injection DOES
    still guarantee is that the injected code itself -- func or file,
    any world -- runs CSP-exempt. So the scriptlet *functions*, which are
    static (they all live in `src/js/resources/`, registered in
    `js/resources/scriptlets.js`'s `builtinScriptlets`), are shipped as
    classic-script files and the dynamic part -- which functions to call,
    with which arguments -- is handed to them out of band. This transform
    imports the resources module here in Node, takes the transitive
    closure of each world's scriptlet set over their declared
    dependencies *and* their bare-name references to one another, and
    emits each function's source verbatim. See the generator below for
    how the functions are split across files and why.

    4. Expose the strict-block bypass deadline map on the exported webRequest
    object in `js/traffic.js`.

    `strictBlockBypasser` is module-private in `src/js/traffic.js`; only its
    `bypass()` method is exported (as `webRequest.strictBlockBypass`). The map of
    "proceed anyway" deadlines lives in the service worker's memory and dies with
    it, which MV3 does often. `platform/chromium-mv3/mv3-post.js` persists it to
    `storage.session` and restores it after boot -- for which it needs a reference
    to the live Map. One property is added to the object literal; the anchor and
    the result are pinned by `tools/verify-mv3-package.mjs`.

    5. Point the WASM LZ4 codec at the package root.

    `lib/lz4/lz4-block-codec-wasm.js` locates its `.wasm` module relative to
    `document.currentScript.src`, which does not exist in a service worker. The
    build replaces that directory-deriving IIFE with a package-root-relative
    constant, resolved by `platform/chromium-mv3/mv3-shims.js`'s fetch() wrapper.
    This is what makes the WASM LZ4 flavor -- opted into with 'wasm-unsafe-eval'
    in platform/chromium-mv3/manifest.overlay.json -- reachable at all. See the
    injection site below for the full rationale.

    6. Harden the MV3 runtime against mid-boot messages and failed storage
       reads, in `js/vapi-background.js`, `js/messaging.js` and `js/storage.js`.

    A service worker is not a background page: Chrome can dispatch an extension
    message at any point of the boot sequence -- while start.js is still
    awaiting its first asset fetch, or after a launch that threw partway
    through and left the worker half-up. The handlers this covers (the
    popup-panel commands, and getLists) report or mutate state which is fully
    initialized only at the very end of the launch sequence, so they await
    `µb.isReadyPromise` -- a promise created with a resolve handler only and
    resolved as the last statement of a *successful* launch (see background.js
    and start.js); a failed launch leaves it pending forever, and a handler
    awaiting it hangs the reply `callback` (the popup panel never paints). The
    `whenReady()` helper races readiness against a bounded timeout, answers the
    callback exactly once, and degrades gracefully on timeout or error.
    Symmetrically, a failed storage read must not be treated as a first-run:
    upstream `vAPI.storage.get()` swallows the read error and fulfills with
    `undefined`, indistinguishable from "no data found". It is made to fulfill
    with `null` on failure, and `µb.loadSelectedFilterLists` retries the read,
    records the failure and keeps the current selection -- persisting the
    default selection over an unread one would silently revert the user's own,
    and a selfie built from the empty engine a failed read leaves behind would
    overwrite a valid one.

    These are upstream files, so the hardening is applied here, against the
    build output. The patched bytes are identical, hunk for hunk, to the
    source-modified versions this transform replaces; because of that, no
    marker comment is added to the patched text and idempotency is probed on
    a substring unique to it instead (see the section below).

    Usage: node tools/patch-mv3-modules.mjs [--dir <package-dir>]

**/

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/******************************************************************************/

// Escape a string for literal use inside a RegExp. Several patterns below
// interpolate resource-derived function names; `$` is legal in a JS identifier
// but is a RegExp metacharacter, so an unescaped name like `foo$bar` would
// silently fail to match -- a missed dependency/reference edge, which would
// violate the "can only over-include" invariant this file relies on.
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/******************************************************************************/
/******************************************************************************/

// Expose the strict-block bypass deadline map on the exported webRequest
// object. See the header comment (transform 4) for the full rationale; the
// anchor is the object literal's tail in js/traffic.js, so any drift in it
// fails the build rather than silently shipping a `strictBlockBypassMap` the
// restore code cannot use (mv3-post.js also complains loudly at runtime).

{
    const rel = 'js/traffic.js';
    const abs = path.join(pkgDir, rel);
    const marker = 'uBO MV3 strict-block bypass map exposure';
    // The upstream source may use either line ending (and has used CRLF);
    // build the anchor and the replacement with the file's own.
    const lines = [
        '    strictBlockBypass: hostname => {',
        '        strictBlockBypasser.bypass(hostname);',
        '    },',
        '};',
    ];
    const replacementLines = [
        '    strictBlockBypass: hostname => {',
        '        strictBlockBypasser.bypass(hostname);',
        '    },',
        '',
        `    // [${marker}] The deadline map is module-private; expose the live`,
        '    // Map so platform/chromium-mv3/mv3-post.js can persist it to',
        '    // storage.session and restore it after a service worker restart.',
        '    strictBlockBypassMap: strictBlockBypasser.hostnameToDeadlineMap,',
        '};',
    ];

    if ( swGraph.has(rel) === false ) {
        console.error(
            `*** patch-mv3-modules: ${rel} is not reachable from js/sw.js; ` +
            `cannot expose the strict-block bypass map`
        );
        process.exit(1);
    } else if ( fs.existsSync(abs) === false ) {
        console.error(
            `*** patch-mv3-modules: ${rel} missing; cannot expose the ` +
            `strict-block bypass map`
        );
        process.exit(1);
    } else {
        const src = fs.readFileSync(abs, 'utf8');
        if ( src.includes(marker) ) {
            console.log(`*** patch-mv3-modules: ${rel} already exposes the strict-block bypass map`);
        } else {
            const eol = src.includes('\r\n') ? '\r\n' : '\n';
            const anchor = lines.join(eol);
            const replacement = replacementLines.join(eol);
            const count = src.split(anchor).length - 1;
            if ( count !== 1 ) {
                console.error(
                    `*** patch-mv3-modules: ${rel} contains ${count} ` +
                    `occurrence(s) of the expected strictBlockBypass tail of ` +
                    `the webRequest object literal (expected exactly 1):\n` +
                    `${lines.join(eol)}\n` +
                    `    Reconcile tools/patch-mv3-modules.mjs with the new ` +
                    `upstream shape (and platform/chromium-mv3/mv3-post.js, ` +
                    `which reads webRequest.strictBlockBypassMap).`
                );
                process.exit(1);
            }
            fs.writeFileSync(abs, src.replace(anchor, () => replacement));
            console.log(
                `*** patch-mv3-modules: ${rel} exposes ` +
                `webRequest.strictBlockBypassMap`
            );
        }
    }
}

/******************************************************************************/
/******************************************************************************/

// Point lib/lz4/lz4-block-codec-wasm.js at the package root.
//
// The WASM flavor of the LZ4 codec locates its .wasm module relative to its
// own script URL through `document.currentScript.src` -- a concept that does
// not exist in a service worker (the shims' `document` stand-in has no
// `currentScript`, so the module would throw at evaluation time). The file
// is only ever imported by `js/mv3-shims.js` in this build (no extension
// page loads it), so replace the whole directory-deriving IIFE with a
// package-root-relative constant: the shims' fetch() wrapper resolves
// relative URLs against the package root, which lands on
// `lib/lz4/lz4-block-codec.wasm` exactly as `wd` would have computed it.
//
// This is what makes the WASM flavor reachable at all, which matters because
// the MV3 manifest opts into 'wasm-unsafe-eval' (see
// platform/chromium-mv3/manifest.overlay.json) and `src/js/lz4.js` asks for
// the default flavor -- WASM first, JS on failure -- whenever
// `vAPI.canWASM` is true. The rewrite is asserted by
// tools/verify-mv3-package.mjs so an upstream change to the anchor fails the
// build instead of silently disabling WASM-flavored selfie decompression.
{
    const rel = 'lib/lz4/lz4-block-codec-wasm.js';
    const abs = path.join(pkgDir, rel);
    const marker = 'uBO MV3 service-worker wasm path';
    if ( fs.existsSync(abs) === false ) {
        console.error(
            `*** patch-mv3-modules: ${rel} missing; cannot make the WASM ` +
            `LZ4 codec service-worker-safe`
        );
        process.exit(1);
    }
    const src = fs.readFileSync(abs, 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const anchor = [
        'const wd = (function() {',
        "    let url = document.currentScript.src;",
        '    let match = /[^\\/]+$/.exec(url);',
        '    return match !== null ?',
        '        url.slice(0, match.index) :',
        "        '';",
        '})();',
    ].join(eol);
    const replacement = [
        `// [${marker}] A service worker has no document.currentScript; the`,
        '// build replaces the directory-deriving IIFE with a package-root-',
        "// relative path, which platform/chromium-mv3/mv3-shims.js's fetch()",
        '// wrapper resolves against the extension origin.',
        "const wd = 'lib/lz4/';",
    ].join(eol);
    if ( src.includes(marker) ) {
        console.log(`*** patch-mv3-modules: ${rel} already has the service-worker wasm path`);
    } else {
        const count = src.split(anchor).length - 1;
        if ( count !== 1 ) {
            console.error(
                `*** patch-mv3-modules: ${rel} contains ${count} ` +
                `occurrence(s) of the expected document.currentScript-based ` +
                `wd initializer (expected exactly 1):\n${anchor}\n` +
                `    Reconcile tools/patch-mv3-modules.mjs with the new ` +
                `upstream shape -- without the rewrite, importing the WASM ` +
                `codec from mv3-shims.js would throw at module evaluation.`
            );
            process.exit(1);
        }
        fs.writeFileSync(abs, src.replace(anchor, () => replacement));
        console.log(
            `*** patch-mv3-modules: ${rel} resolves its wasm module ` +
            `through the package root`
        );
    }
}

/******************************************************************************/
/******************************************************************************/

// Harden the MV3 runtime against mid-boot messages and failed storage reads.
// See the header comment (transform 6) for the full rationale.
//
// Each edit's anchor is upstream's exact code -- the whole diff hunk plus the
// context lines around it, so the anchor is unique in the file -- and any
// upstream drift inside a region fails the build rather than shipping a
// half-hardened runtime. Unlike the other transforms, no marker comment is
// added to the patched text: the output must stay byte-identical to the
// source-modified code this replaces (parts of it are pinned by
// tools/verify-mv3-package.mjs), so idempotency is probed on a substring
// unique to the patched text instead. The edits below do not touch any
// dynamic `import(` text, so they cannot interact with transform 1's rewrite
// pass, which has already run by the time this section executes.

{
    const RUNTIME_HARDENING = [
        {
            // js/vapi-background.js -- vAPI.storage.get() fulfills with `null`
            // when the read failed, so callers can tell a failed read from a
            // successful one which found no data. The one-shot boot recovery in
            // mv3-post.js probes exactly this as its storage-health signal.
            rel: 'js/vapi-background.js',
            probe: 'bin instanceof Object ? bin : null',
            edits: [
                // 1. (anchor: 10 lines, replacement: 18 lines)
                {
                    anchor: [
                        ' * */',
                        '',
                        'vAPI.storage = {',
                        '    get(key, ...args) {',
                        '        return webext.storage.local.get(key, ...args).catch(reason => {',
                        '            console.log(reason);',
                        '        });',
                        '    },',
                        '    set(...args) {',
                        '        return webext.storage.local.set(...args).catch(reason => {',
                    ],
                    replacement: [
                        ' * */',
                        '',
                        'vAPI.storage = {',
                        '    // A read which did not fulfill with an object means it failed, in',
                        '    // which case fulfill with `null`, so as to allow callers to',
                        '    // distinguish a failed read from a successful one which found no',
                        '    // data to return.',
                        '    get(key, ...args) {',
                        '        return webext.storage.local.get(key, ...args).then(',
                        '            bin => bin instanceof Object ? bin : null,',
                        '            reason => {',
                        '                console.log(reason);',
                        '                return null;',
                        '            }',
                        '        );',
                        '    },',
                        '    set(...args) {',
                        '        return webext.storage.local.set(...args).catch(reason => {',
                    ],
                },
            ],
        },
        {
            // js/messaging.js -- the `whenReady()` helper plus the eight handlers
            // routed through it: getPopupData, launchReporter, revertFirewallRules,
            // saveFirewallRules, toggleHostnameSwitch, toggleFirewallRule,
            // toggleNetFiltering and getLists.
            rel: 'js/messaging.js',
            probe: 'const whenReady = (( ) => {',
            edits: [
                // 1. (anchor: 6 lines, replacement: 38 lines)
                {
                    anchor: [
                        '/******************************************************************************/',
                        '/******************************************************************************/',
                        '',
                        '// Channel:',
                        '//      popupPanel',
                        '//      privileged',
                    ],
                    replacement: [
                        '/******************************************************************************/',
                        '/******************************************************************************/',
                        '',
                        '// Several message handlers routed through `whenReady()` (the popup-panel',
                        '// commands, and `getLists`) report or mutate state which is fully initialized',
                        '// only at the very end of the launch sequence, so they must wait on',
                        '// `µb.isReadyPromise`. That promise is created with a resolve handler only (see',
                        '// background.js) and is resolved as the last statement of a *successful* launch',
                        '// (see start.js); a launch which throws at an earlier `await` leaves it forever',
                        '// pending. To ensure the framework\'s reply `callback` is invoked exactly once',
                        '// -- so the caller never hangs and the reply callback is never leaked -- race',
                        '// readiness against a bounded timeout and degrade gracefully on timeout or',
                        '// error. `fn` performs the work and resolves to the response; `fallback`',
                        '// resolves to a safe degraded response (default: no data).',
                        'const whenReady = (( ) => {',
                        '    const readyTimeout = { sec: 5 };',
                        '    return (callback, fn, fallback) => {',
                        '        let answered = false;',
                        '        const answer = response => {',
                        '            if ( answered ) { return; }',
                        '            answered = true;',
                        '            callback(response);',
                        '        };',
                        '        const degrade = ( ) => {',
                        '            if ( answered ) { return; }',
                        '            Promise.resolve().then(fallback).then(answer, ( ) => answer());',
                        '        };',
                        '        µb.isReadyPromise.then(fn).then(answer, degrade);',
                        '        vAPI.defer.once(readyTimeout).then(degrade);',
                        '    };',
                        '})();',
                        '',
                        '/******************************************************************************/',
                        '/******************************************************************************/',
                        '',
                        '// Channel:',
                        '//      popupPanel',
                        '//      privileged',
                    ],
                },
                // 2. (anchor: 10 lines, replacement: 15 lines)
                {
                    anchor: [
                        '        return;',
                        '',
                        '    case \'getPopupData\':',
                        '        popupDataFromRequest(request).then(popupData => {',
                        '            callback(popupData);',
                        '        });',
                        '        return;',
                        '',
                        '    default:',
                        '        break;',
                    ],
                    replacement: [
                        '        return;',
                        '',
                        '    case \'getPopupData\':',
                        '        // Answer only once uBO is fully launched: page stores are bound to',
                        '        // existing tabs at the end of the launch sequence, and answering',
                        '        // before that would report a not-yet-initialized state, i.e. one',
                        '        // where the current site appears to not be filtered at all.',
                        '        return whenReady(',
                        '            callback,',
                        '            ( ) => popupDataFromRequest(request),',
                        '            ( ) => popupDataFromRequest(request).catch(( ) => ({}))',
                        '        );',
                        '',
                        '    default:',
                        '        break;',
                    ],
                },
                // 3. (anchor: 77 lines, replacement: 86 lines)
                {
                    anchor: [
                        '        break;',
                        '    }',
                        '',
                        '    case \'launchReporter\': {',
                        '        launchReporter(request).then(url => {',
                        '            if ( typeof url !== \'string\' ) { return; }',
                        '            µb.openNewTab({ url, select: true, index: -1 });',
                        '        });',
                        '        break;',
                        '    }',
                        '',
                        '    case \'revertFirewallRules\':',
                        '        // TODO: use Set() to message around sets of hostnames',
                        '        sessionFirewall.copyRules(',
                        '            permanentFirewall,',
                        '            request.srcHostname,',
                        '            Object.assign(Object.create(null), request.desHostnames)',
                        '        );',
                        '        sessionSwitches.copyRules(',
                        '            permanentSwitches,',
                        '            request.srcHostname',
                        '        );',
                        '        // https://github.com/gorhill/uBlock/issues/188',
                        '        cosmeticFilteringEngine.removeFromSelectorCache(',
                        '            request.srcHostname,',
                        '            \'net\'',
                        '        );',
                        '        µb.updateToolbarIcon(request.tabId, 0b100);',
                        '        response = popupDataFromTabId(request.tabId);',
                        '        break;',
                        '',
                        '    case \'saveFirewallRules\':',
                        '        // TODO: use Set() to message around sets of hostnames',
                        '        if (',
                        '            permanentFirewall.copyRules(',
                        '                sessionFirewall,',
                        '                request.srcHostname,',
                        '                Object.assign(Object.create(null), request.desHostnames)',
                        '            )',
                        '        ) {',
                        '            µb.savePermanentFirewallRules();',
                        '        }',
                        '        if (',
                        '            permanentSwitches.copyRules(',
                        '                sessionSwitches,',
                        '                request.srcHostname',
                        '            )',
                        '        ) {',
                        '            µb.saveHostnameSwitches();',
                        '        }',
                        '        break;',
                        '',
                        '    case \'toggleHostnameSwitch\':',
                        '        µb.toggleHostnameSwitch(request);',
                        '        response = popupDataFromTabId(request.tabId);',
                        '        break;',
                        '',
                        '    case \'toggleFirewallRule\':',
                        '        µb.toggleFirewallRule(request);',
                        '        response = popupDataFromTabId(request.tabId);',
                        '        break;',
                        '',
                        '    case \'toggleNetFiltering\': {',
                        '        const pageStore = µb.pageStoreFromTabId(request.tabId);',
                        '        if ( pageStore ) {',
                        '            pageStore.toggleNetFilteringSwitch(',
                        '                request.url,',
                        '                request.scope,',
                        '                request.state',
                        '            );',
                        '            µb.updateToolbarIcon(request.tabId, 0b111);',
                        '        }',
                        '        break;',
                        '    }',
                        '    default:',
                        '        return vAPI.messaging.UNHANDLED;',
                        '    }',
                    ],
                    replacement: [
                        '        break;',
                        '    }',
                        '',
                        '    // The commands below act on -- or report -- state which is fully',
                        '    // initialized only by the end of the launch sequence: page stores,',
                        '    // per-session and persistent rulesets. Defer them until then, else',
                        '    // they would act on a not-yet-initialized state: a toggle command',
                        '    // would be silently dropped, or worse a not-yet-loaded ruleset would',
                        '    // be persisted over the user\'s own.',
                        '    case \'launchReporter\':',
                        '        return whenReady(callback, ( ) => launchReporter(request).then(url => {',
                        '            if ( typeof url !== \'string\' ) { return; }',
                        '            µb.openNewTab({ url, select: true, index: -1 });',
                        '        }));',
                        '',
                        '    case \'revertFirewallRules\':',
                        '        return whenReady(callback, ( ) => {',
                        '            // TODO: use Set() to message around sets of hostnames',
                        '            sessionFirewall.copyRules(',
                        '                permanentFirewall,',
                        '                request.srcHostname,',
                        '                Object.assign(Object.create(null), request.desHostnames)',
                        '            );',
                        '            sessionSwitches.copyRules(',
                        '                permanentSwitches,',
                        '                request.srcHostname',
                        '            );',
                        '            // https://github.com/gorhill/uBlock/issues/188',
                        '            cosmeticFilteringEngine.removeFromSelectorCache(',
                        '                request.srcHostname,',
                        '                \'net\'',
                        '            );',
                        '            µb.updateToolbarIcon(request.tabId, 0b100);',
                        '            return popupDataFromTabId(request.tabId);',
                        '        }, ( ) => popupDataFromTabId(request.tabId));',
                        '',
                        '    case \'saveFirewallRules\':',
                        '        return whenReady(callback, ( ) => {',
                        '            // TODO: use Set() to message around sets of hostnames',
                        '            if (',
                        '                permanentFirewall.copyRules(',
                        '                    sessionFirewall,',
                        '                    request.srcHostname,',
                        '                    Object.assign(Object.create(null), request.desHostnames)',
                        '                )',
                        '            ) {',
                        '                µb.savePermanentFirewallRules();',
                        '            }',
                        '            if (',
                        '                permanentSwitches.copyRules(',
                        '                    sessionSwitches,',
                        '                    request.srcHostname',
                        '                )',
                        '            ) {',
                        '                µb.saveHostnameSwitches();',
                        '            }',
                        '        });',
                        '',
                        '    case \'toggleHostnameSwitch\':',
                        '        return whenReady(callback, ( ) => {',
                        '            µb.toggleHostnameSwitch(request);',
                        '            return popupDataFromTabId(request.tabId);',
                        '        }, ( ) => popupDataFromTabId(request.tabId));',
                        '',
                        '    case \'toggleFirewallRule\':',
                        '        return whenReady(callback, ( ) => {',
                        '            µb.toggleFirewallRule(request);',
                        '            return popupDataFromTabId(request.tabId);',
                        '        }, ( ) => popupDataFromTabId(request.tabId));',
                        '',
                        '    case \'toggleNetFiltering\':',
                        '        return whenReady(callback, ( ) => {',
                        '            const pageStore = µb.pageStoreFromTabId(request.tabId);',
                        '            if ( pageStore ) {',
                        '                pageStore.toggleNetFilteringSwitch(',
                        '                    request.url,',
                        '                    request.scope,',
                        '                    request.state',
                        '                );',
                        '                µb.updateToolbarIcon(request.tabId, 0b111);',
                        '            }',
                        '        });',
                        '',
                        '    default:',
                        '        return vAPI.messaging.UNHANDLED;',
                        '    }',
                    ],
                },
                // 4. (anchor: 9 lines, replacement: 20 lines)
                {
                    anchor: [
                        '        });',
                        '',
                        '    case \'getLists\':',
                        '        return µb.isReadyPromise.then(( ) => {',
                        '            getLists(callback);',
                        '        });',
                        '',
                        '    case \'getLocalData\':',
                        '        return getLocalData().then(localData => {',
                    ],
                    replacement: [
                        '        });',
                        '',
                        '    case \'getLists\':',
                        '        // Same readiness/hang guard as the popup-panel commands: `getLists`',
                        '        // reads engine state that is only valid at the end of the launch',
                        '        // sequence, and `µb.isReadyPromise` stays pending forever on a failed',
                        '        // launch. Route through `whenReady()` so the reply callback fires',
                        '        // exactly once -- with the lists on success, or an empty (but',
                        '        // object-shaped) degraded response on timeout/error so the dashboard\'s',
                        '        // `Object.entries(response.available)` cannot throw.',
                        '        return whenReady(',
                        '            callback,',
                        '            ( ) => new Promise((resolve, reject) => {',
                        '                getLists(resolve).then(undefined, reject);',
                        '            }),',
                        '            ( ) => ({ available: {}, cache: {} })',
                        '        );',
                        '',
                        '    case \'getLocalData\':',
                        '        return getLocalData().then(localData => {',
                    ],
                },
            ],
        },
        {
            // js/storage.js -- µb.loadSelectedFilterLists retries a failed read
            // (3 attempts, 1s apart), records selectedFilterListsReadFailed and
            // keeps the current selection when the read fails; selfie creation is
            // skipped when the selection is empty AND the read failed.
            rel: 'js/storage.js',
            probe: 'selectedFilterListsReadFailed',
            edits: [
                // 1. (anchor: 8 lines, replacement: 28 lines)
                {
                    anchor: [
                        '/******************************************************************************/',
                        '',
                        'µb.loadSelectedFilterLists = async function() {',
                        '    const bin = await vAPI.storage.get(\'selectedFilterLists\');',
                        '    if ( bin instanceof Object && Array.isArray(bin.selectedFilterLists) ) {',
                        '        this.selectedFilterLists = bin.selectedFilterLists;',
                        '        return;',
                        '    }',
                    ],
                    replacement: [
                        '/******************************************************************************/',
                        '',
                        'µb.loadSelectedFilterLists = async function() {',
                        '    // `vAPI.storage.get()` fulfills with `null` when the read failed, and',
                        '    // with an object -- possibly an empty one -- otherwise. A failed read',
                        '    // must not be handled as a first-time launch: persisting the default',
                        '    // selection over an unread one would silently revert the user\'s own',
                        '    // selection.',
                        '    let bin = null;',
                        '    // A failed read may be the result of a transient condition, retry.',
                        '    for ( let i = 0; i < 3 && bin === null; i++ ) {',
                        '        if ( i !== 0 ) { await vAPI.defer.once(1000); }',
                        '        bin = await vAPI.storage.get(\'selectedFilterLists\');',
                        '    }',
                        '    // Record whether the read failed so downstream consumers (e.g. selfie',
                        '    // creation) can tell an empty selection caused by a failed read apart',
                        '    // from one the user deliberately chose.',
                        '    this.selectedFilterListsReadFailed = bin === null;',
                        '    if ( bin === null ) {',
                        '        // Keep the current selection as-is, and write nothing. The selection',
                        '        // will be read again at next launch.',
                        '        ubolog(`Selected filter lists could not be read from storage`);',
                        '        return;',
                        '    }',
                        '    if ( Array.isArray(bin.selectedFilterLists) ) {',
                        '        this.selectedFilterLists = bin.selectedFilterLists;',
                        '        return;',
                        '    }',
                    ],
                },
                // 2. (anchor: 6 lines, replacement: 19 lines)
                {
                    anchor: [
                        '        createTimer.off();',
                        '        if ( µb.inMemoryFilters.length !== 0 ) { return; }',
                        '        if ( Object.keys(µb.availableFilterLists).length === 0 ) { return; }',
                        '        await Promise.all([',
                        '            io.toCache(\'selfie/staticMain\', {',
                        '                magic: µb.systemSettings.selfieMagic,',
                    ],
                    replacement: [
                        '        createTimer.off();',
                        '        if ( µb.inMemoryFilters.length !== 0 ) { return; }',
                        '        if ( Object.keys(µb.availableFilterLists).length === 0 ) { return; }',
                        '        // A selfie built from an empty filtering engine is legitimate only',
                        '        // when the empty selection is the user\'s own choice. If the selection',
                        '        // could not be read this launch, the empty engine is not trustworthy:',
                        '        // skip the selfie so it does not overwrite a valid one, letting the',
                        '        // real selection be read again at next launch. An empty selection from',
                        '        // a successful read is a valid state, and a selfie is created for it as',
                        '        // usual, avoiding a needless full re-parse at every launch.',
                        '        if (',
                        '            µb.selectedFilterLists.length === 0 &&',
                        '            µb.selectedFilterListsReadFailed',
                        '        ) {',
                        '            return;',
                        '        }',
                        '        await Promise.all([',
                        '            io.toCache(\'selfie/staticMain\', {',
                        '                magic: µb.systemSettings.selfieMagic,',
                    ],
                },
            ],
        },
    ];

    for ( const { rel, probe, edits } of RUNTIME_HARDENING ) {
        const abs = path.join(pkgDir, rel);
        if ( swGraph.has(rel) === false ) {
            console.error(
                `*** patch-mv3-modules: ${rel} is not reachable from js/sw.js; ` +
                `cannot apply the runtime hardening`
            );
            process.exit(1);
        } else if ( fs.existsSync(abs) === false ) {
            console.error(
                `*** patch-mv3-modules: ${rel} missing; cannot apply the ` +
                `runtime hardening`
            );
            process.exit(1);
        } else {
            const src = fs.readFileSync(abs, 'utf8');
            if ( src.includes(probe) ) {
                console.log(
                    `*** patch-mv3-modules: ${rel} is already hardened ` +
                    `against mid-boot messages and failed reads`
                );
            } else {
                const eol = src.includes('\r\n') ? '\r\n' : '\n';
                let out = src;
                for ( const [ i, edit ] of edits.entries() ) {
                    const anchor = edit.anchor.join(eol);
                    const count = out.split(anchor).length - 1;
                    if ( count !== 1 ) {
                        console.error(
                            `*** patch-mv3-modules: ${rel} contains ${count} ` +
                            `occurrence(s) of edit ${i + 1} of ${edits.length} ` +
                            `of the runtime hardening (expected exactly 1):\n` +
                            `${anchor}\n` +
                            `    Reconcile tools/patch-mv3-modules.mjs with ` +
                            `the new upstream shape.`
                        );
                        process.exit(1);
                    }
                    out = out.replace(anchor, ( ) => edit.replacement.join(eol));
                }
                fs.writeFileSync(abs, out);
                console.log(
                    `*** patch-mv3-modules: ${rel} hardened against mid-boot ` +
                    `messages and failed storage reads (${edits.length} edit(s))`
                );
            }
        }
    }
}

/******************************************************************************/
/******************************************************************************/

// Generate the sharded scriptlet libraries. See the header comment (transform
// 3) for the CSP rationale; what follows decides how the functions are split
// across files, which is a performance decision with correctness constraints.
//
// The cost being optimized is the bytes injected per scriptlet-bearing
// navigation. MV2 assembled one small payload per navigation (1-20 KB); a
// single per-world library file instead makes every navigation inject the
// whole of it (213 KB for MAIN, 57 KB more for ISOLATED when both worlds
// fired). The fix is to split each library into an always-injected "shared"
// file plus per-cluster "shard" files, and have `mv3-shims.js` inject only
// the shards holding the called functions -- computed from the launch
// record's function names, in one `chrome.scripting` call per world.
//
// The correctness constraints, each of which shaped the design:
//
// - Scriptlet sources reference their dependencies by bare name. A bare name
//   resolves only through the defining closure (same file) or the world's
//   global object. Globals were rejected: in the MAIN world they would be
//   page-visible AND page-redefinable (a page could neuter deferred scriptlet
//   calls by overwriting `window.proxyApplyFn` after the injection -- MV2's
//   closure scoping was immune, and so is this). So every reference must
//   resolve within the file that contains it: each shard is closed under the
//   functions it needs, and the ones it needs from elsewhere are
//   destructured out of the injection-time registry (see below), capturing
//   the function at evaluation time -- tamper-proof afterwards.
//
// - `safeSelf()` (and a few other sources) read the per-document
//   `scriptletGlobals` as a bare identifier -- under MV2 it was a closure
//   `const` at the top of the payload IIFE. It must therefore be a closure
//   variable of every file whose sources read it; a page-visible global of
//   that generic name was rejected (page collision, and it would carry the
//   logger secret). Every generated file declares its own
//   `const scriptletGlobals` from the launch record.
//
// - Functions that keep state on themselves (`safeSelf.safe`,
//   `proxyApplyFn.proxies`, `trapPropertyFn.db`, ...) must exist exactly
//   once per world, or two copies would each install their own
//   `Function.prototype.toString` proxy / WeakMap and the earlier copy's
//   registrations would be silently dropped. The generator detects
//   self-referential state and forces any such function needed by more than
//   one shard into the shared file.
//
// - Calls must run in payload order, and -- as under MV2, where the whole
//   payload was one synchronous script evaluation -- with no microtask
//   checkpoint between them (a page's MutationObserver could otherwise
//   observe intermediate states MV2 never showed). Only the launch file
//   executes calls, in one evaluation, after every other file has run.
//
// The resulting file set per world, injected in this order by ONE
// `chrome.scripting` call:
//
//   1. the shared file -- an IIFE which parses the launch record (MAIN: the
//      DOM data attribute the ISOLATED guard func wrote; ISOLATED: the
//      `self.uBO_mv3IsolatedLaunch` stash), stashes it on the transient
//      `self.uBO_mv3Lib` registry, declares `scriptletGlobals`, defines the
//      shared functions and registers them on the registry;
//   2. zero or more shard files -- IIFEs which destructure the shared
//      functions they need out of the registry, declare `scriptletGlobals`,
//      define their scriptlets and cluster-local dependencies, and register
//      their functions on the registry;
//   3. the launch file -- an IIFE which consumes the launch record,
//      dispatches every call in payload order through the registry (each in
//      the same silent try/catch the assembled payload used, resolving the
//      interned-argument indices), then deletes the registry and the launch
//      record. Deferred scriptlet callbacks keep working: they hold direct
//      references captured at evaluation time.
//
// `self.uBO_mv3Lib` is the one transient cross-file channel -- function
// references cannot cross files any other way without globals. It exists for
// the duration of the injection and is deleted by the launch file; the
// page-observable surface it adds is strictly smaller than that of the
// launch-record data attribute, which already exists for one round trip (the
// registry holds no data, only function references).
//
// The layout algorithm is deterministic -- roots are processed in name
// order, every derived set is built from sorted iteration, and the loop
// count is fixed -- so the same resource table always yields the same
// layout:
//
// - The "tree" of a callable scriptlet is the transitive closure over its
//   declared `dependencies` plus any bare-name references to other known
//   functions found in its source (upstream has undeclared references; the
//   regex over-approximates, which can only pull a function into a shard
//   that did not strictly need it).
// - Roots are packed into shards in name order -- alphabetical order keeps
//   same-family scriptlets (json-*, prevent-*, set-*) together, so a
//   navigation's scriptlets usually land in one shard -- splitting whenever
//   a shard's non-shared content reaches the byte target.
// - A function needed by several shards either goes into the shared file
//   (paid by every navigation, once) or is duplicated into each shard that
//   needs it (paid only by those navigations, once per shard). Functions
//   needed by many shards, or carrying self-referential state, are shared;
//   the rest are duplicated. Sharing must be closed under dependencies and
//   references -- a shared function's own references must resolve in the
//   shared file -- and because a function referenced from everywhere is
//   itself needed everywhere, that closure never pulls a cluster-local
//   function in by surprise.
// - Packing and sharing are interdependent (sharing shrinks shards), so the
//   two run together to a fixed point over a bounded number of rounds.
//
// The byte targets below were tuned against the current resource table (129
// MAIN functions / 208 KB, 38 ISOLATED / 54 KB) so that a typical 1-3
// scriptlet navigation injects well under 100 KB per world; the
// per-navigation worst case is bounded by the total size of all of a
// world's files, and tools/verify-mv3-package.mjs asserts budget ceilings
// so upstream growth fails the build rather than silently regressing the
// delivery cost.

// Tuning constants. Byte targets are per shard, excluding shared content.
const SCRIPTLET_SHARDING = {
    ISOLATED: {
        worldKey: 'isolated',
        label: 'isolated-world',
        targetBytes: 9 * 1024,
        shareMinShards: 5,
        shared: 'js/mv3-scriptlet-shared.js',
        shardPrefix: 'js/mv3-scriptlet-library-',
        launch: 'js/mv3-scriptlet-launch.js',
        // The isolated-world shared file is small enough that splitting it
        // would trade a file injection for a few KB; leave it whole.
        splitShared: false,
    },
    MAIN: {
        worldKey: 'main',
        label: 'main-world',
        targetBytes: 10 * 1024,
        // Deliberately high: sharing is a byte trade that also forces a
        // function into whichever shared file holds it, and the main-world
        // shared set is split into core (every navigation pays) and heavy
        // (paid only by the navigations that need it). A stateless dep
        // needed by a minority of shards is cheaper duplicated into each
        // shard that uses it than shared -- sharing it would drag the
        // whole heavy file onto every navigation whose tree touches it
        // (validateConstantFn, needed by 4 of ~24 shards, once cost every
        // set-constant page the entire 48 KB heavy half). Only functions
        // needed by most shards -- or carrying self-referential state,
        // which the fixed point shares unconditionally -- stay shared.
        shareMinShards: 15,
        shared: 'js/mv3-mainworld-shared-core.js',
        heavy: 'js/mv3-mainworld-shared-heavy.js',
        shardPrefix: 'js/mv3-mainworld-library-',
        launch: 'js/mv3-mainworld-launch.js',
        // The main-world shared set is dominated by dependencies only some
        // scriptlet families reach for (JSONPath alone is ~20 KB); split it
        // so a navigation pays for those only when it calls something that
        // needs them.
        splitShared: true,
    },
};
const SHARD_MAX_BYTES = 48 * 1024;
const SHARED_CORE_MAX_BYTES = 16 * 1024;
const SHARED_MAX_BYTES = 64 * 1024;  // the unsplit (isolated-world) shared file
const HEAVY_MAX_BYTES = 64 * 1024;
const MAX_SHARDS = 99;
const PACKING_ROUNDS = 8;

const generateScriptletLibraries = async ( ) => {
    const resourcesModule = await import(pathToFileURL(
        path.join(pkgDir, 'js', 'resources', 'scriptlets.js')
    ).href);
    const entries = resourcesModule.builtinScriptlets;
    if ( Array.isArray(entries) === false || entries.length === 0 ) {
        console.error(
            `*** patch-mv3-modules: js/resources/scriptlets.js exports no ` +
            `builtinScriptlets -- cannot generate the scriptlet libraries`
        );
        process.exit(1);
    }
    const byName = new Map(entries.map(e => [ e.name, e ]));

    // The closure of a world's scriptlet set: every entry routed to that
    // world plus everything reachable through their declared dependencies,
    // mirroring the walk `lookupScriptlet()` in
    // src/js/scriptlet-filtering-core.js performs when it assembles that
    // world's payload.
    const makeClosure = world => {
        const closure = [];
        const seen = new Set();
        const visit = name => {
            if ( seen.has(name) ) { return; }
            seen.add(name);
            const entry = byName.get(name);
            if ( entry === undefined || typeof entry.fn !== 'function' ) { return; }
            closure.push(entry);
            for ( const dep of entry.dependencies || [] ) { visit(dep); }
        };
        for ( const entry of entries ) {
            if ( typeof entry.fn !== 'function' ) { continue; }
            if ( world === 'ISOLATED' ? entry.world !== 'ISOLATED' : entry.world === 'ISOLATED' ) {
                continue;
            }
            visit(entry.name);
        }
        return closure;
    };

    // The injection protocols resolve scriptlets by declared function name,
    // exactly as the payload's calls do (`fname(args);` from
    // patchScriptlet()). A function that is not a named declaration has no
    // such name and cannot be called -- fail the build rather than silently
    // skipping it. Duplicates would silently shadow each other. Named
    // `class` declarations and `async function` declarations are accepted
    // alongside plain ones: the resource table uses both (`jsonpath.fn` is a
    // class, `edit-element-object.fn` is async), and a classic script
    // declares them just as well.
    const collectFunctions = (closure, label) => {
        const fns = new Map();   // entry name -> { fnName, src, size, deps }
        const byFnName = new Map();
        for ( const entry of closure ) {
            const fnName = entry.fn.name;
            const src = entry.fn.toString();
            const reName = escapeRe(fnName);
            const isDecl = typeof fnName === 'string' && fnName !== '' && (
                new RegExp(`^(async\\s+)?function\\s+${reName}\\s*\\(`).test(src) ||
                new RegExp(`^class\\s+${reName}\\s*(\\{|extends)`).test(src)
            );
            if ( isDecl === false ) {
                console.error(
                    `*** patch-mv3-modules: ${entry.name} is not a named ` +
                    `declaration (${src.slice(0, 60)}...); the ${label} ` +
                    `injection protocol cannot call it`
                );
                process.exit(1);
            }
            if ( byFnName.has(fnName) ) {
                console.error(
                    `*** patch-mv3-modules: two ${label} resources declare ` +
                    `the same function name (${fnName})`
                );
                process.exit(1);
            }
            byFnName.set(fnName, entry.name);
            fns.set(entry.name, {
                fnName,
                src,
                size: src.length,
                deps: new Set(entry.dependencies || []),
            });
        }
        return { fns, byFnName };
    };

    const banner = ( marker, description ) => [
        '/*******************************************************************************',
        '',
        `    ${marker} -- DO NOT EDIT.`,
        '',
        '    Generated by tools/patch-mv3-modules.mjs from js/resources/scriptlets.js:',
        ...description,
        '',
        '*******************************************************************************/',
        '',
    ];

    const results = { };

    for ( const world of [ 'ISOLATED', 'MAIN' ] ) {
        const spec = SCRIPTLET_SHARDING[world];
        const closure = makeClosure(world);
        if ( closure.length === 0 ) {
            console.error(
                `*** patch-mv3-modules: no world:'${world}' scriptlets found ` +
                `in js/resources/scriptlets.js -- that injection path would ` +
                `be dead. Reconcile platform/chromium-mv3/mv3-shims.js and ` +
                `tools/patch-mv3-modules.mjs with the new upstream shape.`
            );
            process.exit(1);
        }
        const { fns, byFnName } = collectFunctions(closure, spec.label);

        // Bare-name references between the world's functions: the payload
        // assembled them all into one script scope, so an undeclared
        // reference worked as long as the referent was somewhere in the
        // library. Preserve that by treating every reference as a
        // dependency edge. The regex over-approximates (string literals,
        // comments) which can only over-include.
        const reAnyFn = new RegExp(`\\b(${[ ...byFnName.keys() ].map(escapeRe).join('|')})\\b`, 'g');
        const refs = new Map();  // entry name -> Set<entry name>
        for ( const [ name, info ] of fns ) {
            const out = new Set();
            let match;
            reAnyFn.lastIndex = 0;
            while ( (match = reAnyFn.exec(info.src)) !== null ) {
                const ref = byFnName.get(match[1]);
                if ( ref !== undefined && ref !== name ) { out.add(ref); }
            }
            refs.set(name, out);
        }

        // Functions that keep state on their own function object must never
        // be duplicated across shards (two `Function.prototype.toString`
        // proxies, two WeakMaps, half the registrations lost).
        const stateful = new Set();
        for ( const [ name, info ] of fns ) {
            if ( new RegExp(`\\b${escapeRe(info.fnName)}\\s*\\.[A-Za-z_$][\\w$]*`).test(info.src) ) {
                stateful.add(name);
            }
        }

        // The tree of each callable root: itself plus everything reachable
        // through declared dependencies and bare-name references.
        const rootNames = closure
            .filter(e => world === 'ISOLATED' ? e.world === 'ISOLATED' : e.world !== 'ISOLATED')
            .map(e => e.name)
            .sort();
        const treeOf = new Map();
        for ( const root of rootNames ) {
            const tree = new Set();
            const stack = [ root ];
            while ( stack.length !== 0 ) {
                const name = stack.pop();
                if ( tree.has(name) ) { continue; }
                tree.add(name);
                const info = fns.get(name);
                if ( info === undefined ) { continue; }
                for ( const dep of info.deps ) { stack.push(dep); }
                for ( const ref of refs.get(name) ) { stack.push(ref); }
            }
            treeOf.set(root, tree);
        }

        // Seed the shared set with what at least half the roots need
        // (safeSelf today); the fixed point below grows it from there.
        const rootUsage = new Map();
        for ( const tree of treeOf.values() ) {
            for ( const name of tree ) {
                rootUsage.set(name, (rootUsage.get(name) || 0) + 1);
            }
        }
        const seed = new Set(
            [ ...rootUsage ].filter(([ , n ]) => n >= rootNames.length / 2)
                .map(([ name ]) => name)
        );

        // Fixed point: pack roots into shards by non-shared bytes, then move
        // cross-shard functions that qualify into the shared set, until a
        // round changes nothing. Bounded rounds keep the outcome
        // deterministic even if the two steps were to oscillate.
        let shared = new Set(seed);
        let shards = [ ];
        for ( let round = 0; round < PACKING_ROUNDS; round++ ) {
            shards = [ ];
            let content = new Set();
            let roots = [ ];
            let bytes = 0;
            for ( const root of rootNames ) {
                for ( const name of treeOf.get(root) ) {
                    if ( content.has(name) ) { continue; }
                    content.add(name);
                    if ( shared.has(name) === false ) { bytes += fns.get(name).size; }
                }
                roots.push(root);
                if ( bytes >= spec.targetBytes && root !== rootNames[rootNames.length - 1] ) {
                    shards.push({ roots, content });
                    content = new Set();
                    roots = [ ];
                    bytes = 0;
                }
            }
            if ( roots.length !== 0 ) { shards.push({ roots, content }); }

            const needShards = new Map();
            shards.forEach((shard, i) => {
                for ( const name of shard.content ) {
                    let set = needShards.get(name);
                    if ( set === undefined ) {
                        needShards.set(name, set = new Set());
                    }
                    set.add(i);
                }
            });
            const next = new Set(seed);
            for ( const [ name, set ] of needShards ) {
                if ( set.size < 2 ) { continue; }
                if ( set.size >= spec.shareMinShards || stateful.has(name) ) {
                    next.add(name);
                }
            }
            // Close under dependencies and references: a shared function's
            // own bare-name needs must resolve inside the shared file.
            for (;;) {
                const before = next.size;
                for ( const name of next ) {
                    const info = fns.get(name);
                    if ( info === undefined ) { continue; }
                    for ( const dep of info.deps ) { next.add(dep); }
                    for ( const ref of refs.get(name) ) { next.add(ref); }
                }
                if ( next.size === before ) { break; }
            }
            const converged =
                next.size === shared.size &&
                [ ...next ].every(name => shared.has(name));
            shared = next;
            if ( converged ) { break; }
        }

        if ( shards.length > MAX_SHARDS ) {
            console.error(
                `*** patch-mv3-modules: the ${spec.label} library split into ` +
                `${shards.length} shards (max ${MAX_SHARDS}) -- the resource ` +
                `table has outgrown the packing targets in ` +
                `SCRIPTLET_SHARDING.`
            );
            process.exit(1);
        }

        // Split the shared set when configured to: "core" is what the seed
        // -- the functions at least half the roots need -- closes to under
        // dependencies and references; it is what every scriptlet-bearing
        // navigation pays for. The remainder, "heavy", is dependencies only
        // some families reach for (JSONPath, lookupElementsFn,
        // proxyApplyFn, ...); it is injected only when a called root's tree
        // includes something from it (the manifest carries that set as
        // `heavy.neededBy`, and mv3-shims.js consults it). The split is
        // disjoint, so no function -- stateful ones included -- can exist
        // in both files at once, and core is closed, so it never needs
        // anything from heavy.
        let core = shared;
        let heavy = new Set();
        if ( spec.splitShared ) {
            core = new Set(seed);
            for (;;) {
                const before = core.size;
                for ( const name of core ) {
                    const info = fns.get(name);
                    if ( info === undefined ) { continue; }
                    for ( const dep of info.deps ) { core.add(dep); }
                    for ( const ref of refs.get(name) ) { core.add(ref); }
                }
                if ( core.size === before ) { break; }
            }
            // The fixed point closed `shared` over the same edges and
            // contains the seed, so core is a subset of it by construction.
            heavy = new Set([ ...shared ].filter(name => core.has(name) === false));
        }
        const sharedPool = new Set([ ...core, ...heavy ]);

        // Which roots reach for the heavy half, by function name.
        const heavyNeededBy = [ ];
        if ( heavy.size !== 0 ) {
            for ( const root of rootNames ) {
                const tree = treeOf.get(root);
                if ( [ ...heavy ].some(name => tree.has(name)) === false ) { continue; }
                heavyNeededBy.push(fns.get(root).fnName);
            }
            heavyNeededBy.sort();
        }

        // --- emit the shared file(s) ---
        const coreNames = [ ...core ].sort((a, b) =>
            fns.get(a).fnName < fns.get(b).fnName ? -1 : 1);
        const heavyNames = [ ...heavy ].sort((a, b) =>
            fns.get(a).fnName < fns.get(b).fnName ? -1 : 1);
        const readLaunch = world === 'MAIN'
            ? [
                'self.uBO_mv3Lib = self.uBO_mv3Lib || {};',
                'self.uBO_mv3Lib.launch = document.documentElement.dataset.uBOmv3Main === undefined',
                '    ? undefined',
                '    : JSON.parse(document.documentElement.dataset.uBOmv3Main);',
            ]
            : [
                'self.uBO_mv3Lib = self.uBO_mv3Lib || {};',
                'self.uBO_mv3Lib.launch = self.uBO_mv3IsolatedLaunch;',
            ];
        {
            const parts = banner('uBO MV3 auto-generated shared scriptlet library', [
                `    the ${spec.label} dependencies needed by nearly every shard,`,
                '    each function\'s source emitted verbatim. Injected into the',
                `    ${world} world first whenever any of its scriptlets fire. It`,
                '    also parses the launch record onto the transient',
                '    self.uBO_mv3Lib registry, where the shard and launch files',
                '    find it.',
                ...(heavy.size !== 0 ? [
                    '    Only the core half of the shared set lives here; the',
                    '    heavy half (dependencies few families need) is a separate',
                    '    file, injected only when a called scriptlet reaches for it.',
                ] : []),
            ]);
            parts.push('(function() {');
            parts.push(...readLaunch);
            parts.push(
                'const scriptletGlobals = self.uBO_mv3Lib.launch?.globals || {};',
            );
            for ( const name of coreNames ) {
                parts.push(fns.get(name).src, '');
            }
            parts.push(
                'Object.assign(self.uBO_mv3Lib, {',
                ...coreNames.map(name => `    ${fns.get(name).fnName},`),
                '});',
                '})();',
                '',
            );
            fs.writeFileSync(path.join(pkgDir, spec.shared), parts.join('\n'));
        }
        if ( heavy.size !== 0 ) {
            // The heavy half runs after the core file and destructures the
            // core functions its own sources reference out of the registry,
            // exactly as shard files do -- bare names must resolve within
            // the file.
            const needed = new Set();
            for ( const name of heavyNames ) {
                const info = fns.get(name);
                for ( const dep of info.deps ) {
                    if ( core.has(dep) && heavy.has(dep) === false ) { needed.add(dep); }
                }
                for ( const ref of refs.get(name) ) {
                    if ( core.has(ref) && heavy.has(ref) === false ) { needed.add(ref); }
                }
            }
            const parts = banner('uBO MV3 auto-generated heavy shared scriptlet library', [
                `    the ${spec.label} dependencies shared across several shards`,
                '    but needed only by some scriptlet families, each function\'s',
                '    source emitted verbatim. Injected into the ' + world + ' world',
                '    only when a called scriptlet\'s dependencies reach this half',
                '    (see heavy.neededBy in js/mv3-scriptlet-shards.js);',
                '    mv3-shims.js places it right after the core shared file.',
            ]);
            parts.push('(function() {');
            if ( needed.size !== 0 ) {
                const names = [ ...needed ]
                    .sort((a, b) => fns.get(a).fnName < fns.get(b).fnName ? -1 : 1)
                    .map(name => fns.get(name).fnName);
                parts.push(`const { ${names.join(', ')} } = self.uBO_mv3Lib || {};`);
            }
            parts.push(
                'const scriptletGlobals = self.uBO_mv3Lib?.launch?.globals || {};',
            );
            for ( const name of heavyNames ) {
                parts.push(fns.get(name).src, '');
            }
            parts.push(
                'Object.assign(self.uBO_mv3Lib || (self.uBO_mv3Lib = {}), {',
                ...heavyNames.map(name => `    ${fns.get(name).fnName},`),
                '});',
                '})();',
                '',
            );
            fs.writeFileSync(path.join(pkgDir, spec.heavy), parts.join('\n'));
        }

        // --- emit the shard files ---
        const shardFiles = [ ];
        const fnToFile = new Map();   // entry name -> package-relative file
        for ( const name of coreNames ) { fnToFile.set(name, spec.shared); }
        for ( const name of heavyNames ) { fnToFile.set(name, spec.heavy); }
        shards.forEach((shard, i) => {
            const file = `${spec.shardPrefix}${String(i + 1).padStart(2, '0')}.js`;
            const content = [ ...shard.content ]
                .filter(name => sharedPool.has(name) === false)
                .sort((a, b) => fns.get(a).fnName < fns.get(b).fnName ? -1 : 1);
            const defined = new Set(content);
            // Everything this shard's sources reference that lives in the
            // shared core or heavy files must be destructured out of the
            // registry, so bare names resolve through the shard's own
            // closure. A function needed only by a not-called sibling root
            // in the same shard can destructure to undefined: it is never
            // invoked, so the hole is unreachable.
            const needed = new Set();
            for ( const name of content ) {
                const info = fns.get(name);
                for ( const dep of info.deps ) {
                    if ( sharedPool.has(dep) && defined.has(dep) === false ) {
                        needed.add(dep);
                    }
                }
                for ( const ref of refs.get(name) ) {
                    if ( sharedPool.has(ref) && defined.has(ref) === false ) {
                        needed.add(ref);
                    }
                }
            }
            const parts = banner('uBO MV3 auto-generated scriptlet library shard', [
                `    a cluster of ${spec.label} scriptlets with their`,
                '    cluster-local dependencies, each function\'s source emitted',
                '    verbatim. Injected into the ' + world + ' world only when one of',
                '    its functions is called: mv3-shims.js computes the shard set',
                '    from the launch record\'s function names.',
            ]);
            parts.push('(function() {');
            if ( needed.size !== 0 ) {
                const names = [ ...needed ]
                    .sort((a, b) => fns.get(a).fnName < fns.get(b).fnName ? -1 : 1)
                    .map(name => fns.get(name).fnName);
                parts.push(`const { ${names.join(', ')} } = self.uBO_mv3Lib || {};`);
            }
            parts.push(
                'const scriptletGlobals = self.uBO_mv3Lib?.launch?.globals || {};',
            );
            for ( const name of content ) {
                parts.push(fns.get(name).src, '');
            }
            parts.push(
                'Object.assign(self.uBO_mv3Lib || (self.uBO_mv3Lib = {}), {',
                ...content.map(name => `    ${fns.get(name).fnName},`),
                '});',
                '})();',
                '',
            );
            fs.writeFileSync(path.join(pkgDir, file), parts.join('\n'));
            shardFiles.push(file);
            for ( const name of content ) { fnToFile.set(name, file); }
        });

        // --- emit the launch file ---
        {
            const consumeLaunch = world === 'MAIN'
                ? [
                    'if ( document.documentElement.dataset.uBOmv3Main !== undefined ) {',
                    '    delete document.documentElement.dataset.uBOmv3Main;',
                    '}',
                    'const launch = self.uBO_mv3Lib?.launch;',
                ]
                : [
                    'const launch = self.uBO_mv3IsolatedLaunch;',
                    'self.uBO_mv3IsolatedLaunch = undefined;',
                ];
            const parts = banner('uBO MV3 auto-generated scriptlet library launcher', [
                `    consumes the ${spec.label} launch record and dispatches every`,
                '    call in payload order inside the same silent try/catch the',
                '    assembled payload used, resolving the interned-argument',
                '    indices (see internScriptletArgs in',
                '    platform/chromium-mv3/mv3-post.js), then removes the',
                '    transient registry. Runs last: all shard files must have',
                '    registered their functions first.',
            ]);
            parts.push(
                '(function() {',
                ...consumeLaunch,
                'try {',
                '    if ( launch instanceof Object && launch.calls instanceof Array ) {',
                '        const args = launch.args || [];',
                '        for ( const [ fnName, argIndices ] of launch.calls ) {',
                '            const fn = self.uBO_mv3Lib?.[fnName];',
                '            if ( typeof fn !== \'function\' ) { continue; }',
                '            try { fn(...argIndices.map(i => args[i])); } catch { }',
                '        }',
                '    }',
                '} finally {',
                '    delete self.uBO_mv3Lib;',
                '}',
                '})();',
                '',
            );
            fs.writeFileSync(path.join(pkgDir, spec.launch), parts.join('\n'));
        }

        // --- byte report + hard ceilings ---
        const fileSize = rel => fs.statSync(path.join(pkgDir, rel)).size;
        const sharedBytes = fileSize(spec.shared);
        const heavyBytes = heavy.size !== 0 ? fileSize(spec.heavy) : 0;
        const launchBytes = fileSize(spec.launch);
        const shardBytes = shardFiles.map(fileSize);
        const totalBytes = sharedBytes + heavyBytes + launchBytes +
            shardBytes.reduce((a, b) => a + b, 0);
        const largestShard = shardBytes.reduce((a, b) => Math.max(a, b), 0);
        const sharedCeiling = spec.splitShared ? SHARED_CORE_MAX_BYTES : SHARED_MAX_BYTES;
        if ( sharedBytes > sharedCeiling ) {
            console.error(
                `*** patch-mv3-modules: the ${spec.label} core shared file is ` +
                `${sharedBytes} bytes (max ${sharedCeiling}) -- the resource ` +
                `table has outgrown the sharding constants.`
            );
            process.exit(1);
        }
        if ( heavyBytes > HEAVY_MAX_BYTES ) {
            console.error(
                `*** patch-mv3-modules: the ${spec.label} heavy shared file ` +
                `is ${heavyBytes} bytes (max ${HEAVY_MAX_BYTES}) -- the ` +
                `resource table has outgrown the sharding constants.`
            );
            process.exit(1);
        }
        for ( let i = 0; i < shardFiles.length; i++ ) {
            if ( shardBytes[i] <= SHARD_MAX_BYTES ) { continue; }
            console.error(
                `*** patch-mv3-modules: ${shardFiles[i]} is ${shardBytes[i]} ` +
                `bytes (max ${SHARD_MAX_BYTES}) -- a single cluster has ` +
                `outgrown the sharding constants.`
            );
            process.exit(1);
        }
        console.log(
            `*** patch-mv3-modules: generated the ${spec.label} library: ` +
            `${shards.length} shard(s) + shared${heavy.size !== 0 ? ' (core+heavy)' : ''} + launch, ` +
            `${closure.length} functions, ${totalBytes} bytes total`
        );
        console.log(
            `    shared ${sharedBytes} B` +
            (heavy.size !== 0 ? ` (core) + ${heavyBytes} B (heavy, needed by ${heavyNeededBy.length} of ${rootNames.length} scriptlets)` : '') +
            `, shards ${shardBytes.join(' + ')} B, launch ${launchBytes} B`
        );
        console.log(
            `    worst case (all files) ${totalBytes} B; typical ` +
            `(shared + largest shard + launch) ` +
            `${sharedBytes + largestShard + launchBytes} B`
        );

        results[world] = {
            spec,
            heavyNeededBy,
            fnToFile: [ ...fnToFile ]
                .sort((a, b) => fns.get(a[0]).fnName < fns.get(b[0]).fnName ? -1 : 1)
                .map(([ name, file ]) => [ fns.get(name).fnName, file ]),
        };
    }

    // --- emit the manifest module consumed by mv3-shims.js and pinned by
    // verify-mv3-package.mjs ---
    const parts = [
        '/*******************************************************************************',
        '',
        '    uBO MV3 auto-generated scriptlet shard manifest -- DO NOT EDIT.',
        '',
        '    Generated by tools/patch-mv3-modules.mjs from js/resources/scriptlets.js.',
        '    Maps every scriptlet-library function name to the file defining it,',
        '    per world, so that platform/chromium-mv3/mv3-shims.js can inject only',
        '    the shards a navigation actually calls.',
        '',
        '*******************************************************************************/',
        '',
        'export const scriptletShards = {',
    ];
    for ( const world of [ 'ISOLATED', 'MAIN' ] ) {
        const { spec, heavyNeededBy, fnToFile } = results[world];
        parts.push(
            `    ${spec.worldKey}: {`,
            `        shared: '${spec.shared}',`,
        );
        if ( typeof spec.heavy === 'string' && heavyNeededBy.length !== 0 ) {
            parts.push(
                `        heavy: {`,
                `            file: '${spec.heavy}',`,
                `            neededBy: [`,
            );
            for ( const fnName of heavyNeededBy ) {
                parts.push(`                ${JSON.stringify(fnName)},`);
            }
            parts.push(
                `            ],`,
                `        },`,
            );
        }
        parts.push(
            `        launch: '${spec.launch}',`,
            `        fns: {`,
        );
        for ( const [ fnName, file ] of fnToFile ) {
            parts.push(`            ${JSON.stringify(fnName)}: '${file}',`);
        }
        parts.push(
            '        },',
            '    },',
        );
    }
    parts.push('};', '');
    fs.writeFileSync(
        path.join(pkgDir, 'js/mv3-scriptlet-shards.js'),
        parts.join('\n')
    );
    console.log(
        `*** patch-mv3-modules: generated js/mv3-scriptlet-shards.js ` +
        `(${results.ISOLATED.fnToFile.length + results.MAIN.fnToFile.length} ` +
        `function entries)`
    );
};

await generateScriptletLibraries();
/******************************************************************************/
/******************************************************************************/

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
