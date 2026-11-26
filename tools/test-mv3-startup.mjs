// Exercise the packaged first-install guard and startup-sensitive messages.
// Run by verify-mv3-package.mjs for each built package.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const pkgDir = path.resolve(process.argv[2] || 'dist/build/uBlock0.chromium-mv3');
const source = fs.readFileSync(path.join(pkgDir, 'js/start.js'), 'utf8');
const match = /^([ \t]*)\/\/ https:\/\/github\.com\/uBlockOrigin\/uBlock-issues\/issues\/1547\r?\n\1if \( lastVersionInt === 0 && vAPI\.webextFlavor\.soup\.has\('chromium'\) \) \{\r?\n[\s\S]*?^\1\}/m.exec(source);
assert.ok(match, 'packaged first-install restart guard exists');

async function boot({ bin = {}, lastVersionInt = 0, chromium = true, writeFails = false } = {}) {
    const events = [];
    let saved;
    let finishWrite;
    const write = new Promise(resolve => { finishWrite = resolve; });
    const context = vm.createContext({
        lastVersionInt,
        vAPI: {
            app: { version: '1.75.1.16', restart: () => events.push('restart') },
            webextFlavor: { soup: new Set(chromium ? [ 'chromium' ] : []) },
            storage: { get: async () => bin },
        },
        chrome: { storage: { local: { set: async data => {
            events.push('write');
            if ( writeFails ) { throw new Error('storage unavailable'); }
            await write;
            saved = data;
            events.push('persisted');
        } } } },
        console: { error: () => events.push('error') },
    });
    const pending = vm.runInContext(`(async () => { ${match[0]}\nreturn 'continued'; })()`, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('restart'), false, 'never restart before the durable write completes');
    finishWrite();
    const result = await pending;
    return { events, saved, result };
}

const first = await boot();
assert.deepEqual(first.events, [ 'write', 'persisted', 'restart' ]);
assert.equal(first.result, undefined, 'restart ends this startup');
assert.equal(first.saved.version, '1.75.1.16');
assert.equal(first.saved.mv3FirstInstallRestarted, true);
assert.equal(typeof first.saved.versionUpdateTime, 'number');

for ( const options of [
    { bin: first.saved },
    { bin: null },
    { lastVersionInt: 1750016 },
    { chromium: false },
] ) {
    const result = await boot(options);
    assert.deepEqual(result.events, [], 'existing marker, failed read, upgrade or non-Chromium boot never restarts');
    assert.equal(result.result, 'continued');
}
const failed = await boot({ writeFails: true });
assert.deepEqual(failed.events, [ 'write', 'error' ]);
assert.equal(failed.result, 'continued', 'failed persistence continues startup without a reload loop');
console.log('Startup runtime checks passed: durable write, once-only restart, storage failures and normal boot.');

const messaging = fs.readFileSync(path.join(pkgDir, 'js/messaging.js'), 'utf8').replace(/\r\n/g, '\n');
const background = fs.readFileSync(path.join(pkgDir, 'js/vapi-background.js'), 'utf8').replace(/\r\n/g, '\n');
const promiseMessaging = background.includes('async onDispatch(request, sender) {');
const helper = /^const whenReady = \(\( \) => \{[\s\S]*?^\}\)\(\);/m.exec(messaging)?.[0];
assert.ok(helper, 'packaged message readiness guard exists');
const handlerSource = channel => {
    const start = messaging.indexOf(`//      ${channel}\n`);
    assert.ok(start !== -1, `${channel} channel exists`);
    const end = messaging.indexOf('// <<<<< end of local scope', start);
    assert.ok(end > start, `${channel} scope exists`);
    const region = messaging.slice(start, end);
    const handler = /^(?:async function onMessage|const onMessage = function)\(/m.exec(region);
    assert.ok(handler, `${channel} handler exists`);
    return region.slice(handler.index);
};
const flush = () => new Promise(resolve => setImmediate(resolve));

async function messageDuringStartup(channel, what, state, workFails = false) {
    let ready;
    let fail;
    let timeout;
    let listener;
    let calls = 0;
    let mutations = 0;
    const replies = [];
    const data = { tabId: 1, available: { test: true }, cache: {} };
    const work = () => {
        calls += 1;
        if ( workFails ) { throw new Error('operation failed'); }
        return data;
    };
    const mutate = () => { mutations += 1; return work(); };
    const rules = { copyRules: mutate };
    const context = vm.createContext({
        vAPI: {
            defer: { once: () => new Promise(resolve => { timeout = resolve; }) },
            messaging: { listen: details => {
                assert.equal(details.name, channel);
                assert.equal(details.privileged, true, 'startup guard preserves privileged channels');
                listener = details.listener;
            } },
        },
        µb: {
            isReadyPromise: new Promise((resolve, reject) => { ready = resolve; fail = reject; }),
            pageStoreFromTabId: () => ({ toggleTrustedStatus: mutate }),
            openNewTab: mutate,
            savePermanentFirewallRules: mutate,
            saveHostnameSwitches: mutate,
            toggleHostnameSwitch: mutate,
            toggleFirewallRule: mutate,
            updateToolbarIcon() {},
        },
        popupDataFromRequest: async () => work(),
        popupDataFromTabId: work,
        launchReporter: async () => { work(); return 'https://example.test/report'; },
        getLists: async callback => { const value = work(); callback?.(value); return value; },
        getElementCount: async () => 42,
        sessionFirewall: rules, permanentFirewall: rules,
        sessionSwitches: rules, permanentSwitches: rules,
        cosmeticFilteringEngine: { removeFromSelectorCache() {} },
    });
    vm.runInContext(`${helper}\n${handlerSource(channel)}`, context);
    const send = request => new Promise((resolve, reject) => {
        const receive = value => { replies.push(value); resolve(value); };
        const result = listener(request, {}, receive);
        if ( promiseMessaging ) { Promise.resolve(result).then(receive, reject); }
    });
    if ( channel === 'popupPanel' ) {
        assert.equal(await send({ what: 'getScriptCount', tabId: 1 }), 42,
            'unrelated popup commands do not wait for startup');
        replies.length = 0;
    }
    const pending = send({ what, tabId: 1, desHostnames: {} });
    await flush();
    assert.equal(calls, 0, `${what}: no work before readiness`);
    assert.equal(replies.length, 0, `${what}: no premature reply`);
    if ( state === 'ready' ) { ready(); }
    if ( state === 'failed' ) { fail(new Error('startup failed')); }
    if ( state === 'timeout' ) { timeout(); }
    const response = await pending;
    if ( state === 'ready' && workFails === false ) {
        assert.ok(calls > 0, `${what}: performs work after readiness`);
    } else if ( what === 'getLists' ) {
        assert.deepEqual(JSON.parse(JSON.stringify(response)), { available: {}, cache: {} });
    } else if ( what === 'getPopupData' && workFails ) {
        assert.deepEqual(JSON.parse(JSON.stringify(response)), {});
    }
    if ( state !== 'ready' ) {
        assert.equal(mutations, 0, `${what}: failed startup never mutates state`);
        const beforeLateReadiness = calls;
        ready();
        await flush();
        assert.equal(calls, beforeLateReadiness, `${what}: late readiness never replays a timed-out command`);
    }
    timeout();
    await flush();
    assert.equal(replies.length, 1, `${what}: answers exactly once`);
}

for ( const state of [ 'ready', 'failed', 'timeout' ] ) {
    for ( const what of [
        'getPopupData', 'launchReporter', 'revertFirewallRules', 'saveFirewallRules',
        'toggleHostnameSwitch', 'toggleFirewallRule', 'toggleTrustedStatus',
    ] ) {
        await messageDuringStartup('popupPanel', what, state);
    }
    await messageDuringStartup('dashboard', 'getLists', state);
}
for ( const [ channel, what ] of [
    [ 'popupPanel', 'getPopupData' ], [ 'popupPanel', 'launchReporter' ],
    [ 'dashboard', 'getLists' ],
] ) {
    await messageDuringStartup(channel, what, 'ready', true);
}

const post = fs.readFileSync(path.join(pkgDir, 'js/mv3-post.js'), 'utf8').replace(/\r\n/g, '\n');
const wrapper = /\{\n {4}const origHandler = vAPI\.messaging\.defaultHandler;[\s\S]*?\n\}/.exec(post)?.[0];
assert.ok(wrapper, 'packaged userSettings response wrapper exists');
for ( const callbacks of [ true, false ] ) {
    for ( const supported of [ true, false ] ) {
        const response = { cloudStorageEnabled: true, otherSetting: true };
        const context = vm.createContext({
            Object,
            µb: { cloudStorageSupported: supported },
            vAPI: { messaging: { defaultHandler: callbacks
                ? (request, sender, callback) => callback(response)
                : async () => response,
            } },
        });
        vm.runInContext(wrapper, context);
        const send = what => new Promise(resolve => {
            const result = context.vAPI.messaging.defaultHandler({ what }, {}, callbacks ? resolve : undefined);
            if ( callbacks === false ) { Promise.resolve(result).then(resolve); }
        });
        assert.equal(await send('otherCommand'), response, 'unrelated responses pass through');
        assert.equal(response.cloudStorageEnabled, true);
        assert.equal(await send('userSettings'), response);
        assert.equal(response.cloudStorageEnabled, supported ? true : undefined);
        assert.equal(response.otherSetting, true, 'unrelated settings are preserved');
    }
}
if ( promiseMessaging ) {
    const start = background.indexOf('vAPI.messaging = {');
    const end = background.indexOf('\n};', start);
    assert.ok(start !== -1 && end > start, 'upstream messaging transport exists');
    const context = vm.createContext({
        vAPI: { getURL: () => 'chrome-extension://test/' },
        ubolog() {},
    });
    vm.runInContext(background.slice(start, end + 3), context);
    const transport = context.vAPI.messaging;
    const sender = { origin: 'chrome-extension://test', url: 'chrome-extension://test/popup.html' };
    let calls = 0;
    transport.listen({ name: 'probe', privileged: true, listener: request => {
        calls += 1;
        return request.what;
    } });
    transport.setup(() => { calls += 1; });
    for ( const what of [ 'mv3ForkStatus', 'mv3ShimsKeepalive' ] ) {
        const replies = [];
        assert.equal(transport.onMessage({ what }, sender, response => replies.push(response)), undefined,
            `${what}: upstream leaves raw fork messages to their own listener`);
        await flush();
        assert.equal(replies.length, 0, `${what}: upstream never wins the response race`);
    }
    for ( const origin of [ 'chrome-extension://test', 'https://example.test' ] ) {
        const response = await new Promise(resolve => {
            assert.equal(transport.onMessage({ channel: 'probe', msg: { what: 'reply' } },
                { ...sender, origin }, resolve), true, 'upstream keeps its async response channel open');
        });
        assert.equal(response, origin === sender.origin ? 'reply' : undefined);
    }
    assert.equal(calls, 1, 'unprivileged and raw messages never reach privileged handlers');
}
console.log(`Messaging runtime checks passed (${promiseMessaging ? 'promises' : 'callbacks'}): readiness, timeout, failures, once-only replies, settings and dispatch.`);
