/**
 * @module ai/scripts/diagnostics/gitObjects
 * @summary The two git reads the diagnostics share: a command's output, and many files at one commit
 * through a single `git cat-file --batch`, which never touches the working tree.
 */
import {execFileSync, spawnSync} from 'node:child_process';

/**
 * Runs git in a checkout and returns stdout.
 * @param {String} cwd checkout
 * @param {String[]} args
 * @returns {String}
 */
export function git(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
}

/**
 * Reads files at one commit through a single `git cat-file --batch`.
 * @param {String} repo checkout
 * @param {String} sha
 * @param {String[]} paths
 * @returns {Map<String, String|null>} null for a path that is no file at that commit
 */
export function readAtCommit(repo, sha, paths) {
    const result = new Map();

    if (!paths.length) return result;

    const out    = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {input: paths.map(file => `${sha}:${file}`).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024}).stdout;
    let   offset = 0;

    for (const file of paths) {
        const end    = out.indexOf(10, offset),
              header = out.subarray(offset, end).toString().split(' ');

        offset = end + 1;

        // A found object answers `<oid> <type> <size>`; a missing one echoes the request, which may hold spaces
        if (header.at(-1) === 'missing') { result.set(file, null); continue }

        const size = Number(header[2]);

        result.set(file, header[1] === 'blob' ? out.subarray(offset, offset + size).toString() : null);
        offset += size + 1
    }

    return result
}
