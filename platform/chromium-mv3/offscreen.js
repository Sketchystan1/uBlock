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

    Offscreen document, serving two purposes for the MV3 service worker:

    1. Hosting web workers. `Worker` is exposed on Window, DedicatedWorker and
       SharedWorker -- but not on ServiceWorker. uBO needs one for its filter
       list diff updater (`src/js/assets.js`) and one for filter reverse lookup
       (`src/js/reverselookup.js`). We construct the real workers here and relay
       messages, which `mv3-shims.js` presents to uBO as a normal `Worker`.

       The relay uses BroadcastChannel rather than `chrome.runtime` messaging
       because it is structured-clone rather than JSON: `reverselookup-worker.js`
       replies with prototype-less objects which must survive the round trip.

    2. Keeping the service worker resident. Extension messages reset its 30s
       idle timer and there is no hard lifetime cap, so a periodic ping keeps
       uBO's filtering engines in memory instead of forcing a cold reload of
       every filter list on each wake-up.

**/

const WORKER_CHANNEL = 'uBO-worker-proxy';
const KEEPALIVE_PERIOD = 20000;

/******************************************************************************/

const channel = new BroadcastChannel(WORKER_CHANNEL);
const workers = new Map();

const announce = ( ) => {
    channel.postMessage({ what: 'ready' });
};

channel.onmessage = ev => {
    const msg = ev.data;
    if ( msg instanceof Object === false ) { return; }
    switch ( msg.what ) {
    case 'ping':
        announce();
        break;
    case 'create': {
        if ( workers.has(msg.id) ) { break; }
        const worker = new Worker(msg.url);
        workers.set(msg.id, worker);
        worker.onmessage = wev => {
            channel.postMessage({ what: 'message', id: msg.id, data: wev.data });
        };
        worker.onerror = wev => {
            channel.postMessage({
                what: 'error',
                id: msg.id,
                data: { message: wev.message, filename: wev.filename },
            });
        };
        break;
    }
    case 'message': {
        const worker = workers.get(msg.id);
        if ( worker === undefined ) { break; }
        worker.postMessage(msg.data);
        break;
    }
    case 'terminate': {
        const worker = workers.get(msg.id);
        if ( worker === undefined ) { break; }
        workers.delete(msg.id);
        worker.terminate();
        break;
    }
    default:
        break;
    }
};

// The service worker may have attached its listener before this document
// finished loading, in which case it is polling us with `ping`. It may also
// have restarted underneath an already-loaded document, in which case this
// announcement is what it is waiting for.
announce();

/******************************************************************************/

setInterval(( ) => {
    chrome.runtime.sendMessage({ what: 'mv3ShimsKeepalive' }).catch(( ) => {
        // The service worker is momentarily gone; the next tick will reach it.
    });
}, KEEPALIVE_PERIOD);

/******************************************************************************/
