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

    MV2 -> MV3 compatibility layer for uBO's background process.

    uBO's background code was written for a persistent background *page*. Under
    MV3 it runs in a service worker, which has no DOM and a reduced API surface.
    Rather than patch uBO itself -- which would create a merge conflict with
    upstream on every release -- this module re-creates the small set of globals
    and `chrome.*` entry points uBO expects, and does so *before* any of uBO's
    own modules evaluate. See `sw.js` for the ordering guarantee.

    Two of the gaps are closed by MV3 features which are gated:
    - Blocking `webRequest` requires the `webRequestBlocking` permission, which
      MV3 grants only to policy-installed extensions.
    - Injecting scriptlet code (arbitrary strings) has no MV3 API at all:
      scriptlets are carried as data and inserted by functions of ours, in the
      scriptlet-injection section below.
    See docs/mv3-deployment.md.

**/

/* global chrome */

// Must come before anything which may touch `self.lz4BlockCodec`. The JS
// flavor only assigns `self.LZ4BlockJS` and has no DOM dependency; the WASM
// flavor would compute its module's URL from `document.currentScript`,
// which does not exist in a service worker -- the build rewrites that
// lookup to a package-root-relative path (tools/patch-mv3-modules.mjs),
// which the fetch wrapper above resolves. Both flavors are needed: LZ4
// decompression of the filtering-engine selfie runs 5-20x faster under
// WASM, and `src/js/lz4.js` asks for the default flavor, which is
// WASM-first with a JS fallback.
//
// SW-crash coupling: these are static imports evaluated at service-worker
// startup, ahead of every shim, so a throw from either module's top-level
// evaluation (e.g. a mis-rewritten WASM module URL) aborts the whole worker
// and with it uBO's boot. Both flavors here only assign a global and must stay
// that way -- do not add import-time work that could throw.
import '../lib/lz4/lz4-block-codec-js.js';
import '../lib/lz4/lz4-block-codec-wasm.js';

// Pure modules, safe to import here: neither touches `chrome.*` nor the
// DOM, so neither can depend on a shim this file has not installed yet.
import { decodeScriptletMarker } from './mv3-scriptlet-marker.js';
// Generated into the package by tools/patch-mv3-modules.mjs (it does not
// exist in the source tree): which file of the sharded scriptlet libraries
// defines each function, per world. See the scriptlet-injection section
// below.
import { scriptletShards } from './mv3-scriptlet-shards.js';

/******************************************************************************/

const OFFSCREEN_PAGE = 'offscreen.html';
const KEEPALIVE_ALARM = 'mv3ShimsKeepalive';
const WORKER_CHANNEL = 'uBO-worker-proxy';

/******************************************************************************/

// Relative URLs inside a service worker resolve against the *worker script's*
// URL -- here `chrome-extension://<id>/js/sw.js`, so the base directory is
// `/js/`, not the package root. uBO's background code was written for
// `background.html`, which sits at the root, so every relative path it hands to
// a web-platform API (`fetch`, and anything built on it) is off by one
// directory and 404s.
//
// Extension APIs are not affected: `chrome.scripting` resolves `file:` against
// the extension root in the browser process. But
// `chrome.action.setIcon({path})` only *looks* like one of those -- Chromium
// implements the path->ImageData conversion in the calling context, and its
// service worker branch calls `fetch(path)` right here in the worker
// (`extensions/renderer/resources/set_icon.js`). So it follows the worker base
// URL too, and needs the same treatment.

const rootURL = url => {
    if ( typeof url !== 'string' ) { return url; }
    // Anything already carrying a scheme is absolute -- leave it alone. Tested
    // on the scheme rather than on '://' so that `data:`, `blob:` and
    // `filesystem:` are also passed through untouched; uBO does not currently
    // hand any of those to these two call paths, but silently prefixing one with
    // the extension origin would be a bewildering failure.
    if ( /^[a-z][a-z0-9+.-]*:/i.test(url) ) { return url; }
    // Protocol-relative and root-relative URLs do not depend on the base
    // *directory*, only on the base origin, which is the same either way. Leave
    // them alone so that this function has no effect where it would have none.
    if ( url.startsWith('/') ) { return url; }
    return chrome.runtime.getURL(url);
};

// With `rootURL()` in hand, close the general case: make relative URLs resolve
// against the package root for `fetch()` itself, exactly as they did when the
// background was `background.html`. Two upstream call sites need this, both of
// them WebAssembly module loaders which pass a directory-relative path:
// `src/js/start.js` (`'./js/wasm/'`, for the static network filtering engine)
// and `src/js/storage.js` (`'./lib/publicsuffixlist/wasm/'`). Both are gated on
// `vAPI.canWASM`, which is false unless the manifest CSP opts in -- so without
// this the documented opt-in would silently 404 and disable both engines rather
// than enable them. See docs/mv3-deployment.md.
//
// Everything else uBO fetches is already absolute: `src/js/assets.js` runs its
// asset keys through `vAPI.getURL()` before use, and filter list URLs are
// remote. So this is a safety net for the general case more than a fix for a
// specific caller -- which is the point, since the next relative fetch upstream
// adds to the background would otherwise fail silently too.

{
    const nativeFetch = self.fetch.bind(self);
    self.fetch = (resource, ...args) =>
        nativeFetch(rootURL(resource), ...args);
}

/******************************************************************************/

// `platform/common/vapi.js` is a classic script which pokes at `document` to
// decide whether it is running in a content script. In a service worker there
// is nothing to decide: these are the only two things it would do for us.

self.browser = self.chrome;
self.vAPI = { uBO: true };

/******************************************************************************/

// Globals which uBO's background modules reference unconditionally, and which
// do not exist in a service worker.

// `src/js/i18n.js` and `platform/common/vapi.js` test `x instanceof Element`.
// Nothing in a service worker is ever an Element, so a bare class is enough.
self.Element = class Element {};

// `platform/common/vapi-common.js` probes for native `:has()` support. Chromium
// has shipped it since 105, well below our `minimum_chrome_version`.
//
// Guard on the method, not the namespace: `vapi-common.js` calls
// `CSS.supports()` at module scope, so were a future Chrome to expose a partial
// `CSS` in workers (`escape()` but not `supports()`), a namespace-only check
// would keep that object and the call would throw -- aborting module evaluation
// and with it the whole service worker.
if ( typeof self.CSS?.supports !== 'function' ) {
    self.CSS = Object.assign({}, self.CSS, { supports: ( ) => true });
}

// `vapi-common.js` dispatches a `webextFlavor` event which `vapi-background.js`
// listens for, and `vAPI.cloud` reads `window.navigator.platform`.
// `ServiceWorkerGlobalScope` is an EventTarget and exposes `navigator`, so
// aliasing is sufficient.
self.window = self;

// `requestIdleCallback` and `requestAnimationFrame` are Window APIs. Two call
// sites reach them unguarded from the background: `src/js/tab.js` on every
// toolbar icon update, and `vAPI.defer`'s `onric`/`onraf` paths (used by
// `src/js/static-ext-filtering-db.js`). A service worker never renders and is
// never meaningfully "idle", so run the callback promptly -- which is also the
// fallback uBO itself uses in `src/js/tasks.js`.
self.requestIdleCallback = self.requestIdleCallback || (callback => {
    return setTimeout(( ) => {
        callback({ didTimeout: true, timeRemaining: ( ) => 0 });
    }, 1);
});
self.cancelIdleCallback = self.cancelIdleCallback || (id => clearTimeout(id));
self.requestAnimationFrame = self.requestAnimationFrame || (callback => {
    return setTimeout(( ) => { callback(performance.now()); }, 1);
});
self.cancelAnimationFrame = self.cancelAnimationFrame || (id => clearTimeout(id));

/******************************************************************************/

// A `document` stand-in covering the three things uBO's background asks of it.

self.document = {
    // `src/js/i18n.js` uses this exact string to detect the background process;
    // matching it keeps every DOM code path in that file behind its existing
    // `isBackgroundProcess !== true` guard.
    title: 'uBlock Origin Background Page',

    // `vapi-background.js` renders the toolbar icon into a canvas so it can
    // hand `ImageData` to `action.setIcon()`.
    createElement(tagName) {
        if ( tagName === 'canvas' ) {
            return new OffscreenCanvas(64, 64);
        }
        throw new Error(`mv3-shims: document.createElement("${tagName}")`);
    },

    // `src/js/static-filtering-parser.js` compiles an XPath expression purely
    // to validate it, and treats a throw as "invalid filter". There is no XPath
    // engine in a service worker, so accept the expression as-is: it is still
    // evaluated for real in the content script. The caller also reads
    // `XPathResult.ANY_UNORDERED_NODE_TYPE` after createExpression() -- a
    // global that does not exist in a service worker either, whose
    // ReferenceError was silently discarding every `:xpath()` filter at
    // compile time (live-reproduced 2026-09-16, uBOL test page's
    // `pcf14:xpath(.//b/../..)`).
    createExpression() {
        return { evaluate() {} };
    },
};

// See the `createExpression` shim above: `static-filtering-parser.js` reads
// `XPathResult.ANY_UNORDERED_NODE_TYPE` (a plain integer, 8) when validating
// `:xpath()` filter arguments. The constant is all the parser needs; the
// result object itself is the shim's no-op `evaluate()`.
self.XPathResult = {
    ANY_UNORDERED_NODE_TYPE: 8,
};

/******************************************************************************/

// `vapi-background.js` pre-renders the toolbar icons through `new Image()` to
// work around a Chromium issue with path-based `setIcon()`. `createImageBitmap`
// is the service worker equivalent, wrapped to look like an `HTMLImageElement`
// to the extent that code uses it: `src`, `naturalWidth`, `naturalHeight`,
// `complete`, and a `load` event.

self.Image = class Image extends EventTarget {
    constructor() {
        super();
        this.complete = false;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        this.bitmap = null;
        this._src = '';
    }
    get src() {
        return this._src;
    }
    set src(url) {
        this._src = url;
        this.load(url);
    }
    async load(url) {
        try {
            // `rootURL()`: uBO passes `img/icon_16.png`, which would otherwise
            // resolve against `/js/`. See the note at the top of this file.
            const response = await fetch(rootURL(url));
            if ( response.ok === false ) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            const bitmap = await createImageBitmap(await response.blob());
            this.bitmap = bitmap;
            this.naturalWidth = bitmap.width;
            this.naturalHeight = bitmap.height;
            this.complete = true;
            this.dispatchEvent(new Event('load'));
        } catch {
            this.complete = true;
            this.dispatchEvent(new Event('error'));
        }
    }
};

// `ctx.drawImage()` wants something it can rasterize. Our `Image` is a plain
// object, so unwrap it to the underlying `ImageBitmap`.
{
    const CanvasContext = OffscreenCanvasRenderingContext2D.prototype;
    const drawImage = CanvasContext.drawImage;
    CanvasContext.drawImage = function(image, ...args) {
        if ( image instanceof self.Image ) {
            if ( image.bitmap === null ) { return; }
            return drawImage.call(this, image.bitmap, ...args);
        }
        return drawImage.call(this, image, ...args);
    };
}

/******************************************************************************/

// `src/js/assets.js` fetches filter lists through XMLHttpRequest, which does
// not exist in a service worker. This covers exactly the surface `assets.js`
// uses -- see `assets.fetch()`: open/send/abort, add/removeEventListener for
// load|error|abort|progress, `responseType`, and `response`/`status`/
// `statusText` read off `this` inside the handlers.

self.XMLHttpRequest = class XMLHttpRequest extends EventTarget {
    constructor() {
        super();
        this.responseType = 'text';
        this.response = null;
        this.status = 0;
        this.statusText = '';
        this.url = '';
        this.controller = null;
    }
    open(_method, url) {
        this.url = url;
    }
    abort() {
        if ( this.controller === null ) { return; }
        this.controller.abort();
        this.controller = null;
    }
    send() {
        this.controller = new AbortController();
        this.fetch(this.controller.signal).catch(reason => {
            this.dispatchEvent(new Event(
                reason?.name === 'AbortError' ? 'abort' : 'error'
            ));
        });
    }
    async fetch(signal) {
        const response = await fetch(this.url, { signal });
        this.status = response.status;
        this.statusText = response.statusText;
        // `assets.fetch()` uses `progress` events only to reset its inactivity
        // timeout, so an approximation from the stream is faithful enough.
        const buffer = await this.drain(response);
        switch ( this.responseType ) {
        case 'arraybuffer':
            this.response = buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength
            );
            break;
        case 'blob':
            this.response = new Blob([ buffer ]);
            break;
        default:
            this.response = new TextDecoder().decode(buffer);
            break;
        }
        this.dispatchEvent(new Event('load'));
    }
    async drain(response) {
        if ( response.body === null ) {
            return new Uint8Array(await response.arrayBuffer());
        }
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if ( done ) { break; }
            chunks.push(value);
            loaded += value.byteLength;
            const ev = new Event('progress');
            ev.loaded = loaded;
            this.dispatchEvent(ev);
        }
        const out = new Uint8Array(loaded);
        let offset = 0;
        for ( const chunk of chunks ) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out;
    }
};

/******************************************************************************/

// `src/js/lz4.js` expects the global published by
// `src/lib/lz4/lz4-block-codec-any.js`, which loads its flavors by injecting
// `<script>` elements -- impossible from a service worker. Stand in for it
// with the flavors imported at the top of this file, mirroring the order
// `lz4-block-codec-any.js` itself uses: WASM first when no flavor is
// requested, the pure-JS flavor on WASM failure or on explicit request.
// (The MV3 manifest opts into 'wasm-unsafe-eval', which is what makes
// `vAPI.canWASM` true -- see docs/mv3-deployment.md. Under a manifest
// without the opt-in, the WASM compile is blocked by the CSP, the codec's
// `init()` catches it and reports failure, and this falls back to JS -- so
// the shim is safe under either policy.)

self.lz4BlockCodec = {
    createInstance: function(flavor) {
        const instantiate = ctor => {
            if ( ctor instanceof Function === false ) {
                return Promise.resolve(null);
            }
            const instance = new ctor();
            return instance.init().then(ok => ok ? instance : null);
        };
        if ( flavor === 'js' ) {
            return instantiate(self.LZ4BlockJS);
        }
        if ( flavor === 'wasm' ) {
            return instantiate(self.LZ4BlockWASM);
        }
        return instantiate(self.LZ4BlockWASM).then(instance =>
            instance !== null ? instance : instantiate(self.LZ4BlockJS)
        );
    },
    reset: function() {
    },
};

/******************************************************************************/

// Dynamic `import()` is unconditionally forbidden in a ServiceWorkerGlobalScope
// (Blink: `WorkerModulatorImpl::IsDynamicImportForbidden`). uBO has five call
// sites reachable from the background, and every one of them swallows the
// rejection, so the failures are silent:
// - `src/js/redirect-engine.js` imports `/js/resources/scriptlets.js` from
//   `loadBuiltinResources()`. Its `.catch()` logs and moves on, leaving the
//   engine with zero scriptlets -- i.e. every `+js(...)` filter silently does
//   nothing. Masked whenever the selfie fast path in `src/js/storage.js` hits,
//   so it only bites on a fresh profile or after selfie invalidation.
// - `src/js/messaging.js` imports `./static-dnr-filtering.js` for the "export to
//   DNR" dashboard feature, and `/js/benchmarks.js` for dev-only benchmarks.
//
// `tools/patch-mv3-modules.mjs` rewrites those call sites at build time to go
// through `self.uBO_dynamicImport()` instead. The modules worth supporting are
// registered by `mv3-post.js`, which runs after `start.js` -- it cannot be done
// from this file, because statically importing a uBO module here would evaluate
// it BEFORE these shims are installed, inverting the one ordering guarantee the
// whole port depends on.

{
    const staticModules = new Map();
    let onRegistered;
    const registered = new Promise(resolve => { onRegistered = resolve; });

    // A specifier is written variously as `/js/foo.js`, `./foo.js` or
    // `js/foo.js` depending on the call site; reduce all of them to a path
    // relative to the package's `js/` directory.
    const normalize = spec =>
        spec.replace(/^\.\//, '').replace(/^\/?js\//, '');

    self.uBO_registerStaticModules = modules => {
        for ( const [ spec, module ] of Object.entries(modules) ) {
            staticModules.set(normalize(spec), module);
        }
        onRegistered();
    };

    self.uBO_dynamicImport = async spec => {
        await registered;
        const module = staticModules.get(normalize(spec));
        if ( module !== undefined ) { return module; }
        throw new Error(
            `uBO: dynamic import() is unavailable in a service worker, and ` +
            `"${spec}" is not statically registered. Add it to ` +
            `platform/chromium-mv3/mv3-post.js if this code path is needed.`
        );
    };
}

/******************************************************************************/

// The offscreen document does double duty: it hosts real Workers on uBO's
// behalf (see below), and it pings us every 20s. Per Chrome's service worker
// lifecycle docs, extension messages reset the 30s idle timer and there is no
// cap on total worker lifetime, so those pings keep the filtering engines
// resident. (There are still two per-operation caps, which a keepalive cannot
// help with: 5 minutes for any single event or API call, and 30s for a fetch()
// response to begin arriving.) An alarm re-creates the document should it ever
// go away.
//
// The pings are load-bearing for correctness, not just for warm-start latency:
// BroadcastChannel is a web-platform API, so the Worker relay below does NOT
// reset the idle timer and cannot revive a terminated worker. Without the pings
// the worker could die mid-round-trip and silently drop a reverselookup or
// diff-updater reply, with no retry path.

let offscreenPromise;

// The last moment we had evidence the offscreen document exists -- a keepalive
// ping from it, a `getContexts` confirmation, or its successful creation.
// Fresh evidence lets the keepalive alarm skip the `getContexts` IPC entirely:
// while the document is alive it pings every 20s, so anything older than a
// couple of missed pings means it died (or was never created), and only then
// is a re-check warranted. The worker-relay path below still re-checks on its
// own -- it polls the channel with `ping` until the document answers -- so a
// stale document costs that path a few hundred milliseconds, not correctness.
let offscreenEvidenceAt = 0;
const OFFSCREEN_STALE_AFTER_MS = 45 * 1000;

const offscreenIsFresh = ( ) =>
    Date.now() - offscreenEvidenceAt < OFFSCREEN_STALE_AFTER_MS;

// `force: true` bypasses the freshness short-circuit and always verifies via
// `getContexts` (recreating the document only if it is in fact gone). The
// recovery loop in `whenOffscreenReady` needs this: a document can die while
// its last ping is still inside the freshness window, and the fast path would
// then return without recreating it for up to `OFFSCREEN_STALE_AFTER_MS`.
// Normal callers -- the keepalive alarm and boot -- leave `force` off so they
// keep skipping the `getContexts` IPC while the evidence is fresh.
function ensureOffscreenDocument({ force = false } = {}) {
    if ( offscreenPromise !== undefined ) { return offscreenPromise; }
    if ( force === false && offscreenIsFresh() ) { return Promise.resolve(); }
    offscreenPromise = (async ( ) => {
        try {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: [ 'OFFSCREEN_DOCUMENT' ],
            });
            if ( Array.isArray(contexts) && contexts.length !== 0 ) {
                offscreenEvidenceAt = Date.now();
                return;
            }
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_PAGE,
                reasons: [ 'WORKERS' ],
                justification: 'Host web workers and keep the filtering engines resident, neither of which a service worker can do on its own',
            });
            offscreenEvidenceAt = Date.now();
        } catch (reason) {
            // Most likely another invocation won the race to create it.
            // No evidence was recorded, so the next tick re-checks.
            console.info(`uBO: offscreen document: ${reason}`);
        }
    })().finally(( ) => {
        offscreenPromise = undefined;
    });
    return offscreenPromise;
}

chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: 0.5,
});

// uBO's own listener pushes every alarm name onto `µb.alarmQueue`; unrecognized
// names fall through the switch in `start.js` harmlessly.
chrome.alarms.onAlarm.addListener(alarm => {
    if ( alarm.name !== KEEPALIVE_ALARM ) { return; }
    ensureOffscreenDocument();
});

chrome.runtime.onMessage.addListener((message, sender, callback) => {
    if ( message?.what !== 'mv3ShimsKeepalive' ) { return; }
    // A ping is itself evidence the document is alive.
    offscreenEvidenceAt = Date.now();
    callback();
    return false;
});

ensureOffscreenDocument();

/******************************************************************************/

// Pre-warm at browser start. uBO's MV2 background page booted the moment
// the browser launched; an MV3 service worker starts only when an event
// requires one, so without a registered interest in `onStartup` the whole
// engine boot -- selfie hydration, or a full compile on a cold profile --
// would instead land on the user's first navigation. Registering the
// listener is itself what makes Chrome start the worker at launch; the
// callback has nothing to do, because merely evaluating this module graph
// runs uBO's boot: `src/js/start.js` kicks off its boot sequence at module
// scope. (Fired once per browser launch, not on service worker restarts.)
chrome.runtime.onStartup.addListener(( ) => { });

// Chrome dispatches the event which woke a terminated service worker as soon
// as the worker's initial evaluation finishes; a listener attached later --
// from a promise callback, or after a filter list has loaded -- never sees
// it. Two wake-capable listeners are registered exactly that way by uBO's
// boot sequence, which runs after every module has evaluated:
//
// - `chrome.contextMenus.onClicked`: attached by `vAPI.contextMenu.setEntries`
//   (platform/common/vapi-background.js), reached only from
//   `contextMenu.update()` at the END of src/js/start.js's async boot. The
//   menu entries themselves persist across service worker restarts, so the
//   menu is clickable at precisely the moment its handler is absent.
// - `chrome.runtime.onUpdateAvailable`: registered at the very same spot in
//   src/js/start.js, to decide whether an update should force a reload.
//
// Buffer the first event of each here, at module scope -- this file is the
// first thing the service worker evaluates -- and hand it to the real
// handler once one attaches. `mv3-post.js` does the wiring; it runs after
// uBO's modules have evaluated but before the async boot completes.

const earlyEvents = {
    contextMenuClick: null,
    contextMenuListener: null,
    contextMenuStoodDown: false,
    updateAvailable: null,
    updateAvailableListener: null,
    updateAvailableStoodDown: false,
};

if ( chrome.contextMenus instanceof Object &&
     typeof chrome.contextMenus.onClicked?.addListener === 'function' ) {
    earlyEvents.contextMenuListener = (info, tab) => {
        if ( earlyEvents.contextMenuStoodDown ) { return; }
        // One is enough: a click means "wake up and do this".
        if ( earlyEvents.contextMenuClick !== null ) { return; }
        earlyEvents.contextMenuClick = { info, tab };
    };
    chrome.contextMenus.onClicked.addListener(earlyEvents.contextMenuListener);
}

if ( typeof chrome.runtime?.onUpdateAvailable?.addListener === 'function' ) {
    earlyEvents.updateAvailableListener = details => {
        if ( earlyEvents.updateAvailableStoodDown ) { return; }
        if ( earlyEvents.updateAvailable !== null ) { return; }
        earlyEvents.updateAvailable = details;
    };
    chrome.runtime.onUpdateAvailable.addListener(
        earlyEvents.updateAvailableListener
    );
}

// Consumed by mv3-post.js. `replayContextMenuClick(handler)` stands the
// shim's listener down -- by then `setEntries` has registered the real one
// -- and delivers the buffered click to it, if any. `consumeUpdateAvailable()`
// stands its listener down and returns the buffered event, if any: the real
// listener registered by start.js and the hand-off happen within the same
// synchronous run of the boot sequence, so no event can slip in between and
// be handled twice.
export const mv3EarlyEvents = {
    replayContextMenuClick(handler) {
        if ( earlyEvents.contextMenuListener !== null ) {
            chrome.contextMenus.onClicked.removeListener(
                earlyEvents.contextMenuListener
            );
            earlyEvents.contextMenuListener = null;
        }
        earlyEvents.contextMenuStoodDown = true;
        const buffered = earlyEvents.contextMenuClick;
        earlyEvents.contextMenuClick = null;
        if ( buffered === null || typeof handler !== 'function' ) { return; }
        handler(buffered.info, buffered.tab);
    },
    consumeUpdateAvailable() {
        if ( earlyEvents.updateAvailableListener !== null ) {
            chrome.runtime.onUpdateAvailable.removeListener(
                earlyEvents.updateAvailableListener
            );
            earlyEvents.updateAvailableListener = null;
        }
        earlyEvents.updateAvailableStoodDown = true;
        const buffered = earlyEvents.updateAvailable;
        earlyEvents.updateAvailable = null;
        return buffered;
    },
};

/******************************************************************************/

// `Worker` is `[Exposed=(Window,DedicatedWorker,SharedWorker)]` -- a service
// worker cannot construct one. `src/js/assets.js` (diff updater) and
// `src/js/reverselookup.js` both need one, so proxy to a real Worker living in
// the offscreen document.
//
// BroadcastChannel rather than `chrome.runtime` messaging, because it is
// structured-clone rather than JSON: `reverselookup-worker.js` replies with
// `Object.create(null)` objects which must survive the round trip intact.
//
// The offscreen document outlives any number of service worker lifetimes, and
// every lifetime numbers its workers from 1 again. A relay keyed on the bare
// id therefore collides the moment a service worker dies without terminating
// its workers -- which is the norm, since its death takes the code that would
// terminate them (the reverse lookup worker's TTL timer lives in the service
// worker; the diff updater's worker has no cleanup at all). The next
// lifetime's first `create` was ignored by the offscreen document (id already
// hosted), every message after it was then routed to a stale worker of the
// WRONG kind, and both worker kinds silently ignore each other's messages --
// so a cycle of the asset updater would never complete and never reschedule:
// filter lists silently stopped updating. Two guards, one per side:
//
// - Every message carries an `epoch`, unique per service worker lifetime.
//   On a new epoch the offscreen document terminates every worker it hosts;
//   on a retired epoch (a straggler racing the new lifetime's first message)
//   it drops the message. Replies carry the epoch too, so a straggler reply
//   can never be mistaken for this lifetime's worker answering.
// - The watchdog below: a round trip with no reply has no other failure path
//   (the offscreen document vanished, a worker crashed before `onerror`
//   fired, a message was lost) and uBO's diff updater would wait forever.

if ( typeof Worker !== 'function' ) {
    const workerEpoch = crypto.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let workerIdGenerator = 1;
    const workers = new Map();
    const channel = new BroadcastChannel(WORKER_CHANNEL);

    channel.onmessage = ev => {
        const msg = ev.data;
        if ( msg instanceof Object === false ) { return; }
        // Replies from a previous service worker lifetime.
        if ( msg.epoch !== workerEpoch ) { return; }
        const worker = workers.get(msg.id);
        if ( worker === undefined ) { return; }
        switch ( msg.what ) {
        case 'message':
            worker.onReply(msg.data);
            break;
        case 'error':
            worker.onRelayError(msg.data);
            break;
        default:
            break;
        }
    };

    // A BroadcastChannel does not buffer, so a `create` sent before the
    // offscreen document has attached its own listener would be dropped.
    // Poll with `ping` until it answers `ready` -- this also covers the case of
    // the service worker restarting underneath an already-loaded document, and
    // thus one which will never announce itself again.
    let readyPromise;

    const whenOffscreenReady = ( ) => {
        if ( readyPromise !== undefined ) { return readyPromise; }
        readyPromise = new Promise((resolve, reject) => {
            let attempts = 50;
            const ping = ( ) => {
                if ( attempts-- === 0 ) {
                    clearInterval(timer);
                    channel.removeEventListener('message', onReady);
                    readyPromise = undefined;
                    return reject(new Error('offscreen document did not come up'));
                }
                // `force: true`: recover a document that died while its last
                // ping was still within the freshness window -- the fast path
                // would otherwise skip recreation until the evidence goes
                // stale.
                ensureOffscreenDocument({ force: true }).then(( ) => {
                    channel.postMessage({ what: 'ping' });
                });
            };
            const onReady = ev => {
                if ( ev.data?.what !== 'ready' ) { return; }
                channel.removeEventListener('message', onReady);
                clearInterval(timer);
                resolve();
            };
            channel.addEventListener('message', onReady);
            const timer = setInterval(ping, 200);
            ping();
        });
        return readyPromise;
    };

    // How long a round trip may take before the watchdog intervenes. The
    // reverse lookup worker computes in memory and normally answers in
    // milliseconds. The diff updater fetches patch files from a shuffled
    // list of CDNs, any of which may legally hang until the network stack
    // gives up on it, so its budget is minutes, not seconds.
    const WATCHDOG_TIMEOUT_MS = {
        rpc: 45 * 1000,
        updater: 180 * 1000,
        unknown: 60 * 1000,
    };

    // The watchdog understands the two worker protocols uBO actually runs,
    // learned from the traffic this class relays -- so that it fires only
    // when a round trip is genuinely outstanding:
    // - 'rpc' (`reverselookup-worker.js`): requests carry a numeric `id`,
    //   replies echo it; `setList`/`resetLists` posts expect no reply.
    // - 'updater' (`diff-updater.js`): requests are `{ what: 'update',
    //   assetKey, ... }` objects, each answered by the same object coming
    //   back with a `status`/`error` (or by `{ what: 'broken' }`, which
    //   ends the whole cycle); its unsolicited `{ what: 'ready' }` is not a
    //   reply to anything.
    const classifyRequest = data => {
        if ( data instanceof Object === false ) { return; }
        if ( data.what === 'update' ) { return 'updater'; }
        if ( typeof data.id === 'number' ) { return 'rpc'; }
    };

    self.Worker = class Worker {
        constructor(url) {
            this.url = url;
            this.onmessage = null;
            this.onerror = null;
            // Messages posted before the offscreen document is ready wait
            // here; once flushed, `null` means "relay directly".
            this.queue = [];
            // The id at the offscreen document. Changes when the watchdog
            // replaces a stalled worker, so a fresh `create` can never be
            // mistaken for the old one.
            this.hostedId = 0;
            // Outstanding round trips: numeric ids for 'rpc', asset keys
            // for 'updater'.
            this.open = new Set();
            this.protocol = 'unknown';
            // Everything ever relayed, in order. The retry replays the
            // conversation's preamble plus the still-open round trips from
            // this log -- a fresh worker has none of the context the old one
            // accumulated (compiled filter lists for the reverse lookup,
            // patch state for the diff updater).
            this.sent = [];
            this.retried = false;
            this.dead = false;
            this.watchdogTimer = 0;
            this.newHostedId();
            whenOffscreenReady().then(( ) => {
                if ( this.dead || workers.get(this.hostedId) !== this ) {
                    return;
                }
                channel.postMessage({
                    what: 'create',
                    epoch: workerEpoch,
                    id: this.hostedId,
                    url,
                });
                const queue = this.queue;
                this.queue = null;
                for ( const data of queue ) {
                    this.post(data);
                }
                // Round trips opened while the messages were queued have
                // had no chance of a reply yet -- arm the watchdog for them
                // like postMessage() does for the non-queued path.
                this.armWatchdog();
            }).catch(reason => {
                this.giveUp(`cannot host worker ${url}: ${reason.message}`);
            });
        }
        newHostedId() {
            if ( this.hostedId !== 0 ) { workers.delete(this.hostedId); }
            this.hostedId = workerIdGenerator++;
            workers.set(this.hostedId, this);
        }
        post(data) {
            channel.postMessage({
                what: 'message',
                epoch: workerEpoch,
                id: this.hostedId,
                data,
            });
        }
        postMessage(data) {
            if ( this.dead ) {
                this.deliverToDeadWorker(data);
                return;
            }
            this.sent.push(data);
            this.trackRequest(data);
            if ( this.queue !== null ) {
                this.queue.push(data);
                return;
            }
            this.post(data);
            this.armWatchdog();
        }
        terminate() {
            if ( this.hostedId !== 0 ) {
                workers.delete(this.hostedId);
                channel.postMessage({
                    what: 'terminate',
                    epoch: workerEpoch,
                    id: this.hostedId,
                });
                this.hostedId = 0;
            }
            this.dead = true;
            this.disarmWatchdog();
            this.open.clear();
            this.onmessage = null;
            this.onerror = null;
            this.queue = null;
            this.sent = [];
        }
        onReply(data) {
            // `{ what: 'ready' }` is `diff-updater.js` announcing itself,
            // not an answer to anything.
            if ( (data instanceof Object && data.what === 'ready') === false ) {
                this.trackResponse(data);
            }
            if ( this.onmessage === null ) { return; }
            this.onmessage({ data });
        }
        onRelayError(data) {
            if ( this.onerror !== null ) {
                this.onerror(data);
            }
            // The hosted worker threw an uncaught error; it will not answer
            // whatever is outstanding. Treat it as a watchdog timeout
            // rather than wait one out.
            if ( this.open.size !== 0 ) { this.onWatchdog(); }
        }
        trackRequest(data) {
            const protocol = classifyRequest(data);
            if ( protocol === undefined ) { return; }
            this.protocol = protocol;
            if ( protocol === 'updater' ) {
                if ( typeof data.assetKey === 'string' ) {
                    this.open.add(data.assetKey);
                }
                return;
            }
            this.open.add(data.id);
        }
        trackResponse(data) {
            if ( data instanceof Object === false ) { return; }
            if ( this.protocol === 'updater' ) {
                if ( data.what === 'broken' ) {
                    this.open.clear();
                } else if ( typeof data.assetKey === 'string' ) {
                    this.open.delete(data.assetKey);
                    // Retire every `update` message relayed for this asset.
                    // The diff updater answers each asset with an intermediate
                    // `needtext` and then a terminal `updated`/`error`; on
                    // `needtext`, assets.js re-posts the SAME asset as a fresh
                    // `update` carrying the fetched text (assets.js
                    // diffUpdater), so the original is now dead weight. This
                    // reply is tracked BEFORE onReply hands it to onmessage,
                    // hence before that re-post, so at most one live message
                    // per assetKey is ever kept. That is what makes a watchdog
                    // replay re-drive each outstanding asset exactly ONCE:
                    // replaying the two same-key `update`s a naive log holds
                    // would make the fresh worker answer the asset twice, and
                    // assets.js decrements `pendingOps` per reply -- the second
                    // pushes it below zero and wedges the cycle. Pruning also
                    // bounds `this.sent`, which terminate() would otherwise be
                    // the only thing to clear.
                    this.sent = this.sent.filter(entry =>
                        entry instanceof Object === false ||
                        entry.what !== 'update' ||
                        entry.assetKey !== data.assetKey
                    );
                }
            } else if ( this.protocol === 'rpc' ) {
                if ( typeof data.id === 'number' ) {
                    this.open.delete(data.id);
                    // Same memory bound for the reverse-lookup protocol: drop
                    // the answered request (its unique id never recurs). The
                    // id-less preamble -- `setList`/`resetLists` -- has no
                    // matching reply and stays, which is correct: a replay must
                    // resend it to prime a fresh worker.
                    this.sent = this.sent.filter(entry =>
                        entry instanceof Object === false ||
                        entry.id !== data.id
                    );
                }
            }
            if ( this.open.size === 0 ) {
                this.disarmWatchdog();
            } else {
                this.armWatchdog();
            }
        }
        armWatchdog() {
            if ( this.dead || this.open.size === 0 ) { return; }
            if ( this.watchdogTimer !== 0 ) { return; }
            this.watchdogTimer = setTimeout(( ) => {
                this.watchdogTimer = 0;
                this.onWatchdog();
            }, WATCHDOG_TIMEOUT_MS[this.protocol]);
        }
        disarmWatchdog() {
            if ( this.watchdogTimer === 0 ) { return; }
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = 0;
        }
        onWatchdog() {
            if ( this.dead || this.open.size === 0 ) { return; }
            const outstanding = [ ...this.open ].join(', ').slice(0, 200);
            if ( this.retried === false ) {
                this.retried = true;
                console.error(
                    `uBO: no reply from the ${this.url} worker for ` +
                    `${WATCHDOG_TIMEOUT_MS[this.protocol] / 1000}s ` +
                    `(outstanding: ${outstanding}); replacing the hosted ` +
                    `worker and replaying the unanswered round trips`
                );
                this.replaceHostedWorker();
                return;
            }
            this.giveUp(
                `no reply from the ${this.url} worker after a retry ` +
                `(outstanding: ${outstanding})`
            );
        }
        // What the retry replays: a fresh worker needs the conversation's
        // preamble (the reverse lookup's `setList`s), and the round trips
        // that are still open. Already-answered requests are NOT replayed:
        // the reverse lookup would throw on a reply for an id it has
        // forgotten, and the diff updater counts replies against
        // `pendingOps` -- a duplicate would push it below zero and hang the
        // cycle just as effectively as the stall being recovered from.
        // (`trackResponse` has already dropped answered and superseded
        // messages from `this.sent`, so this filter never sees a second
        // still-open message for the same assetKey to begin with.)
        shouldReplay(data) {
            if ( data instanceof Object === false ) { return true; }
            if ( this.protocol === 'updater' ) {
                if ( data.what === 'update' ) {
                    return typeof data.assetKey === 'string' &&
                           this.open.has(data.assetKey);
                }
                return true;
            }
            if ( this.protocol === 'rpc' ) {
                if ( typeof data.id === 'number' ) {
                    return this.open.has(data.id);
                }
                return true;
            }
            return true;
        }
        replaceHostedWorker() {
            this.disarmWatchdog();
            // Computed while `this.open` still holds the unanswered round
            // trips.
            const replay = this.sent.filter(data => this.shouldReplay(data));
            this.open.clear();
            if ( this.hostedId !== 0 ) {
                channel.postMessage({
                    what: 'terminate',
                    epoch: workerEpoch,
                    id: this.hostedId,
                });
            }
            this.newHostedId();
            // Posts made while the replacement is being set up are held in
            // the queue; they were tracked when posted, and are relayed
            // after the replay below, in order.
            this.queue = this.queue === null ? null : [];
            whenOffscreenReady().then(( ) => {
                if ( this.dead || workers.get(this.hostedId) !== this ) {
                    return;
                }
                channel.postMessage({
                    what: 'create',
                    epoch: workerEpoch,
                    id: this.hostedId,
                    url: this.url,
                });
                const queue = this.queue;
                this.queue = null;
                for ( const data of replay ) {
                    this.post(data);
                    this.trackRequest(data);
                }
                if ( queue !== null ) {
                    for ( const data of queue ) {
                        this.post(data);
                    }
                }
                this.armWatchdog();
            }).catch(reason => {
                this.giveUp(`cannot re-host worker ${this.url}: ${reason.message}`);
            });
        }
        // The relay can no longer deliver. Fail loudly -- the failure is
        // otherwise invisible, both consumers simply wait forever -- and,
        // where the relayed traffic has revealed which of uBO's two worker
        // protocols this worker speaks, synthesize the reply each one
        // already handles as "give up", so the caller unwinds instead of
        // hanging:
        // - 'rpc' (`reverselookup.js`): `{ id, response }` with an
        //   undefined response -- exactly what its own TTL timer resolves
        //   pending lookups with when it reaps the worker.
        // - 'updater' (`assets.js`): `{ what: 'broken' }` -- which makes
        //   the diff updater terminate the worker, resolve its cycle, and
        //   let the regular updater take over with full downloads.
        giveUp(reason) {
            if ( this.dead === false ) {
                console.error(`uBO: worker relay for ${this.url}: ${reason}`);
            }
            // Capture before terminate(): it clears the open set and
            // detaches the handlers.
            const onmessage = this.onmessage;
            // Nothing has been relayed yet, so the traffic could not reveal
            // the protocol -- fall back to the worker script, which the
            // shim knows because it is the one being asked to host it.
            // Without this, a diff updater whose relay never came up would
            // wait forever for the 'ready' it posts nothing before.
            const protocol = this.protocol !== 'unknown'
                ? this.protocol
                : ( this.url.includes('diff-updater') ? 'updater' : 'unknown' );
            const open = [ ...this.open ];
            this.terminate();
            // Keep the consumer's handler attached on this dead instance,
            // so its later posts can still be answered with a give-up
            // rather than silently dropped.
            this.onmessage = onmessage;
            if ( onmessage === null ) { return; }
            if ( protocol === 'rpc' ) {
                for ( const id of open ) {
                    onmessage({ data: { id, response: undefined } });
                }
            } else if ( protocol === 'updater' ) {
                onmessage({
                    data: { what: 'broken', error: `uBO: ${reason}` },
                });
            }
        }
        // A consumer keeps its Worker object even after the relay died; its
        // posts are answered with the same synthesized give-ups, so it
        // unwinds instead of silently waiting.
        deliverToDeadWorker(data) {
            if ( data instanceof Object && typeof data.id === 'number' ) {
                if ( this.onmessage !== null ) {
                    this.onmessage({ data: { id: data.id, response: undefined } });
                }
                return;
            }
            if ( data instanceof Object && data.what === 'update' ) {
                if ( this.onmessage !== null ) {
                    this.onmessage({
                        data: {
                            what: 'broken',
                            error: 'uBO: worker relay is down',
                        },
                    });
                }
                return;
            }
        }
    };
}

/******************************************************************************/

// `chrome.browserAction` became `chrome.action`. `platform/chromium/webext.js`
// and `platform/common/vapi-background.js` both reference the old name; they
// are deliberately left unmodified.

if ( chrome.browserAction === undefined ) {
    chrome.browserAction = chrome.action;
}
if ( chrome.browserAction === undefined ) {
    // Fail loudly rather than let platform/chromium/webext.js trip over an
    // undefined namespace with a much less obvious error.
    throw new Error('mv3-shims: unable to alias chrome.browserAction to chrome.action');
}

// `setIcon({ path })` is resolved by a `fetch()` inside this worker, not by the
// browser process, so uBO's root-relative `img/icon_*.png` paths would resolve
// against `/js/` and fail. See the `rootURL()` note at the top of this file.
// `chrome.browserAction` and `chrome.action` are the same object here, so this
// one patch covers both. `vapi-background.js` reaches this through
// `vAPI.setIcon()` on every toolbar update and `vAPI.setDefaultIcon()` at
// startup.
{
    const setIcon = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = function(details, ...args) {
        if ( details instanceof Object && details.path !== undefined ) {
            details = Object.assign({}, details);
            if ( typeof details.path === 'string' ) {
                details.path = rootURL(details.path);
            } else if ( details.path instanceof Object ) {
                const path = {};
                for ( const [ size, url ] of Object.entries(details.path) ) {
                    path[size] = rootURL(url);
                }
                details.path = path;
            }
        }
        return setIcon(details, ...args);
    };
}

// Two manifest keys changed shape in MV3, and uBO reads both:
// - `vapi-background.js` builds its toolbar tooltip from
//   `browser_action.default_title`
// - it also does `content_security_policy.indexOf("'wasm-unsafe-eval'")`, which
//   would throw on MV3's object-valued CSP
{
    const getManifest = chrome.runtime.getManifest.bind(chrome.runtime);
    let normalized;
    chrome.runtime.getManifest = function() {
        if ( normalized !== undefined ) { return normalized; }
        // Copy rather than mutate: what the bindings hand back is not ours.
        const manifest = Object.assign({}, getManifest());
        if ( manifest.browser_action === undefined ) {
            manifest.browser_action = manifest.action;
        }
        const csp = manifest.content_security_policy;
        if ( csp instanceof Object ) {
            manifest.content_security_policy = csp.extension_pages || '';
        }
        normalized = manifest;
        return normalized;
    };
}

/******************************************************************************/

// Hold requests while the filtering engines load, instead of cancelling them.
//
// uBO cannot decide anything until its filter lists are in memory, so
// `src/js/traffic.js` suspends network activity until they are. What "suspend"
// means is per-platform. Firefox returns a promise from the blocking listener
// and resolves it once the engines are ready
// (`platform/firefox/vapi-background-ext.js`). Chromium MV2 cannot defer a
// blocking decision at all, so `platform/chromium/vapi-background-ext.js`
// *cancels* every non-main-frame request instead and reloads the affected tabs
// afterwards -- which is why `vAPI.Net.canSuspend()` is false there, and why
// `suspendUntilListsAreLoaded` consequently defaults off on Chromium.
//
// MV3 changes that calculation twice over. The startup window now recurs on
// every service worker respawn rather than once per browser launch, so the
// cancel-and-reload cost is paid over and over instead of once. But MV3 also
// supplies the missing capability: Chromium honours a promise returned from a
// blocking `webRequest` listener when the extension is policy-installed -- the
// same installs which are the only ones granted `webRequestBlocking` in the
// first place. See docs/mv3-deployment.md.
//
// So on the install type this port targets, it can do exactly what Firefox
// does, and the two methods below are upstream's Firefox implementations.
// Everywhere else it falls back to the Chromium ones it replaced.

// Chromium gates async blocking on the extension being policy-installed, which
// `chrome.management.getSelf()` reports as an `admin` install type. It needs no
// `management` permission, but it is asynchronous -- and `canSuspend()` is
// consulted synchronously while `traffic.js` evaluates, so there is no way to
// have the answer before the first request can arrive. Requests in that window
// are parked optimistically and reconciled below if the bet was wrong.
let asyncBlockingAvailable;

// One entry per suspended request: the promise handed to Chromium, and the
// `resolve` which decides it. Keyed by `vAPI.Net` instance rather than held in
// a module-level array, so that the bookkeeping cannot outlive the object it
// belongs to. uBO only ever constructs one.
const pendingByNet = new WeakMap();

const pendingRequests = net => {
    let pending = pendingByNet.get(net);
    if ( pending === undefined ) {
        pendingByNet.set(net, (pending = []));
    }
    return pending;
};

// Feed requests we parked on a bet that turned out wrong back into uBO's
// bookkeeping. Chromium ignored the promises, so the requests themselves are
// already gone; what this recovers is the *accounting*. Filing them as
// unprocessed is what makes uBO show its `!` badge and reload the affected tabs
// once the engines are up -- exactly what the cancelling fallback would have
// produced, minus the cancellation.
//
// `onUnprocessedRequest()` rather than `onBeforeSuspendableRequest()`: the
// latter would run the real filtering listener if one had been installed in the
// meantime, double-counting a request which has already completed. Recording is
// all that is wanted here, and it is moot once uBO is up anyway.
const discardPendingRequests = net => {
    const pending = pendingByNet.get(net);
    if ( pending === undefined || pending.length === 0 ) { return; }
    pendingByNet.set(net, []);
    for ( const entry of pending ) {
        entry.resolve();
        net.onUnprocessedRequest(entry.details);
    }
};

const setAsyncBlockingAvailable = available => {
    asyncBlockingAvailable = available;
    if ( available ) { return; }
    console.info(
        'uBO: async blocking is unavailable, which normally means this is not ' +
        'a policy install. Network requests cannot be held while the filtering ' +
        'engines load; they will be cancelled and the affected tabs reloaded ' +
        'instead. See docs/mv3-deployment.md.'
    );
    if ( self.vAPI.net ) { discardPendingRequests(self.vAPI.net); }
};

try {
    chrome.management.getSelf()
        .then(info => setAsyncBlockingAvailable(info?.installType === 'admin'))
        .catch(( ) => setAsyncBlockingAvailable(false));
} catch {
    setAsyncBlockingAvailable(false);
}

// Maps each patched method back to the one it replaced, so that patching a
// subclass finds the *original* implementation rather than the patch installed
// on its base. Without this, a future `vAPI.Net` subclass which does not define
// its own `suspendOneRequest()` would inherit the patched one, capture it as its
// own fallback, and recurse forever.
const netOriginals = new WeakMap();
const netUnpatch = fn => netOriginals.get(fn) || fn;

const patchedNetClasses = new WeakSet();

const patchNetClass = ctor => {
    if ( typeof ctor !== 'function' ) { return ctor; }
    if ( patchedNetClasses.has(ctor) ) { return ctor; }
    patchedNetClasses.add(ctor);

    const proto = ctor.prototype;
    const baseSuspendOne = netUnpatch(proto.suspendOneRequest);
    const baseUnsuspendAll = netUnpatch(proto.unsuspendAllRequests);

    proto.suspendOneRequest = function(details) {
        if ( asyncBlockingAvailable === false ) {
            return baseSuspendOne.call(this, details);
        }
        const entry = {
            details: Object.assign({}, details),
            resolve: undefined,
            promise: undefined,
        };
        entry.promise = new Promise(resolve => { entry.resolve = resolve; });
        pendingRequests(this).push(entry);
        return entry.promise;
    };

    proto.unsuspendAllRequests = function(discard = false) {
        const pending = pendingByNet.get(this);
        if ( pending !== undefined && pending.length !== 0 ) {
            pendingByNet.set(this, []);
            for ( const entry of pending ) {
                entry.resolve(discard !== true
                    ? this.onBeforeSuspendableRequest(entry.details)
                    : undefined
                );
            }
        }
        // Still upstream's job: reload the tabs whose requests went unprocessed.
        // Nothing was recorded as unprocessed on the path above, so this is a
        // no-op whenever the parking worked.
        return baseUnsuspendAll.call(this, discard);
    };

    netOriginals.set(proto.suspendOneRequest, baseSuspendOne);
    netOriginals.set(proto.unsuspendAllRequests, baseUnsuspendAll);

    // Own static, shadowing the inherited one. `src/js/traffic.js` reads this
    // synchronously to decide whether to suspend at module scope, which is the
    // earliest point at which the window can be closed, and `src/js/background.js`
    // derives the `suspendUntilListsAreLoaded` user setting default from it.
    //
    // Unconditionally true, even though async blocking may turn out to be
    // unavailable: the alternative is the status quo, where nothing is suspended
    // until user settings have been read from storage and requests up to that
    // point are simply let through. Suspending from the earliest moment and
    // falling back to cancelling is the safer of the two, and it is what a user
    // who leaves the setting alone would get on Firefox.
    ctor.canSuspend = ( ) => true;

    return ctor;
};

// `vAPI.Net` is assigned twice -- the base class in
// `platform/common/vapi-background.js`, then a subclass of it in
// `platform/chromium/vapi-background-ext.js` -- and only the second one is ever
// instantiated. Patch on assignment rather than at some later fixed point, so
// that whichever class ends up in place is the patched one, and so that the
// patch is visible to `src/js/background.js` when it evaluates in between.
{
    let NetClass;
    Object.defineProperty(self.vAPI, 'Net', {
        configurable: true,
        enumerable: true,
        get: ( ) => NetClass,
        set: ctor => { NetClass = patchNetClass(ctor); },
    });
}

/******************************************************************************/

// `chrome.tabs.executeScript()`, `insertCSS()` and `removeCSS()` were replaced
// by `chrome.scripting`. `platform/chromium/webext.js` promisifies the old
// callback-style entry points, so provide them in that shape: a trailing
// callback, and errors surfaced via `chrome.runtime.lastError` rather than
// thrown. There are ~20 call sites across uBO, all of them going through
// `vAPI.tabs.executeScript` / `insertCSS` / `removeCSS`.

const targetFromDetails = details => {
    const target = { tabId: details.tabId };
    if ( typeof details.frameId === 'number' ) {
        target.frameIds = [ details.frameId ];
    } else if ( details.allFrames === true ) {
        target.allFrames = true;
    }
    return target;
};

// Scriptlet injection under MV3 has to reproduce what MV2's scriptlets
// observably did -- deliver on strict-CSP pages -- and live testing has now
// mapped the whole mechanism. MV2 never injected into the page's MAIN world:
// `chrome.tabs.executeScript({code})` ran the wrapper in that API's isolated
// world, whose element insertions were *exempt from the page's CSP*. That is
// the only world kind with the exemption, and the API is gone. On MV3:
// - a `<script>` element created from a static content-script world is
//   governed by the PAGE's CSP (blocked on `script-src 'self'` pages);
// - a `<script>` element created from a `chrome.scripting` ISOLATED world is
//   governed by that WORLD's own CSP, the extension's (no `unsafe-inline`:
//   blocked);
// - but the injected code itself -- func OR file, in ANY world -- always runs
//   CSP-exempt. Only element creation and eval consult a CSP.
//
// So no element is created at all, and no code string is executed anywhere
// (there is no API left for that: `chrome.userScripts` needs the per-
// extension "Allow user scripts" toggle nothing can pre-grant, and `eval()`
// is blocked in every world `chrome.scripting` can reach). Instead, the
// scriptlet *functions* -- which are static, all of them registered in
// `js/resources/scriptlets.js` -- ship as generated classic-script files,
// and the dynamic part (which functions to call, with which arguments) is
// handed to them out of band. The program `src/js/scriptlet-filtering.js`
// assembles is demoted from code to data (`mv3-post.js` prefixes it with a
// marker carrying the parsed calls for both worlds, the per-document
// scriptlet globals, the filters that fired and the logger channel name --
// see `./mv3-scriptlet-marker.js`), and `executeCode()` below performs, in
// MV2's own order -- relay, wrapper, isolated injector -- what MV2's single
// injection performed:
//
// 1. `ISOLATED`, beside `contentscript.js`: one func which installs the
//    scriptlet->logger relay -- MV2's `uBO_bcSecret` BroadcastChannel, which
//    carries log lines from the scriptlets (in the page) to `vAPI.messaging`
//    (which exists only here) -- applies MV2's once-per-document + hostname
//    guards, records `self.uBO_scriptletsInjected` where its two readers
//    (`src/js/contentscript.js`, `src/js/scriptlets/cosmetic-report.js`)
//    look for it, and hands each world's launch record to its library (see
//    step 2 for how). Its return value says whether this call won the right
//    to inject.
//
// 2. The generated sharded libraries, injected as FILES (CSP-exempt, no
//    elements, no eval). One `chrome.scripting` call per world that fired,
//    with a files array computed from the launch record's function names
//    through the `scriptletShards` manifest (generated at build time by
//    tools/patch-mv3-modules.mjs): the world's "shared" file (the
//    near-universal dependencies, which also parses the launch record onto
//    the transient `self.uBO_mv3Lib` registry), then -- main world only,
//    and only when a called scriptlet's dependency tree reaches for it --
//    the "heavy" shared file (the dependencies few families need, JSONPath
//    the largest of them), then every shard holding a called function,
//    then the world's "launch" file. In that order:
//    `files:` entries are injected in array order, and only the launch file
//    executes calls -- after every shard has registered its functions -- so
//    calls run in payload order, inside a single script evaluation, exactly
//    as MV2's one payload IIFE ran them (no microtask checkpoint can
//    interleave between calls). Both the sharding and the cross-file
//    registry protocol are documented in the generator.
//
//    - `js/mv3-mainworld-*.js`, into `world: 'MAIN'` -- the shared file,
//      shards and launcher for the main-world scriptlets. Every file is an
//      IIFE, so the page's global object keeps nothing but the transient
//      `uBO_mv3Lib` registry, which the launcher deletes. The launch record
//      reaches the shared file through the synchronous CustomEvent handshake
//      the func and the shared file run (fixed-name ready event, answer on an
//      unguessable per-record event id; Chromium structured-clones
//      `CustomEvent.detail` across worlds -- expando properties do not cross,
//      events do), so no state is ever left in the DOM.
//    - `js/mv3-scriptlet-*.js`, into `world: 'ISOLATED'` -- same shape for
//      the isolated-world scriptlets, launched from a stash the func leaves
//      at `self.uBO_mv3IsolatedLaunch` (same world, so no DOM round trip is
//      needed). This also retires the 38 persistent globals the first
//      monolithic isolated-world library installed: the functions live in
//      per-file IIFEs now, reachable only through the registry.
//
//    The two worlds' file injections run in parallel rather than in
//    sequence. Cross-world ordering has no observable semantics here: each
//    world is its own JS environment, the launch record is written by the
//    func BEFORE either files call and is read only by the MAIN-world
//    files, the stash is read only by the ISOLATED-world files, and no file
//    of either world touches the other's state. (MV2's sequence existed
//    only because both payloads were inserted by one synchronous
//    injection; within each world the files-array order above preserves
//    everything MV2's order carried.) Intra-world order is preserved by
//    `chrome.scripting`'s documented in-order injection of `files:`.
//
// The one observable difference from MV2 is the handshake itself: a
// fixed-name CustomEvent dispatched (and its unguessable-id answer received)
// during the MAIN-world shared file's evaluation, entirely synchronous. MV2's
// payload lived only inside a synchronously-removed `<script>` element; this
// leaves nothing in the DOM at any point, so MutationObservers see nothing
// either. A page hooking addEventListener before document_start could still
// observe the handshake's existence (not its payload -- the record travels
// on the fresh random id), a strictly smaller surface than MV3's earlier
// DOM-attribute channel. See docs/mv3-deployment.md.

// Passed to `chrome.scripting.executeScript({ func })`, which stringifies it
// -- so it must stay free of references to anything in this module's scope.
//
// The relay half mirrors `onScriptletMessageInjector` in
// `src/js/scriptlet-filtering.js`, the guards and markers mirror the
// Chromium `vAPI.scriptletsInjector` wrapper, and the two launch records
// stand in for the wrapper's element insertion and the isolated-world
// injector that ran after it -- so the observable state and the message
// handling behave exactly as they did under MV2. `name` is empty when the
// logger is off; MV2 injected no relay in that case either. `mainCalls` and
// `calls` carry uBOL-style interned arguments: their arg lists are index
// arrays into `args`, and the libraries resolve them before invoking (the
// encoding is chosen in `mv3-post.js`, see `internScriptletArgs` there).
const prepareScriptletInjection = (
    name, hostname, filters, isolatedOnly, mainCalls, args, globals, calls
) => {
    // Scriptlet -> logger relay. Idempotent, because a frame can be injected
    // into more than once (uBO re-injects when the logger's level changes, for
    // one). The handshake is order-proof: whichever side lands first, the
    // payload buffers its log lines until it hears 'iamready!'.
    if ( name !== '' && self.uBO_bcSecret === undefined ) {
        try {
            const bcSecret = new self.BroadcastChannel(name);
            bcSecret.onmessage = ev => {
                const msg = ev.data;
                switch ( typeof msg ) {
                case 'string':
                    if ( msg !== 'areyouready?' ) { break; }
                    bcSecret.postMessage('iamready!');
                    break;
                case 'object':
                    if ( self.vAPI && self.vAPI.messaging ) {
                        self.vAPI.messaging.send('contentscript', msg);
                    } else {
                        console.log(`[uBO][${msg.type}]${msg.text}`);
                    }
                    break;
                }
            };
            bcSecret.postMessage('iamready!');
            self.uBO_bcSecret = bcSecret;
        } catch {
        }
    }
    // Once-per-document + hostname guards, and the markers they leave behind.
    // A document with only isolated-world scriptlets never had
    // `uBO_scriptletsInjected` set under MV2 -- `vAPI.scriptletsInjector` was
    // not called for it, so the popup panel did not list those filters either
    // -- so `uBO_isolatedScriptlets` stands in for the same purpose instead.
    // When both worlds fired, MV2 left both markers; so does this.
    if ( isolatedOnly === true ) {
        if ( self.uBO_isolatedScriptlets === 'done' ) { return false; }
    } else if ( self.uBO_scriptletsInjected !== undefined ) {
        return false;
    }
    const doc = document;
    const loc = doc.location;
    if ( loc === null ) { return false; }
    if ( loc.hostname !== '' && loc.hostname !== hostname ) { return false; }
    // The wrapper's half: the main-world launch record. Handed to the
    // MAIN-world library files through a synchronous CustomEvent handshake
    // instead of a DOM data attribute: Chromium structured-clones
    // `CustomEvent.detail` across worlds (expando properties still do not
    // cross), so the record -- already plain data, it arrives here as
    // `executeScript` args -- travels as an event payload with no DOM
    // mutation at all. The MAIN-world shared file dispatches a fixed-name
    // 'uBOmv3MainReady' event whose detail is a fresh unguessable data-event
    // id; this listener, registered before that file can possibly run (it
    // injects in the second executeScript round, below), answers
    // synchronously with the record as that id's event detail, during the
    // shared file's own dispatchEvent. The library files are CSP-exempt
    // file-class injections, which is what makes scriptlets deliver on
    // strict-CSP pages exactly as MV2 delivered them. Skipped wholesale when
    // there are no main-world calls.
    if ( isolatedOnly !== true && Array.isArray(mainCalls) && mainCalls.length !== 0 ) {
        const record = { globals, args, calls: mainCalls };
        self.addEventListener('uBOmv3MainReady', ev => {
            const dataId = ev.detail;
            if ( typeof dataId !== 'string' ) { return; }
            ev.stopImmediatePropagation();
            self.dispatchEvent(new CustomEvent(dataId, { detail: record }));
        }, { once: true, capture: true });
        self.uBO_scriptletsInjected = filters;
    } else if ( isolatedOnly === true ) {
        self.uBO_isolatedScriptlets = 'done';
    }
    // The isolated-world injector's half: stash the calls for the library
    // file to consume. MV2 ran that injector after the wrapper in the same
    // program; the stash is its stand-in. Same world, so no DOM record is
    // needed.
    if ( Array.isArray(calls) && calls.length !== 0 ) {
        self.uBO_isolatedScriptlets = 'done';
        self.uBO_mv3IsolatedLaunch = { globals, args, calls };
    }
    return true;
};

// Scriptlet code arrives as a string carrying a marker; both are data, and
// only the func and the generated library files above ever execute.
//
// Compute the files array for one world's library injection: the shared
// file first, the shards holding called functions in name order, and the
// launcher last (files are injected in array order, and the launcher must
// run after every shard has registered its functions). Returns `undefined`
// when a called function cannot be located -- in which case the whole
// world's call set is dropped rather than running a partial one, the same
// all-or-nothing rule `parseScriptletCalls()` in `mv3-post.js` applies to
// the payload itself. `tools/verify-mv3-package.mjs` pins the manifest
// against the resource table, so this should be unreachable; the error is
// loud precisely so that it is not silently unreachable.
const libraryFilesFor = (world, calls) => {
    const spec = scriptletShards instanceof Object
        ? scriptletShards[world]
        : undefined;
    if (
        spec instanceof Object === false ||
        typeof spec.shared !== 'string' ||
        typeof spec.launch !== 'string' ||
        spec.fns instanceof Object === false
    ) {
        console.error(
            `uBO: the scriptlet shard manifest has no usable "${world}" ` +
            `section, so no ${world}-world scriptlet injection is possible. ` +
            `See tools/patch-mv3-modules.mjs.`
        );
        return undefined;
    }
    const shardFiles = new Set();
    for ( const call of calls ) {
        const file = spec.fns[call[0]];
        if ( typeof file !== 'string' ) {
            console.error(
                `uBO: scriptlet function "${call[0]}" is not in the ` +
                `"${world}" shard manifest; dropping the whole call set ` +
                `rather than running a partial one. See ` +
                `tools/patch-mv3-modules.mjs.`
            );
            return undefined;
        }
        if ( file !== spec.shared && file !== spec.launch ) {
            shardFiles.add(file);
        }
    }
    const files = [ spec.shared ];
    // The heavy half of the shared set is paid for only by navigations
    // whose called scriptlets (transitively) need something from it; the
    // manifest's neededBy list is exactly that root set, computed by the
    // generator from each root's dependency tree.
    const heavy = spec.heavy;
    if (
        heavy instanceof Object &&
        typeof heavy.file === 'string' &&
        Array.isArray(heavy.neededBy) &&
        calls.some(call => heavy.neededBy.includes(call[0]))
    ) {
        files.push(heavy.file);
    }
    for ( const file of [ ...shardFiles ].sort() ) {
        if ( files.includes(file) === false ) { files.push(file); }
    }
    files.push(spec.launch);
    return files;
};

// Per-frame injection failures are routine and self-correcting -- a frame
// navigated away or closed mid-injection, a restricted URL, a race with tab
// teardown -- so the executeScript calls below fall back rather than reject.
// But a genuine misconfiguration (a missing host permission, a bad library
// path) fails through the same catch, and swallowing it silently makes that
// indistinguishable from the benign case. Surface the reason, rate-limited to
// once a minute, so a persistent fault is diagnosable without flooding the
// console on a busy page.
let lastInjectionErrorAt = 0;
const logInjectionError = (where, reason) => {
    const now = Date.now();
    if ( now - lastInjectionErrorAt < 60000 ) { return; }
    lastInjectionErrorAt = now;
    console.error(`uBO: scriptlet injection failed (${where}): ${reason}`);
};

const executeCode = async details => {
    const target = targetFromDetails(details);
    const injectImmediately = details.runAt === 'document_start';

    let marker;
    try {
        marker = decodeScriptletMarker(details.code).details;
    } catch (reason) {
        console.error(`uBO: scriptlet filters marker: ${reason}`);
    }
    if ( marker === undefined ) {
        // With `mv3-post.js` in place, every scriptlet injection carries a
        // marker, including documents where only isolated-world scriptlets
        // fired. Anything else is not a scriptlet injection, and there is no
        // code-string API left to run it with -- so refuse rather than guess.
        console.error('uBO: code injection without a scriptlet marker was not injected');
        return [];
    }

    // The `filters` guard is not paranoia about a value uBO always supplies --
    // it is about what happens if it ever does not. `executeScript` serializes
    // args as JSON, so an absent `filters` would arrive as `null`, which is
    // `!== undefined` and so counts as a set marker; then
    // `cosmetic-report.js` does `matchedSelectors.push(...null)` and throws,
    // taking the popup's cosmetic report with it. An empty array degrades to
    // a harmless "no scriptlet filters to report".
    let filters = [];
    if ( Array.isArray(marker.filters) ) {
        filters = marker.filters;
    } else {
        console.error(
            `uBO: scriptlet filters marker carried no filter array: ${JSON.stringify(marker.filters)}`
        );
    }
    const calls = Array.isArray(marker.isolatedCalls)
        ? marker.isolatedCalls
        : [];
    const mainCalls = Array.isArray(marker.mainCalls)
        ? marker.mainCalls
        : [];
    // The interned-argument table both call sets index into (see
    // `internScriptletArgs` in mv3-post.js). Consumers resolve indices
    // before invoking.
    const args = Array.isArray(marker.args)
        ? marker.args
        : [];
    const globals = marker.scriptletGlobals instanceof Object
        ? marker.scriptletGlobals
        : {};
    if ( mainCalls.length === 0 && calls.length === 0 ) { return []; }

    // One func does everything MV2's single injection did, in its order:
    // relay, guards, the markers, the CustomEvent handshake listener for the
    // MAIN-world library and the stash for the isolated-world one. Its return value
    // says which frames won the right to inject -- `src/js/messaging.js`
    // treats `needScriptlets` (derived from `uBO_scriptletsInjected`) as
    // "nothing has been injected here yet", and for non-network URIs that
    // message is the *only* path which injects at all, so the marker must
    // never land in a frame whose injection then did not happen.
    // First of two chrome.scripting round trips: this func runs (guards,
    // markers, the DOM launch record), we await its result, then the library
    // files inject below. MV2 did both in one synchronous injection; MV3 has
    // no single call that runs a decision func AND conditionally injects files
    // from its result, so the split -- and the small window between the two --
    // is an accepted limitation, not a bug to collapse. See the design note
    // above.
    const prepared = await chrome.scripting.executeScript({
        target,
        injectImmediately,
        world: 'ISOLATED',
        func: prepareScriptletInjection,
        args: [
            typeof marker.bcSecret === 'string' ? marker.bcSecret : '',
            typeof marker.hostname === 'string' ? marker.hostname : '',
            filters,
            marker.isolatedOnly === true,
            mainCalls,
            args,
            globals,
            calls,
        ],
    }).catch(reason => { logInjectionError('prepare', reason); return []; });
    const frameIds = [];
    if ( Array.isArray(prepared) ) {
        for ( const result of prepared ) {
            if ( result?.result !== true ) { continue; }
            if ( typeof result.frameId !== 'number' ) { continue; }
            frameIds.push(result.frameId);
        }
    }
    if ( frameIds.length === 0 ) { return prepared; }
    const libraryTarget = { tabId: target.tabId, frameIds };

    // The sharded library files are extension-injected, so they run
    // CSP-exempt in their worlds -- no `<script>` element is ever created,
    // which is the whole point: every world MV3 offers governs elements
    // with some CSP, and MV2's element exemption died with
    // tabs.executeScript. Only the shards holding a called function are
    // injected (plus the always-needed shared file and the launcher), so a
    // typical 1-3-scriptlet navigation delivers a fraction of the whole
    // library instead of all of it.
    const injections = [ ];
    if ( mainCalls.length !== 0 ) {
        const files = libraryFilesFor('main', mainCalls);
        if ( files !== undefined ) {
            injections.push(chrome.scripting.executeScript({
                target: libraryTarget,
                injectImmediately,
                world: 'MAIN',
                files,
            }).catch(reason => {
                logInjectionError('main-world library', reason);
                return null;
            }));
        }
    }
    if ( calls.length !== 0 ) {
        const files = libraryFilesFor('isolated', calls);
        if ( files !== undefined ) {
            injections.push(chrome.scripting.executeScript({
                target: libraryTarget,
                injectImmediately,
                world: 'ISOLATED',
                files,
            }).catch(reason => {
                logInjectionError('isolated-world library', reason);
                return null;
            }));
        }
    }
    if ( injections.length === 0 ) { return prepared; }
    // The two worlds are injected in parallel -- see the design comment
    // above for why cross-world ordering carries no observable semantics.
    // The return value keeps the old shape: the results of the LAST world
    // that fired and succeeded (the isolated-world one when both did),
    // falling back to `prepared`.
    const results = await Promise.all(injections);
    let lastResults = prepared;
    for ( const result of results ) {
        if ( result !== null ) { lastResults = result; }
    }
    return lastResults;
};

const executeFile = async details => {
    // uBO passes both `/js/foo.js` and `js/foo.js`; MV2 accepted either.
    // `chrome.scripting` documents paths as relative to the extension root,
    // so normalize to that form. Everything runs in the `ISOLATED` world,
    // alongside `contentscript.js` -- the cross-world state the scriptlet
    // helpers read (`uBO_bcSecret`, `uBO_scriptletsInjected`) is written
    // there by `prepareScriptletInjection` above.
    const file = details.file.replace(/^\/+/, '');
    return chrome.scripting.executeScript({
        files: [ file ],
        target: targetFromDetails(details),
        injectImmediately: details.runAt === 'document_start',
    });
};

chrome.tabs.executeScript = function(tabId, details, callback) {
    const injection = Object.assign({ tabId }, details);
    const promise = typeof details.code === 'string'
        ? executeCode(injection)
        : executeFile(injection);
    promise.then(results => {
        // MV2 resolved to an array of raw return values, MV3 wraps each one in
        // an InjectionResult. uBO expects the MV2 shape.
        callback(Array.isArray(results) ? results.map(a => a?.result) : []);
    }).catch(( ) => {
        callback([]);
    });
};

const cssInjection = details => ({
    css: details.code,
    origin: details.cssOrigin === 'user' ? 'USER' : 'AUTHOR',
    target: targetFromDetails(details),
});

chrome.tabs.insertCSS = function(tabId, details, callback) {
    chrome.scripting.insertCSS(
        cssInjection(Object.assign({ tabId }, details))
    ).catch(( ) => {}).then(( ) => { callback(); });
};

chrome.tabs.removeCSS = function(tabId, details, callback) {
    chrome.scripting.removeCSS(
        cssInjection(Object.assign({ tabId }, details))
    ).catch(( ) => {}).then(( ) => { callback(); });
};

/******************************************************************************/
