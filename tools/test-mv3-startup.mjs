// Exercise the actual packaged first-install guard, including storage failure
// and reload ordering. Run by verify-mv3-package.mjs for each built package.
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
