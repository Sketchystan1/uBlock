import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { controlFiles, planRelease, prepareRelease } from './make-mv3-release-tree.mjs';

function fixture(t, { collision = false } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ublock-release-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
        fs.rmSync(cwd, { recursive: true, force: true });
    });
    const git = (...args) => execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ],
    }).trim();
    const write = (name, contents) => {
        const dest = path.join(cwd, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, contents);
    };
    const read = name => fs.readFileSync(path.join(cwd, name), 'utf8');
    const commit = message => {
        git('add', '--all');
        git('commit', '-m', message);
        return git('rev-parse', 'HEAD');
    };
    git('init');
    git('config', 'user.name', 'MV3 test');
    git('config', 'user.email', 'mv3-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    write('Makefile', 'all:\n\t@echo upstream\n');
    write('src/engine.js', 'old upstream\n');
    if ( collision ) { write('GNUmakefile', 'owned by old upstream\n'); }
    const oldUpstream = commit('Old upstream');
    git('update-ref', 'refs/upstream-tags/1.0.0', oldUpstream);
    write('platform/runtime.js', 'legacy runtime\n');
    write('platform/legacy-only.js', 'legacy helper\n');
    write('dist/mv3-build', '501\n');
    const legacy = commit('Compatible legacy port');

    git('checkout', '--detach', oldUpstream);
    write('src/engine.js', 'new upstream\n');
    if ( collision ) { fs.unlinkSync(path.join(cwd, 'GNUmakefile')); }
    const upstream = commit('New upstream');
    git('update-ref', 'refs/remotes/upstream/master', upstream);
    git('update-ref', 'refs/upstream-tags/2.0.0', upstream);
    for ( const name of controlFiles ) { write(name, `current ${name}\n`); }
    write('platform/runtime.js', 'current runtime\n');
    write('platform/current-only.js', 'current helper\n');
    write('dist/mv3-build', '508\n');
    const config = { schemaVersion: 1, pins: {
        '1.0.0': { upstream: oldUpstream, port: legacy, reason: 'Tested legacy port' },
    } };
    write('dist/mv3-release-ports.json', JSON.stringify(config));
    const fork = commit('Current fork');
    return { cwd, git, read, write, commit, fork, upstream, oldUpstream, legacy, config };
}

test('pinned releases retain exact upstream and legacy runtime, with current tooling and a fresh version', t => {
    const f = fixture(t);
    const plan = planRelease({ cwd: f.cwd, tag: '1.0.0' });
    assert.equal(plan.port, f.legacy);
    assert.equal(f.git('rev-parse', 'HEAD'), f.fork, 'planning does not change the checkout');
    const result = prepareRelease({ cwd: f.cwd, tag: '1.0.0' });
    assert.equal(result.pinned, true);
    assert.equal(f.git('rev-parse', 'HEAD^'), f.oldUpstream);
    assert.equal(f.read('src/engine.js'), 'old upstream\n');
    assert.equal(f.read('platform/runtime.js'), 'legacy runtime\n');
    assert.equal(f.read('platform/legacy-only.js'), 'legacy helper\n');
    assert.equal(fs.existsSync(path.join(f.cwd, 'platform/current-only.js')), false);
    assert.equal(f.read('tools/make-crx.mjs'), 'current tools/make-crx.mjs\n');
    assert.equal(f.read('dist/mv3-build'), '508\n', 'do not reuse the legacy build number');
    const provenance = JSON.parse(f.read('dist/mv3-release.json'));
    assert.equal(provenance.upstream, f.oldUpstream);
    assert.equal(provenance.port, f.legacy);
    assert.equal(provenance.tooling, f.fork);
    assert.equal(f.git('diff', '--name-only', '--diff-filter=MDRT', f.oldUpstream, 'HEAD'), '');
});

test('unlisted upstream tags use the current port', t => {
    const f = fixture(t);
    const result = prepareRelease({ cwd: f.cwd, tag: '2.0.0' });
    assert.equal(result.pinned, false);
    assert.equal(result.port, f.fork);
    assert.equal(f.git('rev-parse', 'HEAD^'), f.upstream);
    assert.equal(f.read('platform/runtime.js'), 'current runtime\n');
});

test('upstream modifications fail before any checkout change', t => {
    const f = fixture(t);
    f.write('Makefile', 'changed upstream\n');
    const head = f.commit('Break overlay invariant');
    assert.throws(() => prepareRelease({ cwd: f.cwd, tag: '1.0.0' }), /modifies upstream files: Makefile/);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('moved upstream tags cannot silently reuse a compatibility pin', t => {
    const f = fixture(t);
    f.git('update-ref', 'refs/upstream-tags/1.0.0', f.upstream);
    assert.throws(() => prepareRelease({ cwd: f.cwd, tag: '1.0.0' }), /changed upstream tag/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.fork);
});

test('a pin for a different upstream base is rejected', t => {
    const f = fixture(t);
    f.config.pins['1.0.0'].port = f.fork;
    f.write('dist/mv3-release-ports.json', JSON.stringify(f.config));
    f.commit('Wrong port pin');
    assert.throws(() => prepareRelease({ cwd: f.cwd, tag: '1.0.0' }), /not based on upstream/);
});

test('fork additions cannot overwrite files owned by an old upstream tag', t => {
    const f = fixture(t, { collision: true });
    assert.throws(() => prepareRelease({ cwd: f.cwd, tag: '1.0.0' }), /would replace upstream files: GNUmakefile/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.fork);
});

test('preparing a release preserves uncommitted tracked work', t => {
    const f = fixture(t);
    f.write('platform/runtime.js', 'uncommitted work\n');
    assert.throws(() => prepareRelease({ cwd: f.cwd, tag: '1.0.0' }), /Commit or stash tracked changes/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.fork);
    assert.equal(f.read('platform/runtime.js'), 'uncommitted work\n');
});
