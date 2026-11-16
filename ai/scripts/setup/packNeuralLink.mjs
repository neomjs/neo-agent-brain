#!/usr/bin/env node
/**
 * @module ai/scripts/setup/packNeuralLink
 * @summary Compatibility wrapper delegating standalone Neural Link assembly to `packMcpServer.mjs`.
 */

import {Command}       from 'commander';
import path            from 'node:path';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';
import {
    FORBIDDEN_RUNTIME_DEPS,
    collectClosure,
    moduleSpecifiers,
    packMcpServer
} from './packMcpServer.mjs';

export {FORBIDDEN_RUNTIME_DEPS, collectClosure, moduleSpecifiers, packMcpServer};

/**
 * @summary Writes the standalone `neo-neural-link` package into `out`, replacing whatever was there.
 * @param {Object} options
 * @param {String} options.out Destination directory.
 * @param {String} [options.root] Checkout root directory override.
 * @returns {Promise<{files: String[], manifest: Object, packages: String[]}>}
 */
export async function packNeuralLink({out, root} = {}) {
    if (!out) throw new Error('packNeuralLink: an output directory is required');

    return packMcpServer({
        target: 'neural-link',
        out,
        ...(root ? {root} : {})
    });
}

if (isEntryModule(import.meta.url)) {
    const {out} = new Command()
        .requiredOption('-o, --out <dir>', 'directory the package is written into (replaced)')
        .parse(process.argv)
        .opts();

    const {files, manifest, packages} = await packNeuralLink({out: path.resolve(out)});

    console.log(`✅ ${manifest.name}@${manifest.version} → ${out}: ${files.length} modules, ${packages.length} dependencies (${packages.join(', ')})`);
}
