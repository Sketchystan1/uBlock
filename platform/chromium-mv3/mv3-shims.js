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
    - Injecting scriptlet code (arbitrary strings) requires `chrome.userScripts`,
      which requires the per-extension "Allow user scripts" toggle.
    See docs/mv3-deployment.md.

**/

// Must come before anything which may touch `self.lz4BlockCodec`. This file
// only assigns `self.LZ4BlockJS`, it has no DOM dependency.
import '../lib/lz4/lz4-block-codec-js.js';

// A pure module, safe to import here: it touches neither `chrome.*` nor the DOM,
// so it cannot depend on a shim this file has not installed yet.
import { decodeScriptletMarker } from './mv3-scriptlet-marker.js';

/******************************************************************************/

const OFFSCREEN_PAGE = 'offscreen.html';
const KEEPALIVE_ALARM = 'mv3ShimsKeepalive';
const WORKER_CHANNEL = 'uBO-worker-proxy';

// uBO's scriptlets live in the `USER_SCRIPT` world, so the few scriptlet files
// which read state left behind by them must be injected there too. Everything
// else belongs in `ISOLATED`, alongside `contentscript.js`.
const reUserScriptWorldFiles = /\/scriptlet-loglevel-\d+\.js$/;

/******************************************************************************/

// Relative URLs inside a service worker resolve against the *worker script's*
// URL -- here `chrome-extension://<id>/js/sw.js`, so the base directory is
// `/js/`, not the package root. uBO's background code was written for
// `background.html`, which sits at the root, so every relative path it hands to
// a web-platform API (`fetch`, and anything built on it) is off by one
// directory and 404s.
//
// Extension APIs are not affected: `chrome.scripting`/`chrome.userScripts`
// resolve `file:` against the extension root in the browser process. But
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
    // evaluated for real in the content script.
    createExpression() {
        return { evaluate() {} };
    },
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
// `<script>` elements. The pure-JS flavor is already imported at the top of
// this file; the wasm flavor is unreachable from a service worker and is not
// needed, since uBO's Chromium CSP leaves `vAPI.canWASM` false either way.

self.lz4BlockCodec = {
    createInstance: function() {
        if ( self.LZ4BlockJS instanceof Function === false ) {
            return Promise.resolve(null);
        }
        const instance = new self.LZ4BlockJS();
        return instance.init().then(ok => ok ? instance : null);
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

function ensureOffscreenDocument() {
    if ( offscreenPromise !== undefined ) { return offscreenPromise; }
    offscreenPromise = (async ( ) => {
        try {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: [ 'OFFSCREEN_DOCUMENT' ],
            });
            if ( Array.isArray(contexts) && contexts.length !== 0 ) { return; }
            await chrome.offscreen.createDocument({
                url: OFFSCREEN_PAGE,
                reasons: [ 'WORKERS' ],
                justification: 'Host web workers and keep the filtering engines resident, neither of which a service worker can do on its own',
            });
        } catch (reason) {
            // Most likely another invocation won the race to create it.
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
    callback();
    return false;
});

ensureOffscreenDocument();

/******************************************************************************/

// `Worker` is `[Exposed=(Window,DedicatedWorker,SharedWorker)]` -- a service
// worker cannot construct one. `src/js/assets.js` (diff updater) and
// `src/js/reverselookup.js` both need one, so proxy to a real Worker living in
// the offscreen document.
//
// BroadcastChannel rather than `chrome.runtime` messaging, because it is
// structured-clone rather than JSON: `reverselookup-worker.js` replies with
// `Object.create(null)` objects which must survive the round trip intact.

if ( typeof Worker !== 'function' ) {
    let workerIdGenerator = 1;
    const workers = new Map();
    const channel = new BroadcastChannel(WORKER_CHANNEL);

    channel.onmessage = ev => {
        const msg = ev.data;
        if ( msg instanceof Object === false ) { return; }
        if ( msg.what === 'ready' ) { return; }
        const worker = workers.get(msg.id);
        if ( worker === undefined ) { return; }
        switch ( msg.what ) {
        case 'message':
            if ( worker.onmessage === null ) { break; }
            worker.onmessage({ data: msg.data });
            break;
        case 'error':
            if ( worker.onerror === null ) { break; }
            worker.onerror(msg.data);
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
                ensureOffscreenDocument().then(( ) => {
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

    self.Worker = class Worker {
        constructor(url) {
            this.id = workerIdGenerator++;
            this.onmessage = null;
            this.onerror = null;
            this.queue = [];
            workers.set(this.id, this);
            whenOffscreenReady().then(( ) => {
                if ( workers.has(this.id) === false ) { return; }
                channel.postMessage({ what: 'create', id: this.id, url });
                const queue = this.queue;
                this.queue = null;
                for ( const data of queue ) {
                    channel.postMessage({ what: 'message', id: this.id, data });
                }
            }).catch(reason => {
                console.error(`uBO: cannot host worker ${url}: ${reason.message}`);
                workers.delete(this.id);
            });
        }
        postMessage(data) {
            if ( this.queue !== null ) {
                this.queue.push(data);
                return;
            }
            channel.postMessage({ what: 'message', id: this.id, data });
        }
        terminate() {
            workers.delete(this.id);
            this.onmessage = null;
            this.onerror = null;
            this.queue = null;
            channel.postMessage({ what: 'terminate', id: this.id });
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

let userScriptsAvailable;

const canUserScripts = ( ) => {
    if ( userScriptsAvailable !== undefined ) { return userScriptsAvailable; }
    // The "Allow user scripts" toggle can be revoked while we are running, in
    // which case the namespace stays defined but its methods throw. This is the
    // availability check Chrome's own documentation recommends.
    try {
        chrome.userScripts.getScripts();
        userScriptsAvailable = true;
    } catch {
        userScriptsAvailable = false;
        console.error(
            'uBO: chrome.userScripts is unavailable, so scriptlet filters will not be injected. ' +
            'Enable "Allow user scripts" on this extension\'s details page in chrome://extensions.'
        );
    }
    return userScriptsAvailable;
};

/******************************************************************************/

// The `USER_SCRIPT` world has no `chrome.*` at all by default, which breaks
// uBO's scriptlet->logger bridge: the relay that `src/js/scriptlet-filtering.js`
// injects tests `self.vAPI && self.vAPI.messaging` and falls back to
// `console.log` when it is absent, so scriptlet log lines end up in the page
// console instead of uBO's logger.
//
// `configureWorld({ messaging: true })` exposes `chrome.runtime.sendMessage` in
// that world, which is enough to rebuild the one thing the relay asks for. This
// is the same mechanism upstream's own MV3 build uses -- see
// `platform/mv3/extension/js/background.js` -- and messages so sent arrive on
// `chrome.runtime.onUserScriptMessage`, which `mv3-post.js` forwards into
// `vAPI.messaging`.
//
// A `USER_SCRIPT` world is never privileged: it runs on the page's origin, and
// the code in it came from a filter list. `mv3-post.js` reflects that when it
// forwards, so this grants scriptlets no more authority than the MV2 content
// script relay had.

let userScriptWorldConfigured;

const configureUserScriptWorld = ( ) => {
    if ( userScriptWorldConfigured !== undefined ) {
        return userScriptWorldConfigured;
    }
    userScriptWorldConfigured = (async ( ) => {
        try {
            await chrome.userScripts.configureWorld({ messaging: true });
        } catch (reason) {
            // Not fatal: scriptlets still inject, they just cannot reach the
            // logger. Say so once rather than per injection.
            console.error(`uBO: userScripts.configureWorld: ${reason}`);
        }
    })();
    return userScriptWorldConfigured;
};

// Warm it during service worker startup rather than on the first injection.
// Scriptlets inject at `document_start`, racing the page's own scripts, and only
// the first injection of each worker lifetime would otherwise pay for this round
// trip -- which under MV3 means once per respawn, not once per browser launch.
// It also surfaces the "Allow user scripts" warning in the worker's console
// immediately, instead of only after the first page with scriptlet filters.
if ( canUserScripts() ) {
    configureUserScriptWorld();
}

// Prepended to every code injection into the `USER_SCRIPT` world. Idempotent,
// because a frame can be injected into more than once (uBO re-injects when the
// logger's level changes, for one). Deliberately minimal: `send()` is the only
// member of `vAPI.messaging` the injected relay touches, and the relay ignores
// the return value -- hence the `catch`, since `sendMessage()` rejects when the
// service worker is momentarily gone and an ignored rejection would surface as
// noise in the page's console.
const USER_SCRIPT_WORLD_PREAMBLE = [
    'if ( self.vAPI instanceof Object === false ) { self.vAPI = {}; }',
    'if ( self.vAPI.messaging instanceof Object === false ) {',
    '    self.vAPI.messaging = {',
    '        send: function(channel, msg) {',
    '            try {',
    '                return self.chrome.runtime.sendMessage({ channel, msg })',
    '                    .catch(( ) => {});',
    '            } catch {',
    '                return Promise.resolve();',
    '            }',
    '        },',
    '    };',
    '}',
].join('\n');

/******************************************************************************/

// Scriptlet injection has to straddle two worlds under MV3, and one bit of
// state has to straddle with it.
//
// `platform/common/vapi-background.js` leaves `vAPI.scriptletsInjector` for
// platform code to define, and its Chromium implementation returns a wrapper
// which does two things: it inserts the main-world scriptlet payload as a
// `<script>` element, and it records the filters that fired in
// `self.uBO_scriptletsInjected`. Under MV2 that wrapper ran in the same isolated
// world as `contentscript.js`, so two readers could see the marker:
// `src/js/contentscript.js` (to tell the background it already has scriptlets)
// and `src/js/scriptlets/cosmetic-report.js` (to list scriptlet filters in the
// popup's "extended" section).
//
// Under MV3 the wrapper is a code string, so only `chrome.userScripts` can
// inject it, and its only non-`MAIN` world is `USER_SCRIPT`. The `<script>`
// insertion is unaffected -- any world with DOM access can do it -- but the
// marker now lands somewhere neither reader can see.
//
// So `mv3-post.js` wraps `vAPI.scriptletsInjector` to prefix its output with the
// filters, and `executeCode()` below peels that off and replays the marker into
// the `ISOLATED` world through `chrome.scripting.executeScript({ func, args })` --
// which needs no code string, and therefore no `userScripts`. Both worlds then
// see what MV2's single world saw. `./mv3-scriptlet-marker.js` holds the wire
// format both ends share.

// Mirrors the guards in the Chromium `vAPI.scriptletsInjector` wrapper, so that
// the marker appears in the `ISOLATED` world under the same conditions it
// appears in the `USER_SCRIPT` one: once per document, and only if the document
// still is where the payload was computed for.
//
// Passed to `chrome.scripting.executeScript({ func })`, which stringifies it --
// so it must stay free of references to anything in this module's scope.
const markScriptletsInjected = (hostname, filters) => {
    if ( self.uBO_scriptletsInjected !== undefined ) { return; }
    const loc = document.location;
    if ( loc === null ) { return; }
    if ( loc.hostname !== '' && loc.hostname !== hostname ) { return; }
    self.uBO_scriptletsInjected = filters;
};

/******************************************************************************/

// Scriptlet code is assembled as a string, which only `userScripts` can inject.
const executeCode = async details => {
    const target = targetFromDetails(details);
    const injectImmediately = details.runAt === 'document_start';

    let code = details.code;
    let marker;
    try {
        const decoded = decodeScriptletMarker(code);
        code = decoded.code;
        marker = decoded.details;
    } catch (reason) {
        console.error(`uBO: scriptlet filters marker: ${reason}`);
    }

    if ( canUserScripts() === false ) { return []; }
    await configureUserScriptWorld();
    const results = await chrome.userScripts.execute({
        js: [ { code: `${USER_SCRIPT_WORLD_PREAMBLE}\n${code}` } ],
        target,
        injectImmediately,
        world: 'USER_SCRIPT',
    });

    // Replay the `self.uBO_scriptletsInjected` marker into the ISOLATED world --
    // but only now, having got this far, so that the marker means the same thing
    // it meant under MV2: the wrapper ran.
    //
    // Ordering matters more than it looks. `src/js/messaging.js` treats
    // `needScriptlets` (which is derived from this marker) as "nothing has been
    // injected here yet", and for non-network URIs -- `about:blank`, `data:`,
    // extension pages -- that message is the *only* path which injects at all.
    // Setting the marker on a failed injection, or before one, would therefore
    // not merely mislead the popup panel: it would silently drop scriptlets in
    // those frames. Hence after the await, and hence not at all when
    // `userScripts` is unavailable.
    //
    // Fire-and-forget from here: its two readers run later, and making the
    // scriptlets wait on bookkeeping would be the wrong trade.
    //
    // The `Array.isArray` guard is not paranoia about a value uBO always
    // supplies -- it is about what happens if it ever does not. `executeScript`
    // serializes args as JSON, so an absent `filters` would arrive as `null`,
    // which is `!== undefined` and so counts as a set marker; then
    // `cosmetic-report.js` does `matchedSelectors.push(...null)` and throws,
    // taking the popup's cosmetic report with it. Skipping the marker instead
    // degrades to the pre-fix behaviour, which is merely wasteful.
    if ( Array.isArray(marker?.filters) ) {
        chrome.scripting.executeScript({
            target,
            injectImmediately,
            world: 'ISOLATED',
            func: markScriptletsInjected,
            args: [ marker.hostname, marker.filters ],
        }).catch(( ) => {});
    } else if ( marker !== undefined ) {
        console.error(
            `uBO: scriptlet filters marker carried no filter array: ${JSON.stringify(marker)}`
        );
    }

    return results;
};

const executeFile = async details => {
    // uBO passes both `/js/foo.js` and `js/foo.js`; MV2 accepted either.
    // `chrome.scripting` and `chrome.userScripts` both document paths as
    // relative to the extension root, so normalize to that form.
    const file = details.file.replace(/^\/+/, '');
    if ( reUserScriptWorldFiles.test(`/${file}`) ) {
        if ( canUserScripts() === false ) { return []; }
        await configureUserScriptWorld();
        return chrome.userScripts.execute({
            js: [ { file } ],
            target: targetFromDetails(details),
            injectImmediately: details.runAt === 'document_start',
            world: 'USER_SCRIPT',
        });
    }
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
