/*******************************************************************************

    uBlock Origin (Sketchy MV3 fork) -- popup degraded-state banner.

    Fork-ADDED file. Copied into js/ by tools/make-chromium-mv3.sh and injected
    into popup-fenix.html by tools/patch-mv3-modules.mjs; it is not an upstream
    file, so it cannot conflict with the unattended upstream merge.

    Asks the service worker for the fork's network-filtering status
    (`mv3ForkStatus`) and, when filtering is degraded, prepends a warning banner
    to the popup so the failure is visible rather than console-only:

      - webRequest blocking not working  -> not policy-installed; the extension
                                            filters nothing.
      - async blocking not working       -> installType != 'admin'; cold-start
                                            requests are cancelled (and their
                                            tabs reloaded), not held.

    See platform/chromium-mv3/mv3-shims.js (the status channel) and
    docs/mv3-deployment.md.

*******************************************************************************/

/* global chrome */

'use strict';

// The fork's setup/troubleshooting documentation. A link, not a hard
// dependency: the banner is fully informative on its own if it 404s.
const DOC_URL =
    'https://github.com/Sketchystan1/uBlock/blob/master/docs/mv3-deployment.md';

/******************************************************************************/

// Ask the service worker for {webRequestBlocking, asyncBlocking}. MV3
// sendMessage returns a promise; a missing listener rejects with "Could not
// establish connection" -- treat any failure as "status unknown" and render
// nothing (assume healthy) rather than showing a false alarm.
const askStatus = ( ) => new Promise(resolve => {
    try {
        const p = chrome.runtime.sendMessage({ what: 'mv3ForkStatus' });
        if ( p && typeof p.then === 'function' ) {
            p.then(resolve, ( ) => resolve(undefined));
        } else {
            resolve(undefined);
        }
    } catch {
        resolve(undefined);
    }
});

/******************************************************************************/

const makeRow = (title, body) => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 10px;border-top:1px solid rgba(0,0,0,0.15);';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;';
    h.textContent = `⚠ ${title}`;
    const p = document.createElement('div');
    p.style.cssText = 'opacity:0.9;';
    p.textContent = body;
    row.append(h, p);
    return row;
};

const renderBanner = status => {
    if ( status instanceof Object === false ) { return; }
    const rows = [];
    if ( status.webRequestBlocking === false ) {
        rows.push(makeRow(
            'Network filtering INACTIVE',
            'webRequest blocking is not working — this build is not ' +
            'policy-installed, so nothing is being blocked.'
        ));
    }
    if ( status.asyncBlocking === false ) {
        rows.push(makeRow(
            'Async blocking off',
            'installType is not "admin": requests during engine cold-start ' +
            'are cancelled and their tabs reloaded, not held.'
        ));
    }
    if ( rows.length === 0 ) { return; }

    const banner = document.createElement('div');
    banner.id = 'uBO-mv3-status-banner';
    banner.setAttribute('role', 'alert');
    // Theme-agnostic: a translucent red wash over whatever the popup's own
    // background is, with the popup's own text colour. Works in light and dark.
    banner.style.cssText = [
        'background:rgba(200,0,0,0.14)',
        'color:inherit',
        'border-left:4px solid #b00000',
        'font-size:12px',
        'line-height:1.35',
        'box-sizing:border-box',
        'width:100%',
    ].join(';') + ';';

    const link = document.createElement('a');
    link.href = DOC_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Setup instructions ›';
    link.style.cssText =
        'display:block;padding:6px 10px;border-top:1px solid rgba(0,0,0,0.15);' +
        'color:inherit;font-weight:700;';

    for ( const row of rows ) { banner.append(row); }
    banner.append(link);

    // Prepend so it is the first thing seen. #main is the primary pane; fall
    // back to #panes or <body> so a popup markup change cannot drop the banner.
    const host = document.getElementById('main') ||
        document.getElementById('panes') ||
        document.body;
    if ( host === null ) { return; }
    host.prepend(banner);
};

/******************************************************************************/

const run = ( ) => { askStatus().then(renderBanner); };

if ( document.readyState === 'loading' ) {
    document.addEventListener('DOMContentLoaded', run, { once: true });
} else {
    run();
}
