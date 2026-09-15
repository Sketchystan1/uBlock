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
       Because this document outlives any number of service worker lifetimes,
       and each lifetime numbers its workers from 1 again, every relay message
       carries a per-lifetime `epoch` -- see `adoptWorkerEpoch()` below.

    2. Keeping the service worker resident. Extension messages reset its 30s
       idle timer and there is no hard lifetime cap, so a periodic ping keeps
       uBO's filtering engines in memory instead of forcing a cold reload of
       every filter list on each wake-up.

**/

/* global chrome */

const WORKER_CHANNEL = 'uBO-worker-proxy';
const KEEPALIVE_PERIOD = 20000;

/******************************************************************************/

const channel = new BroadcastChannel(WORKER_CHANNEL);
const workers = new Map();

// The service worker restarts underneath this document, and every lifetime
// numbers its workers from 1 again. Relay messages therefore carry an
// `epoch` unique to the service worker lifetime that sent them:
//
// - a message with a NEW epoch means the previous service worker died
//   without terminating its workers -- which is the norm, since its death
//   took the code that would terminate them (the reverse lookup worker's
//   TTL timer lives in the service worker; the diff updater's worker has
//   no cleanup at all). Terminate them all: they hold megabytes of
//   compiled filter lists and answer to nobody.
// - a message with a RETIRED epoch is a straggler from a lifetime we have
//   already replaced, racing the new one's first message. Adopting it back
//   would tear down the new lifetime's freshly created workers, so drop it.
//
// Replies are stamped with the epoch of the worker that produced them, so
// the service worker can never mistake a straggler reply for its own
// worker answering.
let workerEpoch = '';
const retiredEpochs = new Set();

const retireEpoch = epoch => {
    if ( epoch === '' ) { return; }
    retiredEpochs.add(epoch);
    // Bounded: an epoch can never come back, but a document that outlives
    // many service worker lifetimes must not accumulate them forever.
    if ( retiredEpochs.size > 16 ) {
        retiredEpochs.delete(retiredEpochs.values().next().value);
    }
};

const terminateAllWorkers = ( ) => {
    for ( const worker of workers.values() ) {
        worker.terminate();
    }
    workers.clear();
};

const createWorker = (id, url) => {
    const worker = new Worker(url);
    workers.set(id, worker);
    worker.onmessage = wev => {
        channel.postMessage({
            what: 'message',
            epoch: workerEpoch,
            id,
            data: wev.data,
        });
    };
    worker.onerror = wev => {
        channel.postMessage({
            what: 'error',
            epoch: workerEpoch,
            id,
            data: { message: wev.message, filename: wev.filename },
        });
    };
};

const adoptWorkerEpoch = epoch => {
    if ( typeof epoch !== 'string' || epoch === '' ) { return false; }
    if ( epoch === workerEpoch ) { return true; }
    if ( retiredEpochs.has(epoch) ) { return false; }
    if ( workerEpoch !== '' ) { retireEpoch(workerEpoch); }
    workerEpoch = epoch;
    terminateAllWorkers();
    return true;
};

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
    case 'create':
        if ( adoptWorkerEpoch(msg.epoch) === false ) { break; }
        {
            // An id reuse within one epoch means the service worker lost
            // track of the worker at that id -- its watchdog does this to
            // recover from a stalled round trip. Replace the hosted worker
            // rather than ignore the create, which is what once turned an
            // id collision into messages routed to a worker of the wrong
            // kind.
            const worker = workers.get(msg.id);
            if ( worker !== undefined ) { worker.terminate(); }
            createWorker(msg.id, msg.url);
        }
        break;
    case 'message': {
        if ( adoptWorkerEpoch(msg.epoch) === false ) { break; }
        const worker = workers.get(msg.id);
        if ( worker === undefined ) { break; }
        worker.postMessage(msg.data);
        break;
    }
    case 'terminate': {
        if ( adoptWorkerEpoch(msg.epoch) === false ) { break; }
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
