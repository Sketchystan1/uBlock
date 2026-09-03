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
    dynamic `import()`, two halves of the scriptlet world-straddling shim, and one
    user-setting default whose MV2 value is wrong under MV3.

**/

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
//
// `/js/benchmarks.js` is deliberately NOT registered: it is reachable only
// through hidden dev-only settings, and importing it here would add its cost to
// every service worker start. Those code paths now reject with an explanatory
// error instead of silently doing nothing.

import * as resourcesScriptlets from './resources/scriptlets.js';
import * as staticDnrFiltering from './static-dnr-filtering.js';
import { encodeScriptletMarker } from './mv3-scriptlet-marker.js';
import µb from './background.js';

self.uBO_registerStaticModules({
    '/js/resources/scriptlets.js': resourcesScriptlets,
    './static-dnr-filtering.js': staticDnrFiltering,
});

/******************************************************************************/

// Carry the filters that fired across into the ISOLATED world.
//
// `platform/common/vapi-background.js` declares `vAPI.scriptletsInjector` a
// platform hook ("To be defined by platform-specific code"), and Chromium's
// `platform/chromium/vapi-background-ext.js` defines it as a wrapper which both
// inserts the main-world payload and records the filters in
// `self.uBO_scriptletsInjected`. Under MV3 that wrapper can only be injected as
// a code string, i.e. into the `USER_SCRIPT` world, where neither of the
// marker's two readers can see it: `src/js/contentscript.js` and
// `src/js/scriptlets/cosmetic-report.js` both run in `ISOLATED`.
//
// Rather than reimplement the wrapper -- which would fork logic that upstream
// still maintains -- keep it and prefix its output with the filters, so that
// `executeCode()` in `mv3-shims.js` can peel them off and set the marker in the
// `ISOLATED` world too. See `./mv3-scriptlet-marker.js` for the wire format and
// `mv3-shims.js` for the other end.

{
    const injector = vAPI.scriptletsInjector;
    if ( typeof injector !== 'function' ) {
        console.error(
            'uBO: vAPI.scriptletsInjector is not a function, so the popup panel ' +
            'will not list scriptlet filters. See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        vAPI.scriptletsInjector = (hostname, details) =>
            encodeScriptletMarker({ hostname, filters: details.filters }) +
            injector(hostname, details);
    }
}

/******************************************************************************/

// Forward messages from the `USER_SCRIPT` world into `vAPI.messaging`.
//
// uBO talks to its content scripts and pages over ports exclusively, and
// `runtime.connect` is not among what `configureWorld({ messaging: true })`
// exposes, so the scriptlet->logger relay's `vAPI.messaging.send()` -- shimmed in
// that world by `mv3-shims.js` -- arrives here as a plain message instead. Feed
// it to the same channel listener a port message would have reached.
//
// Unprivileged, always: a `USER_SCRIPT` world runs on the page's origin and its
// code came from a filter list. That is exactly the status uBO computes for a
// content script port (`platform/common/vapi-background.js`, `onPortConnect`),
// so privileged channels are refused outright rather than left to a per-listener
// check.

if ( chrome.runtime.onUserScriptMessage !== undefined ) {
    chrome.runtime.onUserScriptMessage.addListener((request, sender, callback) => {
        if ( request instanceof Object === false ) { return; }
        const { channel, msg } = request;
        if ( typeof channel !== 'string' ) { return; }
        if ( msg instanceof Object === false ) { return; }
        const listener = vAPI.messaging.listeners.get(channel);
        if ( listener === undefined ) { return; }
        if ( listener.privileged ) { return; }
        const details = {
            tabId: sender.tab?.id,
            tabURL: sender.tab?.url,
            frameId: sender.frameId,
            frameURL: sender.url,
            privileged: false,
        };
        const r = listener.fn(msg, details, response => {
            try { callback(response); } catch {}
        });
        if ( r === vAPI.messaging.UNHANDLED ) { return; }
        // uBO's listeners may answer synchronously or not; keep the channel open
        // either way. `messageToLogger`, the one message this path exists for,
        // never answers at all.
        return true;
    });
}

/******************************************************************************/

// Close the cold-start filtering gap by default.
//
// uBO keeps its compiled lists in memory, so until they are loaded it cannot
// decide anything. `src/js/traffic.js` handles that by suspending network
// activity, but `vAPI.Net.canSuspend()` is false on Chromium, which makes
// `src/js/background.js` default the `suspendUntilListsAreLoaded` user setting to
// false as well -- so requests are *allowed* through until the engines are ready.
//
// Under MV2 that window opened once per browser launch, because the background
// page was persistent. Under MV3 it opens on every service worker respawn, which
// turns "briefly unfiltered at startup" into "intermittently unfiltered".
// Preserving the MV2 build's actual behaviour therefore means changing the
// default, not keeping it.
//
// `canSuspend()` is deliberately left alone. Flipping it would make
// `src/js/traffic.js` suspend at module scope, closing the window completely --
// but Chromium cannot defer a blocking `webRequest` decision, so its
// `suspendOneRequest()` (`platform/chromium/vapi-background-ext.js`) *cancels*
// non-main-frame requests instead. With `canSuspend()` false, a user who unticks
// the setting gets exactly the MV2 behaviour and never pays that cost; with it
// true, they would pay it during every boot regardless. So: same mechanism uBO
// already ships on Chromium, opt-out rather than opt-in.
//
// This runs before `loadUserSettings()` reads storage -- `src/js/start.js` kicks
// off its boot as an async IIFE which hits its first `await` well before that --
// so a value the user has actually chosen still wins.

{
    const settingName = 'suspendUntilListsAreLoaded';
    if ( Object.hasOwn(µb.userSettingsDefault, settingName) === false ) {
        console.error(
            `uBO: no "${settingName}" user setting; the MV3 cold-start window ` +
            `is no longer being closed. See platform/chromium-mv3/mv3-post.js.`
        );
    } else {
        µb.userSettingsDefault[settingName] = true;
        µb.userSettings[settingName] = true;
    }
}

/******************************************************************************/
