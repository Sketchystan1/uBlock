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
import { userScripts } from './mv3-shims.js';
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

// Say so on the toolbar when scriptlet filters are not being injected.
//
// `chrome.userScripts` is the only MV3 API which can inject a code string, and
// it is gated behind a per-extension toggle the user has to find and enable by
// hand (see docs/mv3-deployment.md). Until they do, every `+js(...)` filter
// silently does nothing while the rest of uBO works normally -- which reads, to
// the user, as uBO being broken on the sites those filters exist to fix.
//
// `mv3-shims.js` logs one line to the service worker console, and nobody reads
// that. So borrow the vocabulary uBO already uses for "this is not filtering
// what you think it is": the `!` badge in `#FC0` which
// `platform/common/vapi-background.js` shows for unprocessed requests. Both the
// per-tab badge and the default one are needed, since uBO sets a per-tab badge
// on every tab it tracks and that masks the default.

{
    const setDefaultBadge = ( ) => {
        const text = userScripts.available === false ? '!' : '';
        chrome.action.setBadgeText({ text }).catch(( ) => {});
        chrome.action.setBadgeBackgroundColor({
            color: text === '!' ? '#FC0' : '#666',
        }).catch(( ) => {});
    };

    const setIcon = vAPI.setIcon;
    if ( typeof setIcon !== 'function' ) {
        console.error(
            'uBO: vAPI.setIcon is not a function, so a missing "Allow user ' +
            'scripts" toggle will not be flagged on the toolbar. ' +
            'See platform/chromium-mv3/mv3-post.js.'
        );
    } else {
        vAPI.setIcon = function(tabId, details) {
            if ( userScripts.available === false && details instanceof Object ) {
                // `parts` bit 1 selects the badge text and bit 2 its colour;
                // without them an icon-only update would leave the warning
                // unpainted. Bit 3 (hide the badge) is deliberately left alone:
                // uBO respects it for its own `!`, and a user who has turned
                // badges off has said what they want.
                details = Object.assign({}, details, {
                    badge: '!',
                    color: '#FC0',
                    parts: (details.parts ?? 0b0001) | 0b0110,
                });
            }
            return setIcon.call(this, tabId, details);
        };
    }

    // uBO's `vAPI.Net` constructor calls `vAPI.setDefaultIcon()`, which resets
    // the default badge -- so paint ours only now, once that has happened.
    userScripts.onChange = setDefaultBadge;
    setDefaultBadge();
}

/******************************************************************************/
