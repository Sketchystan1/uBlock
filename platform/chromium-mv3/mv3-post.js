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
    dynamic `import()`, the scriptlet-injection data channel (the marker prefix
    `mv3-shims.js` consumes), one user-setting default whose MV2 value is wrong
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
    sessionFirewall,
    sessionSwitches,
    sessionURLFiltering,
} from './filtering-engines.js';
import { ScriptletFilteringEngine } from './scriptlet-filtering-core.js';
import { encodeScriptletMarker } from './mv3-scriptlet-marker.js';
import io from './assets.js';
import { mv3EarlyEvents, mv3ForkStatus, mv3ForkStatusReady } from './mv3-shims.js';
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

// Carry a whole scriptlet injection across the func/args boundary.
//
// `platform/common/vapi-background.js` declares `vAPI.scriptletsInjector` a
// platform hook ("To be defined by platform-specific code"), and Chromium's
// `platform/chromium/vapi-background-ext.js` defines it as a wrapper which
// both inserts the main-world payload as a `<script>` element and records
// the filters in `self.uBO_scriptletsInjected`. That wrapper is a code
// string, and `chrome.scripting` -- the only injection API this port has
// left -- cannot execute code strings. So the wrapper's output is never run;
// it is kept only so the program `src/js/scriptlet-filtering.js` assembles
// still looks like upstream's. Everything `executeCode()` in `mv3-shims.js`
// needs to perform the injection properly is prefixed to it as a marker:
// the scriptlet calls for both worlds (parsed back out of their payloads),
// the per-document scriptlet globals, the filters that fired, and the
// `bcSecret` of the scriptlet->logger relay. See `./mv3-scriptlet-marker.js`
// for the wire format and `mv3-shims.js` for the other end.

// The relay's channel name is not passed to the injector hook, but
// `src/js/scriptlet-filtering.js` bakes it into the payloads' private
// `scriptletGlobals` object whenever the logger is on, so it can be read
// back out. The `scriptletGlobals` declaration precedes any scriptlet code
// in the payload, so the first match is the real one -- a filter argument
// quoting the same text can only appear later, and can at worst redirect
// log lines to a channel nobody listens on.
const rebcSecret = /"bcSecret":\s*"([^"]*)"/;

// Neither payload can be executed as a string: no MV3 API injects code into
// either world, `eval()` is blocked everywhere extension code runs, and a
// `<script>` element created by extension code is blocked by whichever CSP
// governs the world that created it. So `mv3-shims.js` runs the scriptlet
// *calls* instead, through the function libraries `tools/patch-mv3-modules.mjs`
// generates. Read them back out of the payloads: `lookupScriptlet()` in
// `src/js/scriptlet-filtering-core.js` renders each call as a single
// `fname(JSON-args);` line inside a fixed try/catch wrapper -- the same
// wrapper for both worlds -- and a JSON string never contains a physical
// newline, so each call is exactly one line and cannot be confused with
// anything around it.
const reScriptletCall = /\ntry \{\n\t([A-Za-z_$][\w$]*)\((.*)\);\n\} catch/g;
const reScriptletTryBlock = /\ntry \{\n/g;

const parseScriptletCalls = payload => {
    if ( typeof payload !== 'string' || payload === '' ) { return []; }
    const calls = [];
    try {
        for ( const match of payload.matchAll(reScriptletCall) ) {
            calls.push([ match[1], JSON.parse(`[${match[2]}]`) ]);
        }
    } catch (reason) {
        console.error(`uBO: scriptlet calls: ${reason}`);
        return [];
    }
    // Every try-block must have parsed, or the payload's shape has drifted
    // from what the regex above understands. Shipping a partial call list
    // would run some scriptlets and silently drop the rest, so run none and
    // say so; `tools/verify-mv3-package.mjs` pins the shapes so this should
    // be unreachable.
    const tryCount = (payload.match(reScriptletTryBlock) || []).length;
    if ( tryCount !== calls.length ) {
        console.error(
            `uBO: parsed ${calls.length} scriptlet call(s) out of ${tryCount} ` +
            `-- dropping them all rather than running a partial set. See ` +
            `platform/chromium-mv3/mv3-post.js.`
        );
        return [];
    }
    return calls;
};

// The per-document `scriptletGlobals` (warOrigin/warSecret, plus the
// logger's bcSecret/logLevel when it is on) is baked into the payloads but
// not passed to the injector hook either; the isolated-world scriptlets
// need it as data, so capture it while it is still an object. Set by the
// core-retrieve wrap below and consumed by the injector wrap within the
// same synchronous `retrieve()` call -- nothing can interleave.
let currentScriptletGlobals;

// uBOL-style argument interning (see
// platform/mv3/extension/js/offscreen/make-scriptlets.js): scriptlet
// arguments repeat heavily -- the same selector in two filters, the empty
// flags most scriptlets take -- and the calls travel several IPC hops
// (marker string, executeScript args, DOM launch record), so carry them as
// a deduped table plus index arrays instead. The two call sets share one
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

// When only isolated-world scriptlets fired, upstream's `retrieve()` never
// calls `vAPI.scriptletsInjector` (it gates on `details.mainWorld`), so no
// marker would ride the assembled code and `executeCode()` would have
// nothing to inject. Force the call by handing the engine's own core
// `retrieve()` result a truthy sentinel in the main-world slot; the wrapper
// below maps it back to "no main-world payload" and flags the injection
// `isolatedOnly`. Nothing downstream executes the slot, so the sentinel
// never escapes as code; the NULs on both ends ensure no assembled payload
// -- all of which start with `(function() {` -- can ever equal it.
const MV3_ISOLATED_ONLY = '\u0000uBO-mv3-isolated-only\u0000';
{
    const injector = vAPI.scriptletsInjector;
    const coreRetrieve = ScriptletFilteringEngine.prototype.retrieve;
    if ( typeof injector !== 'function' ) {
        console.error(
            'uBO: vAPI.scriptletsInjector is not a function, so scriptlet ' +
            'filters cannot be injected. See platform/chromium-mv3/mv3-post.js.'
        );
    } else if ( typeof coreRetrieve !== 'function' ) {
        console.error(
            'uBO: ScriptletFilteringEngine.prototype.retrieve is not a ' +
            'function, so documents with only isolated-world scriptlets ' +
            'cannot be injected. See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        ScriptletFilteringEngine.prototype.retrieve = function(...args) {
            currentScriptletGlobals = args[1]?.scriptletGlobals;
            const details = coreRetrieve.apply(this, args);
            if (
                details instanceof Object &&
                details.isolatedWorld &&
                !details.mainWorld
            ) {
                details.mainWorld = MV3_ISOLATED_ONLY;
            }
            return details;
        };
        vAPI.scriptletsInjector = (hostname, details) => {
            const isolatedOnly = details.mainWorld === MV3_ISOLATED_ONLY;
            const mainWorld = isolatedOnly ? '' : details.mainWorld;
            const findbcSecret = payload => {
                if ( typeof payload !== 'string' ) { return undefined; }
                const match = rebcSecret.exec(payload);
                return match !== null ? match[1] : undefined;
            };
            const { args, compact } = internScriptletArgs();
            const marker = {
                hostname,
                filters: details.filters,
                args,
                mainCalls: compact(parseScriptletCalls(mainWorld)),
                isolatedCalls: compact(parseScriptletCalls(details.isolatedWorld)),
                scriptletGlobals: currentScriptletGlobals,
                bcSecret: findbcSecret(mainWorld) ??
                    findbcSecret(details.isolatedWorld),
            };
            if ( isolatedOnly ) { marker.isolatedOnly = true; }
            return encodeScriptletMarker(marker) + injector(hostname, details);
        };
    }
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
// reloads and browser restarts. Upstream's scriptlet payload cache adds a
// same-lifetime staleness on top: `scriptlet-filtering.js` clears it only
// when the redirect engine's resources change, so even rebuilt engines keep
// serving the removed scriptlet's assembled payload for the rest of the
// worker's life.
//
// MV2 parity: every piece of this is shared `src/` code, so the MV2 build
// has the identical hole through the identical call sequence (its dashboard
// works around it the same way). The fix is applied here, at the port level,
// rather than in `src/js/storage.js`: this fork's whole merge story is "no
// upstream file is modified", and the wrap below gives every
// `saveUserFilters` caller the dashboard's semantics without touching one.
// The upstreamable version is the same two changes in `saveUserFilters()`
// (rebuild the engines) and in the scriptlet cache's reset condition
// (a user-filters generation).
{
    const baseSaveUserFilters = µb.saveUserFilters;
    const baseEngineRetrieve = scriptletFilteringEngine?.retrieve;
    if ( typeof baseSaveUserFilters !== 'function' ) {
        console.error(
            'uBO: µb.saveUserFilters is not a function, so user-filter ' +
            'changes cannot be made to take effect in the engines. See ' +
            'platform/chromium-mv3/mv3-post.js.'
        );
    } else if ( typeof baseEngineRetrieve !== 'function' ) {
        console.error(
            'uBO: scriptletFilteringEngine.retrieve is not a function, so ' +
            'stale scriptlet payloads cannot be invalidated on user-filter ' +
            'changes. See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        // Generation clock: bumped each time the user-filters raw asset is
        // (re)written. Compared against the scriptlet payload cache's own
        // reset time below -- upstream's condition only consults the
        // redirect engine's modify time, which user-filter changes do not
        // touch.
        let userFiltersModifyTime = 0;

        scriptletFilteringEngine.retrieve = function(...args) {
            if ( this.scriptletCache?.resetTime < userFiltersModifyTime ) {
                this.clearCache();
            }
            return baseEngineRetrieve.apply(this, args);
        };

        µb.saveUserFilters = function(...args) {
            const result = baseSaveUserFilters.apply(this, args);
            const ubo = this;
            Promise.resolve(result).then(( ) => {
                // `+ 1` so a cache reset happening in the same millisecond
                // as this save still counts as pre-save state (a save and a
                // reset can share a timestamp; the stale check is strict
                // less-than).
                userFiltersModifyTime = Date.now() + 1;
                // Remove the compiled user-filters entry again, and this
                // time await it. Round 6 got this wrong twice over: the
                // base's own `removeCompiledFilterList()` helper returns
                // NOTHING (it fires `io.remove()` without returning it), so
                // chaining `.catch()` off its result threw a TypeError the
                // moment the chain was entered -- silently swallowed by the
                // outer catch, so the reload below never ran and the stale
                // engines (and the selfie they got snapshotted into) lived
                // on. Calling `io.remove()` directly returns a real promise,
                // and awaiting it also closes the base's fire-and-forget
                // race: the reload can never read a stale compiled entry
                // back.
                //
                // Readiness gate: a save landing before `readyToFilter`
                // (a filter added during boot -- restoreUserData, an eager
                // element picker, a harness) must NOT be dropped. Defer the
                // rebuild onto `isReadyPromise` instead of skipping: the
                // boot's own loadFilterLists would otherwise read the raw
                // asset through whatever the save race left, and post-boot
                // saves have nothing waiting for them. Live-reproduced
                // 2026-09-16: filters added in that window never reached
                // the engines for the rest of the worker's life, while the
                // raw and compiled assets both carried them (the compiled
                // cache made it look like everything worked).
                const rebuild = ( ) => {
                    io.remove(`compiled/${ubo.userFiltersPath}`)
                        .catch(( ) => { })
                        .then(( ) => ubo.loadFilterLists())
                        .catch(( ) => { });
                };
                if ( ubo.readyToFilter === true ) { return rebuild(); }
                Promise.resolve(ubo.isReadyPromise).then(rebuild);
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
    restored: false,      // page-store directory has been read back (see applyBootState)
    sessionRulesActive: false, // persist-on-mutation armed
};

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
        entry.allowLargeMediaElementsRegex =
            pageStore.allowLargeMediaElementsRegex;
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
    // storage on it.
    if (
        entry.counts.every(v => v === 0) &&
        entry.hosts.length === 0 &&
        entry.popupBlockedCount === 0 &&
        entry.largeMediaCount === 0 &&
        entry.remoteFontCount === 0
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
    pageStores.timer = 0;
    const dirty = pageStores.dirty;
    if ( dirty.size === 0 ) { return; }
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
    for ( const tabId of candidates ) {
        const pageStore = µb.pageStores.get(tabId);
        const entry = pageStore === undefined
            ? undefined
            : snapshotPageStore(pageStore);
        if ( entry !== undefined && dir.length < MAX_SNAPSHOTTED_TABS ) {
            bin[PS_KEY_PREFIX + tabId] = entry;
            entries.set(PS_KEY_PREFIX + tabId, tabId);
            if ( dir.includes(tabId) === false ) {
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
    const writes = [];
    if ( Object.keys(bin).length !== 0 ) {
        for ( const [ key, entry ] of Object.entries(bin) ) {
            pageStores.keyBytes.set(key, key.length + JSON.stringify(entry).length);
        }
        writes.push(vAPI.sessionStorage.set(bin));
    }
    for ( const key of toRemove ) {
        pageStores.keyBytes.delete(key);
    }
    if ( pageStores.dirDirty ) {
        pageStores.dirDirty = false;
        writes.push(vAPI.sessionStorage.set({ [PS_DIR_KEY]: dir }));
    }
    if ( toRemove.length !== 0 ) {
        writes.push(vAPI.sessionStorage.remove(toRemove));
    }
    for ( const write of writes ) { write.catch(( ) => { }); }
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
    if ( entry.allowLargeMediaElementsRegex instanceof RegExp ) {
        pageStore.allowLargeMediaElementsRegex =
            entry.allowLargeMediaElementsRegex;
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
    if ( bootState.applied ) { return; }
    bootState.applied = true;
    fetchBootState().then(( ) => {
        if ( bootState.bin === undefined ) { return; }
        applySessionRules();
        applyStrictBlockBypasses();
        return applyPageStores();
    }).then(( ) => {
        // `applied` (set synchronously above) means only "restore started",
        // which is all the session-rule and strict-bypass paths need. The
        // page-store directory, though, is not read into pageStores.dir until
        // applyPageStores() has resolved -- so gate the flush and unbind paths
        // on this later flag, or they would overwrite the persisted directory
        // / splice a directory not yet loaded during the restore window.
        bootState.restored = true;
    }).catch(( ) => {
        // Each restore step swallows its own failures, so this chain settles
        // in practice; guard the pathological reject so flushPageStoreSnapshots
        // does not respin forever with the gate shut.
        bootState.restored = true;
    });
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
            applyBootState();
            // After the state restore, so the requests un-parked by the
            // original start() are filtered with the restored rules.
            return start.apply(this, args);
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
            return restart.apply(this, args);
        };
    }
}

/******************************************************************************/
