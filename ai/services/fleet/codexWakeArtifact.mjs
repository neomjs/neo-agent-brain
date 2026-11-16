import {createHash} from 'node:crypto';
import path         from 'node:path';

/**
 * @module ai/services/fleet/codexWakeArtifact
 * @summary The versioned package declaration shared by the host publisher and Fleet's Start verifier.
 */
export const CODEX_WAKE_ARTIFACT_DECLARATION = 'codex-wake-artifact.json';
export const CODEX_WAKE_ARTIFACT_ROOT        = 'wake-artifacts-v1';
export const CODEX_WAKE_WIRE                 = 'neo-codex-primary-wake-v1';
export const CODEX_WAKE_ORGANISM             = 'Contents/Resources/organism';
export const CODEX_WAKE_EXECUTABLE           = 'Contents/MacOS/Neo Harness';
export const CODEX_WAKE_MODULE               = 'ai/daemons/wake/codexWakeHook.mjs';
export const CODEX_WAKE_PROTOCOL             = 'ai/daemons/wake/codexWakeProtocol.json';

/** @summary Require canonical, ordered, unique selectors. A declaration never supplies an executable path. */
function pathsOf(values, grammar) {
    if (!Array.isArray(values) || values.length > 8192 || values.some((value, i) =>
        typeof value !== 'string' || !grammar.test(value) || (i && value <= values[i - 1]))) {
        throw new Error('Invalid Codex wake package selectors')
    }
    return values
}

/**
 * @summary Selects the sealed executable, all framework bytes, hook imports and whole npm package subtrees.
 * The source package owns dependency discovery. The consumer requires every declared root in its verified
 * physical inventory, and hashes the same manifest grammar as the complete runtime.
 * @param {Object} options A parsed package declaration and its authenticated full runtime inventory.
 * @returns {{entries:Array, digest:String}} The exact rows to publish, including parent directories.
 */
export function describeCodexWakeArtifact({declaration, entries}) {
    if (!declaration || Object.keys(declaration).sort().join(',') !== 'files,packages,version,wire' ||
        declaration.version !== 1 || declaration.wire !== CODEX_WAKE_WIRE || !Array.isArray(entries)) {
        throw new Error('Unsupported Codex wake package declaration')
    }
    const files    = pathsOf(declaration.files, /^(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.mjs$/u);
    const packages = pathsOf(declaration.packages, /^node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9_.-]*(?:\/node_modules\/(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9_.-]*)*$/u);
    if (!files.includes(CODEX_WAKE_MODULE) || !files.includes('ai/daemons/wake/fleetPrimarySessionWake.mjs') ||
        files.some(file => file.split('/').includes('node_modules'))) throw new Error('Codex wake entry or consumer is not declared');
    const organism = name => CODEX_WAKE_ORGANISM + '/' + name;
    const trees    = new Set(['Contents/MacOS', 'Contents/Frameworks', ...packages.map(organism)]);
    const selected = new Set(['Contents/Info.plist','Contents/PkgInfo',CODEX_WAKE_EXECUTABLE,organism(CODEX_WAKE_PROTOCOL),
        ...files.map(organism), ...packages.map(name => organism(name + '/package.json'))]);
    const byName = new Map(entries.map(row => [row[0], row]));
    for (const name of selected) {
        if (byName.get(name)?.[1] !== 'file') throw new Error('Unattested Codex wake file: ' + name)
    }
    if (!(byName.get(CODEX_WAKE_EXECUTABLE)[2] & 0o111)) throw new Error('Codex wake executable is not executable');
    for (const tree of trees) {
        if (byName.get(tree)?.[1] !== 'directory') throw new Error('Unattested Codex wake directory: ' + tree)
    }
    for (const name of [...selected, ...trees]) {
        for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) {
            if (byName.get(dir)?.[1] !== 'directory') throw new Error('Invalid Codex wake parent');
            selected.add(dir)
        }
    }
    selected.add('');
    const manifest = entries.filter(([name]) => {
        if (selected.has(name)) return true;
        for (let dir = name; dir && dir !== '.'; dir = path.posix.dirname(dir)) {
            if (trees.has(dir)) return true
        }
        return false
    });
    if (manifest.some(([,type,mode]) => type !== 'link' && mode & 0o222)) throw new Error('Codex wake payload is not sealed');
    return {entries:manifest, digest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}
}
