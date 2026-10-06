/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2026-present Raymond Hill

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

    MV3 replacement for `platform/chromium/vapi-scripting.js`, which
    `tools/make-chromium-mv3.sh` overwrites with this file in the package.

    Upstream's Chromium flavor executes one code string -- every scriptlet of
    every filter list, plus an early-bailout preamble -- in each committed
    frame through `tabs.executeScript({ code })`, and has the isolated half
    insert the main-world half as a `<script>` element. Neither survives MV3:
    no API executes a code string in any world, and every world governs
    element creation with a CSP. So the code strings `src/js/scriptlet-
    filtering.js` assembles are never run here. What this module keeps is the
    one piece of them which is data: the per-registration `scriptletGlobals`
    (warOrigin, warSecret, and the logger's bcSecret/logLevel when it is on),
    which the scriptlets read at run time and which upstream bakes into the
    code strings. Registration also serves as the "armed" state: upstream
    unregisters while the engine is reset or holds no scriptlet at all, and
    injects nothing in the meantime -- neither does this port.

    The injection itself is performed per committed frame by `mv3-post.js`,
    which resolves the frame's scriptlet calls from the engine's own database
    and hands them to the CSP-exempt sharded libraries `mv3-shims.js` injects.
    That is where upstream's early bailouts (trusted sites, a first-party
    `allow` rule) are applied too, against uBO's own state instead of a
    serialized copy of it.

    The exports must stay in lockstep with upstream's Chromium flavor:
    `tools/verify-mv3-package.mjs` fails the build when they drift apart.

**/

/******************************************************************************/

let registeredGlobals;

export function registerContentScripts(details) {
    registeredGlobals = undefined;
    if ( details instanceof Object === false ) { return; }
    if ( Boolean(details.isolatedCode) === false ) {
        if ( Boolean(details.mainCode) === false ) { return; }
    }
    registeredGlobals = Object.assign({}, details.scriptletGlobals);
}

export function unregisterContentScripts() {
    registeredGlobals = undefined;
}

// MV3-only: consumed by mv3-post.js. `undefined` while nothing is registered.
export function mv3RegisteredScriptletGlobals() {
    return registeredGlobals;
}

/******************************************************************************/
