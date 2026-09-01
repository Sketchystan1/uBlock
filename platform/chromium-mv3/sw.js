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

    MV3 service worker entry point, replacing `src/background.html`.

    Ordering matters and is guaranteed by the module specification: a module's
    dependencies are evaluated depth-first in the order their import
    declarations appear, and all of them complete before the importing module's
    own body runs. So `mv3-shims.js` -- and everything it defines on the global
    object -- is fully in place before uBO's first module evaluates.

    This is also what makes MV3's blocking `webRequest` viable: `start.js` pulls
    in `traffic.js`, which registers uBO's blocking `onBeforeRequest` listener
    synchronously at module scope. The listener therefore exists before the
    browser can dispatch the event which woke this worker.

**/

import './mv3-shims.js';
import './start.js';
