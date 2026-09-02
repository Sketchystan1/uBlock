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
import path from 'node:path';

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
// tools/make-chromium-mv3.sh or tools/copy-common-files.sh has drifted.
const REQUIRED_FILES = [
    'manifest.json',
    'offscreen.html',
    'js/sw.js',
    'js/mv3-shims.js',
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
];

for ( const rel of REQUIRED_FILES ) {
    if ( existsPkg(rel) ) { continue; }
    fail('required-file', `missing from package: ${rel}`,
        'check tools/make-chromium-mv3.sh and tools/copy-common-files.sh');
}
if ( failures === 0 ) { pass(`${REQUIRED_FILES.length} required files present`); }

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
];

for ( const [ name, test, message ] of manifestChecks ) {
    if ( test() ) { pass(name); continue; }
    fail(name, message, 'see tools/make-chromium-mv3-meta.py');
}

// Every permission the port's own code paths depend on.
const REQUIRED_PERMISSIONS = [
    'alarms',               // mv3-shims.js keepalive watchdog
    'offscreen',            // Worker host + keepalive pings
    'scripting',            // executeScript/insertCSS/removeCSS shims
    'userScripts',          // the only MV3 API that injects a code string
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

// mv3-shims.js routes `code` injections to the USER_SCRIPT world and `file`
// injections to the ISOLATED world, except for a hand-maintained regex of files
// that must join the scriptlets in USER_SCRIPT. That list has to track the set
// of scriptlet files reading cross-world state.
{
    const shims = readRepo('platform/chromium-mv3/mv3-shims.js');
    const scriptletDir = path.join(repoDir, 'src/js/scriptlets');
    const reUserScriptWorldFiles = /reUserScriptWorldFiles\s*=\s*(\/[^\n]+?\/)[a-z]*\s*;/.exec(shims);
    if ( reUserScriptWorldFiles === null ) {
        warn('scriptlet-worlds',
            'could not locate reUserScriptWorldFiles in mv3-shims.js -- skipping the world-routing drift check');
    } else {
        const re = new RegExp(reUserScriptWorldFiles[1].slice(1, -1));
        const readers = [];
        for ( const name of fs.readdirSync(scriptletDir) ) {
            if ( name.endsWith('.js') === false ) { continue; }
            const src = fs.readFileSync(path.join(scriptletDir, name), 'utf8');
            if ( /uBO_scriptletsInjected|uBO_bcSecret|uBO_isolatedScriptlets/.test(src) === false ) { continue; }
            readers.push({ name, routed: re.test(`/js/scriptlets/${name}`) });
        }
        const unrouted = readers.filter(r => r.routed === false).map(r => r.name);
        // cosmetic-report.js is a known exception: it needs vAPI.domFilterer, so
        // it must stay in the ISOLATED world even though it reads a marker set
        // in USER_SCRIPT. Tracked separately; see docs/mv3-deployment.md.
        const KNOWN_ISOLATED_READERS = [ 'cosmetic-report.js' ];
        const surprises = unrouted.filter(n => KNOWN_ISOLATED_READERS.includes(n) === false);
        if ( surprises.length !== 0 ) {
            fail('scriptlet-worlds',
                `scriptlet file(s) read cross-world state but are injected into the ISOLATED world: ${surprises.join(', ')}`,
                'either add them to reUserScriptWorldFiles in mv3-shims.js, or to KNOWN_ISOLATED_READERS here with a reason');
        } else {
            pass(`${readers.length} cross-world scriptlet reader(s) routed as expected`);
        }
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
