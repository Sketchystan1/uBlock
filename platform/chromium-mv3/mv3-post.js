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
    by load-order surprises.

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

self.uBO_registerStaticModules({
    '/js/resources/scriptlets.js': resourcesScriptlets,
    './static-dnr-filtering.js': staticDnrFiltering,
});

/******************************************************************************/
