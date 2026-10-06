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

    Fix-ups which can only be applied AFTER uBO's own modules have evaluated.

    `mv3-shims.js` runs before uBO and may therefore not import anything of
    uBO's -- doing so would evaluate a uBO module before the shims it depends on
    are installed, inverting the one ordering guarantee this port rests on. This
    module is the other half: `sw.js` imports it after `./start.js`, so by the
    time it runs uBO is fully loaded and it is safe both to import uBO's modules
    and to patch what they defined.

    Keep this file small. Anything that can be done from `mv3-shims.js` belongs
    there instead, because a shim installed before uBO loads cannot be defeated
    by load-order surprises. What is here needs uBO itself: a substitute for
    dynamic `import()`, the per-frame scriptlet injection (calls resolved from
    uBO's engine, injected by `mv3-shims.js`), one user-setting default whose MV2 value is wrong
    under MV3, the replaying of cold-wake events `mv3-shims.js` buffers (the
    context menu, update availability), and the persistence and restore of the
    state a service worker death would otherwise silently revert (session
    dynamic rules, per-tab page stores, strict-block bypasses) -- all of it
    hooked onto objects only uBO's own modules can have defined by now.

**/

/* global chrome */

/******************************************************************************/

// Substitutes for the dynamic `import()` calls that `tools/patch-mv3-modules.mjs`
// rewrote, since dynamic import is forbidden in a ServiceWorkerGlobalScope. See
// the `uBO_dynamicImport` block in `mv3-shims.js` for the full explanation.
//
// Only the call paths that matter are provided:
// - `resources/scriptlets.js` is required by `redirect-engine.js`'s
//   `loadBuiltinResources()`. Without it uBO's scriptlet resource table is
//   empty and every `+js(...)` filter silently does nothing.
// - `static-dnr-filtering.js` backs the dashboard's "export to DNR" feature.
// - `benchmarks.js` backs the devtools page's benchmark buttons. Without it
//   the dynamic import rejects with no `.catch`, and the buttons hang
//   forever with no feedback. Everything it imports is already in the
//   service worker's graph, so registering it costs one module body per
//   service worker start and nothing else until a benchmark is run.

import * as benchmarks from './benchmarks.js';
import * as resourcesScriptlets from './resources/scriptlets.js';
import * as staticDnrFiltering from './static-dnr-filtering.js';
import {
    domainFromHostname,
    entityFromHostname,
    hostnameFromURI,
} from './uri-utils.js';
import {
    mv3EarlyEvents,
    mv3ForkStatus,
    mv3ForkStatusReady,
    mv3InjectScriptlets,
} from './mv3-shims.js';
import {
    sessionFirewall,
    sessionSwitches,
    sessionURLFiltering,
} from './filtering-engines.js';
import io from './assets.js';
import { mv3RegisteredScriptletGlobals } from './vapi-scripting.js';
import { redirectEngine } from './redirect-engine.js';
// Generated into the package by tools/patch-mv3-modules.mjs.
import { scriptletShards } from './mv3-scriptlet-shards.js';
import scriptletFilteringEngine from './scriptlet-filtering.js';
import staticNetFilteringEngine from './static-net-filtering.js';
import webRequest from './traffic.js';
import µb from './background.js';

self.uBO_registerStaticModules({
    '/js/resources/scriptlets.js': resourcesScriptlets,
    './static-dnr-filtering.js': staticDnrFiltering,
    // Registered so the devtools page's benchmark buttons answer instead of
    // hanging: `src/js/messaging.js` imports this module dynamically for
    // them, and an unregistered specifier rejects with nothing left to call
    // the callback. Every module it imports is already in the service
    // worker's graph, so registering it costs one module body, not a new
    // dependency tree; it pulls its benchmark dataset only when run.
    '/js/benchmarks.js': benchmarks,
});

/******************************************************************************/

// Durable settings storage: mirror chrome.storage.local into IndexedDB.
//
// chrome.storage.local does NOT persist across a browser restart for this
// fork's install type. Confirmed live over CDP (see the first-install restart
// guard in tools/patch-mv3-modules.mjs): the per-extension "Local Extension
// Settings" LevelDB is never committed to disk, so every settings write --
// user settings, the filter-list selection, the trusted-site whitelist, the
// permanent dynamic rules and hostname switches, hidden settings -- is silently
// lost on the next launch. IndexedDB, by contrast, DOES persist: it is the
// backend cacheStorage uses (src/js/cachestorage.js, fastCache = 'indexedDB'),
// and it is the sole reason "My filters" (stored as the user-filters asset
// through io.put -> cacheStorage) survives a restart while nothing on the other
// dashboard tabs does. The whole reported symptom -- "only My filters is
// restored, everything else is lost after a restart" -- is exactly this backend
// split.
//
// So make uBO's settings store durable by backing vAPI.storage with IndexedDB:
// write-through on set/remove/clear, read-fallback on get. The mirror is
// transparent to every uBO caller (they still call vAPI.storage), lives in its
// own database rather than in cacheStorage -- cache entries are disposable and
// purged on selfie/format changes, settings must never be -- and degrades to
// the original local-only behavior if IndexedDB itself is ever unavailable.
//
// Installed here, synchronously at mv3-post.js evaluation: sw.js evaluates this
// module immediately after start.js, whose boot IIFE yields on its first
// `await` (restoreAdminSettings) before it reads any settings, so the wrapper
// is in place before the first storage.local read of the boot.

// Assigned by the durable-storage block below; used by the vAPI.app.restart
// wrapper further down to flush pending durable writes before a reload.
let flushDurableSettingsWrites = ( ) => Promise.resolve();

{
    const DB_NAME = 'uBlock0Settings';
    const STORE_NAME = 'settings';
    let dbPromise;

    const openDB = ( ) => {
        if ( dbPromise !== undefined ) { return dbPromise; }
        dbPromise = new Promise(resolve => {
            let req;
            try {
                req = indexedDB.open(DB_NAME, 1);
            } catch {
                return resolve(null);
            }
            req.onupgradeneeded = ev => {
                const db = ev.target.result;
                if ( db.objectStoreNames.contains(STORE_NAME) === false ) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = ev => { resolve(ev.target.result); };
            req.onerror = ( ) => {
                // A wedged open must not poison every later call: re-arm so a
                // transient failure can be retried on the next access.
                dbPromise = undefined;
                resolve(null);
            };
        });
        return dbPromise;
    };
    const txStore = async mode => {
        const db = await openDB();
        if ( db === null ) { return null; }
        try {
            return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
        } catch {
            return null;
        }
    };

    // All idb helpers resolve rather than reject -- a broken mirror must never
    // wedge a settings read/write, only forgo durability. Missing keys are
    // simply absent from the returned bin, so callers can test presence.
    const idbGet = async keys => {
        const out = {};
        const store = await txStore('readonly');
        if ( store === null ) { return out; }
        await Promise.all(keys.map(key => new Promise(resolve => {
            const req = store.get(key);
            req.onsuccess = ( ) => {
                if ( req.result !== undefined ) { out[key] = req.result; }
                resolve();
            };
            req.onerror = ( ) => resolve();
        })));
        return out;
    };

    const idbGetAll = async ( ) => {
        const out = {};
        const store = await txStore('readonly');
        if ( store === null ) { return out; }
        return new Promise(resolve => {
            const req = store.openCursor();
            req.onsuccess = ev => {
                const cursor = ev.target.result;
                if ( cursor === null ) { return resolve(out); }
                out[cursor.key] = cursor.value;
                cursor.continue();
            };
            req.onerror = ( ) => resolve(out);
        });
    };

    const idbSet = async bin => {
        const store = await txStore('readwrite');
        if ( store === null ) { return; }
        await Promise.all(Object.keys(bin).map(key => new Promise(resolve => {
            const req = store.put(bin[key], key);
            req.onsuccess = ( ) => resolve();
            req.onerror = ( ) => resolve();
        })));
    };
    const idbRemove = async keys => {
        const store = await txStore('readwrite');
        if ( store === null ) { return; }
        const list = Array.isArray(keys) ? keys : [ keys ];
        await Promise.all(list.map(key => new Promise(resolve => {
            const req = store.delete(key);
            req.onsuccess = ( ) => resolve();
            req.onerror = ( ) => resolve();
        })));
    };

    const idbClear = async ( ) => {
        const store = await txStore('readwrite');
        if ( store === null ) { return; }
        await new Promise(resolve => {
            const req = store.clear();
            req.onsuccess = ( ) => resolve();
            req.onerror = ( ) => resolve();
        });
    };

    // The argument shapes uBO passes to storage.get: a string key, an array of
    // keys, an object whose keys carry default values, or null/undefined for
    // "everything". Mirrors src/js/cachestorage.js's keysFromGetArg.
    const keysFromArg = arg => {
        if ( arg === null || arg === undefined ) { return null; }
        if ( typeof arg === 'string' ) { return [ arg ]; }
        if ( Array.isArray(arg) ) { return arg.slice(); }
        if ( typeof arg === 'object' ) { return Object.keys(arg); }
        return [];
    };

    // Track in-flight durable writes so a restart (backup restore / "reset all
    // settings") can flush them before the service worker reloads. Without this
    // the fire-and-forget vAPI.storage.set()s in messaging.js's restoreUserData
    // race the immediate vAPI.app.restart() and never reach IndexedDB -- which
    // is exactly why restoring from a backup file "doesn't fully work".
    const durableWrites = new Set();
    const trackDurable = promise => {
        durableWrites.add(promise);
        promise.finally(( ) => durableWrites.delete(promise));
        return promise;
    };
    flushDurableSettingsWrites = ( ) => Promise.allSettled([ ...durableWrites ]);

    // Best-effort refresh of chrome.storage.local from the durable mirror, so
    // keys recovered from IndexedDB after a restart are also present in the
    // (possibly non-persisting) local store for the rest of this session. Never
    // awaited: a failure changes nothing, the mirror stays authoritative.
    const backfillLocal = (localSet, bin) => {
        if ( bin instanceof Object === false ) { return; }
        if ( Object.keys(bin).length === 0 ) { return; }
        try { trackDurable(Promise.resolve(localSet(bin)).catch(( ) => {})); } catch {}
    };
    const local = vAPI.storage;
    const localGet = local.get.bind(local);
    const localSet = local.set.bind(local);
    const localRemove = local.remove.bind(local);
    const localClear = local.clear.bind(local);

    vAPI.storage.get = async function(arg, ...args) {
        const keys = keysFromArg(arg);

        // "Get everything": union of the durable mirror and whatever the local
        // store still holds, local winning on conflict (write-through keeps the
        // two equal; local is only ever a same-session subset).
        if ( keys === null ) {
            const [ localBin, idbBin ] = await Promise.all([
                localGet(arg, ...args),
                idbGetAll(),
            ]);
            if ( localBin instanceof Object === false ) {
                return Object.keys(idbBin).length !== 0 ? idbBin : null;
            }
            return Object.assign({}, idbBin, localBin);
        }

        // Object-with-defaults (createDefaultProps at boot): the result carries,
        // per key, the stored value if any, else the caller's default -- and is
        // never null. Probe the local store with the bare key list so a default
        // cannot masquerade as a stored value, then layer default < mirror <
        // local.
        if ( arg instanceof Object && Array.isArray(arg) === false ) {
            const [ localBin, idbBin ] = await Promise.all([
                localGet(keys),
                idbGet(keys),
            ]);
            const result = Object.assign({}, arg);
            const recovered = {};
            for ( const key of keys ) {
                if ( localBin instanceof Object && Object.hasOwn(localBin, key) ) {
                    result[key] = localBin[key];
                } else if ( Object.hasOwn(idbBin, key) ) {
                    result[key] = idbBin[key];
                    recovered[key] = idbBin[key];
                }
            }
            backfillLocal(localSet, recovered);
            return result;
        }
        // String or array of keys: preserve the patched null-on-failure signal
        // that this module's boot-recovery relies on, but treat storage as
        // healthy whenever the durable mirror can serve the read.
        const localBin = await localGet(arg, ...args);
        if ( localBin instanceof Object === false ) {
            const idbBin = await idbGet(keys);
            if ( Object.keys(idbBin).length !== 0 ) {
                backfillLocal(localSet, idbBin);
                return idbBin;
            }
            return null;
        }
        const missing = keys.filter(key => Object.hasOwn(localBin, key) === false);
        if ( missing.length !== 0 ) {
            const idbBin = await idbGet(missing);
            const recovered = {};
            for ( const key of missing ) {
                if ( Object.hasOwn(idbBin, key) === false ) { continue; }
                localBin[key] = idbBin[key];
                recovered[key] = idbBin[key];
            }
            backfillLocal(localSet, recovered);
        }
        return localBin;
    };

    // Write-through. The durable (IndexedDB) write is tracked synchronously at
    // call time so a restart issued right after a fire-and-forget set() still
    // flushes it; neither write may reject the caller (uBO's saveUserSettings
    // et al. do not await).
    vAPI.storage.set = function(bin, ...args) {
        const localP = Promise.resolve(localSet(bin, ...args)).catch(( ) => {});
        const idbP = trackDurable(idbSet(bin instanceof Object ? bin : {}));
        return Promise.allSettled([ localP, idbP ]).then(( ) => {});
    };

    vAPI.storage.remove = function(keys, ...args) {
        const localP = Promise.resolve(localRemove(keys, ...args)).catch(( ) => {});
        const idbP = trackDurable(idbRemove(keys));
        return Promise.allSettled([ localP, idbP ]).then(( ) => {});
    };

    vAPI.storage.clear = function(...args) {
        const localP = Promise.resolve(localClear(...args)).catch(( ) => {});
        const idbP = trackDurable(idbClear());
        return Promise.allSettled([ localP, idbP ]).then(( ) => {});
    };
}

/******************************************************************************/

// Grey out "Enable cloud storage support".
//
// uBO's cloud storage IS chrome.storage.sync (Google-account sync). Chromium's
// IsSyncable() excludes this force-installed off-store build from sync on two
// counts -- policy/external install location and a non-gallery update URL -- so
// the feature can never sync cross-device here; it would be a toggle that
// silently does nothing. Flag it unsupported so the feature is genuinely off:
// src/js/messaging.js no-ops every cloud handler and src/js/cloud-ui.js leaves
// each per-pane cloud widget hidden. The Settings checkbox is greyed + unchecked
// the SAME way "Uncloak canonical names" is: src/js/messaging.js sends
// `cloudStorageEnabled = undefined` when unsupported, so settings.js takes the
// generic disabled+unchecked path (disables the .checkbox wrapper, which
// common.css greys via `.checkbox[disabled]` -- not just the input). One
// assignment plus that one mirror line; chrome.storage.sync is reached only
// through vAPI.cloud, so nothing else is affected. The Google-Drive-based
// cross-device sync design (the only viable route) is recorded in docs/mv3-sync.md.
µb.cloudStorageSupported = false;

/******************************************************************************/

// Visible degraded-state indicator on the toolbar icon.
//
// When network filtering is inert -- webRequest blocking not working (not
// policy-installed) or async blocking off (installType != 'admin') -- set a red
// "!" badge so the failure is visible, not console-only. The popup banner
// (platform/chromium-mv3/mv3-popup-banner.js) carries the detail; this is the
// attention-grabber. The status is probed in mv3-shims.js and settles shortly
// after boot.
//
// While degraded, uBO's own per-tab badge updates (block counts, the "off"
// state) are overridden to keep the indicator visible: a build that is not
// filtering has no meaningful per-tab counts, so forcing the error badge over
// them is the right trade. Both action methods are already wrapped by
// mv3-shims.js (tabId validation); this wraps those wrappers.
mv3ForkStatusReady.then(( ) => {
    const degraded =
        mv3ForkStatus.webRequestBlocking === false ||
        mv3ForkStatus.asyncBlocking === false;
    if ( degraded === false ) { return; }
    const ERROR_TEXT = '!';
    const ERROR_COLOR = '#b00000';
    if ( chrome.action instanceof Object === false ) { return; }
    const setBadgeText = chrome.action.setBadgeText?.bind(chrome.action);
    const setBadgeColor = chrome.action.setBadgeBackgroundColor?.bind(chrome.action);
    if ( typeof setBadgeText !== 'function' ) { return; }
    chrome.action.setBadgeText = function(details, ...args) {
        const forced = Object.assign({}, details, { text: ERROR_TEXT });
        return setBadgeText(forced, ...args);
    };
    if ( typeof setBadgeColor === 'function' ) {
        chrome.action.setBadgeBackgroundColor = function(details, ...args) {
            const forced = Object.assign({}, details, { color: ERROR_COLOR });
            return setBadgeColor(forced, ...args);
        };
    }
    // Seed the default (no-tab) badge now, so tabs uBO has not touched yet also
    // show it; navigations re-assert it through the wraps above.
    try {
        chrome.action.setBadgeText({ text: ERROR_TEXT });
        if ( typeof setBadgeColor === 'function' ) {
            chrome.action.setBadgeBackgroundColor({ color: ERROR_COLOR });
        }
    } catch { }
}).catch(( ) => { });

/******************************************************************************/

// Scriptlet injection, per committed frame.
//
// Upstream compiles every scriptlet filter into one program which
// `platform/chromium/vapi-scripting.js` executes as a code string in every
// committed frame, where it matches the document's hostname, entity and
// ancestors against tables baked into the code. No MV3 API executes a code
// string, so `./vapi-scripting.js` keeps only the registration state and its
// `scriptletGlobals`, and the per-frame work happens here, in the service
// worker -- where MV2 uBO itself did it until upstream 9af8ef4c6: resolve the
// frame's scriptlet calls from the engine's database, then hand them to
// `mv3InjectScriptlets()` (mv3-shims.js), which runs them through the
// CSP-exempt sharded libraries `tools/patch-mv3-modules.mjs` generates.
//
// Same trigger as upstream: `webNavigation.onCommitted`, for http(s) and
// about: documents -- the latter resolved to the frame they inherit their
// origin from, which is what upstream's in-page matcher sees through
// `document.location.origin`. Hooked onto uBO's own committed handler rather
// than a listener of ours, so that the frame is already recorded in its page
// store when this runs: `>>` ancestor filters need the frame tree. The early
// bailouts upstream serializes into its program -- trusted sites, a
// first-party `allow` rule -- are applied here, below.

const reScriptletDocumentURL = /^https?:|^about:/;
const reNetworkDocumentURL = /^https?:\/\//;

// `lookupScriptlet()` in upstream's pre-9af8ef4c6 core used the same test to
// tell function-style scriptlets from legacy `{{1}}`-placeholder ones.
const reScriptletFunction = /^function\s+([^(\s]+)\s*\(/;

// Mirrors `ScriptletFilteringEngine.prototype.retrieve()` in
// `src/js/scriptlet-filtering-core.js`, which upstream ends by decompiling the
// tokens into filter text for the logger; the injection needs the tokens
// themselves. `tools/verify-mv3-package.mjs` pins upstream's body, so any
// change to it fails the build until this is reconciled.
const collectScriptletTokens = request => {
    const db = scriptletFilteringEngine.scriptletDB;
    if ( db.size === 0 ) { return; }

    const all = new Set();
    const { ancestors = [], domain, hostname } = request;

    db.retrieveSpecifics(all, hostname);
    const entity = entityFromHostname(hostname, domain);
    db.retrieveSpecifics(all, entity);
    db.retrieveSpecificsByRegex(all, hostname, request.url);
    db.retrieveGenerics(all);
    const visitedAncestors = [];
    for ( const ancestor of ancestors ) {
        const { domain, hostname } = ancestor;
        if ( visitedAncestors.includes(hostname) ) { continue; }
        visitedAncestors.push(hostname);
        db.retrieveSpecifics(all, `${hostname}>>`);
        const entity = entityFromHostname(hostname, domain);
        if ( entity !== '' ) {
            db.retrieveSpecifics(all, `${entity}>>`);
        }
    }
    if ( all.size === 0 ) { return; }

    // Wholly disable scriptlet injection?
    if ( all.has('-[]') ) { return; }

    const tokens = [];
    for ( const s of all ) {
        if ( s.charCodeAt(0) === 0x2D /* - */ ) { continue; }
        const token = s.slice(1);
        if ( all.has(`-${token}`) ) { continue; }
        tokens.push(token);
    }
    return tokens;
};

// Resolve tokens to calls into the sharded libraries, per world. Only
// built-in scriptlets ship as library functions: a resource from
// `userResourcesLocation`, or a legacy placeholder-style one, would have to
// be executed as a code string, which MV3 cannot do -- say so once per name
// and inject the rest. Ordered as upstream ordered calls before 9af8ef4c6
// (resource priority first, then the call text), so that e.g.
// `proxy-apply-config` still runs ahead of the scriptlets it configures.
const unsupportedScriptlets = new Set();

const scriptletCallsFromTokens = tokens => {
    const worlds = { main: [], isolated: [] };
    for ( const token of tokens ) {
        let args;
        try { args = JSON.parse(token); } catch { continue; }
        if ( Array.isArray(args) === false || args.length === 0 ) { continue; }
        const details = redirectEngine.contentFromName(`${args[0]}.js`, 'text/javascript');
        if ( details === undefined ) { continue; }
        const world = details.world === 'ISOLATED' ? 'isolated' : 'main';
        const match = reScriptletFunction.exec(details.js);
        const fname = match !== null ? match[1] : undefined;
        if ( fname === undefined || typeof scriptletShards?.[world]?.fns?.[fname] !== 'string' ) {
            if ( unsupportedScriptlets.has(args[0]) === false ) {
                unsupportedScriptlets.add(args[0]);
                console.warn(
                    `uBO: +js(${args[0]}) is not a built-in scriptlet, and ` +
                    'only built-in scriptlets can be injected under MV3'
                );
            }
            continue;
        }
        const fargs = args.slice(1);
        worlds[world].push({
            call: [ fname, fargs ],
            priority: details.priority ?? 0,
            key: `${fname}(${JSON.stringify(fargs).slice(1, -1)})`,
        });
    }
    const sorted = entries => entries.sort((a, b) =>
        b.priority - a.priority || a.key.localeCompare(b.key)
    ).map(a => a.call);
    return {
        mainCalls: sorted(worlds.main),
        isolatedCalls: sorted(worlds.isolated),
    };
};

// uBOL-style argument interning (see
// platform/mv3/extension/js/offscreen/make-scriptlets.js): scriptlet
// arguments repeat heavily -- the same selector in two filters, the empty
// flags most scriptlets take -- and the calls travel several IPC hops
// (executeScript args, the MAIN-world launch record), so carry them as a
// deduped table plus index arrays instead. The two call sets share one
// table.
//
// Dedupe is by `JSON.stringify` identity. The arguments are JSON values
// straight out of `JSON.parse`, so identical serializations imply identical
// values (and `1` vs `"1"` serialize differently, so there is no type
// confusion). Structurally equal values with different key orders
// serialize differently and are merely kept twice -- a lost saving, never a
// wrong argument.
const internScriptletArgs = ( ) => {
    const args = [];
    const argIndex = new Map();
    const intern = arg => {
        const key = JSON.stringify(arg);
        let i = argIndex.get(key);
        if ( i === undefined ) {
            i = args.length;
            args.push(arg);
            argIndex.set(key, i);
        }
        return i;
    };
    const compact = calls =>
        calls.map(([ fname, arglist ]) => [ fname, arglist.map(intern) ]);
    return { args, compact };
};

// Upstream's second early bailout (`topFrameRulesMatcher` in
// `src/js/scriptlet-filtering.js`): the session firewall's first-party rules,
// snapshotted at registration time, matched against the top-level document's
// hostname and its parent domains, then `*`. The first rule found decides,
// and only an `allow` rule bails out. Rebuilt whenever upstream re-registers
// -- which it does on every `filteringBehaviorChanged`, firewall toggles
// included -- exactly as its serialized copy is.
let topFrameRules = { globals: undefined, rules: new Map() };

const topFrameRulesBailout = (globals, tabHostname) => {
    if ( topFrameRules.globals !== globals ) {
        topFrameRules = {
            globals,
            rules: new Map(sessionFirewall.export1stPartyRules().filter(a =>
                a[1] !== 'behind-the-scene'
            )),
        };
    }
    const { rules } = topFrameRules;
    if ( rules.size === 0 ) { return false; }
    let pos = 0;
    do {
        const value = rules.get(tabHostname.slice(pos));
        if ( typeof value === 'boolean' ) { return value; }
        pos = tabHostname.indexOf('.', pos) + 1;
    } while ( pos !== 0 );
    return rules.get('*') === true;
};

// `details` is a webNavigation frame: tabId, frameId, url, and documentId
// when the browser supplies one -- which binds the injection to the document
// that committed rather than to whatever occupies the frame by then.
const injectFrameScriptlets = details => {
    const { tabId, frameId } = details;
    if ( typeof tabId !== 'number' || tabId < 0 ) { return; }
    if ( typeof frameId !== 'number' ) { return; }
    if ( typeof details.url !== 'string' ) { return; }
    if ( reScriptletDocumentURL.test(details.url) === false ) { return; }
    // Nothing registered: the engine is being reset, or holds no scriptlet.
    const globals = mv3RegisteredScriptletGlobals();
    if ( globals === undefined ) { return; }
    // Upstream's first early bailout (`isTrustedContext`): the top-level
    // document is on a trusted site.
    const pageStore = µb.pageStoreFromTabId(tabId);
    if ( pageStore === null || pageStore.isTrusted() ) { return; }
    if ( topFrameRulesBailout(globals, pageStore.tabHostname) ) { return; }
    const url = details.url.startsWith('about:')
        ? pageStore.getEffectiveFrameURL({ frameId, frameURL: details.url })
        : details.url;
    if ( reNetworkDocumentURL.test(url) === false ) { return; }
    const hostname = hostnameFromURI(url);
    if ( hostname === '' ) { return; }
    const tokens = collectScriptletTokens({
        url,
        hostname,
        domain: domainFromHostname(hostname),
        ancestors: pageStore.getFrameAncestorDetails(frameId),
    });
    if ( tokens === undefined || tokens.length === 0 ) { return; }
    const { mainCalls, isolatedCalls } = scriptletCallsFromTokens(tokens);
    if ( mainCalls.length === 0 && isolatedCalls.length === 0 ) { return; }
    const { args, compact } = internScriptletArgs();
    return mv3InjectScriptlets({
        target: typeof details.documentId === 'string'
            ? { tabId, documentIds: [ details.documentId ] }
            : { tabId, frameIds: [ frameId ] },
        hostname,
        bcSecret: typeof globals.bcSecret === 'string' ? globals.bcSecret : '',
        globals,
        args,
        mainCalls: compact(mainCalls),
        isolatedCalls: compact(isolatedCalls),
    });
};

{
    const tabs = vAPI.tabs;
    const baseOnCommitted = tabs instanceof Object
        ? tabs.onCommittedHandler
        : undefined;
    if ( typeof baseOnCommitted !== 'function' ) {
        console.error(
            'uBO: vAPI.tabs.onCommittedHandler is not a function, so ' +
            'scriptlet filters cannot be injected. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        tabs.onCommittedHandler = function(details) {
            baseOnCommitted.call(this, details);
            try {
                injectFrameScriptlets(details);
            } catch (reason) {
                console.error(`uBO: scriptlet injection: ${reason}`);
            }
        };
    }
}

// Upstream also injects into every already-open tab, once per launch (`onceFn`
// in platform/chromium/vapi-scripting.js): that is what gives tabs open at
// install, update or re-enable their scriptlets. A service worker restart is
// not a launch -- the tabs it finds went through `onCommitted` already -- so
// the sweep is gated on a `storage.session` flag, which survives worker
// restarts and is cleared by browser restart and extension reload/update.
// Frames the page store has not seen are recorded first, so that ancestor
// and about: resolution work as they do for a live navigation.
{
    const SWEEP_KEY = 'uBOMv3ScriptletSweepDone';
    Promise.resolve(µb.isReadyPromise).then(async ( ) => {
        const bin = await chrome.storage.session.get(SWEEP_KEY).catch(( ) => null);
        if ( bin instanceof Object === false || bin[SWEEP_KEY] === true ) { return; }
        await chrome.storage.session.set({ [SWEEP_KEY]: true });
        const tabs = await vAPI.tabs.query({ url: '<all_urls>' });
        for ( const tab of tabs ) {
            if ( tab.discarded === true ) { continue; }
            if ( tab.status === 'unloaded' ) { continue; }
            const pageStore = µb.pageStoreFromTabId(tab.id);
            if ( pageStore === null ) { continue; }
            const frames = await chrome.webNavigation.getAllFrames({
                tabId: tab.id,
            }).catch(( ) => null);
            if ( Array.isArray(frames) === false ) { continue; }
            for ( const frame of frames ) {
                if ( pageStore.getFrameStore(frame.frameId) !== null ) { continue; }
                pageStore.setFrameURL(frame);
            }
            for ( const frame of frames ) {
                injectFrameScriptlets(Object.assign({ tabId: tab.id }, frame));
            }
        }
    }).catch(reason => {
        console.error(`uBO: scriptlet injection into open tabs: ${reason}`);
    });
}

/******************************************************************************/

// Make user-filter changes take effect in the filtering engines, not just in
// the persisted raw asset.
//
// The hole (live-reproduced): `µb.saveUserFilters()` writes the raw
// `user-filters` asset and removes its compiled entry, but leaves the
// in-memory engines exactly as they were -- upstream relies on the sender to
// follow up with a full reload (the dashboard's editor pane does exactly
// that: `writeUserFilters`, then `reloadAllFilters` -- see
// src/js/1p-filters.js, `applyChanges`). Any other writer -- the element
// picker's `appendUserFilters`, `restoreUserData`, a CDP-driven harness --
// gets no such follow-up, so filters REMOVED from the raw asset keep
// filtering from the stale engines. Worse, `selfieManager.destroy()` (which
// `appendUserFilters` and the `io.remove` of the compiled entry both
// trigger) schedules a selfie recreate a `selfieDelayInSeconds` later, which
// snapshots whatever is in memory at that moment: the stale engines get
// baked into a *fresh* selfie, and the removed scriptlet survives extension
// reloads and browser restarts. (Scriptlets themselves need nothing more:
// the per-frame injection above reads the engine's database live, and the
// rebuild recompiles upstream's registered program on `freeze()`.)
//
// MV2 parity: every piece of this is shared `src/` code, so the MV2 build
// has the identical hole through the identical call sequence (its dashboard
// works around it the same way). The fix is applied here, at the port level,
// rather than in `src/js/storage.js`: this fork's whole merge story is "no
// upstream file is modified", and the wrap below gives every
// `saveUserFilters` caller the dashboard's semantics without touching one.
// The upstreamable version is the same change in `saveUserFilters()`:
// rebuild the engines.
{
    const baseSaveUserFilters = µb.saveUserFilters;
    if ( typeof baseSaveUserFilters !== 'function' ) {
        console.error(
            'uBO: µb.saveUserFilters is not a function, so user-filter ' +
            'changes cannot be made to take effect in the engines. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        // Coalesce rapid successive saves into a single engine rebuild. Each
        // save bumps the generation; a rebuild records the generation it
        // covered and, on completion, runs exactly once more if newer saves
        // arrived while it was in flight. The pre-coalesce wrapper reloaded all
        // lists once per save -- N full reloads for N quick saves (a batch
        // import, or repeated dashboard saves); this does one. The staleness
        // fix is untouched: every save still drops the compiled user-filters
        // entry and rebuilds before the raw asset can be read stale.
        //
        // The rebuild awaits `io.remove()` directly rather than the base's own
        // `removeCompiledFilterList()`, which returns NOTHING (it fires
        // `io.remove()` without returning it) -- chaining off its result threw
        // a swallowed TypeError, so the reload never ran and stale engines (and
        // the selfie made from them) lived on. Awaiting the real promise also
        // closes the base's fire-and-forget race so the reload cannot read a
        // stale compiled entry back.
        let saveGeneration = 0;
        let rebuildSatisfied = 0;
        let rebuildInFlight = false;
        const rebuildEngines = ubo => {
            if ( rebuildInFlight ) { return; }
            const generation = saveGeneration;
            rebuildInFlight = true;
            io.remove(`compiled/${ubo.userFiltersPath}`)
                .catch(( ) => { })
                .then(( ) => ubo.loadFilterLists())
                .catch(( ) => { })
                .then(( ) => {
                    rebuildInFlight = false;
                    rebuildSatisfied = generation;
                    // A save that landed mid-rebuild bumped the generation past
                    // the one this rebuild covered -- run once more for it.
                    if ( saveGeneration !== rebuildSatisfied ) {
                        rebuildEngines(ubo);
                    }
                });
        };

        µb.saveUserFilters = function(...args) {
            const result = baseSaveUserFilters.apply(this, args);
            const ubo = this;
            Promise.resolve(result).then(( ) => {
                saveGeneration += 1;
                // Readiness gate: a save landing before `readyToFilter` (a
                // filter added during boot -- restoreUserData, an eager element
                // picker, a harness) must NOT be dropped. Defer the rebuild
                // onto `isReadyPromise` instead of skipping, or the filters
                // never reach the engines for the rest of the worker's life
                // (live-reproduced 2026-09-16) while the raw/compiled assets
                // both carry them, so the compiled cache makes it look fine.
                if ( ubo.readyToFilter === true ) { return rebuildEngines(ubo); }
                Promise.resolve(ubo.isReadyPromise).then(( ) => rebuildEngines(ubo));
            }).catch(( ) => { });
            return result;
        };
    }
}

/******************************************************************************/

// Verify that the cold-start filtering gap is closed by default.
//
// uBO keeps its compiled lists in memory, so until they are loaded it cannot
// decide anything. `src/js/traffic.js` handles that by suspending network
// activity, and `src/js/background.js` derives the `suspendUntilListsAreLoaded`
// user setting default from `vAPI.Net.canSuspend()`. `mv3-shims.js` makes that
// true, so upstream computes the default we want on its own -- but only if it
// evaluates after the shim's `vAPI.Net` setter has fired, which is an ordering
// no assertion in the build can prove holds at runtime. Check it here rather
// than let a reordering upstream silently reopen a window that now recurs on
// every service worker respawn.
//
// Repairing it is still worth doing when the check fails: this runs before
// `loadUserSettings()` reads storage -- `src/js/start.js` kicks off its boot as
// an async IIFE which hits its first `await` well before that -- so a value the
// user has actually chosen still wins.

{
    const settingName = 'suspendUntilListsAreLoaded';
    if ( Object.hasOwn(µb.userSettingsDefault, settingName) === false ) {
        console.error(
            `uBO: no "${settingName}" user setting; the MV3 cold-start window ` +
            `is no longer being closed. See platform/chromium-mv3/mv3-post.js.`
        );
    } else if ( µb.userSettingsDefault[settingName] !== true ) {
        console.error(
            `uBO: "${settingName}" did not default on, so vAPI.Net.canSuspend() ` +
            `was false when src/js/background.js evaluated. Check the vAPI.Net ` +
            `setter in platform/chromium-mv3/mv3-shims.js against the import ` +
            `order in src/js/start.js.`
        );
        µb.userSettingsDefault[settingName] = true;
        µb.userSettings[settingName] = true;
    }
}

/******************************************************************************/

// One-shot recovery from a failed boot -- uBOL's `goodStart` behavior
// (platform/mv3/extension/js/background.js, "Force a restart of the
// extension once when an internal error occurs"), adapted to this port.
//
// The failure class: uBO's boot is defensive -- every phase catches its own
// exceptions and the boot always resolves `µb.isReadyPromise` -- so a corrupt
// selfie, a broken storage backend, or anything else that leaves the engines
// empty produces a half-initialized extension that runs for the whole browser
// session: nothing blocked, nothing filtered, no recovery. uBOL's answer is
// to reload the extension exactly once and hope the second boot fares better
// (a broken storage read is often transient; a corrupt selfie is destroyed
// and recompiled on the next successful compile).
//
// The audit reads only signals that are verifiable after the boot settles:
// - `µb.readyToFilter` never became true (the boot did not reach
//   `src/js/start.js`'s final initialization steps, or died on the way);
// - a plain storage read still fails (`vAPI.storage.get` fulfills with
//   `null` only on failure -- see platform/common/vapi-background.js), i.e.
//   the storage backend which feeds the whole boot is broken;
// - the storage-persisted filter-list selection is non-empty yet the
//   net-filtering engine compiled nothing (`getFilterCount() === 0`), i.e.
//   the selfie load failed AND the fallback compile failed too.
//
// Loop-safety: the retry marker lives in `chrome.storage.local`, not in a
// session-scoped store -- the storage docs are explicit that Chrome clears
// the session one when the extension is *reloaded*, so a session-scoped
// flag could not survive the very `runtime.reload()` it is supposed to
// gate, and a persistently failing boot would reload forever. A local-storage
// flag survives the reload; it is written only after a failed audit and
// *before* the reload, and cleared only by a successful boot. A reload can
// therefore only ever be triggered by a boot which found the marker absent,
// and the marker can only be cleared by a boot which will not trigger one --
// if the retried boot also fails, the port stays half-up exactly as it does
// today, never loops. A stale marker from a previous browser session is
// cleared by the first successful boot, at worst suppressing one retry.
//
// Interaction with the session-state snapshots this module persists: the
// recovery reloads via `chrome.runtime.reload()` directly rather than
// through the restart wrapper patched further down in this module -- that
// wrapper's snapshot clearing exists for backup-restore/reset semantics,
// where the snapshots are stale by definition, while a boot retry wants
// every valid session state preserved. In practice `runtime.reload()` wipes
// the session-scoped store wholesale anyway (Chrome semantics), so the
// page-store and session-rule snapshots do not survive a retry; losing
// per-tab session bookkeeping once, to recover a working filter engine, is
// the right trade. The offscreen keepalive document and the early-event
// buffers are in-memory and are simply re-created by the reloaded service
// worker.
{
    const RETRY_MARKER = 'mv3BootRetryPending';
    // Generous: a healthy boot resolves in seconds even when it must compile
    // every list from scratch; this only backstops a boot that died so hard
    // the promise never settles.
    const BOOT_TIMEOUT_MS = 60000;

    const auditBoot = async ( ) => {
        if ( µb.readyToFilter !== true ) {
            return 'boot did not reach readyToFilter';
        }
        const bin = await vAPI.storage.get('selectedFilterLists');
        if ( bin === null ) {
            return 'storage read failed';
        }
        if (
            Array.isArray(bin.selectedFilterLists) &&
            bin.selectedFilterLists.length !== 0 &&
            staticNetFilteringEngine.getFilterCount() === 0
        ) {
            return 'no compiled net-filtering data despite a non-empty filter-list selection';
        }
        return null;
    };

    const onBootSettled = async ( ) => {
        const failure = await auditBoot();
        if ( failure === null ) {
            // Re-arm recovery for the next failure; also drops a stale
            // marker left behind by a previous browser session.
            chrome.storage.local.remove(RETRY_MARKER).catch(( ) => {});
            return;
        }
        console.error(`uBO: boot failed (${failure})`);
        // If the marker read itself fails, the once-guarantee cannot be
        // established -- stay half-up rather than risk a reload loop.
        const bin = await vAPI.storage.get(RETRY_MARKER);
        if ( bin === null || bin[RETRY_MARKER] === true ) {
            console.error(
                'uBO: not reloading to recover: the one boot-retry of this ' +
                'extension has already been used (or its state cannot be ' +
                'read). See platform/chromium-mv3/mv3-post.js.'
            );
            return;
        }
        // The write must succeed before the reload: the marker is the only
        // thing standing between a persistently failing boot and an
        // infinite reload loop. vAPI.storage.set swallows failures, so use
        // the raw API, which rejects.
        try {
            await chrome.storage.local.set({ [RETRY_MARKER]: true });
        } catch (reason) {
            console.error(`uBO: cannot persist the boot-retry marker: ${reason}`);
            return;
        }
        console.error('uBO: reloading the extension once to retry the boot');
        chrome.runtime.reload();
    };

    // Plain setTimeout: if the service worker is torn down before it fires,
    // the worker restarts and boots afresh anyway.
    Promise.race([
        µb.isReadyPromise,
        new Promise(resolve => { setTimeout(resolve, BOOT_TIMEOUT_MS); }),
    ]).then(onBootSettled).catch(reason => {
        // onBootSettled/auditBoot are async and can reject on a corrupt
        // engine (a throwing getFilterCount(), a rejecting storage read).
        // Without this the rejection is unhandled and the recovery silently
        // never runs; log it so a broken boot is at least visible.
        console.error(`uBO: boot-recovery audit failed: ${reason}`);
    });
}

/******************************************************************************/

// Cold-wake events. `mv3-shims.js` buffers the first context-menu click and
// the first update-available notification of a service worker lifetime,
// because uBO attaches the real listeners only at the end of its async boot
// sequence -- too late for the event which did the waking. Wire the buffers
// to the real handlers here.

// The context menu's click handler attaches through
// `vAPI.contextMenu.setEntries`, called by `contextMenu.update()` at the end
// of the boot sequence (and again whenever the menu must change). Once a
// real handler is registered, replay the buffered click to it and stand the
// buffer down: from then on Chrome dispatches straight to the real handler,
// and the shim's listener would only double-deliver.
{
    const setEntries = vAPI.contextMenu?.setEntries;
    if ( typeof setEntries !== 'function' ) {
        console.error(
            'uBO: vAPI.contextMenu.setEntries is not a function, so a ' +
            'context-menu click which wakes the service worker cannot be ' +
            'replayed. See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        vAPI.contextMenu.setEntries = function(entries, callback) {
            const out = setEntries.call(this, entries, callback);
            if (
                typeof callback === 'function' &&
                (entries || []).length !== 0
            ) {
                mv3EarlyEvents.replayContextMenuClick(callback);
            }
            return out;
        };
    }
}

// The real update listener is registered by start.js immediately before
// isReadyResolve() -- within the same synchronous run of the boot sequence
// -- so replaying the buffered event once ready is equivalent to having had
// the listener all along. Same logic as the listener start.js registers.
µb.isReadyPromise.then(( ) => {
    const details = mv3EarlyEvents.consumeUpdateAvailable();
    if ( details === null || details instanceof Object === false ) { return; }
    const toInt = vAPI.app.intFromVersion;
    if (
        µb.hiddenSettings.extensionUpdateForceReload === true ||
        toInt(details.version) <= toInt(vAPI.app.version)
    ) {
        vAPI.app.restart();
    }
});

/******************************************************************************/

// `vAPI.cloud`'s default device name is `window.navigator.platform`, which a
// service worker does not have (WorkerNavigator drops it), so cloud pushes
// would carry `source: undefined` and the cloud settings pane an empty
// placeholder. The options object is closure-private inside
// `vapi-background.js`, but `getOptions()` hands out the live object -- patch
// it in place rather than shadow it.
if ( vAPI.cloud instanceof Object && typeof vAPI.cloud.getOptions === 'function' ) {
    vAPI.cloud.getOptions(options => {
        if (
            typeof options.defaultDeviceName === 'string' &&
            options.defaultDeviceName !== ''
        ) {
            return;
        }
        const ua = self.navigator.userAgent;
        options.defaultDeviceName = self.navigator.userAgentData?.platform ||
            ( /Windows/.test(ua) ? 'Windows' :
              /Macintosh/.test(ua) ? 'macOS' :
              /Linux/.test(ua) ? 'Linux' : 'Chrome' );
    });
}

/******************************************************************************/

// State that MV2 kept in the never-ending background page and MV3 loses with
// every service worker death. Three classes of it:
//
// - session dynamic rules (the un-pinned popup/firewall/switch toggles):
//   `onFirstFetchReady()` in start.js re-seeds them from the permanent rules
//   at every service worker start, so a death silently reverted whatever the
//   user had toggled.
// - per-tab page stores: toolbar badges and popup counts reverted to zero.
// - strict-block bypasses ("proceed anyway"), which live in a Map inside
//   src/js/traffic.js with nothing to survive a death.
//
// All three are persisted to `storage.session` on mutation.
// `storage.session` lives in the browser process: it survives any number of
// service worker deaths and is cleared when the browsing session (or the
// extension) ends -- the same lifetime this state had under MV2.
//
// The restore is driven from `webRequest.start()`, which start.js calls after
// `initializeTabs()` has rebuilt the page stores and after
// `onFirstFetchReady()` has re-seeded the session rules, and before
// `µb.isReadyResolve()`. The `storage.session` reads are asynchronous, so the
// restore can complete just after `start()` un-parks the first requests and
// just after `µb.isReadyResolve()`: a request un-parked in that first tick may
// be evaluated before its restored strict-block bypass is back, and a popup
// opened in that window may briefly read pre-restore counts. Both self-heal on
// the next navigation / journal flush. The flush-snapshot and unbind paths are
// separately gated on `bootState.restored` so they cannot clobber or orphan the
// restored page-store directory during that window.

const SESSION_RULES_KEY = 'uBOMv3SessionRules';
const STRICT_BYPASS_KEY = 'uBOMv3StrictBypass';
const PS_DIR_KEY = 'uBOMv3PSDir';
const PS_KEY_PREFIX = 'uBOMv3PS:';

// Per-tab hostname details feed the popup's per-site breakdown; heavy pages
// can accumulate hundreds, so cap what is persisted per tab (the totals are
// kept exactly). And bound how many tabs hold snapshots at all, so a long
// session of tab churn cannot grow storage without limit.
const MAX_HOSTNAMES_PER_TAB = 100;
const MAX_SNAPSHOTTED_TABS = 500;

// How many consecutive flush write-failures to retry before abandoning the
// episode (self-heals on the next successful write). Bounds a persistently
// broken storage.session from respinning the flush timer forever.
const MAX_FLUSH_RETRIES = 5;

// `chrome.storage.session` has a hard quota (10 MB as of Chrome 138) and
// writes past it fail *silently* -- at 500 tabs x 100 hostnames the
// snapshots alone could reach ~7.5 MB. Budget total session usage at 4 MB
// and degrade past it: hostname rows first (they are the bulk of every
// entry and feed only the popup's per-site breakdown), then whole entries,
// oldest-dirtied first, then stored snapshots of tabs not being rewritten
// this flush. Never throws; logged once per degradation episode.
const SESSION_BUDGET_BYTES = 4 * 1024 * 1024;

const bootState = {
    fetched: undefined,   // Promise
    bin: undefined,       // what storage.session held at service worker start
    applied: false,       // restore has been driven (webRequest.start wrap)
    enforcementReady: undefined, // Promise: session rules + strict bypasses restored
    restored: false,      // page-store directory has been read back (see applyBootState)
    sessionRulesActive: false, // persist-on-mutation armed
};

// Enforcement state must be restored before parked requests are released, but
// a wedged storage.session read must never park traffic forever: bound the
// wait, then release with whatever restored in time. Generous enough that the
// timeout effectively never fires in practice.
const ENFORCEMENT_RESTORE_TIMEOUT_MS = 5000;

const fetchBootState = ( ) => {
    if ( bootState.fetched !== undefined ) { return bootState.fetched; }
    bootState.fetched = vAPI.sessionStorage.get([
        SESSION_RULES_KEY,
        STRICT_BYPASS_KEY,
        PS_DIR_KEY,
    ]).then(bin => {
        // Whatever storage.session held at the moment this service worker
        // started; mutations this lifetime makes cannot reach it, so the
        // restore can never read back its own writes.
        bootState.bin = bin instanceof Object ? bin : {};
    }).catch(( ) => {
        bootState.bin = {};
    });
    return bootState.fetched;
};
fetchBootState();

/*** Session dynamic rules ********************************************/

let sessionRulesTimer = 0;

const persistSessionRulesSoon = ( ) => {
    if ( bootState.sessionRulesActive !== true ) { return; }
    if ( sessionRulesTimer !== 0 ) { return; }
    sessionRulesTimer = setTimeout(( ) => {
        sessionRulesTimer = 0;
        vAPI.sessionStorage.set({
            [SESSION_RULES_KEY]: {
                // The serialization these classes already use for backup
                // and restore.
                firewall: sessionFirewall.toString(),
                switches: sessionSwitches.toString(),
                urlFiltering: sessionURLFiltering.toString(),
            },
        }).catch(( ) => { });
    }, 500);
};

{
    // Own properties shadowing the prototype methods, so only the session
    // rule sets are intercepted -- the permanent ones share the classes.
    // Every public mutator is wrapped: the popup and dashboard paths go
    // through these and nothing else.
    const wrapMutators = (ruleset, names) => {
        for ( const name of names ) {
            const fn = ruleset[name];
            if ( typeof fn !== 'function' ) {
                console.error(
                    `uBO: session rule set is missing mutator "${name}"; ` +
                    `changes through it would not survive a service worker ` +
                    `restart. See platform/chromium-mv3/mv3-post.js.`
                );
                continue;
            }
            ruleset[name] = function(...args) {
                const out = fn.apply(this, args);
                persistSessionRulesSoon();
                return out;
            };
        }
    };
    wrapMutators(sessionFirewall, [
        'setCell', 'unsetCell', 'assign', 'copyRules', 'fromString',
        'fromSelfie', 'reset',
    ]);
    wrapMutators(sessionSwitches, [
        'toggle', 'toggleOneZ', 'toggleBranchZ', 'toggleZ', 'assign',
        'copyRules', 'fromString', 'reset',
    ]);
    wrapMutators(sessionURLFiltering, [
        'setRule', 'removeRule', 'assign', 'copyRules', 'fromString', 'reset',
    ]);
}

const applySessionRules = ( ) => {
    // Arm persistence only now: the boot seeding (onFirstFetchReady in
    // start.js) must not overwrite the snapshot before it is restored.
    bootState.sessionRulesActive = true;
    const snapshot = bootState.bin[SESSION_RULES_KEY];
    if ( snapshot instanceof Object === false ) { return; }
    try {
        if ( typeof snapshot.firewall === 'string' ) {
            sessionFirewall.fromString(snapshot.firewall);
        }
        if ( typeof snapshot.switches === 'string' ) {
            sessionSwitches.fromString(snapshot.switches);
        }
        if ( typeof snapshot.urlFiltering === 'string' ) {
            sessionURLFiltering.fromString(snapshot.urlFiltering);
        }
    } catch (reason) {
        console.error(`uBO: could not restore session dynamic rules: ${reason}`);
    }
};

/*** Strict-block bypasses ********************************************/

let strictBypassTimer = 0;

const persistStrictBypasses = ( ) => {
    strictBypassTimer = 0;
    const map = webRequest.strictBlockBypassMap;
    if ( map instanceof Map === false ) { return; }
    const now = Date.now();
    const entries = [];
    for ( const [ hostname, deadline ] of map ) {
        if ( deadline <= now ) { continue; }
        entries.push([ hostname, deadline ]);
        if ( entries.length === 256 ) { break; }
    }
    vAPI.sessionStorage.set({ [STRICT_BYPASS_KEY]: entries }).catch(( ) => { });
};

const persistStrictBypassesSoon = ( ) => {
    if ( strictBypassTimer !== 0 ) { return; }
    strictBypassTimer = setTimeout(persistStrictBypasses, 2000);
};

{
    const bypass = webRequest.strictBlockBypass;
    if ( typeof bypass !== 'function' ) {
        console.error(
            'uBO: webRequest.strictBlockBypass is not a function, so ' +
            '"proceed anyway" strict-block bypasses cannot be intercepted. ' +
            'See platform/chromium-mv3/mv3-post.js.'
        );
    } else if ( webRequest.strictBlockBypassMap instanceof Map === false ) {
        console.error(
            'uBO: webRequest.strictBlockBypassMap is not exposed, so ' +
            'strict-block bypasses cannot be persisted across service ' +
            'worker restarts. Check the traffic.js transform in ' +
            'tools/patch-mv3-modules.mjs.'
        );
    } else {
        webRequest.strictBlockBypass = function(...args) {
            const out = bypass.apply(this, args);
            persistStrictBypassesSoon();
            return out;
        };
    }
}

const applyStrictBlockBypasses = ( ) => {
    const map = webRequest.strictBlockBypassMap;
    const entries = bootState.bin[STRICT_BYPASS_KEY];
    if ( map instanceof Map === false || Array.isArray(entries) === false ) {
        return;
    }
    const now = Date.now();
    for ( const entry of entries ) {
        if ( Array.isArray(entry) === false || entry.length !== 2 ) { continue; }
        const [ hostname, deadline ] = entry;
        if ( typeof hostname !== 'string' || hostname === '' ) { continue; }
        if ( typeof deadline !== 'number' || deadline <= now ) { continue; }
        map.set(hostname, deadline);
    }
};

/*** Per-tab page stores **********************************************/

const pageStores = {
    dirty: new Set(),
    dirtyAt: new Map(),  // tabId -> when it became dirty (eviction order)
    dir: [],             // tab ids with snapshots, as persisted
    dirDirty: false,
    timer: 0,
    flushing: false,     // a flush is awaiting its writes (serialize the next)
    flushFailures: 0,    // consecutive write-failure count (bounded retries)
    keyBytes: new Map(), // PS key -> estimated bytes of the last value written
    budgetWarned: false, // one log per degradation episode
};

const markTabDirty = tabId => {
    if ( pageStores.dirty.has(tabId) === false ) {
        pageStores.dirtyAt.set(tabId, Date.now());
    }
    pageStores.dirty.add(tabId);
    if ( pageStores.timer !== 0 ) { return; }
    pageStores.timer = setTimeout(flushPageStoreSnapshots, 1000);
};

const snapshotPageStore = pageStore => {
    const { allowed, blocked } = pageStore.counts;
    const entry = {
        // The restore is skipped for a tab whose URL changed while the
        // service worker was dead: those counts belong to the old page.
        rawURL: pageStore.rawURL,
        counts: [
            allowed.any, allowed.frame, allowed.script,
            blocked.any, blocked.frame, blocked.script,
        ],
        popupBlockedCount: pageStore.popupBlockedCount || 0,
        largeMediaCount: pageStore.largeMediaCount || 0,
        remoteFontCount: pageStore.remoteFontCount || 0,
        contentLastModified: pageStore.contentLastModified || 0,
        hosts: [],
    };
    if ( typeof pageStore.allowLargeMediaElementsUntil === 'number' ) {
        entry.allowLargeMediaElementsUntil =
            pageStore.allowLargeMediaElementsUntil;
    }
    if ( pageStore.allowLargeMediaElementsRegex instanceof RegExp ) {
        // storage.session serializes a RegExp to `{}` (structured clone drops
        // it; JSON would give "{}" too) -- either way the `instanceof RegExp`
        // check on restore never matches and the exemption is silently lost.
        // Persist the parts and rebuild the RegExp on restore.
        entry.allowLargeMediaElementsRegex = {
            source: pageStore.allowLargeMediaElementsRegex.source,
            flags: pageStore.allowLargeMediaElementsRegex.flags,
        };
    }
    let n = 0;
    for ( const details of pageStore.hostnameDetailsMap.values() ) {
        if ( n === MAX_HOSTNAMES_PER_TAB ) { break; }
        const c = details.counts;
        entry.hosts.push([
            details.hostname,
            details.cname || '',
            c.allowed.any, c.allowed.frame, c.allowed.script,
            c.blocked.any, c.blocked.frame, c.blocked.script,
        ]);
        n += 1;
    }
    // Nothing a fresh page store would not have anyway -- do not spend
    // storage on it. A pending media-elements exemption (set just above) is
    // NOT such a default, so preserve the entry when one is present even if
    // every counter is still zero.
    if (
        entry.counts.every(v => v === 0) &&
        entry.hosts.length === 0 &&
        entry.popupBlockedCount === 0 &&
        entry.largeMediaCount === 0 &&
        entry.remoteFontCount === 0 &&
        entry.allowLargeMediaElementsUntil === undefined &&
        entry.allowLargeMediaElementsRegex === undefined
    ) {
        return undefined;
    }
    return entry;
};

const flushPageStoreSnapshots = async ( ) => {
    // Until the persisted directory has actually been read back into
    // pageStores.dir -- which happens asynchronously, only once
    // applyPageStores() resolves, not merely when the restore is driven --
    // flushing could overwrite the directory of snapshots the restore is
    // about to read.
    if ( bootState.restored !== true ) {
        pageStores.timer = setTimeout(flushPageStoreSnapshots, 1000);
        return;
    }
    // This function now awaits its storage writes, so a flush can be in flight
    // when the next one is triggered. Serialize them: the second reschedules
    // rather than mutating `dir`/`dirty` concurrently with the first.
    if ( pageStores.flushing ) {
        pageStores.timer = setTimeout(flushPageStoreSnapshots, 1000);
        return;
    }
    pageStores.flushing = true;
    pageStores.timer = 0;
    const dirty = pageStores.dirty;
    if ( dirty.size === 0 ) { pageStores.flushing = false; return; }
    // Candidates in oldest-dirtied-first order -- the byte budget below
    // drops entries in this order when it must, on the grounds that the
    // least recently dirtied tab matters least, and a live tab re-dirties
    // (and so re-snapshots) on its next count change anyway.
    const candidates = [ ...dirty ].sort((a, b) =>
        (pageStores.dirtyAt.get(a) || 0) - (pageStores.dirtyAt.get(b) || 0)
    );
    dirty.clear();
    pageStores.dirtyAt.clear();
    const bin = { };
    const toRemove = [];
    const dir = pageStores.dir;
    const entries = new Map(); // PS key -> tabId, for the budget ladder
    // This synchronous section runs BEFORE the persist try/finally below, which
    // is what normally clears `flushing`. A throw here (e.g. snapshotPageStore)
    // would otherwise leave `flushing` stuck true and wedge every future flush
    // for the worker's lifetime. Guard it: reset the flag and bail. The tabs
    // this flush would have covered were already cleared from `dirty` above, so
    // one flush's counters are lost -- exactly the pre-serialization behavior --
    // but the next markTabDirty reschedules and recovers.
    try {
        for ( const tabId of candidates ) {
            const pageStore = µb.pageStores.get(tabId);
            const entry = pageStore === undefined
                ? undefined
                : snapshotPageStore(pageStore);
            // The cap bounds how many DISTINCT tabs hold snapshots; it must not
            // block an update to a tab already in the directory, or a full
            // directory would drop live tabs' fresh counts (reproduced: updating
            // tab 1 at 500 entries deleted its snapshot).
            const isKnown = dir.includes(tabId);
            if ( entry !== undefined && (isKnown || dir.length < MAX_SNAPSHOTTED_TABS) ) {
                bin[PS_KEY_PREFIX + tabId] = entry;
                entries.set(PS_KEY_PREFIX + tabId, tabId);
                if ( isKnown === false ) {
                    dir.push(tabId);
                    pageStores.dirDirty = true;
                }
                continue;
            }
            toRemove.push(PS_KEY_PREFIX + tabId);
            const pos = dir.indexOf(tabId);
            if ( pos !== -1 ) {
                dir.splice(pos, 1);
                pageStores.dirDirty = true;
            }
        }
    } catch (reason) {
        pageStores.flushing = false;
        console.error(`uBO: page-store snapshot build failed: ${reason}`);
        return;
    }
    // The byte budget. Best-effort by design: `getBytesInUse()` reports the
    // whole store, and per-key sizes are only known for what this service
    // worker lifetime itself wrote, so the projection deliberately
    // over-counts (a rewritten key is charged its new size without credit
    // for the old value's unknown size). A degraded flush therefore
    // converges over the following flushes rather than ever over-writing.
    // Every step is non-throwing; a failure anywhere leaves the flush
    // writing exactly what it had collected.
    let degraded = false;
    try {
        let bytesInUse = -1;
        if ( typeof vAPI.sessionStorage.getBytesInUse === 'function' ) {
            bytesInUse = await vAPI.sessionStorage.getBytesInUse();
        }
        if ( typeof bytesInUse === 'number' && bytesInUse >= 0 ) {
            const estimateOf = (key, entry) =>
                key.length + JSON.stringify(entry).length;
            const projected = ( ) => {
                let total = bytesInUse;
                for ( const [ key, entry ] of Object.entries(bin) ) {
                    total += estimateOf(key, entry) -
                        (pageStores.keyBytes.get(key) || 0);
                }
                for ( const key of toRemove ) {
                    total -= pageStores.keyBytes.get(key) || 0;
                }
                return total;
            };
            const evictEntry = key => {
                delete bin[key];
                toRemove.push(key);
                const tabId = entries.get(key);
                entries.delete(key);
                const pos = dir.indexOf(tabId);
                if ( pos !== -1 ) {
                    dir.splice(pos, 1);
                    pageStores.dirDirty = true;
                }
            };
            if ( projected() > SESSION_BUDGET_BYTES ) {
                degraded = true;
                // Level 1: hostname rows are the bulk and feed only the
                // popup's per-site breakdown -- drop them everywhere first.
                for ( const entry of Object.values(bin) ) {
                    entry.hosts = [ ];
                }
            }
            if ( degraded && projected() > SESSION_BUDGET_BYTES ) {
                // Level 2: drop whole entries, oldest-dirtied first --
                // `bin`'s insertion order is the candidates order above.
                for ( const key of Object.keys(bin) ) {
                    if ( projected() <= SESSION_BUDGET_BYTES ) { break; }
                    evictEntry(key);
                }
            }
            if ( projected() > SESSION_BUDGET_BYTES ) {
                // Level 3: evict stored snapshots of tabs not being
                // rewritten this flush, oldest-snapshotted first (the front
                // of the persisted directory). Their exact sizes are
                // unknown, so evict a bounded batch per flush and let the
                // next flush's `getBytesInUse` reading verify the result.
                degraded = true;
                let evictions = Math.max(1, Math.ceil(dir.length / 4));
                for ( let i = 0; i < dir.length && evictions > 0; i++ ) {
                    const key = PS_KEY_PREFIX + dir[i];
                    if ( bin[key] !== undefined || toRemove.includes(key) ) {
                        continue;
                    }
                    dir.splice(i, 1);
                    pageStores.dirDirty = true;
                    toRemove.push(key);
                    i -= 1;
                    evictions -= 1;
                }
            }
        }
    } catch (reason) {
        console.error(`uBO: page-store snapshot byte budget check failed: ${reason}`);
    }
    if ( degraded && pageStores.budgetWarned === false ) {
        pageStores.budgetWarned = true;
        console.error(
            `uBO: page-store snapshots exceeded the ${SESSION_BUDGET_BYTES}-byte ` +
            `session-storage budget and were degraded -- hostname rows were ` +
            `dropped and the oldest-dirtiest entries evicted. Badges and ` +
            `popup counts remain exact; only the per-site breakdown loses ` +
            `detail. See platform/chromium-mv3/mv3-post.js.`
        );
    } else if ( degraded === false && pageStores.budgetWarned ) {
        pageStores.budgetWarned = false;
    }
    // Persist. Await each write so a rejection is observed rather than
    // dropped, and requeue the affected tabs on failure (bounded) so a
    // transient storage.session error is retried on the next flush instead of
    // silently losing a snapshot. The directory write in particular must land,
    // or the next boot reads a directory out of sync with the per-tab keys.
    // keyBytes is updated only after a write actually succeeds, so the byte
    // budget never credits bytes that were never stored.
    try {
        if ( Object.keys(bin).length !== 0 ) {
            await vAPI.sessionStorage.set(bin);
            for ( const [ key, entry ] of Object.entries(bin) ) {
                pageStores.keyBytes.set(key, key.length + JSON.stringify(entry).length);
            }
        }
        if ( toRemove.length !== 0 ) {
            await vAPI.sessionStorage.remove(toRemove);
            for ( const key of toRemove ) {
                pageStores.keyBytes.delete(key);
            }
        }
        if ( pageStores.dirDirty ) {
            await vAPI.sessionStorage.set({ [PS_DIR_KEY]: dir });
            pageStores.dirDirty = false;
        }
        pageStores.flushFailures = 0;
    } catch (reason) {
        pageStores.flushFailures = (pageStores.flushFailures || 0) + 1;
        if ( pageStores.flushFailures <= MAX_FLUSH_RETRIES ) {
            // Re-dirty the tabs this flush tried to snapshot so the next flush
            // retries them; `dirDirty` stays set (never cleared above on this
            // path) if the directory write did not land.
            for ( const tabId of entries.values() ) {
                if ( pageStores.dirty.has(tabId) ) { continue; }
                pageStores.dirty.add(tabId);
                pageStores.dirtyAt.set(tabId, Date.now());
            }
            if ( pageStores.timer === 0 ) {
                pageStores.timer = setTimeout(flushPageStoreSnapshots, 1000);
            }
        } else {
            console.error(
                `uBO: page-store snapshot flush failed ${pageStores.flushFailures} ` +
                `times; abandoning this episode until a write succeeds. See ` +
                `platform/chromium-mv3/mv3-post.js. ${reason}`
            );
        }
    } finally {
        pageStores.flushing = false;
    }
};

const restorePageStore = (pageStore, entry) => {
    if ( entry.rawURL !== pageStore.rawURL ) { return false; }
    if (
        Array.isArray(entry.counts) === false ||
        entry.counts.length !== 6 ||
        entry.counts.some(v => typeof v !== 'number')
    ) {
        return false;
    }
    const [ aA, aF, aS, bA, bF, bS ] = entry.counts;
    const { allowed, blocked } = pageStore.counts;
    allowed.any = aA; allowed.frame = aF; allowed.script = aS;
    blocked.any = bA; blocked.frame = bF; blocked.script = bS;
    pageStore.popupBlockedCount = entry.popupBlockedCount;
    pageStore.largeMediaCount = entry.largeMediaCount;
    pageStore.remoteFontCount = entry.remoteFontCount;
    pageStore.contentLastModified = entry.contentLastModified;
    if ( typeof entry.allowLargeMediaElementsUntil === 'number' ) {
        pageStore.allowLargeMediaElementsUntil =
            entry.allowLargeMediaElementsUntil;
    }
    // Rebuilt from the { source, flags } persisted by snapshotPageStore -- a
    // RegExp does not survive storage.session as itself.
    const reSpec = entry.allowLargeMediaElementsRegex;
    if ( reSpec instanceof Object && typeof reSpec.source === 'string' ) {
        try {
            pageStore.allowLargeMediaElementsRegex = new RegExp(
                reSpec.source,
                typeof reSpec.flags === 'string' ? reSpec.flags : ''
            );
        } catch (reason) {
            console.error(`uBO: could not restore allowLargeMediaElementsRegex: ${reason}`);
        }
    }
    const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
    // The live engine's journalProcess() calls `hnDetails.counts.inc(...)` on
    // whatever sits in this map (src/js/pagestore.js), so `counts` must be a
    // real CountDetails, not a plain object -- otherwise the first request to
    // a restored active tab throws an uncaught TypeError, recurring on every
    // request thereafter. CountDetails is not exported, but every page store
    // owns one (`pageStore.counts`), so obtain the exact same class from it.
    const CountDetails = pageStore.counts.constructor;
    for ( const host of hosts ) {
        if ( Array.isArray(host) === false || host.length !== 8 ) { continue; }
        const [ hostname, cname, haA, haF, haS, hbA, hbF, hbS ] = host;
        if ( typeof hostname !== 'string' || hostname === '' ) { continue; }
        // Mirror the top-level counts guard above: never seed a CountDetails
        // with non-numbers, or `.inc()` would accumulate onto NaN forever.
        if ( [ haA, haF, haS, hbA, hbF, hbS ].some(v => typeof v !== 'number') ) {
            continue;
        }
        const counts = new CountDetails();
        counts.allowed.any = haA;
        counts.allowed.frame = haF;
        counts.allowed.script = haS;
        counts.blocked.any = hbA;
        counts.blocked.frame = hbF;
        counts.blocked.script = hbS;
        pageStore.hostnameDetailsMap.set(hostname, {
            hostname,
            cname: cname || undefined,
            counts,
            // pagestore.js recycles entries through dispose(); a no-op only
            // skips the recycling.
            dispose() {},
        });
    }
    return true;
};

// `µb.updateToolbarIcon()` is called on every meaningful per-tab mutation
// (request counts, popup blocks, badge refreshes), which is exactly the
// signal a snapshot needs; the write itself is debounced.
{
    const updateToolbarIcon = µb.updateToolbarIcon;
    if ( typeof updateToolbarIcon !== 'function' ) {
        console.error(
            'uBO: µb.updateToolbarIcon is not a function, so per-tab ' +
            'counters would not be persisted. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        µb.updateToolbarIcon = function(tabId, newParts) {
            if ( typeof tabId === 'number' && tabId > 0 ) {
                markTabDirty(tabId);
            }
            return updateToolbarIcon.call(this, tabId, newParts);
        };
    }
}

// A closed tab's snapshot is evicted outright -- storage.session lives
// until the browsing session ends, so without this it would only ever grow.
{
    const unbind = µb.unbindTabFromPageStore;
    if ( typeof unbind !== 'function' ) {
        console.error(
            'uBO: µb.unbindTabFromPageStore is not a function, so ' +
            'page-store snapshots for closed tabs are not evicted. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        µb.unbindTabFromPageStore = function(tabId) {
            const out = unbind.call(this, tabId);
            pageStores.dirty.delete(tabId);
            // Until the persisted directory has been read back into
            // pageStores.dir it is not yet authoritative -- leave it alone
            // rather than splice/persist a directory the restore has not
            // loaded.
            if ( bootState.restored !== true ) { return out; }
            const pos = pageStores.dir.indexOf(tabId);
            if ( pos === -1 ) { return out; }
            pageStores.dir.splice(pos, 1);
            pageStores.keyBytes.delete(PS_KEY_PREFIX + tabId);
            vAPI.sessionStorage.remove([ PS_KEY_PREFIX + tabId ]).catch(( ) => { });
            vAPI.sessionStorage.set({ [PS_DIR_KEY]: pageStores.dir }).catch(( ) => { });
            return out;
        };
    }
}

const applyPageStores = ( ) => {
    const dir = bootState.bin[PS_DIR_KEY];
    if ( Array.isArray(dir) === false || dir.length === 0 ) {
        pageStores.dir = [];
        return Promise.resolve();
    }
    pageStores.dir = dir.filter(tabId => typeof tabId === 'number');
    const keys = pageStores.dir.map(tabId => PS_KEY_PREFIX + tabId);
    return vAPI.sessionStorage.get(keys).then(bin => {
        for ( const [ tabId, pageStore ] of µb.pageStores ) {
            const entry = bin?.[PS_KEY_PREFIX + tabId];
            if ( entry instanceof Object === false ) { continue; }
            if ( restorePageStore(pageStore, entry) !== true ) { continue; }
            // Draw the restored badge. This re-marks the tab dirty, which
            // merely re-persists what was just restored.
            µb.updateToolbarIcon(tabId, 0b111);
        }
    }).catch(( ) => { });
};

/*** The restore itself ***********************************************/

const applyBootState = ( ) => {
    if ( bootState.applied ) { return bootState.enforcementReady; }
    bootState.applied = true;
    // Enforcement state -- session dynamic rules and strict-block bypasses --
    // gates request release: a queued decision must not fall back to startup
    // permanent rules. Resolve as soon as it is restored, but never later than
    // the timeout, so a wedged storage read cannot hold traffic indefinitely.
    const enforcement = fetchBootState().then(( ) => {
        if ( bootState.bin === undefined ) { return; }
        applySessionRules();
        applyStrictBlockBypasses();
    }).catch(( ) => { });
    const timeout = new Promise(resolve => {
        setTimeout(resolve, ENFORCEMENT_RESTORE_TIMEOUT_MS);
    });
    bootState.enforcementReady = Promise.race([ enforcement, timeout ]);
    // Page stores are display-only counters, not enforcement -- restore them
    // off the release path so they never delay traffic. `restored` flips only
    // once the persisted directory has actually been read into pageStores.dir,
    // which the flush and unbind paths gate on. Wait on the real fetch (not the
    // enforcement race, which may have resolved via timeout) before reading it.
    enforcement.then(fetchBootState).then(( ) => {
        if ( bootState.bin === undefined ) { return; }
        return applyPageStores();
    }).then(( ) => {
        bootState.restored = true;
    }).catch(( ) => {
        // Each restore step swallows its own failures, so this chain settles
        // in practice; guard the pathological reject so flushPageStoreSnapshots
        // does not respin forever with the gate shut.
        bootState.restored = true;
    });
    return bootState.enforcementReady;
};

{
    const start = webRequest.start;
    if ( typeof start !== 'function' ) {
        console.error(
            'uBO: webRequest.start is not a function, so MV3 session state ' +
            'cannot be restored. See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        webRequest.start = function(...args) {
            // The request-parking listener is installed synchronously by
            // `new vAPI.Net()` at module eval, so no startup request is missed
            // while this waits. The original start() both installs the real
            // suspendable listener AND unsuspends -- releasing parked requests
            // through it -- so defer the whole call behind enforcement restore.
            // start.js is an upstream file the port must not edit, so the
            // gating lives entirely here: chaining start() off the enforcement
            // promise means the unsuspend cannot run before the session rules
            // and strict-block bypasses are back, whether or not the caller
            // awaits the returned promise. Return it anyway, so a caller that
            // does await observes "requests released".
            return applyBootState().then(( ) => start.apply(this, args));
        };
    }
}

// Backup-restore and "reset all settings" both end in vAPI.app.restart().
// A restart means the session-scope state this module persists is no longer
// meaningful -- clear it, so the next boot seeds from whatever was restored
// or reset rather than from the pre-restart snapshot. (Chrome clears
// storage.session on extension unload anyway; this makes the intent
// explicit and covers any divergence from that.)
{
    const restart = vAPI.app?.restart;
    if ( typeof restart !== 'function' ) {
        console.error(
            'uBO: vAPI.app.restart is not a function, so persisted ' +
            'session state is not cleared on backup restore or reset. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        vAPI.app.restart = function(...args) {
            bootState.sessionRulesActive = false;
            vAPI.sessionStorage.remove([
                SESSION_RULES_KEY,
                STRICT_BYPASS_KEY,
                PS_DIR_KEY,
                ...pageStores.dir.map(tabId => PS_KEY_PREFIX + tabId),
            ]).catch(( ) => { });
            // Flush durable settings writes before the reload. Backup-restore
            // and "reset all settings" issue fire-and-forget vAPI.storage.set()s
            // and then restart synchronously; without this the service worker
            // reloads before those writes reach IndexedDB and the restored
            // settings are lost -- the reported "restore doesn't fully work".
            return Promise.resolve(flushDurableSettingsWrites())
                .then(( ) => restart.apply(this, args));
        };
    }
}

/******************************************************************************/
