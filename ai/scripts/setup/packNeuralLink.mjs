#!/usr/bin/env node
/**
 * @module ai/scripts/setup/packNeuralLink
 * @summary Assembles the standalone Neural Link npm package from this checkout: the server's import
 * closure, its runtime assets and config overlays, and a manifest the MCP Registry can verify.
 *
 * This repository is `private` and is never published whole. An outside developer's MCP client needs
 * one server that runs with no checkout, no Agent OS and no native dependency, and the registry
 * needs an npm package whose `mcpName` equals the manifest name. So the package is the closure of
 * the server's entrypoints and nothing more, copied with its paths intact, so every relative import
 * resolves exactly as it does here.
 *
 * **One declaration owns the package's identity:** `ai/mcp/server/neural-link/server.json`. Its `name`
 * is the `mcpName`, and its npm `packages` entry supplies the package name and version. Renaming
 * the package is a one-line change there, and the registry entry can never disagree with what was
 * published.
 *
 * **The overlays are written the way `prepare` writes them on a clean clone** — from the tracked
 * templates, through `initTier1Config` and `initConfigs`. A registry install never runs `prepare`,
 * so the package must carry them. The walk follows each overlay's template rather than any local
 * overlay, so an operator's deltas in this checkout can never ship.
 *
 * @example
 * npm run pack:neural-link -- --out /tmp/neural-link-package
 * (cd /tmp/neural-link-package && npm pack)
 */

import {parse}                        from 'acorn';
import {Command}                      from 'commander';
import fs                             from 'node:fs';
import {builtinModules}               from 'node:module';
import path                           from 'node:path';
import {fileURLToPath}                from 'node:url';
import {initConfigs, initTier1Config} from './initServerConfigs.mjs';
import {isEntryModule}                from '../../services/shared/isEntryModule.mjs';

const
    brainRoot   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    SERVER_DIR  = 'ai/mcp/server/neural-link',
    ENTRYPOINTS = [`${SERVER_DIR}/standalone.mjs`, `${SERVER_DIR}/mcp-server.mjs`, `${SERVER_DIR}/run-bridge.mjs`],
    // Read by path at runtime (`ToolService`, `HealthService`), so no import walk can find them.
    ASSETS      = [`${SERVER_DIR}/openapi.yaml`, `${SERVER_DIR}/server.json`],
    OVERLAY     = 'config.mjs',
    TEMPLATE    = 'config.template.mjs';

/**
 * @summary Every node of an acorn AST, depth-first.
 * @param {Object} node
 * @param {Function} visit
 */
function walk(node, visit) {
    visit(node);

    for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
            if (child && typeof child.type === 'string') walk(child, visit)
        }
    }
}

/**
 * @summary The module specifiers one source imports: static declarations, re-exports and dynamic
 * imports whose specifier is a string literal. A computed specifier cannot be followed and is skipped.
 * @param {String} source
 * @returns {String[]}
 */
export function moduleSpecifiers(source) {
    const specifiers = [];

    walk(parse(source, {ecmaVersion: 'latest', sourceType: 'module'}), node => {
        if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
            specifiers.push(node.source.value)
        } else if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
            specifiers.push(node.source.value)
        }
    });

    return specifiers
}

/**
 * @summary The relative-import closure of the entrypoints, and the npm packages it imports.
 *
 * An import of an untracked overlay resolves to its tracked template, because the package writes
 * its overlays from the templates. An import that resolves to nothing is an error, not a skip: a
 * package that loads in this checkout but not from npm would fail on the outside developer's
 * machine, where nobody can see why.
 * @param {Object} [options]
 * @param {String} [options.root=brainRoot]
 * @param {String[]} [options.entrypoints=ENTRYPOINTS] Paths relative to `root`.
 * @returns {{files: String[], packages: String[]}}
 */
export function collectClosure({root = brainRoot, entrypoints = ENTRYPOINTS} = {}) {
    const
        files    = new Set(),
        packages = new Set(),
        queue    = [...entrypoints];

    while (queue.length) {
        const file = queue.shift();

        if (files.has(file)) continue;
        files.add(file);

        for (const specifier of moduleSpecifiers(fs.readFileSync(path.join(root, file), 'utf8'))) {
            if (specifier.startsWith('.')) {
                let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));

                if (path.posix.basename(target) === OVERLAY) {
                    const template = path.posix.join(path.posix.dirname(target), TEMPLATE);

                    if (fs.existsSync(path.join(root, template))) target = template
                }

                if (!fs.existsSync(path.join(root, target))) {
                    throw new Error(`${file} imports ${specifier}, which resolves to nothing at ${target}`)
                }

                queue.push(target)
            } else {
                const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

                if (!specifier.startsWith('node:') && !builtinModules.includes(name)) packages.add(name)
            }
        }
    }

    return {files: [...files].sort(), packages: [...packages].sort()}
}

/**
 * @summary The range a dependency is published with: this repository's own range, or — where this
 * repository pins a tarball or a git URL, as it does the engine — a caret on the installed version,
 * because a published package must resolve from the registry.
 * @param {Object} brain This repository's `package.json`.
 * @param {String} name
 * @param {String} root
 * @returns {String}
 */
function publishedRange(brain, name, root) {
    const range = brain.dependencies?.[name];

    if (!range) throw new Error(`the closure imports ${name}, which this repository's package.json does not declare`);
    if (/^[~^]?\d/.test(range)) return range;

    return `^${JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version}`
}

/**
 * @summary Writes the standalone package into `out`, replacing whatever was there.
 * @param {Object} options
 * @param {String} options.out
 * @param {String} [options.root=brainRoot]
 * @returns {Promise<{files: String[], manifest: Object, packages: String[]}>}
 */
export async function packNeuralLink({out, root = brainRoot}) {
    if (!out) throw new Error('packNeuralLink: an output directory is required');

    const
        server = JSON.parse(fs.readFileSync(path.join(root, SERVER_DIR, 'server.json'), 'utf8')),
        npm    = server.packages?.find(entry => entry.registryType === 'npm');

    if (!npm) throw new Error(`${SERVER_DIR}/server.json declares no npm package; it owns the package's name and version`);

    const
        brain             = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
        {files, packages} = collectClosure({root}),
        quiet             = {log() {}, warn() {}, error: console.error};

    fs.rmSync(out, {force: true, recursive: true});

    for (const file of [...files, ...ASSETS]) {
        fs.mkdirSync(path.dirname(path.join(out, file)), {recursive: true});
        fs.copyFileSync(path.join(root, file), path.join(out, file))
    }

    await initTier1Config({aiRoot: path.join(out, 'ai'), argv: [], logger: quiet});
    await initConfigs({aiRoot: path.join(out, 'ai'), argv: [], logger: quiet, serversRoot: path.join(out, 'ai/mcp/server')});

    const manifest = {
        name       : npm.identifier,
        version    : npm.version,
        description: server.description,
        mcpName    : server.name,
        type       : 'module',
        license    : 'MIT',
        homepage   : server.websiteUrl,
        repository : {type: 'git', url: `git+${server.repository.url}.git`, directory: server.repository.subfolder},
        engines    : brain.engines,
        bin        : {[npm.identifier]: `${SERVER_DIR}/standalone.mjs`},
        // What `ConnectionService#spawnBridge` runs inside `--cwd`, which the launcher sets to this package.
        scripts     : {'ai:server-neural-link': `node ./${SERVER_DIR}/run-bridge.mjs`},
        files       : [...new Set(files.map(file => file.split('/')[0]))].sort(),
        dependencies: Object.fromEntries(packages.map(name => [name, publishedRange(brain, name, root)]))
    };

    fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(path.join(out, 'README.md'), readme(manifest));

    return {files, manifest, packages}
}

/**
 * @summary The package README: what it is and the one configuration line each client needs.
 * @param {Object} manifest
 * @returns {String}
 */
function readme({name, description}) {
    return `# ${name}

${description} The [Neural Link](https://neomjs.com) MCP server, packaged to run with no checkout:
your coding agent inspects and verifies the neo.mjs app it is building, live.

## Use it

Claude Code (\`.mcp.json\` in your workspace):

\`\`\`json
{"mcpServers": {"neural-link": {"command": "npx", "args": ["-y", "${name}"]}}}
\`\`\`

Codex (\`.codex/config.toml\` in a trusted project):

\`\`\`toml
[mcp_servers.neural-link]
command = "npx"
args    = ["-y", "${name}"]
\`\`\`

Then let the app connect in development: \`"useAiClient": "development"\` in its \`neo-config.json\`.
Workspaces created by \`npx neo-app\` are set up this way already.

## What it writes

Logs go to \`~/.neo-ai/neural-link/logs\`. The Bridge listens on \`127.0.0.1:8081\`; set \`NEO_NL_PORT\` to
use another port. Nothing else on the machine is touched.

MIT licensed. Source: https://github.com/neomjs/neo-agent-brain/tree/dev/ai/mcp/server/neural-link
`
}

if (isEntryModule(import.meta.url)) {
    const {out} = new Command()
        .requiredOption('-o, --out <dir>', 'directory the package is written into (replaced)')
        .parse(process.argv)
        .opts();

    const {files, manifest, packages} = await packNeuralLink({out: path.resolve(out)});

    console.log(`✅ ${manifest.name}@${manifest.version} → ${out}: ${files.length} modules, ${packages.length} dependencies (${packages.join(', ')})`)
}
