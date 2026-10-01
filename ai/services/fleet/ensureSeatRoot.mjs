import fs   from 'node:fs';
import path from 'node:path';

/**
 * @summary Make a Fleet seat root owner-only: create it `0700`, or narrow an existing root that grants
 * group or other access.
 *
 * Harness homes below the root hold logins, and the folders above it need not keep them private (on
 * the operator's host, measured 2026-10-01: `~` `0750`, `~/.neo-ai` `0755`), so the root is where
 * privacy is set: a `0700` root closes traversal to every seat inside it. Missing ancestors keep the
 * default mode; only the root is narrowed.
 *
 * @param {String} root Absolute seat root (`fleet.agentsRoot`).
 * @returns {String} The root.
 * @throws {Error} When the root is not a directory, or grants access that cannot be narrowed.
 */
export function ensureSeatRoot(root) {
    fs.mkdirSync(path.dirname(root), {recursive: true});

    try {
        fs.mkdirSync(root, {mode: 0o700})
    } catch (error) {
        if (error.code !== 'EEXIST') throw error
    }

    const stats = fs.statSync(root);

    if (!stats.isDirectory()) {
        throw new Error(`ensureSeatRoot: '${root}' is not a directory.`)
    }

    if (stats.mode & 0o077) {
        try {
            fs.chmodSync(root, 0o700)
        } catch (error) {
            throw new Error(`ensureSeatRoot: '${root}' grants group or other access and could not be narrowed (${error.code}).`)
        }
    }

    return root
}
