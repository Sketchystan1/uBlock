// Construct a release from the exact upstream tag plus a compatible MV3 port.
// This creates a local commit only. Tagging, signing and publishing remain in CI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const controlFiles = [
    'GNUmakefile',
    'dist/mv3-build',
    'dist/mv3-release-ports.json',
    '.github/workflows/release.yml',
    '.github/workflows/sync-upstream.yml',
    'tools/make-mv3-release-tree.mjs',
    'tools/make-chromium-mv3.sh',
    'tools/make-crx.mjs',
    'tools/make-update-xml.mjs',
    'tools/verify-crx.mjs',
];
const provenanceFile = 'dist/mv3-release.json';

function repository(cwd) {
    const git = (...args) => execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
    const commit = ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const files = (...args) => git(...args).split('\0').filter(Boolean);
    const overlay = (port, upstream) => {
        const base = git('merge-base', port, upstream).trim();
        const altered = files('diff', '--no-renames', '--name-only', '-z', '--diff-filter=MDRT', base, port);
        if ( altered.length !== 0 ) {
            throw new Error(`MV3 port modifies upstream files: ${altered.join(', ')}. Move fork changes into added files.`);
        }
        const added = files('diff', '--no-renames', '--name-only', '-z', '--diff-filter=A', base, port);
        if ( added.length === 0 ) { throw new Error('The MV3 port adds no files'); }
        return { base, added };
    };
    return { git, commit, files, overlay };
}

export function planRelease({ cwd = process.cwd(), fork = 'HEAD', upstream = 'upstream/master', tag }) {
    const repo = repository(cwd);
    const forkCommit = repo.commit(fork);
    const upstreamHead = repo.commit(upstream);
    const current = repo.overlay(forkCommit, upstreamHead);
    if ( tag === undefined ) { return { fork: forkCommit, ...current }; }
    if ( /^\d+\.\d+\.\d+(?:(?:b|rc)\d+)?$/.test(tag) === false ) {
        throw new Error(`Invalid upstream release tag: ${tag}`);
    }
    const upstreamCommit = repo.commit(`refs/upstream-tags/${tag}`);
    const config = JSON.parse(repo.git('show', `${forkCommit}:dist/mv3-release-ports.json`));
    if ( config.schemaVersion !== 1 || typeof config.pins !== 'object' || config.pins === null ) {
        throw new Error('Unsupported MV3 release-port configuration');
    }
    const pin = config.pins[tag];
    if ( pin !== undefined && (
        /^[a-f0-9]{40}$/.test(pin.port || '') === false ||
        pin.upstream !== upstreamCommit
    ) ) {
        throw new Error(`Invalid MV3 port pin or changed upstream tag: ${tag}`);
    }
    const port = pin === undefined ? forkCommit : repo.commit(pin.port);
    const selected = repo.overlay(port, upstreamHead);
    if ( pin !== undefined && selected.base !== upstreamCommit ) {
        throw new Error(`Pinned MV3 port was not based on upstream ${tag}`);
    }
    for ( const name of controlFiles ) {
        if ( current.added.includes(name) === false ) {
            throw new Error(`Release control file must be fork-owned: ${name}`);
        }
    }
    const added = [ ...new Set([ ...selected.added, ...controlFiles ]) ];
    const collisions = repo.files('ls-tree', '-r', '--name-only', '-z', upstreamCommit, '--', ...added, provenanceFile);
    if ( collisions.length !== 0 ) {
        throw new Error(`Release overlay would replace upstream files: ${collisions.join(', ')}`);
    }
    const build = repo.git('show', `${forkCommit}:dist/mv3-build`).trim();
    if ( /^\d+$/.test(build) === false || Number(build) < 500 || Number(build) > 65535 ) {
        throw new Error(`Invalid fork build number: ${build}`);
    }
    return {
        tag, upstream: upstreamCommit, port, tooling: forkCommit,
        forkBuild: Number(build), pinned: pin !== undefined,
        reason: pin?.reason || 'Current MV3 port',
        portFiles: selected.added,
    };
}

export function prepareRelease(options) {
    const cwd = options.cwd || process.cwd();
    const repo = repository(cwd);
    // Validate the entire plan before changing the checkout.
    const plan = planRelease(options);
    if ( plan.tag === undefined ) { throw new Error('Preparing a release requires --tag'); }
    if ( repo.git('status', '--porcelain', '--untracked-files=no').trim() !== '' ) {
        throw new Error('Commit or stash tracked changes before preparing a release');
    }
    repo.git('checkout', '--detach', plan.upstream);
    repo.git('checkout', plan.port, '--', ...plan.portFiles);
    // Use current signing/publishing code and the next unused build number,
    // even when the runtime and its verifier come from an older port.
    repo.git('checkout', plan.tooling, '--', ...controlFiles);
    const provenance = { ...plan };
    delete provenance.portFiles;
    const root = repo.git('rev-parse', '--show-toplevel').trim();
    fs.writeFileSync(path.join(root, provenanceFile), JSON.stringify(provenance, null, 2) + '\n');
    repo.git('add', '--', provenanceFile);
    repo.git('commit', '-m', `Chromium MV3 build of uBlock Origin ${plan.tag}`,
        '-m', `Upstream: ${plan.upstream}\nMV3 port: ${plan.port}\nRelease tooling: ${plan.tooling}\nFork build: ${plan.forkBuild}`);
    return { ...provenance, commit: repo.commit('HEAD') };
}

if ( process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url ) {
    try {
        const options = {};
        let checkOnly = false;
        let planOnly = false;
        for ( let i = 2; i < process.argv.length; i++ ) {
            const key = process.argv[i];
            if ( key === '--check-only' ) { checkOnly = true; continue; }
            if ( key === '--plan' ) { planOnly = true; continue; }
            if ( [ '--tag', '--fork', '--upstream' ].includes(key) === false || !process.argv[i+1] ) {
                throw new Error('Usage: node tools/make-mv3-release-tree.mjs [--check-only | --plan] [--tag TAG] [--fork REF] [--upstream REF]');
            }
            options[key.slice(2)] = process.argv[++i];
        }
        if ( checkOnly ) { delete options.tag; }
        console.log(JSON.stringify(checkOnly || planOnly ? planRelease(options) : prepareRelease(options), null, 2));
    } catch (reason) {
        console.error(reason.message);
        if ( reason.stderr ) { console.error(reason.stderr.toString()); }
        process.exitCode = 1;
    }
}
