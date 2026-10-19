// Exercise the packaged upstream engine and MV3 adapter together. Browser I/O
// is stubbed; filter lookup, compilation, globals and per-frame selection are
// the actual shipped code. Run by verify-mv3-package.mjs on every build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const pkgDir = path.resolve(process.argv[2] || 'dist/build/uBlock0.chromium-mv3');
const read = name => fs.readFileSync(path.join(pkgDir, `js/${name}.js`), 'utf8');
const makeScriptlets = await import(pathToFileURL(path.join(pkgDir, 'js/make-scriptlets.js')));
const plain = value => JSON.parse(JSON.stringify(value));
const withoutImports = src => src.replace(/^import\b[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
const broadcasts = [];
const injections = [];
const storage = {};
let secret = 0;
let firewallRules = [];
let trusted = false;
const main = { name: 'main-probe.js', fn: function mainProbe() {}, world: 'MAIN' };
const isolated = { name: 'isolated-probe.js', fn: function isolatedProbe() {}, world: 'ISOLATED' };
const resources = new Map([ main, isolated ].map(entry => [ entry.name, {
    js: entry.fn.toString(), world: entry.world, priority: 0,
} ]));
const pageStore = {
    tabHostname: 'example.com',
    isTrusted: () => trusted,
    getEffectiveFrameURL: () => 'https://example.com/frame',
    getFrameAncestorDetails: () => [ { hostname: 'parent.test', domain: 'parent.test' } ],
};
const ubo = {
    readyToFilter: false,
    hiddenSettings: {},
    userSettings: {},
    trustedSites: { getMatcher: () => ({ match() {}, data: new Map() }) },
    pageStoreFromTabId: () => pageStore,
};
const context = vm.createContext({
    URL, console, structuredClone,
    self: { crypto: webcrypto },
    makeScriptlets,
    builtinScriptlets: [ main, isolated ],
    hostnameFromURI: url => new URL(url).hostname,
    domainFromHostname: hostname => hostname.split('.').slice(-2).join('.'),
    entityFromHostname: (hostname, domain) => hostname.slice(0, -domain.split('.').at(-1).length) + '*',
    vAPI: {
        getURL: value => `chrome-extension://test${value}`,
        warSecret: { long: value => value || 'war-secret' },
        generateSecret: () => `logger-${++secret}`,
        webextFlavor: { soup: new Set() },
        defer: { create: () => ({ off() {}, onidle() {}, ongoing: () => false }) },
        tabs: { query: async () => [] },
    },
    logger: { enabled: true },
    onBroadcast: fn => { broadcasts.push(fn); return {}; },
    sessionFirewall: { export1stPartyRules: () => firewallRules },
    redirectEngine: { resources: new Map(), contentFromName: name => resources.get(name) },
    cacheStorage: {
        get: async () => storage,
        set: async data => Object.assign(storage, data),
        remove: key => { delete storage[key]; },
    },
    fetch: async url => ({ text: async () => fs.readFileSync(path.join(pkgDir, url.slice(1)), 'utf8') }),
    µb: ubo,
    scriptletShards: {
        main: { fns: { mainProbe: 'main.js' } },
        isolated: { fns: { isolatedProbe: 'isolated.js' } },
    },
    mv3InjectScriptlets: details => { injections.push(details); return details; },
});
const run = src => vm.runInContext(src, context);
const scripting = run(withoutImports(read('vapi-scripting')) + '\n' +
    '({ registerContentScripts, unregisterContentScripts, onGetContentScripts, reset, mv3RegisteredScriptletGlobals });');
context.scripting = scripting;
context.mv3RegisteredScriptletGlobals = scripting.mv3RegisteredScriptletGlobals;
run(withoutImports(read('static-ext-filtering-db')));
run(withoutImports(read('scriptlet-filtering-core')));
const engineSource = read('scriptlet-filtering');
const perHostname = engineSource.includes('scripting.onGetContentScripts(');
const engine = run(withoutImports(engineSource).replace(/^default scriptletFilteringEngine;\r?$/m, 'scriptletFilteringEngine;'));

if ( perHostname ) {
    assert.deepEqual(plain(run('[ templateBegin, templateCore, templateEnd ]')),
        [ 'scriptlet-begin.template', 'scriptlet.template', 'scriptlet-end.template' ].map(read),
        'embedded templates must match the bundled files byte for byte');
}

const post = read('mv3-post');
// Source checkouts may use CRLF; locate the same delimiter after normalizing.
const normalizedPost = post.replace(/\r\n/g, '\n');
const regionStart = normalizedPost.indexOf('const reScriptletDocumentURL =');
const regionEnd = normalizedPost.indexOf('\n{\n    const tabs = vAPI.tabs;', regionStart);
assert.ok(regionStart !== -1 && regionEnd > regionStart, 'per-frame injection region exists');
const inject = run(normalizedPost.slice(regionStart, regionEnd) + '\ninjectFrameScriptlets;');
const add = (hostname, name, arg = hostname, exception = false) =>
    engine.scriptletDB.store(hostname, `${exception ? '-' : '+'}${JSON.stringify([ name, arg ])}`);
const details = { tabId: 1, frameId: 0, url: 'https://example.com/page', documentId: 'doc-1' };
const calls = result => [ ...result.mainCalls, ...result.isolatedCalls ].map(([ name, indices ]) =>
    [ name, indices.map(i => result.args[i]) ]);
const refresh = async what => {
    for ( const fn of broadcasts ) { fn({ what }); }
    // The preceding registration API restores globals from async cache storage.
    await new Promise(resolve => setImmediate(resolve));
};

add('example.com', 'main-probe', 'specific');
add('example.*', 'isolated-probe', 'entity');
add('example.com/special', 'main-probe', 'path');
add('parent.test>>', 'main-probe', 'ancestor');
add('other.test', 'main-probe', 'other');
await engine.freeze();
assert.equal(inject(details), undefined, 'do not prepare scripts before the engine is ready');
ubo.readyToFilter = true;
let result = inject(details);
assert.deepEqual(plain(result.target), { tabId: 1, documentIds: [ 'doc-1' ] });
assert.deepEqual(plain(calls(result)).sort(), [
    [ 'mainProbe', [ 'ancestor' ] ], [ 'mainProbe', [ 'specific' ] ], [ 'isolatedProbe', [ 'entity' ] ],
].sort(), 'hostname, entity and ancestor rules select only matching calls');
assert.equal(result.globals.warSecret, 'war-secret');
assert.equal(result.globals.logLevel, 1);
const firstGlobals = result.globals;
assert.equal(inject(details).globals, firstGlobals, 'reuse globals for the hostname');
result = inject({ ...details, url: 'https://example.com/special' });
assert.ok(calls(result).some(([, args]) => args[0] === 'path'), 'path matching is per frame, even with cached globals');
assert.ok(inject({ ...details, frameId: 1, url: 'about:blank' }), 'about: frames use their effective URL');
assert.equal(inject({ ...details, url: 'data:text/html,test' }), undefined);
assert.equal(inject({ ...details, tabId: -1 }), undefined);
trusted = true;
assert.equal(inject(details), undefined, 'trusted sites bypass injection');
trusted = false;

firewallRules = [ [ 'example.com', true ] ];
await refresh('filteringBehaviorChanged');
assert.equal(inject(details), undefined, 'firewall allow changes invalidate the snapshot');
firewallRules = [];
await refresh('filteringBehaviorChanged');
assert.ok(inject(details), 'removing the allow rule restores injection');
context.logger.enabled = false;
await refresh('loggerDisabled');
assert.equal(inject(details).bcSecret, '', 'logger disable clears its secret');
context.logger.enabled = true;
await refresh('loggerEnabled');
assert.notEqual(inject(details).globals.bcSecret, firstGlobals.bcSecret, 'logger restart gets a fresh secret');

add('example.com', 'main-probe', 'specific', true);
assert.equal(calls(inject(details)).some(([, args]) => args[0] === 'specific'), false, 'scriptlet exception wins');
engine.scriptletDB.store('example.com', '-[]');
assert.equal(inject(details), undefined, 'blanket exception suppresses every scriptlet');
await engine.reset();
assert.equal(inject(details), undefined, 'engine reset clears all injections');
add('example.com', 'main-probe', 'after-reload');
await engine.freeze();
const selfie = structuredClone(engine.toSelfie());
assert.ok(inject(details), 'filter reload rearms injection');
// Restore into an empty DB, as happens on worker startup. Old registration
// builds also need their persisted compiled program, which reset removes.
const savedStorage = { ...storage };
await engine.reset();
Object.assign(storage, savedStorage);
assert.equal(await engine.fromSelfie(selfie), true);
assert.deepEqual(plain(calls(inject(details))), [ [ 'mainProbe', [ 'after-reload' ] ] ], 'selfie restore rearms injection');

if ( perHostname ) {
    const beforeEviction = scripting.mv3RegisteredScriptletGlobals(details.url);
    for ( let i = 0; i < 130; i++ ) {
        scripting.mv3RegisteredScriptletGlobals(`https://host${i}.test/`);
    }
    assert.notEqual(scripting.mv3RegisteredScriptletGlobals(details.url), beforeEviction, 'hostname cache is bounded');
}
assert.ok(injections.length > 0);
console.log('Scriptlet runtime checks passed: templates, selection, exceptions, frames, firewall, logger, reload and selfie.');
