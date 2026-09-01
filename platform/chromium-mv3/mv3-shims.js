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

/******************************************************************************/

const OFFSCREEN_PAGE = 'offscreen.html';
const KEEPALIVE_ALARM = 'mv3ShimsKeepalive';
const WORKER_CHANNEL = 'uBO-worker-proxy';

// uBO's scriptlets live in the `USER_SCRIPT` world, so the few scriptlet files
// which read state left behind by them must be injected there too. Everything
// else belongs in `ISOLATED`, alongside `contentscript.js`.
const reUserScriptWorldFiles = /\/scriptlet-loglevel-\d+\.js$/;

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
self.CSS = self.CSS || { supports: ( ) => true };

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
            const response = await fetch(url);
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

// The offscreen document does double duty: it hosts real Workers on uBO's
// behalf (see below), and it pings us every 20s. Per Chrome's service worker
// lifecycle docs, extension messages reset the 30s idle timer and there is no
// hard lifetime cap, so those pings keep the filtering engines resident. An
// alarm re-creates the document should it ever go away.

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

// Scriptlet code is assembled as a string, which only `userScripts` can inject.
const executeCode = async details => {
    if ( canUserScripts() === false ) { return []; }
    return chrome.userScripts.execute({
        js: [ { code: details.code } ],
        target: targetFromDetails(details),
        injectImmediately: details.runAt === 'document_start',
        world: 'USER_SCRIPT',
    });
};

const executeFile = async details => {
    // uBO passes both `/js/foo.js` and `js/foo.js`; MV2 accepted either.
    // `chrome.scripting` and `chrome.userScripts` both document paths as
    // relative to the extension root, so normalize to that form.
    const file = details.file.replace(/^\/+/, '');
    if ( reUserScriptWorldFiles.test(`/${file}`) ) {
        if ( canUserScripts() === false ) { return []; }
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
