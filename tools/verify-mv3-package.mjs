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

    Verify a built Chromium MV3 package, and verify that the assumptions this
    port makes about upstream still hold.

    Two distinct jobs, deliberately in one tool so that both the CI build and
    the release build run the exact same checks:

    1. PACKAGE checks -- is the thing we are about to ship shaped like a valid
       MV3 extension? These used to live inline in .github/workflows/build.yml,
       which meant the one build that actually shipped (release.yml) was the
       least checked.

    2. DRIFT checks -- the port adds files and modifies none, so an unattended
       merge from upstream can never conflict. The flip side is that a merge can
       silently invalidate an assumption instead. Every hard-coded upstream
       string, file list and manifest shape this port depends on is asserted
       here, so a breaking upstream change fails the build with a message that
       names the fix.

    Usage:
      node tools/verify-mv3-package.mjs [--dir <package-dir>] [--repo <root>]

    Defaults: --dir dist/build/uBlock0.chromium-mv3, --repo the parent of this
    script's directory. Exits 0 when everything passes, 1 otherwise. Under
    GitHub Actions it also emits ::error:: / ::warning:: annotations.

**/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/******************************************************************************/

const args = new Map();
for ( let i = 2; i < process.argv.length; i += 2 ) {
    args.set(process.argv[i].replace(/^--/, ''), process.argv[i+1]);
}

const repoDir = path.resolve(
    args.get('repo') || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '..')
);
const pkgDir = path.resolve(
    args.get('dir') || path.join(repoDir, 'dist/build/uBlock0.chromium-mv3')
);

const inActions = process.env.GITHUB_ACTIONS === 'true';

/******************************************************************************/

let failures = 0;
let warnings = 0;
const checked = [];

function fail(check, message, remedy) {
    failures += 1;
    const text = remedy ? `${message}\n    FIX: ${remedy}` : message;
    if ( inActions ) {
        // Annotations are single-line; keep the remedy on the same line there.
        console.log(`::error title=${check}::${text.replace(/\n\s*/g, ' -- ')}`);
    }
    console.log(`  FAIL  ${check}`);
    console.log(`        ${text.split('\n').join('\n        ')}`);
}

function warn(check, message) {
    warnings += 1;
    if ( inActions ) {
        console.log(`::warning title=${check}::${message.replace(/\n\s*/g, ' -- ')}`);
    }
    console.log(`  WARN  ${check}`);
    console.log(`        ${message}`);
}

function pass(check) {
    checked.push(check);
    console.log(`  ok    ${check}`);
}

function readPkg(rel) {
    return fs.readFileSync(path.join(pkgDir, rel), 'utf8');
}

function readRepo(rel) {
    return fs.readFileSync(path.join(repoDir, rel), 'utf8');
}

function existsPkg(rel) {
    return fs.existsSync(path.join(pkgDir, rel));
}

function section(title) {
    console.log(`\n--- ${title} ---`);
}

/******************************************************************************/

if ( fs.existsSync(pkgDir) === false ) {
    fail('package-exists', `No package at ${pkgDir}`,
        'Run: bash tools/make-chromium-mv3.sh');
    process.exit(1);
}

console.log(`*** verify-mv3-package`);
console.log(`    package ${pkgDir}`);
console.log(`    repo    ${repoDir}`);

/******************************************************************************/

section('package contents');

// Files without which the port simply does not run. `js/sw.js` and
// `js/mv3-shims.js` come from platform/chromium-mv3/, the rest are upstream
// files the shims stand in front of -- if a build stops producing one of them,
// tools/make-chromium-mv3.sh or tools/copy-common-files.sh has drifted. The
// two scriptlet libraries are the exception: they are generated by
// tools/patch-mv3-modules.mjs out of js/resources/scriptlets.js.
const REQUIRED_FILES = [
    'manifest.json',
    'offscreen.html',
    'js/sw.js',
    'js/mv3-shims.js',
    'js/mv3-post.js',
    'js/mv3-scriptlet-marker.js',
    'js/mv3-scriptlet-shards.js',
    'js/mv3-scriptlet-shared.js',
    'js/mv3-scriptlet-launch.js',
    'js/mv3-mainworld-shared-core.js',
    'js/mv3-mainworld-shared-heavy.js',
    'js/mv3-mainworld-launch.js',
    'js/offscreen.js',
    'js/start.js',
    'js/webext.js',
    'js/vapi.js',
    'js/vapi-background.js',
    'js/vapi-background-ext.js',
    'js/contentscript.js',
    'js/diff-updater.js',
    'js/reverselookup-worker.js',
    'js/resources/scriptlets.js',
    'lib/lz4/lz4-block-codec-js.js',
    // The WASM flavor the shims import for LZ4-selfie decompression, the
    // module it fetches, and the engine's other WASM modules (fetched by
    // start.js / storage.js once the manifest CSP opts into
    // 'wasm-unsafe-eval' -- see the wasm check below).
    'lib/lz4/lz4-block-codec-wasm.js',
    'lib/lz4/lz4-block-codec.wasm',
    'js/wasm/hntrie.wasm',
    'js/wasm/biditrie.wasm',
    'lib/publicsuffixlist/wasm/publicsuffixlist.wasm',
];

for ( const rel of REQUIRED_FILES ) {
    if ( existsPkg(rel) ) { continue; }
    fail('required-file', `missing from package: ${rel}`,
        'check tools/make-chromium-mv3.sh and tools/copy-common-files.sh');
}
if ( failures === 0 ) {
    pass(`${REQUIRED_FILES.length} required files present`);
} else {
    // Several later checks read specific package files directly (readPkg) and
    // would throw ENOENT mid-run if one were absent -- losing every check
    // after it, and the summary. A missing required file has already been
    // reported above, so stop cleanly here rather than crashing downstream.
    console.log('\n*** verify-mv3-package: FAILED');
    process.exit(1);
}

// MV3 has no background page. Shipping one would leave a second, unreferenced
// copy of uBO's background loadable by URL.
for ( const rel of [ 'background.html', 'manifest.overlay.json' ] ) {
    if ( existsPkg(rel) === false ) { continue; }
    fail('unwanted-file', `${rel} must not be packaged`,
        rel === 'background.html'
            ? 'tools/make-chromium-mv3.sh removes it after copy-common-files.sh'
            : 'the overlay is build input, not a shipped file');
}
pass('no background page or overlay in package');

/******************************************************************************/

section('manifest');

let manifest;
try {
    manifest = JSON.parse(readPkg('manifest.json'));
} catch ( ex ) {
    fail('manifest-parse', `manifest.json is not valid JSON: ${ex.message}`,
        'check tools/make-chromium-mv3-meta.py');
    manifest = {};
}

const manifestChecks = [
    [ 'manifest-version',
      ( ) => manifest.manifest_version === 3,
      'manifest_version is not 3' ],
    [ 'browser-action-renamed',
      ( ) => manifest.browser_action === undefined && manifest.action !== undefined,
      'browser_action survived the transform, or action is missing' ],
    [ 'service-worker',
      ( ) => manifest.background?.service_worker === 'js/sw.js',
      'service worker not wired up to js/sw.js' ],
    [ 'service-worker-module',
      ( ) => manifest.background?.type === 'module',
      'service worker is not type "module" -- sw.js uses static imports' ],
    [ 'no-background-page',
      ( ) => manifest.background?.page === undefined && manifest.background?.scripts === undefined,
      'an MV2-style background page/scripts key survived' ],
    [ 'host-permissions-split',
      ( ) => Array.isArray(manifest.host_permissions) && manifest.host_permissions.length !== 0,
      'host_permissions is empty -- the permissions split did not happen' ],
    [ 'no-host-patterns-in-permissions',
      ( ) => Array.isArray(manifest.permissions) &&
             manifest.permissions.some(p => p.includes('://') || p === '<all_urls>') === false,
      'host patterns left in permissions' ],
    [ 'csp-object-form',
      ( ) => typeof manifest.content_security_policy?.extension_pages === 'string',
      'content_security_policy is not in MV3 object form' ],
    [ 'war-object-form',
      ( ) => Array.isArray(manifest.web_accessible_resources) &&
             manifest.web_accessible_resources[0] instanceof Object &&
             Array.isArray(manifest.web_accessible_resources[0].resources),
      'web_accessible_resources is not in MV3 object form' ],
    [ 'devbuild-version-name',
      ( ) => {
          if ( /^\d+\.\d+\.\d+\.\d+$/.test(manifest.version) ) {
              return typeof manifest.version_name === 'string' &&
                     /^\d+\.\d+\.\d+\D/.test(manifest.version_name);
          }
          return true;
      },
      'dev builds (4-part version) require version_name matching /^\\d+\\.\\d+\\.\\d+\\D/ so vapi-common.js devbuild check succeeds' ],
];

for ( const [ name, test, message ] of manifestChecks ) {
    if ( test() ) { pass(name); continue; }
    fail(name, message, 'see tools/make-chromium-mv3-meta.py');
}

// Every permission the port's own code paths depend on.
const REQUIRED_PERMISSIONS = [
    'alarms',               // mv3-shims.js keepalive watchdog
    'offscreen',            // Worker host + keepalive pings
    'scripting',            // executeScript/insertCSS/removeCSS shims, incl. scriptlets
    'storage',
    'tabs',
    'webNavigation',
    'webRequest',
    'webRequestBlocking',   // policy-installed only, but must be declared
];
const missingPerms = REQUIRED_PERMISSIONS.filter(
    p => Array.isArray(manifest.permissions) === false || manifest.permissions.includes(p) === false
);
if ( missingPerms.length !== 0 ) {
    fail('required-permissions', `missing permission(s): ${missingPerms.join(', ')}`,
        'API permissions come from platform/chromium/manifest.json plus platform/chromium-mv3/manifest.overlay.json');
} else {
    pass(`${REQUIRED_PERMISSIONS.length} required permissions declared`);
}

// `userScripts` was removed along with the code-string injection path that
// needed it: scriptlets are now carried as data and inserted through
// `chrome.scripting` (see the scriptlet checks below). The permission drags
// the per-extension "Allow user scripts" toggle behind it, which nothing can
// pre-grant -- re-adding it would resurrect a silent off-by-default state.
if ( Array.isArray(manifest.permissions) && manifest.permissions.includes('userScripts') ) {
    fail('userScripts-permission',
        'manifest declares the "userScripts" permission, but nothing uses it',
        'remove it from platform/chromium-mv3/manifest.overlay.json -- the scriptlet path runs on chrome.scripting only');
} else {
    pass('no vestigial "userScripts" permission');
}

// A version Chrome will accept: one to four dot-separated integers, each
// 0-65535. This is what update.xml advertises and what Chrome compares.
if ( /^\d+(\.\d+){0,3}$/.test(manifest.version || '') === false ) {
    fail('version-shape', `manifest version is not a legal Chrome version: ${manifest.version}`,
        'it comes verbatim from dist/version -- a release must be built from a tree whose dist/version is a release version');
} else if ( (manifest.version || '').split('.').some(n => Number(n) > 65535) ) {
    fail('version-range', `a version component exceeds 65535: ${manifest.version}`);
} else {
    pass(`version ${manifest.version}`);
}

/******************************************************************************/

section('manifest-referenced assets');

// Chrome refuses to LOAD the extension when a file named by certain manifest
// keys is missing (managed_schema, the default-locale messages), and silently
// drops a feature when others are (a missing content script disables all
// injection). REQUIRED_FILES above is a hand-curated floor; this instead
// follows the manifest itself, so a key that begins pointing somewhere new is
// covered without editing a list.
const referenced = new Map(); // package-relative path -> manifest key that named it

function refer(rel, whence) {
    if ( typeof rel !== 'string' || rel === '' ) { return; }
    // Manifest paths may be root-absolute ("/js/x.js") or relative ("js/x.js");
    // both resolve against the package root.
    referenced.set(rel.replace(/^\//, ''), whence);
}

refer(manifest.storage?.managed_schema, 'storage.managed_schema');
if ( typeof manifest.default_locale === 'string' ) {
    refer(`_locales/${manifest.default_locale}/messages.json`, 'default_locale');
}
for ( const cs of manifest.content_scripts || [] ) {
    for ( const js of cs.js || [] ) { refer(js, 'content_scripts[].js'); }
    for ( const css of cs.css || [] ) { refer(css, 'content_scripts[].css'); }
}
refer(manifest.action?.default_popup, 'action.default_popup');
refer(manifest.options_ui?.page, 'options_ui.page');
for ( const p of Object.values(manifest.action?.default_icon || {}) ) { refer(p, 'action.default_icon'); }
for ( const p of Object.values(manifest.icons || {}) ) { refer(p, 'icons'); }
refer(manifest.background?.service_worker, 'background.service_worker');

const missingRefs = [];
for ( const [ rel, whence ] of referenced ) {
    if ( existsPkg(rel) === false ) { missingRefs.push(`${rel} (${whence})`); }
}
if ( missingRefs.length !== 0 ) {
    fail('manifest-referenced-files',
        `manifest names ${missingRefs.length} file(s) absent from the package:\n  ${missingRefs.join('\n  ')}`,
        'Chrome refuses to load when managed_schema or the default-locale messages are missing, and silently drops injection when a content script is; check tools/copy-common-files.sh and tools/make-assets.sh');
} else {
    pass(`${referenced.size} manifest-referenced file(s) present`);
}

// web_accessible_resources are globs ("/web_accessible_resources/*"); assert the
// directory each glob roots at exists rather than trying to expand the glob.
for ( const entry of manifest.web_accessible_resources || [] ) {
    for ( const res of entry.resources || [] ) {
        const dir = res.replace(/^\//, '').replace(/\/?\*+.*$/, '');
        if ( dir === '' || existsPkg(dir) ) { continue; }
        warn('war-dir', `web_accessible_resources glob "${res}" roots at "${dir}", which is absent from the package`);
    }
}

// minimum_chrome_version is kept at 138 as a conservative floor: the port is
// only ever exercised against current Chrome, and 138 was the last value with
// a hard feature dependency (the userScripts "Allow user scripts" toggle of
// the old scriptlet path, since removed). With userScripts gone the true
// floor is lower -- `chrome.scripting` MAIN-world injection is Chrome 95+ --
// so if a lower floor is ever wanted, re-derive it from the APIs the shims
// actually call rather than lowering this number on its own.
const MIN_CHROME = 138;
const mcv = parseInt((manifest.minimum_chrome_version || '').split('.')[0], 10);
if ( Number.isNaN(mcv) ) {
    fail('minimum-chrome-version', 'minimum_chrome_version is missing or unparseable',
        `set it to at least ${MIN_CHROME} in platform/chromium-mv3/manifest.overlay.json`);
} else if ( mcv < MIN_CHROME ) {
    fail('minimum-chrome-version', `minimum_chrome_version ${manifest.minimum_chrome_version} is below ${MIN_CHROME}`,
        `raise it in platform/chromium-mv3/manifest.overlay.json`);
} else {
    pass(`minimum_chrome_version ${manifest.minimum_chrome_version}`);
}

/******************************************************************************/

section('service worker module graph');

// Walk every static import reachable from js/sw.js. Anything unresolved would
// abort service worker startup, and the extension would be completely dead.
const reStaticImport =
    /(?:^|\n)[ \t]*(?:import|export)[^;\n]*?from[ \t]+["']([^"']+)["']|(?:^|\n)[ \t]*import[ \t]+["']([^"']+)["']/g;

const swReachable = new Set();
{
    const missing = [];
    const stack = [ 'js/sw.js' ];
    while ( stack.length !== 0 ) {
        const rel = stack.pop();
        if ( swReachable.has(rel) ) { continue; }
        swReachable.add(rel);
        let src;
        try {
            src = readPkg(rel);
        } catch {
            continue;
        }
        reStaticImport.lastIndex = 0;
        let match;
        while ( (match = reStaticImport.exec(src)) !== null ) {
            const spec = match[1] || match[2];
            if ( spec.startsWith('.') === false ) { continue; }
            const next = path.posix.normalize(
                path.posix.join(path.posix.dirname(rel), spec)
            );
            if ( existsPkg(next) ) {
                stack.push(next);
            } else {
                missing.push(`${rel} -> ${spec}`);
            }
        }
    }
    for ( const entry of missing ) {
        fail('unresolved-import', `unresolved import: ${entry}`,
            'the build flattens src/js, platform/common, platform/chromium and platform/chromium-mv3 into js/ -- a new upstream subdirectory would break this');
    }
    if ( missing.length === 0 ) {
        pass(`${swReachable.size} modules reachable from js/sw.js, all resolvable`);
    }
}

// The shims must be in place before any uBO module evaluates.
{
    const sw = readPkg('js/sw.js');
    const shims = sw.indexOf('./mv3-shims.js');
    const start = sw.indexOf('./start.js');
    if ( shims === -1 || start === -1 || shims > start ) {
        fail('shim-ordering', 'js/sw.js must import ./mv3-shims.js before ./start.js',
            'module dependencies evaluate in import order; the shims install globals uBO reads at module scope');
    } else {
        pass('mv3-shims.js imported before start.js');
    }
}

// Dynamic import() is unconditionally forbidden in a ServiceWorkerGlobalScope
// (Blink: WorkerModulatorImpl::IsDynamicImportForbidden). Any reachable call
// site rejects at runtime, and uBO swallows those rejections.
// tools/patch-mv3-modules.mjs rewrites upstream's call sites at build time; this
// asserts that none survived, so a new one added upstream fails the build
// instead of regressing silently.
{
    // The port's own modules are skipped for the same reason the patcher skips
    // them: this scan is not comment- or string-aware, and those files discuss
    // the construct in prose and quote it in an error message.
    const PORT_OWN_MODULES = new Set([
        'js/sw.js',
        'js/mv3-shims.js',
        'js/mv3-post.js',
    ]);
    const offenders = [];
    for ( const rel of swReachable ) {
        if ( PORT_OWN_MODULES.has(rel) ) { continue; }
        let src;
        try {
            src = readPkg(rel);
        } catch {
            continue;
        }
        const lines = src.split('\n');
        for ( let i = 0; i < lines.length; i++ ) {
            const line = lines[i];
            if ( /(?:^|[^.\w$])import\s*\(/.test(line) === false ) { continue; }
            if ( /^\s*(?:\/\/|\*|\/\*)/.test(line) ) { continue; }
            offenders.push(`${rel}:${i+1}: ${line.trim()}`);
        }
    }
    if ( offenders.length !== 0 ) {
        fail('dynamic-import',
            `dynamic import() is forbidden in a service worker; ${offenders.length} surviving call site(s):\n` +
            offenders.map(o => `  ${o}`).join('\n'),
            'tools/patch-mv3-modules.mjs should have rewritten these -- check that its pattern still matches, and register the module in platform/chromium-mv3/mv3-post.js');
    } else {
        pass('no dynamic import() reachable from the service worker');
    }
}

// The rewrite is only useful if the substitute exists and is populated.
{
    const shims = readPkg('js/mv3-shims.js');
    const post = readPkg('js/mv3-post.js');
    const sw = readPkg('js/sw.js');
    if ( shims.includes('uBO_dynamicImport') === false ) {
        fail('dynamic-import-shim', 'js/mv3-shims.js does not define uBO_dynamicImport',
            'the patched call sites would throw "not a function"');
    } else if ( post.includes('uBO_registerStaticModules') === false ) {
        fail('dynamic-import-shim', 'js/mv3-post.js does not register any static module',
            'uBO_dynamicImport awaits registration and would hang forever');
    } else if ( sw.indexOf('./mv3-post.js') < sw.indexOf('./start.js') ) {
        fail('dynamic-import-shim', 'js/sw.js must import ./mv3-post.js after ./start.js',
            'mv3-post.js patches what uBO defines during its own evaluation');
    } else {
        pass('uBO_dynamicImport defined, populated, and ordered after start.js');
    }
}

/******************************************************************************/

section('upstream drift');

// mv3-shims.js fakes document.title so that src/js/i18n.js's background-process
// detection matches. If upstream changes that <title>, i18n.js takes the page
// branch, calls document.body.setAttribute() at module scope, and the service
// worker dies during evaluation -- a total failure, far from its cause.
{
    const backgroundHtml = readRepo('src/background.html');
    const shims = readRepo('platform/chromium-mv3/mv3-shims.js');
    const titleMatch = /<title>([^<]*)<\/title>/.exec(backgroundHtml);
    const title = titleMatch && titleMatch[1];
    if ( title === null ) {
        fail('background-title', 'no <title> found in src/background.html',
            'mv3-shims.js sets document.title to match it');
    } else if ( shims.includes(`'${title}'`) === false ) {
        fail('background-title',
            `src/background.html <title> is "${title}", which mv3-shims.js does not set`,
            'update the document.title value in platform/chromium-mv3/mv3-shims.js to match, and check src/js/i18n.js\'s isBackgroundProcess test');
    } else {
        pass(`background page title "${title}" matches the shim`);
    }

    // src/background.html is what sw.js replaces. It currently loads three
    // scripts; sw.js covers them via mv3-shims.js (lz4 + vapi) and start.js.
    // A fourth script added upstream would be silently dropped.
    const scripts = [ ...backgroundHtml.matchAll(/<script[^>]*\bsrc="([^"]+)"/g) ].map(m => m[1]);
    const KNOWN_BACKGROUND_SCRIPTS = [
        'lib/lz4/lz4-block-codec-any.js',
        'js/vapi.js',
        'js/start.js',
    ];
    const unexpected = scripts.filter(s => KNOWN_BACKGROUND_SCRIPTS.includes(s) === false);
    if ( unexpected.length !== 0 ) {
        fail('background-scripts',
            `src/background.html loads script(s) the service worker does not: ${unexpected.join(', ')}`,
            'teach platform/chromium-mv3/sw.js or mv3-shims.js about them, then add them to KNOWN_BACKGROUND_SCRIPTS here');
    } else {
        pass(`src/background.html loads only the ${scripts.length} known scripts`);
    }
}

// tools/make-chromium-mv3-meta.py transforms a known set of manifest keys. A
// new key upstream would pass through untransformed -- harmless for some,
// invalid or wrong under MV3 for others (background.scripts, a DNR ruleset,
// side_panel, ...).
{
    const mv2 = JSON.parse(readRepo('platform/chromium/manifest.json'));
    const KNOWN_MV2_KEYS = [
        'author', 'background', 'browser_action', 'commands', 'content_scripts',
        'content_security_policy', 'default_locale', 'description', 'icons',
        'incognito', 'manifest_version', 'minimum_chrome_version', 'name',
        'options_ui', 'permissions', 'short_name', 'storage', 'version',
        'web_accessible_resources',
    ];
    const unknown = Object.keys(mv2).filter(k => KNOWN_MV2_KEYS.includes(k) === false);
    if ( unknown.length !== 0 ) {
        fail('manifest-keys',
            `platform/chromium/manifest.json has key(s) the MV3 generator does not know about: ${unknown.join(', ')}`,
            'decide how each behaves under MV3 in tools/make-chromium-mv3-meta.py, then add it to KNOWN_MV2_KEYS here');
    } else {
        pass(`all ${Object.keys(mv2).length} upstream manifest keys are accounted for`);
    }

    // The whole reason this port exists: uBO's filtering needs blocking
    // webRequest, which MV3 grants only to policy-installed extensions.
    if ( (mv2.permissions || []).includes('webRequestBlocking') === false ) {
        fail('upstream-webrequestblocking',
            'platform/chromium/manifest.json no longer requests webRequestBlocking',
            'upstream may have moved to declarativeNetRequest; this port\'s premise needs re-examining');
    } else {
        pass('upstream still requests webRequestBlocking');
    }
}

// Scriptlet helper files all run in the `ISOLATED` world (`chrome.scripting`
// files), alongside `contentscript.js`. The cross-world state some of them
// read is written there by the injection func in mv3-shims.js:
// `self.uBO_bcSecret` by the scriptlet->logger relay (read by
// `scriptlet-loglevel-*.js`), and `self.uBO_scriptletsInjected` /
// `self.uBO_isolatedScriptlets` by the once-per-document guard (read by
// `contentscript.js` and `scriptlets/cosmetic-report.js`). The scriptlets
// themselves run through the two generated libraries: the isolated-world set
// from a stash at `self.uBO_mv3IsolatedLaunch`, and the main-world set from a
// launch record the func writes to `document.documentElement.dataset.uBOmv3Main`
// -- a data attribute, the only state that crosses from the isolated world
// into the page. Both libraries are file-class injections, which run
// CSP-exempt in their worlds; no `<script>` element is ever created, because
// every world MV3 offers governs element creation with some CSP (the page's
// from MAIN, the extension's own from ISOLATED) -- MV2's element exemption
// died with tabs.executeScript.
//
// This check pins that whole shape: the relay, guards, DOM launch-record
// writer and stash all live inside the single `prepareScriptletInjection`
// func; mv3-shims.js contains exactly one `world:'MAIN'` occurrence (the
// mainworld library file call) and no `createElement` at all; both libraries
// exist, carry their halves of the protocol, and define the dependency every
// scriptlet shares; and no `chrome.userScripts` call survived anywhere -- the
// permission is no longer declared, so any surviving call would throw.
{
    const shims = readRepo('platform/chromium-mv3/mv3-shims.js');
    const post = readRepo('platform/chromium-mv3/mv3-post.js');
    const problems = [];
    // The single injection func: everything from its declaration to
    // `executeCode` is its region, and every world-touching piece must be
    // in it.
    const funcRegion = /const prepareScriptletInjection = \([\s\S]*?\nconst executeCode/.exec(shims);
    if ( funcRegion === null ) {
        problems.push('mv3-shims.js: cannot locate the prepareScriptletInjection func');
    } else {
        const region = funcRegion[0];
        const inFunc = [
            [ /new self\.BroadcastChannel\(name\)/, 'the scriptlet->logger relay' ],
            [ /self\.uBO_scriptletsInjected\s*=\s*filters/, 'the uBO_scriptletsInjected marker' ],
            [ /self\.uBO_isolatedScriptlets\s*=\s*'done'/, 'the uBO_isolatedScriptlets marker' ],
            [ /dataset\.uBOmv3Main\s*=\s*JSON\.stringify\(\{ globals, args, calls: mainCalls \}\)/, 'the DOM launch-record writer for the MAIN-world library' ],
            [ /self\.uBO_mv3IsolatedLaunch\s*=\s*\{ globals, args, calls \}/, 'the isolated-world call stash' ],
        ];
        for ( const [ re, what ] of inFunc ) {
            if ( re.test(region) ) { continue; }
            problems.push(`mv3-shims.js: ${what} is no longer inside the ISOLATED-world injection func`);
        }
    }
    // Line-anchored so the design comment's prose mentions do not count:
    // the one real occurrence is the library file call's `world:` property.
    if ( (shims.match(/^\s*world:\s*'MAIN',/gm) || []).length !== 1 ) {
        problems.push("mv3-shims.js must contain exactly one world:'MAIN' injection -- the MAIN-world library files call, which runs CSP-exempt in the page");
    }
    if ( /scriptletShards/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer imports the scriptlet shard manifest');
    }
    if ( /libraryFilesFor/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer computes a per-navigation shard file set (libraryFilesFor)');
    }
    if ( /createElement\('script'\)/.test(shims) ) {
        problems.push("mv3-shims.js creates a <script> element: element creation is CSP-governed in every MV3 world, and MV2's element exemption died with tabs.executeScript -- launch the libraries through DOM data instead");
    }
    if ( /isolatedWorld/.test(shims) ) {
        problems.push('mv3-shims.js references isolatedWorld: the isolated-world payload must be executed in the ISOLATED world through the library, never embedded in the MAIN-world launch record');
    }
    if ( /chrome\.userScripts\./.test(shims) ) {
        problems.push('mv3-shims.js still calls chrome.userScripts, but the permission is no longer declared');
    }
    if ( /chrome\.userScripts\./.test(post) ) {
        problems.push('mv3-post.js still calls chrome.userScripts, but the permission is no longer declared');
    }
    if ( existsPkg('js/mv3-scriptlet-shards.js') === false ) {
        problems.push('js/mv3-scriptlet-shards.js (the shard manifest) is missing from the package');
    }
    if ( problems.length !== 0 ) {
        fail('scriptlet-bridge', problems.join('\n'),
            'reconcile platform/chromium-mv3/mv3-shims.js, mv3-post.js and tools/patch-mv3-modules.mjs with the scriptlet injection design in docs/mv3-deployment.md');
    } else {
        pass('scriptlet bridge intact: relay, guards, launch records and the sharded libraries wired, one MAIN-world injection call, no element creation');
    }
}

// The sharded scriptlet libraries: manifest consistency, the cross-file
// protocol, the core/heavy shared split, and the byte budgets. The manifest
// is generated data, so it cannot be pinned to fixed content -- instead
// every invariant the injection protocol depends on is re-derived here,
// independently of the generator:
//
// - every function of each world's closure is mapped to exactly one file,
//   and that file actually declares it;
// - the shared and launch files exist for both worlds and carry their
//   halves of the protocol (launch-record parse/consume, registry
//   install/delete, interned-argument resolution);
// - no shard references a function that is defined neither in itself nor
//   in one of its world's shared files: scriptlet sources call
//   dependencies by bare name, nothing is a global, so such a reference
//   would throw ReferenceError at call time (references out of the shared
//   files themselves resolve through the registry destructure, which the
//   check accounts for);
// - the main-world shared split: the manifest's heavy.neededBy list is
//   re-derived from the resource table (each root's dependency tree) and
//   must match exactly -- too small and a navigation injects shards that
//   reference functions nobody registered; too large and the optimization
//   silently stops saving bytes;
// - every generated file is an IIFE, so no declaration leaks into the
//   injected world;
// - byte budgets: the audit target is that a typical 1-3-scriptlet
//   navigation injects well under 40 KB per world, so the core shared file
//   plus the largest shard plus the launcher must stay under it, with the
//   heavy shared file (paid only by the navigations that need it) and each
//   single file under their own ceilings.
{
    const problems = [];
    let shardsModule;
    let resources;
    try {
        shardsModule = await import(pathToFileURL(
            path.join(pkgDir, 'js/mv3-scriptlet-shards.js')
        ).href);
    } catch (ex) {
        problems.push(`cannot import js/mv3-scriptlet-shards.js: ${ex.message}`);
    }
    try {
        resources = await import(pathToFileURL(
            path.join(pkgDir, 'js/resources/scriptlets.js')
        ).href);
    } catch (ex) {
        problems.push(`cannot import js/resources/scriptlets.js: ${ex.message}`);
    }
    if ( shardsModule?.scriptletShards !== undefined && Array.isArray(resources?.builtinScriptlets) ) {
        const manifest = shardsModule.scriptletShards;
        const byName = new Map(resources.builtinScriptlets.map(e => [ e.name, e ]));
        const closureOf = world => {
            const closure = [], seen = new Set();
            const visit = name => {
                if ( seen.has(name) ) { return; }
                seen.add(name);
                const entry = byName.get(name);
                if ( entry === undefined || typeof entry.fn !== 'function' ) { return; }
                closure.push(entry);
                for ( const dep of entry.dependencies || [] ) { visit(dep); }
            };
            for ( const entry of resources.builtinScriptlets ) {
                if ( typeof entry.fn !== 'function' ) { continue; }
                if ( world === 'ISOLATED' ? entry.world !== 'ISOLATED' : entry.world === 'ISOLATED' ) {
                    continue;
                }
                visit(entry.name);
            }
            return closure;
        };
        const SHARD_LIB_BUDGET = 40 * 1024;   // core shared + largest shard + launch
        const SHARD_FILE_BUDGET = 48 * 1024;  // any single shard or launch file
        const SHARED_FILE_BUDGET = 16 * 1024; // the always-injected (core) shared file
        const HEAVY_FILE_BUDGET = 64 * 1024;  // the needed-when-called shared file
        const WORLD_FILE_BUDGET = 384 * 1024; // all of a world's files (worst case)
        for ( const [ world, section, key ] of [
            [ 'ISOLATED', manifest.isolated, 'isolated' ],
            [ 'MAIN', manifest.main, 'main' ],
        ] ) {
            const label = world === 'ISOLATED' ? 'isolated-world' : 'main-world';
            if ( section instanceof Object === false ) {
                problems.push(`the shard manifest has no "${key}" section`);
                continue;
            }
            const closure = closureOf(world);
            const fnNames = new Set(closure.map(e => e.fn.name));
            const manifestNames = new Set(Object.keys(section.fns || {}));
            for ( const name of fnNames ) {
                if ( manifestNames.has(name) ) { continue; }
                problems.push(`${label}: function ${name} is in the world's closure but not in the shard manifest`);
            }
            for ( const name of manifestNames ) {
                if ( fnNames.has(name) ) { continue; }
                problems.push(`${label}: function ${name} is in the shard manifest but not in the world's closure`);
            }
            // Gather the world's files once; verify each declared function
            // is declared by the file the manifest points at.
            const contents = new Map(); // file -> source
            const readFile = file => {
                if ( contents.has(file) === false ) {
                    contents.set(file, existsPkg(file) ? readPkg(file) : '');
                }
                return contents.get(file);
            };
            const heavyFile = section.heavy instanceof Object &&
                typeof section.heavy.file === 'string'
                ? section.heavy.file
                : undefined;
            if ( section.heavy instanceof Object && heavyFile === undefined ) {
                problems.push(`${label}: the manifest has a heavy section with no file`);
            }
            for ( const file of [
                section.shared, section.launch,
                ...(heavyFile !== undefined ? [ heavyFile ] : []),
                ...Object.values(section.fns || {}),
            ] ) {
                if ( typeof file !== 'string' || file === '' ) {
                    problems.push(`${label}: the manifest names a non-file: ${file}`);
                    continue;
                }
                if ( existsPkg(file) === false ) {
                    problems.push(`${label}: the manifest names a missing file: ${file}`);
                    continue;
                }
                readFile(file);
                if ( /^\(function\(\) \{/m.test(contents.get(file)) === false ) {
                    problems.push(`${label}: ${file} is not wrapped in an IIFE -- its declarations would leak into the injected world`);
                }
            }
            // What each file actually declares, plus the names it
            // destructures out of the registry (those resolve through the
            // file's own closure, so a bare-name reference to them is
            // sound). Cross-shard functions below the sharing threshold
            // are deliberately duplicated, so a name can be declared by
            // several shard files; the manifest maps each name to one of
            // them, and any one suffices for dispatch.
            const reDeclOf = name => new RegExp(
                `^(?:async\\s+function|function)\\s+${name}\\s*\\(` +
                `|^class\\s+${name}(?:\\s|\\{|extends)` +
                `|^(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?` +
                `(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`, 'm'
            );
            const declaredOf = new Map(); // file -> Set<fnName>
            for ( const [ file, source ] of contents ) {
                const declared = new Set();
                for ( const name of fnNames ) {
                    if ( reDeclOf(name).test(source) ) { declared.add(name); }
                }
                for ( const match of source.matchAll(/const \{ ([\w$, ]+) \} = self\.uBO_mv3Lib/g) ) {
                    for ( const name of match[1].split(',') ) {
                        declared.add(name.trim());
                    }
                }
                declaredOf.set(file, declared);
            }
            for ( const [ fnName, file ] of Object.entries(section.fns || {}) ) {
                if ( (declaredOf.get(file) || new Set()).has(fnName) ) { continue; }
                problems.push(`${label}: the manifest maps ${fnName} to ${file}, which does not declare it`);
            }
            // The cross-file protocol: a bare-name reference out of a
            // shard must resolve in the same file or in a shared file
            // (core or heavy); a bare-name reference out of the heavy file
            // must resolve in itself or the core file. The launcher
            // dispatches through the registry and references nothing by
            // bare name.
            const sharedDeclared = new Set([
                ...(declaredOf.get(section.shared) || new Set()),
                ...(heavyFile !== undefined ? (declaredOf.get(heavyFile) || new Set()) : new Set()),
            ]);
            for ( const [ file, source ] of contents ) {
                if ( file === section.launch || file === section.shared ) { continue; }
                const declared = declaredOf.get(file) || new Set();
                const pool = file === heavyFile
                    ? new Set([ ...declared, ...(declaredOf.get(section.shared) || new Set()) ])
                    : new Set([ ...declared, ...sharedDeclared ]);
                for ( const name of fnNames ) {
                    if ( pool.has(name) ) { continue; }
                    if ( new RegExp(`\\b${name}\\b`).test(source) === false ) { continue; }
                    problems.push(`${label}: ${file} references ${name}, which resolves in neither it nor the shared files -- the call would throw ReferenceError`);
                }
            }
            // The protocol halves.
            const launchSrc = contents.get(section.launch) || '';
            const sharedSrc = contents.get(section.shared) || '';
            if ( /argIndices\.map\(i => args\[i\]\)/.test(launchSrc) === false ) {
                problems.push(`${label}: the launcher no longer resolves the interned-argument indices (must stay in lockstep with internScriptletArgs in mv3-post.js)`);
            }
            if ( launchSrc.includes('delete self.uBO_mv3Lib;') === false ) {
                problems.push(`${label}: the launcher no longer deletes the transient registry`);
            }
            if ( sharedSrc.includes('self.uBO_mv3Lib.launch = ') === false ) {
                problems.push(`${label}: the shared file no longer parses the launch record onto the registry`);
            }
            if ( sharedSrc.includes('const scriptletGlobals = ') === false ) {
                problems.push(`${label}: the shared file no longer declares the per-document scriptletGlobals closure variable`);
            }
            if ( world === 'MAIN' ) {
                if ( launchSrc.includes('delete document.documentElement.dataset.uBOmv3Main') === false ) {
                    problems.push('main-world: the launcher no longer deletes the DOM launch record after consuming it');
                }
                if ( sharedSrc.includes('document.documentElement.dataset.uBOmv3Main') === false ) {
                    problems.push('main-world: the shared file no longer reads the DOM launch record');
                }
            } else {
                if ( launchSrc.includes('self.uBO_mv3IsolatedLaunch = undefined;') === false ) {
                    problems.push('isolated-world: the launcher no longer consumes the uBO_mv3IsolatedLaunch stash');
                }
                if ( sharedSrc.includes('self.uBO_mv3IsolatedLaunch') === false ) {
                    problems.push('isolated-world: the shared file no longer reads the uBO_mv3IsolatedLaunch stash');
                }
            }
            // The core/heavy split, re-derived from the resource table: the
            // roots of this world (its callable scriptlets), each root's
            // dependency tree (declared dependencies plus bare-name
            // references, transitively -- the same over-approximation the
            // generator uses), and the heavy membership from the manifest.
            // heavy.neededBy must be exactly the roots whose trees touch
            // the heavy half.
            if ( heavyFile !== undefined ) {
                const rootEntries = closure
                    .filter(e => world === 'ISOLATED' ? e.world === 'ISOLATED' : e.world !== 'ISOLATED');
                const entryOfFn = new Map(closure.map(e => [ e.fn.name, e ]));
                const srcOfFn = new Map(closure.map(e => [ e.fn.name, e.fn.toString() ]));
                const reAnyFn = new RegExp(`\\b(${[ ...fnNames ].join('|')})\\b`, 'g');
                const refsOf = new Map(); // fnName -> Set<fnName>
                for ( const fnName of fnNames ) {
                    const out = new Set();
                    let match;
                    reAnyFn.lastIndex = 0;
                    while ( (match = reAnyFn.exec(srcOfFn.get(fnName))) !== null ) {
                        if ( match[1] !== fnName ) { out.add(match[1]); }
                    }
                    refsOf.set(fnName, out);
                }
                const treeOfFn = fnName => {
                    const tree = new Set();
                    const stack = [ fnName ];
                    while ( stack.length !== 0 ) {
                        const name = stack.pop();
                        if ( tree.has(name) ) { continue; }
                        tree.add(name);
                        const entry = entryOfFn.get(name);
                        if ( entry === undefined ) { continue; }
                        for ( const dep of entry.dependencies || [] ) {
                            const depEntry = byName.get(dep);
                            if ( depEntry !== undefined ) { stack.push(depEntry.fn.name); }
                        }
                        for ( const ref of refsOf.get(name) || [] ) { stack.push(ref); }
                    }
                    return tree;
                };
                const heavyFns = new Set(
                    Object.entries(section.fns || {})
                        .filter(([ , file ]) => file === heavyFile)
                        .map(([ fnName ]) => fnName)
                );
                if ( heavyFns.size === 0 ) {
                    problems.push(`${label}: the manifest names a heavy file but maps no function to it`);
                }
                const expected = rootEntries
                    .map(e => e.fn.name)
                    .filter(fnName => {
                        const tree = treeOfFn(fnName);
                        return [ ...heavyFns ].some(h => tree.has(h));
                    })
                    .sort();
                const actual = Array.isArray(section.heavy.neededBy)
                    ? [ ...section.heavy.neededBy ].sort()
                    : [];
                if ( JSON.stringify(expected) !== JSON.stringify(actual) ) {
                    problems.push(`${label}: heavy.neededBy does not match the dependency trees re-derived from the resource table (${actual.length} listed, ${expected.length} expected) -- too small and shards reference unregistered functions, too large and the split saves nothing`);
                }
                // The core half must be closed: it may not reference
                // anything from the heavy half (it is injected without it).
                for ( const fnName of heavyFns ) {
                    if ( new RegExp(`\\b${fnName}\\b`).test(sharedSrc) === false ) { continue; }
                    problems.push(`${label}: the core shared file references ${fnName}, which lives in the heavy half it is injected without`);
                }
                const heavySrc = contents.get(heavyFile) || '';
                if ( /Object\.assign\(self\.uBO_mv3Lib/.test(heavySrc) === false ) {
                    problems.push(`${label}: the heavy shared file does not register its functions on the transient registry`);
                }
                if ( heavySrc.includes('const scriptletGlobals = ') === false ) {
                    problems.push(`${label}: the heavy shared file no longer declares the per-document scriptletGlobals closure variable`);
                }
            }
            // Byte budgets.
            const sizeOf = file => typeof file === 'string' && existsPkg(file)
                ? fs.statSync(path.join(pkgDir, file)).size
                : 0;
            const shardFiles = [ ...contents.keys() ]
                .filter(file => file !== section.shared && file !== section.launch && file !== heavyFile);
            const sharedBytes = sizeOf(section.shared);
            const heavyBytes = heavyFile !== undefined ? sizeOf(heavyFile) : 0;
            const launchBytes = sizeOf(section.launch);
            const largestShard = shardFiles.reduce(
                (max, file) => Math.max(max, sizeOf(file)), 0
            );
            const worldBytes = [ ...contents.keys() ].reduce(
                (sum, file) => sum + sizeOf(file), 0
            );
            if ( sharedBytes + largestShard + launchBytes > SHARD_LIB_BUDGET ) {
                problems.push(`${label}: core shared (${sharedBytes}) + largest shard (${largestShard}) + launch (${launchBytes}) exceeds the ${SHARD_LIB_BUDGET}-byte typical-navigation budget -- retune SCRIPTLET_SHARDING in tools/patch-mv3-modules.mjs`);
            }
            if ( sharedBytes > SHARED_FILE_BUDGET ) {
                problems.push(`${label}: the (core) shared file is ${sharedBytes} bytes (max ${SHARED_FILE_BUDGET})`);
            }
            if ( heavyBytes > HEAVY_FILE_BUDGET ) {
                problems.push(`${label}: the heavy shared file is ${heavyBytes} bytes (max ${HEAVY_FILE_BUDGET})`);
            }
            for ( const file of [ ...contents.keys() ] ) {
                if ( file === section.shared || file === heavyFile ) { continue; }
                if ( sizeOf(file) <= SHARD_FILE_BUDGET ) { continue; }
                problems.push(`${label}: ${file} is ${sizeOf(file)} bytes (max ${SHARD_FILE_BUDGET})`);
            }
            if ( worldBytes > WORLD_FILE_BUDGET ) {
                problems.push(`${label}: all library files total ${worldBytes} bytes (max ${WORLD_FILE_BUDGET} for the worst-case navigation)`);
            }
            // Shard naming: the shims sort the files array by name, so the
            // two-digit suffix must stay zero-padded and unique.
            for ( const file of shardFiles ) {
                if ( /^js\/mv3-(scriptlet|mainworld)-library-\d{2}\.js$/.test(file) === false ) {
                    problems.push(`${label}: unexpected shard file name: ${file}`);
                }
            }
        }
    } else {
        // The imports above succeeded but an expected export is absent or
        // not the expected type: that is exactly the drift this check exists
        // to catch, so report it rather than falling through to a pass. (A
        // failed import was already recorded above; guard against
        // double-reporting it here.)
        if ( shardsModule !== undefined && shardsModule.scriptletShards === undefined ) {
            problems.push('js/mv3-scriptlet-shards.js no longer exports scriptletShards');
        }
        if ( resources !== undefined && Array.isArray(resources.builtinScriptlets) === false ) {
            problems.push('js/resources/scriptlets.js no longer exports builtinScriptlets as an array');
        }
    }
    if ( problems.length !== 0 ) {
        fail('scriptlet-shards', problems.join('\n'),
            'see the sharded-library generator in tools/patch-mv3-modules.mjs and libraryFilesFor() in platform/chromium-mv3/mv3-shims.js');
    } else {
        pass('scriptlet shards: manifest consistent, cross-file references resolve, protocol halves intact, byte budgets met');
    }
}

// The scriptlet injection (mv3-post.js marker -> mv3-shims.js -> the two
// injection funcs -> ISOLATED + MAIN worlds) rests on a handful of upstream
// shapes. Each is cheap to assert and expensive to debug: break one and the
// popup panel quietly stops listing scriptlet filters, log lines stop
// reaching the logger, or every `+js()` filter silently does nothing.
{
    const checks = [
        [ 'platform/common/vapi-background.js', /vAPI\.scriptletsInjector\s*=/,
          'vAPI.scriptletsInjector is no longer the platform hook mv3-post.js wraps' ],
        [ 'platform/chromium/vapi-background-ext.js', /self\.uBO_scriptletsInjected\s*=\s*details\.filters/,
          'the Chromium injector no longer records details.filters in self.uBO_scriptletsInjected' ],
        [ 'src/js/scriptlet-filtering.js', /vAPI\.scriptletsInjector\(\s*hostname\s*,\s*scriptletDetails\s*\)/,
          'scriptlet-filtering.js no longer calls vAPI.scriptletsInjector(hostname, scriptletDetails)' ],
        [ 'src/js/scriptlet-filtering.js', /if\s*\(\s*scriptletDetails\.mainWorld\s*\)\s*\{\s*contentScript\.push\(\s*vAPI\.scriptletsInjector/s,
          'scriptletsInjector is no longer gated on scriptletDetails.mainWorld -- mv3-post.js forces this call with a sentinel for isolated-only documents' ],
        [ 'src/js/scriptlet-filtering.js', /super\.retrieve\(\s*request,\s*options\s*\)/,
          'the extended engine no longer calls super.retrieve(), so mv3-post.js can no longer intercept the core result to force the injector call' ],
        [ 'src/js/scriptlet-filtering.js', /options\.scriptletGlobals\.bcSecret\s*=\s*bcSecret/,
          'the logger secret is no longer baked into scriptletGlobals, so mv3-post.js can no longer read it back out of the payloads for the relay' ],
        [ 'src/js/scriptlet-filtering.js', /self\.vAPI\s*&&\s*self\.vAPI\.messaging/,
          'the scriptlet->logger relay no longer probes self.vAPI.messaging, which the ISOLATED-world relay in mv3-shims.js mirrors' ],
        [ 'src/js/scriptlet-filtering.js', /vAPI\.messaging\.send\(\s*'contentscript'/,
          'the relay no longer sends on the "contentscript" channel, which the ISOLATED-world relay in mv3-shims.js forwards to' ],
        [ 'src/js/scriptlet-filtering.js', /bcSecret\.postMessage\('iamready!'\)/,
          'the relay handshake changed; the order-proof buffering the ISOLATED-world relay relies on may no longer hold' ],
        [ 'src/js/scriptlet-filtering-core.js', /export class ScriptletFilteringEngine/,
          'mv3-post.js imports ScriptletFilteringEngine from scriptlet-filtering-core.js to intercept the core retrieve()' ],
        [ 'src/js/scriptlet-filtering-core.js', /'\}\)\(\);',/,
          'the main-world payload is no longer a self-executing IIFE, so mv3-shims.js can no longer insert it as-is' ],
        [ 'src/js/scriptlet-filtering-core.js', /'function\(\) \{',/,
          'the isolated-world payload is no longer a bare function expression, which mv3-post.js parses the scriptlet calls out of' ],
        [ 'src/js/scriptlet-filtering-core.js', /'try \{',/,
          'scriptlet calls are no longer wrapped in try-blocks, so mv3-post.js can no longer parse them out of the isolated-world payload' ],
        [ 'src/js/scriptlet-filtering-core.js', /\\t\$\{content\}/,
          'scriptlet calls are no longer single tab-indented lines, so mv3-post.js can no longer parse them out of the isolated-world payload' ],
        [ 'src/js/scriptlet-filtering-core.js', /const scriptletGlobals = \$\{scriptletGlobalsJSON\};/,
          'scriptletGlobals is no longer embedded verbatim in the payloads, so mv3-post.js can no longer capture it for the isolated-world scriptlets' ],
        [ 'src/js/contentscript.js', /needScriptlets:\s*self\.uBO_scriptletsInjected\s*===\s*undefined/,
          'contentscript.js no longer derives needScriptlets from self.uBO_scriptletsInjected' ],
        [ 'src/js/scriptlets/cosmetic-report.js', /self\.uBO_scriptletsInjected/,
          'cosmetic-report.js no longer reads self.uBO_scriptletsInjected' ],
        [ 'src/js/messaging.js', /name:\s*'contentscript',\s*listener:/,
          'the "contentscript" message channel is gone or renamed' ],
    ];
    let broken = 0;
    for ( const [ rel, re, message ] of checks ) {
        if ( re.test(readRepo(rel)) ) { continue; }
        broken += 1;
        fail('scriptlet-marker', `${rel}: ${message}`,
            'reconcile platform/chromium-mv3/mv3-post.js and mv3-shims.js with the new upstream shape');
    }
    if ( broken === 0 ) {
        pass(`${checks.length} scriptlet-injection upstream assumptions hold`);
    }
}

// mv3-shims.js patches `vAPI.Net` on assignment so that `canSuspend()` is true
// and suspended requests are parked as promises rather than cancelled. Four
// upstream shapes have to hold for that to land where it is aimed.
{
    const background = readRepo('src/js/background.js');
    const vapi = readRepo('platform/common/vapi-background.js');
    const ext = readRepo('platform/chromium/vapi-background-ext.js');
    const start = readRepo('src/js/start.js');

    // The setter has to see both assignments: the base class and the Chromium
    // subclass which is the one actually instantiated.
    const assigns = /^\s*vAPI\.Net\s*=\s*class/m;

    // `traffic.js` reads canSuspend() to decide whether to suspend at module
    // scope, and `background.js` derives the user setting default from it. Both
    // happen after vapi-background-ext.js evaluates only because start.js
    // imports it first.
    const extImport = start.indexOf(`'./vapi-background-ext.js'`);
    const trafficImport = start.indexOf(`'./traffic.js'`);

    if ( /suspendUntilListsAreLoaded:\s*vAPI\.Net\.canSuspend\(\)/.test(background) === false ) {
        fail('suspend-default',
            'src/js/background.js no longer defaults suspendUntilListsAreLoaded from vAPI.Net.canSuspend()',
            'the MV3 cold-start window is closed by making canSuspend() true; check platform/chromium-mv3/mv3-shims.js');
    } else if ( assigns.test(vapi) === false || assigns.test(ext) === false ) {
        fail('suspend-default',
            'vAPI.Net is no longer assigned as `vAPI.Net = class` in vapi-background.js and/or chromium/vapi-background-ext.js',
            'the setter in platform/chromium-mv3/mv3-shims.js patches on assignment and would never fire');
    } else if ( extImport === -1 || trafficImport === -1 || extImport > trafficImport ) {
        fail('suspend-default',
            'src/js/start.js no longer imports ./vapi-background-ext.js before ./traffic.js',
            'canSuspend() would be read before mv3-shims.js has patched it, reopening the cold-start window');
    } else if ( /suspendOneRequest\(details\)/.test(ext) === false ||
                /unsuspendAllRequests\(discard/.test(ext) === false ) {
        fail('suspend-default',
            'platform/chromium/vapi-background-ext.js no longer defines suspendOneRequest()/unsuspendAllRequests()',
            'mv3-shims.js captures both as the fallback used when the extension is not policy-installed');
    } else {
        pass('vAPI.Net async-suspension patch still lands where it is aimed');
    }
}

// The worker relay's watchdog and failure synthesis, and the session-state
// restore, rest on upstream shapes in the two worker protocols and the
// page store. Each is cheap to assert and expensive to debug: break one and
// a stalled diff updater waits forever again, or a restored page store
// throws on dispose.
{
    const checks = [
        [ 'src/js/diff-updater.js', /what: 'broken'/,
          'the diff updater no longer reports fatal errors as { what: "broken" }, which the watchdog synthesis in mv3-shims.js feeds to assets.js to unwind a stalled cycle' ],
        [ 'src/js/diff-updater.js', /self\.postMessage\(\{ what: 'ready' \}\)/,
          'the diff updater no longer announces itself with { what: "ready" }, which the watchdog treats as a non-reply' ],
        [ 'src/js/assets.js', /assetDetails\.what = 'update'/,
          'assets.js no longer marks diff-update requests with what: "update", which the watchdog uses to open per-assetKey round trips' ],
        [ 'src/js/assets.js', /data\.what === 'broken'/,
          'assets.js no longer unwinds the diff-updater cycle on { what: "broken" }, the message the watchdog synthesizes on final failure' ],
        [ 'src/js/reverselookup-worker.js', /\{ id: details\.id, response \}/,
          'the reverse lookup worker no longer replies with { id, response }, the shape the watchdog synthesizes to resolve pending lookups' ],
        [ 'src/js/reverselookup.js', /pendingResponses\.get\(msg\.id\)/,
          'reverselookup.js no longer correlates worker replies by numeric id, which the watchdog uses to track open round trips' ],
        [ 'src/js/reverselookup.js', /workerTTLTimer/,
          'the reverse lookup worker no longer has an in-service-worker TTL, which bounds how long a lookup can hang if the relay is down entirely' ],
        [ 'src/js/traffic.js', /strictBlockBypasser\.bypass\(hostname\)/,
          'the strictBlockBypass tail of the webRequest object changed; tools/patch-mv3-modules.mjs and mv3-post.js must be reconciled' ],
        [ 'src/js/pagestore.js', /item\.dispose\(\)/,
          'hostnameDetailsMap.dispose() no longer calls dispose() on each entry, so restored entries (which carry a no-op dispose) may now be missing something it does' ],
        [ 'src/js/contextmenu.js', /vAPI\.contextMenu\.setEntries\(/,
          'contextmenu.js no longer registers its click handler through vAPI.contextMenu.setEntries, where mv3-post.js replays buffered cold-wake clicks' ],
    ];
    let broken = 0;
    for ( const [ rel, re, message ] of checks ) {
        if ( re.test(readRepo(rel)) ) { continue; }
        broken += 1;
        fail('worker-relay-upstream', `${rel}: ${message}`,
            'reconcile platform/chromium-mv3/mv3-shims.js, mv3-post.js and tools/patch-mv3-modules.mjs with the new upstream shape');
    }
    // start.js must call contextMenu.update() and register
    // runtime.onUpdateAvailable after initializeTabs() but before
    // isReadyResolve(): the replay of buffered cold-wake events and the
    // session-state restore both hang off that exact window.
    {
        const start = readRepo('src/js/start.js');
        const p1 = start.indexOf('await initializeTabs()');
        const p2 = start.indexOf('contextMenu.update()');
        const p3 = start.indexOf('onUpdateAvailable.addListener');
        const p4 = start.indexOf('isReadyResolve()');
        if ( p1 === -1 || p2 === -1 || p3 === -1 || p4 === -1 ||
             p1 > p2 || p2 > p3 || p3 > p4 ) {
            broken += 1;
            fail('worker-relay-upstream',
                'src/js/start.js no longer runs initializeTabs() -> contextMenu.update() -> onUpdateAvailable -> isReadyResolve() in that order',
                'the cold-wake replay and the session-state restore in platform/chromium-mv3/mv3-post.js are wired to this exact sequence');
        }
    }
    if ( broken === 0 ) {
        pass(`${checks.length} worker-relay/session-state upstream assumptions hold`);
    }
}

/******************************************************************************/

section('port self-checks');

// WebAssembly opt-in. The MV3 manifest's extension_pages CSP is this fork's
// to set, and it opts into 'wasm-unsafe-eval' -- the divergence from the MV2
// Chromium build is deliberate: uBO's WASM fast paths (LZ4-block decompression
// of the filtering-engine selfie, hntrie/biditrie matching, the public suffix
// list) are 5-20x faster than their JS implementations, which matters every
// time a service worker cold-boots. uBO gates all of it on `vAPI.canWASM`,
// which the shims' normalized `getManifest()` flips by reading this CSP. The
// pieces this depends on are all asserted here: the CSP token itself, the
// WASM codec import + its build-time service-worker rewrite, and the packaged
// .wasm modules. (A selfie written by a JS-mode engine loads fine under WASM
// mode and vice versa -- the trie selfie format is engine-agnostic and the
// LZ4 block format is codec-agnostic; see docs/mv3-deployment.md.)
{
    const problems = [];
    const csp = manifest.content_security_policy?.extension_pages || '';
    if ( csp.includes("'wasm-unsafe-eval'") === false ) {
        problems.push("the extension_pages CSP does not include 'wasm-unsafe-eval', so vAPI.canWASM is false and every WASM fast path stays disabled");
    }
    const shims = readPkg('js/mv3-shims.js');
    if ( shims.includes('lz4-block-codec-wasm.js') === false ) {
        problems.push('js/mv3-shims.js no longer imports the WASM LZ4 codec, so selfie decompression cannot use it');
    }
    if ( shims.includes('LZ4BlockWASM') === false ) {
        problems.push('js/mv3-shims.js no longer instantiates the WASM LZ4 flavor');
    }
    const pkgWasm = readPkg('lib/lz4/lz4-block-codec-wasm.js');
    if ( pkgWasm.includes("const wd = 'lib/lz4/';") === false ) {
        problems.push('the packaged lib/lz4/lz4-block-codec-wasm.js does not carry the service-worker wasm-path rewrite (tools/patch-mv3-modules.mjs)');
    }
    const repoWasm = readRepo('src/lib/lz4/lz4-block-codec-wasm.js');
    if ( repoWasm.includes('document.currentScript.src') === false ) {
        problems.push('src/lib/lz4/lz4-block-codec-wasm.js no longer locates its module through document.currentScript -- the patcher anchor and this check must be reconciled');
    }
    if ( problems.length !== 0 ) {
        fail('wasm-opt-in', problems.join('\n'),
            'see platform/chromium-mv3/manifest.overlay.json, the lz4 shim in platform/chromium-mv3/mv3-shims.js, and the lz4 transform in tools/patch-mv3-modules.mjs');
    } else {
        pass("WASM opt-in intact: CSP carries 'wasm-unsafe-eval', codecs and modules packaged, wasm-path rewrite in place");
    }
}

// Parse every module the port owns.
//
// A service worker whose entry module fails to parse is not a degraded
// extension, it is an absent one -- and nothing else in this build pipeline
// parses these files. `npm run lint` would, but it is not a gate here and does
// not run as part of the build. The bug that motivated this: a `*` followed by a
// `/` inside a prose comment, which closed the comment block early and turned the
// rest of the file into garbage. Invisible on inspection, fatal at load.
//
// Each file is copied to a temp file whose extension declares its module kind,
// rather than piped to `node --check --input-type=...`. `.js` in the package
// would otherwise be parsed as CommonJS and rejected for using `import`, and
// the extension is understood identically by every Node version we might run on.
{
    const PORT_MODULES = [
        [ 'js/sw.js', 'mjs' ],
        [ 'js/mv3-shims.js', 'mjs' ],
        [ 'js/mv3-post.js', 'mjs' ],
        [ 'js/mv3-scriptlet-marker.js', 'mjs' ],
        // Generated: the shard manifest (an ES module) and the fixed
        // library files. The shard files are discovered through the
        // directory scan below, so a shard that fails to parse fails here
        // rather than at injection time.
        [ 'js/mv3-scriptlet-shards.js', 'mjs' ],
        [ 'js/mv3-scriptlet-shared.js', 'cjs' ],
        [ 'js/mv3-scriptlet-launch.js', 'cjs' ],
        [ 'js/mv3-mainworld-shared-core.js', 'cjs' ],
        [ 'js/mv3-mainworld-shared-heavy.js', 'cjs' ],
        [ 'js/mv3-mainworld-launch.js', 'cjs' ],
        // Loaded as a classic script by offscreen.html.
        [ 'js/offscreen.js', 'cjs' ],
    ];
    const broken = [];
    {
        // Every shard file in the package: the manifest is authoritative
        // for what ships (checked in the scriptlet-shards section), this
        // scan is authoritative for what parses.
        const shardFiles = fs.readdirSync(path.join(pkgDir, 'js'))
            .filter(name => /^mv3-(scriptlet|mainworld)-library-\d{2}\.js$/.test(name))
            .sort();
        if ( shardFiles.length === 0 ) {
            broken.push('js/: no mv3-*-library-NN.js shard files found');
        }
        for ( const name of shardFiles ) {
            PORT_MODULES.push([ `js/${name}`, 'cjs' ]);
        }
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubo-mv3-parse-'));
    try {
        for ( const [ rel, ext ] of PORT_MODULES ) {
            if ( existsPkg(rel) === false ) {
                broken.push(`${rel}: missing from package`);
                continue;
            }
            const tmpFile = path.join(
                tmpDir,
                `${path.basename(rel, '.js')}.${ext}`
            );
            fs.writeFileSync(tmpFile, readPkg(rel));
            const r = spawnSync(
                process.execPath,
                [ '--check', tmpFile ],
                { encoding: 'utf8' }
            );
            if ( r.status === 0 ) { continue; }
            const detail = (r.stderr || `exit ${r.status}`).split('\n')
                .filter(line => line.trim() !== '')
                .slice(0, 4)
                .join('\n');
            broken.push(`${rel}:\n${detail}`);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if ( broken.length !== 0 ) {
        fail('port-modules-parse', broken.join('\n'),
            'a parse error here means the service worker never starts');
    } else {
        pass(`${PORT_MODULES.length} port-owned modules parse`);
    }
}

// Round-trip the scriptlet marker codec out of the built package. It is a pure
// module for this reason: the encode and decode ends live in different execution
// contexts at runtime and cannot test each other there.
{
    const rel = 'js/mv3-scriptlet-marker.js';
    let codec;
    if ( existsPkg(rel) === false ) {
        fail('marker-codec', `${rel} missing from package`,
            'tools/make-chromium-mv3.sh copies platform/chromium-mv3/*.js into js/');
    } else {
        // Guarded: the parse check above already reports a broken module, and an
        // uncaught rejection here would abort the run and lose every check after
        // it, including the summary.
        try {
            codec = await import(pathToFileURL(path.join(pkgDir, rel)).href);
        } catch ( ex ) {
            fail('marker-codec', `cannot import ${rel}: ${ex.message}`,
                'see the port-modules-parse check above');
        }
    }
    if ( codec !== undefined ) {
        const { encodeScriptletMarker, decodeScriptletMarker } = codec;
        // Hostile-but-real filter text: `*/` would close a block comment, a bare
        // newline would truncate a line comment, and non-Latin-1 is everywhere in
        // filter lists (btoa() throws on it). The payloads now ride in the
        // marker too, so they get the same hostile treatment.
        // The interned-argument encoding (see internScriptletArgs in
        // mv3-post.js): both call sets index into one shared args table.
        // Hostile-but-real filter text rides in the table: `*/` would close
        // a block comment, a bare newline would truncate a line comment, and
        // non-Latin-1 is everywhere in filter lists (btoa() throws on it).
        const args = [
            'uboParityTest',                                  // 0 (shared by both call sets)
            '42',                                             // 1
            'ob',                                             // 2
            'ads',                                            // 3
            'a$b',                                            // 4 ('$$$' pre-escaping nets to one '$')
            '例え.рф',                                         // 5
            'x.com##+js(set, y, */)',                         // 6
            'a.com##+js(x, "line1\nline2")',                  // 7
        ];
        const details = {
            hostname: 'пример.рф',
            filters: [
                'example.com##+js(trusted-replace-regex, /a*/g, b)',
                'x.com##+js(set, y, */)',
                '例え.jp##+js(aopr, 日本語 100%)',
                'a.com##+js(x, "line1\nline2")',
            ],
            args,
            mainCalls: [
                [ 'setConstant', [ 0, 1 ] ],
                [ 'abortOnPropertyRead', [ 2 ] ],
            ],
            isolatedCalls: [
                [ 'removeClass', [ 3, 1 ] ],
                [ 'replaceNodeText', [ 4, 5, 6, 7 ] ],
            ],
            scriptletGlobals: {
                warOrigin: 'chrome-extension://xyz/web_accessible_resources',
                bcSecret: 'S3cr3t/* with a slash',
                logLevel: 2,
            },
            bcSecret: 'S3cr3t/* with a slash',
        };
        const marker = encodeScriptletMarker(details);
        const problems = [];
        if ( marker.includes('\n') === false || marker.endsWith('\n') === false ) {
            problems.push('the marker is not a single newline-terminated line');
        }
        if ( marker.slice(0, -1).includes('\n') ) {
            problems.push('the marker payload contains a newline, which truncates the line comment');
        }
        if ( marker.slice(2).includes('/') ) {
            problems.push('the marker payload contains "/", which can close a block comment early');
        }
        // Exactly how src/js/scriptlet-filtering.js assembles injectNow()'s code:
        // the relay and an optional `debugger` are prepended, so the marker is
        // not first, and the inert wrapper output follows it.
        const assembled = [
            'debugger',
            `RELAY(${JSON.stringify('abc')});`,
            `${marker}WRAPPER(${JSON.stringify(details.filters)});\n\nISOLATED();`,
        ].join('\n\n');
        const decoded = decodeScriptletMarker(assembled);
        if ( JSON.stringify(decoded.details) !== JSON.stringify(details) ) {
            problems.push(`round trip lost data: ${JSON.stringify(decoded.details)}`);
        }
        if ( decoded.code.includes('uBO-mv3-filters') ) {
            problems.push('the marker survived decoding and would be injected');
        }
        for ( const token of [ 'RELAY', 'WRAPPER', 'ISOLATED', 'debugger' ] ) {
            if ( decoded.code.includes(token) ) { continue; }
            problems.push(`decoding removed real code: ${token} is gone`);
        }
        // An absent marker means the code did not come from the scriptlet
        // injector at all; it must be a clean pass-through, not a throw.
        const untouched = decodeScriptletMarker('ISOLATED();');
        if ( untouched.details !== undefined || untouched.code !== 'ISOLATED();' ) {
            problems.push('a marker-less program is not passed through unchanged');
        }
        if ( problems.length !== 0 ) {
            fail('marker-codec', problems.join('\n'),
                'see platform/chromium-mv3/mv3-scriptlet-marker.js');
        } else {
            pass('scriptlet marker codec round-trips hostile payloads and filter text');
        }
    }
}

// The scriptlet->logger bridge is MV2's again, rebuilt from func+args: the
// payload (in the page's MAIN world) posts to the `uBO_bcSecret`
// BroadcastChannel, and a relay injected into the ISOLATED world -- beside
// contentscript.js, where `vAPI.messaging` lives -- forwards to the
// "contentscript" channel. The USER_SCRIPT-world machinery this replaces
// (configureWorld messaging, the vAPI.messaging preamble, the
// onUserScriptMessage forwarder) must not come back: none of it is reachable
// without the "Allow user scripts" toggle, and the permission is no longer
// declared.
{
    const shims = readPkg('js/mv3-shims.js');
    const post = readPkg('js/mv3-post.js');
    const dead = [
        [ shims, 'configureWorld', 'js/mv3-shims.js still configures a userScripts world' ],
        [ post, 'onUserScriptMessage', 'js/mv3-post.js still listens on runtime.onUserScriptMessage' ],
    ];
    const problems = [];
    for ( const [ src, needle, message ] of dead ) {
        if ( src.includes(needle) === false ) { continue; }
        problems.push(message);
    }
    if ( /prepareScriptletInjection/.test(shims) === false ) {
        problems.push('js/mv3-shims.js no longer injects the ISOLATED-world relay + guard func');
    } else if ( /BroadcastChannel\(name\)/.test(shims) === false ) {
        problems.push('the relay in js/mv3-shims.js no longer opens the bcSecret BroadcastChannel');
    }
    if ( problems.length !== 0 ) {
        fail('scriptlet-logger-bridge', problems.join('\n'),
            'scriptlet log lines would stop reaching the logger; see the scriptlet-injection section of platform/chromium-mv3/mv3-shims.js');
    } else {
        pass('scriptlet->logger bridge runs in ISOLATED on the bcSecret BroadcastChannel');
    }
}

// The one-shot boot-recovery (uBOL's goodStart, adapted) rests on a handful
// of shapes both in this port's own code and upstream. Each is cheap to
// assert and expensive to debug: break one and a failed boot either stays
// half-up forever (the failure class this exists to fix) or, worse, the
// once-guard fails and a persistently broken install reloads in a loop.
{
    const post = readRepo('platform/chromium-mv3/mv3-post.js');
    // The recovery block, isolated from the rest of the module (bounded by
    // the next banner divider).
    const region = /One-shot recovery from a failed boot[\s\S]*?\n\/\*{6,}\//.exec(post);
    const problems = [];
    if ( region === null ) {
        problems.push('cannot locate the boot-recovery block in mv3-post.js');
    } else {
        const block = region[0];
        const pins = [
            [ /µb\.readyToFilter !== true/, 'the readyToFilter audit signal' ],
            [ /vAPI\.storage\.get\('selectedFilterLists'\)/, 'the storage-health audit probe' ],
            [ /staticNetFilteringEngine\.getFilterCount\(\) === 0/, 'the engine-data audit signal' ],
            [ /bin\[RETRY_MARKER\] === true/, 'the once-guard (a used retry marker must suppress the reload)' ],
            [ /await chrome\.storage\.local\.set\(\{ \[RETRY_MARKER\]: true \}\);/, 'the marker write before the reload' ],
            [ /chrome\.runtime\.reload\(\);/, 'the reload call site' ],
            [ /chrome\.storage\.local\.remove\(RETRY_MARKER\)/, 'the clear-on-success' ],
            [ /µb\.isReadyPromise/, 'the boot-completion trigger' ],
        ];
        for ( const [ re, what ] of pins ) {
            if ( re.test(block) ) { continue; }
            problems.push(`mv3-post.js boot-recovery: ${what} is gone`);
        }
        // The recovery must reload directly: vAPI.app.restart clears the
        // session-state snapshots, which is restore/reset semantics, not
        // boot-retry semantics.
        if ( /vAPI\.app\.restart/.test(block) ) {
            problems.push('boot-recovery routes through vAPI.app.restart, which clears the session snapshots -- a boot retry must reload via chrome.runtime.reload() directly');
        }
        // The marker must NOT live in storage.session: the storage docs are
        // explicit that session storage is cleared when the extension is
        // reloaded, so a session-scoped marker cannot survive the reload it
        // is supposed to gate (infinite-loop hazard).
        if ( /sessionStorage|storage\.session/.test(block) ) {
            problems.push('boot-recovery uses session storage for the retry marker -- it is cleared by runtime.reload() itself and cannot gate the reload');
        }
    }
    // Upstream anchors the audit reads.
    const drift = [
        [ 'src/js/static-net-filtering.js', /getFilterCount = function\(\)/,
          'the net-filtering engine no longer exposes getFilterCount(), which the boot audit reads' ],
        [ 'src/js/start.js', /µb\.readyToFilter = true;/,
          'start.js no longer sets readyToFilter, which the boot audit reads' ],
        [ 'src/js/background.js', /readyToFilter: false,/,
          'background.js no longer initializes readyToFilter' ],
    ];
    for ( const [ rel, re, message ] of drift ) {
        if ( re.test(readRepo(rel)) ) { continue; }
        problems.push(`${rel}: ${message}`);
    }
    // vAPI.storage.get's null-on-failure fulfillment is a build-time
    // transform (tools/patch-mv3-modules.mjs, transform 6) applied to the
    // packaged copy -- the source tree is upstream's again -- so this pin
    // reads the package, not the repo.
    if ( /bin instanceof Object \? bin : null/.test(readPkg('js/vapi-background.js')) === false ) {
        problems.push('js/vapi-background.js: vAPI.storage.get no longer fulfills with null on failure, which the boot audit uses as its storage-health signal');
    }
    if ( problems.length !== 0 ) {
        fail('boot-recovery', problems.join('\n'),
            'reconcile platform/chromium-mv3/mv3-post.js (and its upstream anchors) with the goodStart design in docs/mv3-deployment.md');
    } else {
        pass('one-shot boot recovery intact: audit signals, once-guard, reload and clear-on-success pinned');
    }
}

// The user-filter staleness fix (mv3-post.js) wraps `µb.saveUserFilters` so a
// raw-asset change also rebuilds the engines, and wraps the scriptlet
// engine's retrieve so its payload cache invalidates on a user-filters
// generation. Both halves, plus the upstream shapes they lean on, are pinned
// here: lose one and removed `+js(...)` filters keep injecting -- within the
// worker's life from the cache, across reloads from a selfie that snapshotted
// stale engines.
{
    const post = readRepo('platform/chromium-mv3/mv3-post.js');
    const region = /Make user-filter changes take effect[\s\S]*?\n\/\*{6,}\//.exec(post);
    const problems = [];
    if ( region === null ) {
        problems.push('cannot locate the user-filter staleness fix in mv3-post.js');
    } else {
        const block = region[0];
        const pins = [
            [ /let userFiltersModifyTime = 0;/, 'the user-filters generation clock' ],
            [ /this\.scriptletCache\?\.resetTime < userFiltersModifyTime/, 'the scriptlet payload-cache generation check' ],
            [ /this\.clearCache\(\);/, 'the payload-cache clear' ],
            [ /µb\.saveUserFilters = function/, 'the saveUserFilters wrap' ],
            [ /io\.remove\(`compiled\/\$\{ubo\.userFiltersPath\}`\)/, 'the awaited compiled-entry re-removal through io (the removal helper itself returns nothing -- see the round-7 root cause)' ],
            [ /ubo\.loadFilterLists\(\)/, 'the engine rebuild trigger' ],
            [ /ubo\.readyToFilter !== true/, 'the boot-time guard' ],
        ];
        for ( const [ re, what ] of pins ) {
            if ( re.test(block) ) { continue; }
            problems.push(`mv3-post.js user-filter fix: ${what} is gone`);
        }
        // Round-7 root cause, pinned so it can never come back: the chain
        // must not call anything that returns undefined and then chain
        // promises off it -- the TypeError is swallowed by the outer catch
        // and the rebuild silently never happens.
        if ( /this\.removeCompiledFilterList\([^)]*\)\s*\n\s*\.catch/.test(block) ) {
            problems.push('the fix chains .catch() off removeCompiledFilterList(), which returns undefined -- that is the round-7 root cause (silent TypeError, rebuild never runs)');
        }
    }
    const drift = [
        [ 'src/js/storage.js', /µb\.saveUserFilters = function\(content\) \{[\s\S]*?removeCompiledFilterList\(this\.userFiltersPath\);[\s\S]*?return io\.put\(this\.userFiltersPath, content\);/,
          'saveUserFilters no longer removes the compiled entry before writing the raw asset -- the wrap in mv3-post.js leans on both' ],
        [ 'src/js/storage.js', /µb\.removeCompiledFilterList = function\(assetKey\) \{\s*\n\s*io\.remove\(`compiled\/\$\{assetKey\}`\);\s*\n\};/,
          'removeCompiledFilterList no longer returns nothing -- if it now returns io.remove()\'s promise, the wrap in mv3-post.js could await it directly instead of calling io.remove() itself' ],
        [ 'src/js/storage.js', /µb\.loadFilterLists = function\(\) \{\s*\n\s*if \( loadingPromise instanceof Promise \)/,
          'loadFilterLists no longer coalesces concurrent calls -- the wrap triggers it on every save' ],
        [ 'src/js/scriptlet-filtering.js', /this\.scriptletCache\.resetTime < reng\.modifyTime/,
          'the scriptlet payload cache no longer consults the redirect engine\'s modify time -- reconcile the generation check in mv3-post.js with the new upstream condition' ],
        [ 'src/js/scriptlet-filtering.js', /clearCache\(\) \{\s*\n\s*this\.scriptletCache\.reset\(\);/,
          'the scriptlet engine no longer has a clearCache() the generation check can call' ],
    ];
    for ( const [ rel, re, message ] of drift ) {
        if ( re.test(readRepo(rel)) ) { continue; }
        problems.push(`${rel}: ${message}`);
    }
    if ( problems.length !== 0 ) {
        fail('user-filter-staleness', problems.join('\n'),
            'reconcile platform/chromium-mv3/mv3-post.js with the new upstream shape; removed +js() filters must stop injecting in this worker\'s life AND across reloads');
    } else {
        pass('user-filter staleness fix intact: engine rebuild + payload-cache generation pinned');
    }
}

// Extension pages have no equivalent of mv3-shims.js. `webext.js` reads
// `chrome.browserAction` at module-evaluation time, which MV3 leaves undefined
// (the key is now `action`), so the read throws and aborts the module graph of
// every page importing webext.js -- Filter lists, My filters, Support, the
// logger. tools/patch-mv3-modules.mjs prepends an alias to the packaged webext.js
// to close this; assert it survived. A blank dashboard pane over a healthy
// service worker is exactly the kind of failure this port asserts away.
{
    const rel = 'js/webext.js';
    if ( existsPkg(rel) === false ) {
        // The required-files check already fails on this; don't double-report.
    } else if ( /chrome\.browserAction\s*=\s*chrome\.action/.test(readPkg(rel)) ) {
        pass('webext.js has the page-context chrome.browserAction alias');
    } else {
        fail('page-browseraction-alias',
            'js/webext.js is missing the page-context chrome.browserAction alias',
            'tools/patch-mv3-modules.mjs must prepend `chrome.browserAction = chrome.action` so pages importing webext.js do not throw at load');
    }
}

// The worker relay is epoch-namespaced end to end, and its watchdog can
// retry and then fail loudly. These are shape-critical invariants: an
// offscreen document that ignores epochs reintroduces the id collision
// that silently killed filter list updates, and a watchdog that cannot
// synthesize the consumers' give-up messages leaves a stall hanging.
{
    const offscreen = readPkg('js/offscreen.js');
    const shims = readPkg('js/mv3-shims.js');
    const problems = [];
    if ( /adoptWorkerEpoch/.test(offscreen) === false ) {
        problems.push('offscreen.js no longer adopts per-lifetime worker epochs');
    }
    if ( /retiredEpochs/.test(offscreen) === false ) {
        problems.push('offscreen.js no longer ignores retired epochs (stragglers from a replaced service worker)');
    }
    if ( /epoch: workerEpoch/.test(offscreen) === false ) {
        problems.push('offscreen.js no longer stamps worker replies with the epoch');
    }
    if ( /const workerEpoch = crypto\.randomUUID/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer mints a per-lifetime worker epoch');
    }
    if ( /msg\.epoch !== workerEpoch/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer drops replies from a foreign worker epoch');
    }
    if ( /replaceHostedWorker/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer retries a stalled worker on a fresh id');
    }
    if ( /giveUp\(/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer fails loudly and synthesizes the consumers\' give-up messages');
    }
    if ( /offscreenEvidenceAt/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer caches offscreen-document evidence, so the keepalive alarm would IPC chrome.runtime.getContexts on every 30s tick');
    }
    if ( problems.length !== 0 ) {
        fail('worker-relay', problems.join('\n'),
            'see the worker relay section of platform/chromium-mv3/mv3-shims.js and offscreen.js');
    } else {
        pass('worker relay: epoch namespacing, replacement and watchdog intact');
    }
}

// Cold-wake events. Chrome dispatches the event which woke a terminated
// service worker only to listeners registered synchronously during initial
// evaluation; uBO registers the context menu and update listeners at the
// end of its async boot. mv3-shims.js buffers the first event of each at
// module scope and mv3-post.js replays them -- both halves must exist.
{
    const shims = readPkg('js/mv3-shims.js');
    const post = readPkg('js/mv3-post.js');
    const problems = [];
    if ( /chrome\.contextMenus\.onClicked\.addListener/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer registers an early contextMenus.onClicked buffer');
    }
    if ( /chrome\.runtime\.onUpdateAvailable\.addListener/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer registers an early runtime.onUpdateAvailable buffer');
    }
    if ( /chrome\.runtime\.onStartup\.addListener/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer registers a runtime.onStartup listener, so the service worker no longer boots at browser start and the engine load lands on the first navigation');
    }
    if ( /export const mv3EarlyEvents/.test(shims) === false ) {
        problems.push('mv3-shims.js no longer exports the early-event buffers');
    }
    if ( /replayContextMenuClick/.test(post) === false ) {
        problems.push('mv3-post.js no longer replays buffered context-menu clicks');
    }
    if ( /consumeUpdateAvailable/.test(post) === false ) {
        problems.push('mv3-post.js no longer replays a buffered update-available event');
    }
    if ( problems.length !== 0 ) {
        fail('cold-wake-events', problems.join('\n'),
            'a click on a persistent context menu item, or an update notification, waking a cold service worker would be dropped again');
    } else {
        pass('cold-wake context-menu and update events are buffered and replayed');
    }
}

// Session state a service worker death would otherwise revert -- session
// dynamic rules, per-tab page stores, strict-block bypasses -- is persisted
// to storage.session and restored from a webRequest.start() wrap, before
// isReadyResolve(). The strict-block half additionally needs the
// strictBlockBypassMap exposure the patcher adds to js/traffic.js.
{
    const post = readPkg('js/mv3-post.js');
    const problems = [];
    // js/traffic.js is an upstream file the patcher rewrites, not one of the
    // port's own files, so it is not in REQUIRED_FILES; guard the read so an
    // absent one is recorded as a failure rather than throwing ENOENT and
    // aborting the run before the summary.
    if ( existsPkg('js/traffic.js') === false ) {
        problems.push('js/traffic.js is missing from the package (check tools/copy-common-files.sh)');
    } else if ( /strictBlockBypassMap/.test(readPkg('js/traffic.js')) === false ) {
        problems.push('js/traffic.js does not expose webRequest.strictBlockBypassMap (tools/patch-mv3-modules.mjs transform 4)');
    }
    if ( /strictBlockBypassMap/.test(post) === false ) {
        problems.push('mv3-post.js no longer persists/restores the strict-block bypass map');
    }
    if ( /sessionFirewall\.fromString\(snapshot\.firewall\)/.test(post) === false ) {
        problems.push('mv3-post.js no longer restores the session firewall from storage.session');
    }
    if ( /uBOMv3PS:/.test(post) === false ) {
        problems.push('mv3-post.js no longer persists per-tab page-store snapshots');
    }
    if ( /applyBootState/.test(post) === false ) {
        problems.push('mv3-post.js no longer drives the session-state restore');
    }
    if ( /webRequest\.start = function/.test(post) === false ) {
        problems.push('mv3-post.js no longer wraps webRequest.start, the one hook that runs after onFirstFetchReady() and before isReadyResolve()');
    }
    if ( /'\/js\/benchmarks\.js': benchmarks/.test(post) === false ) {
        problems.push('mv3-post.js no longer registers /js/benchmarks.js, so the devtools benchmark buttons hang');
    }
    if ( /SESSION_BUDGET_BYTES/.test(post) === false ) {
        problems.push('mv3-post.js no longer budgets page-store snapshots against the storage.session quota, so past-quota writes fail silently again');
    }
    if ( /getBytesInUse/.test(post) === false ) {
        problems.push('mv3-post.js no longer measures storage.session usage before writing page-store snapshots');
    }
    if ( problems.length !== 0 ) {
        fail('session-state', problems.join('\n'),
            'see the session-state section of platform/chromium-mv3/mv3-post.js');
    } else {
        pass('session rules, page stores and strict-block bypasses survive service worker deaths');
    }
}

/******************************************************************************/

section('summary');

console.log(`    ${checked.length} checks passed, ${warnings} warning(s), ${failures} failure(s)`);

if ( failures !== 0 ) {
    console.log('\n*** verify-mv3-package: FAILED');
    process.exit(1);
}
console.log('\n*** verify-mv3-package: OK');
