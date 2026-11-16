#!/usr/bin/env node
/**
 * @module ai/scripts/setup/packMcpServer
 * @summary Assembles standalone MCP server npm packages from their static import closure, assets, and server.json manifest.
 */

import {parse}                        from 'acorn';
import {Command}                      from 'commander';
import {execFileSync}                 from 'node:child_process';
import fs                             from 'node:fs';
import {builtinModules}               from 'node:module';
import os                             from 'node:os';
import path                           from 'node:path';
import {fileURLToPath}                from 'node:url';
import {initConfigs, initTier1Config} from './initServerConfigs.mjs';
import {isEntryModule}                from '../../services/shared/isEntryModule.mjs';

const
    brainRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    OVERLAY   = 'config.mjs',
    TEMPLATE  = 'config.template.mjs';

/**
 * Heavy Agent OS or native packages that must never enter standalone `npx` closures.
 * @type {ReadonlyArray<String>}
 */
export const FORBIDDEN_RUNTIME_DEPS = Object.freeze([
    'better-sqlite3',
    'chromadb',
    '@chroma-core/default-embed',
    '@google/generative-ai',
    'playwright'
]);

/**
 * @summary Generates the README for the packaged Neural Link server.
 * @param {Object} manifest Generated `package.json` manifest.
 * @returns {String}
 */
function neuralLinkReadme({name, description}) {
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

/**
 * @summary Generates the README for the packaged standalone Memory Core server.
 * @param {Object} manifest Generated `package.json` manifest.
 * @returns {String}
 */
function memoryCoreReadme({name, description}) {
    return `# ${name}

${description} Zero-daemon cross-harness episodic memory powered by append-locked JSONL WAL segments
and a derived \`node:sqlite\` FTS5 lexical index — no Docker, no native C++ addons, and no embedding server.

## Use it

Claude Code (\`.mcp.json\` in your workspace):

\`\`\`json
{"mcpServers": {"memory-core": {"command": "npx", "args": ["-y", "${name}"]}}}
\`\`\`

Codex (\`.codex/config.toml\` in a trusted project):

\`\`\`toml
[mcp_servers.memory-core]
command = "npx"
args    = ["-y", "${name}"]
\`\`\`

Workspaces created with \`npx neo-app --memory\` configure this server alongside Neural Link automatically.

## Storage & promotion

Turns are appended to \`~/.neo-ai/memory-core/wal/wal-YYYY-MM-DD.jsonl\` and indexed in
\`~/.neo-ai/memory-core/index.sqlite\` scoped by resolved git remote / repository root.
Logs go to \`~/.neo-ai/memory-core/logs\`. Promote standalone segments into a full Agent OS plane with:

\`\`\`bash
npx -y ${name} promote --target-wal-dir <walDir> --target-graph-db <graphSqlite> --owner <agentIdentity>
\`\`\`

MIT licensed. Source: https://github.com/neomjs/neo-agent-brain/tree/dev/ai/mcp/server/memory-core
`
}

/**
 * Declarative standalone packaging specifications keyed by server folder name.
 * @type {Object<String, Object>}
 */
export const PACK_TARGETS = Object.freeze({
    'neural-link': Object.freeze({
        serverDir  : 'ai/mcp/server/neural-link',
        entrypoints: Object.freeze([
            'ai/mcp/server/neural-link/standalone.mjs',
            'ai/mcp/server/neural-link/mcp-server.mjs',
            'ai/mcp/server/neural-link/run-bridge.mjs'
        ]),
        assets: Object.freeze([
            'ai/mcp/server/neural-link/openapi.yaml',
            'ai/mcp/server/neural-link/server.json'
        ]),
        scripts: Object.freeze({
            'ai:server-neural-link': 'node ./ai/mcp/server/neural-link/run-bridge.mjs'
        }),
        readme: neuralLinkReadme
    }),
    'memory-core': Object.freeze({
        serverDir  : 'ai/mcp/server/memory-core',
        entrypoints: Object.freeze([
            'ai/mcp/server/memory-core/standalone.mjs'
        ]),
        assets: Object.freeze([
            'ai/mcp/server/memory-core/openapi.yaml',
            'ai/mcp/server/memory-core/server.json'
        ]),
        scripts: null,
        readme : memoryCoreReadme
    })
});

/**
 * @summary Every node of an acorn AST, depth-first.
 * @param {Object} node AST node.
 * @param {Function} visit Visitor callback.
 */
function walk(node, visit) {
    visit(node);

    for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
            if (child && typeof child.type === 'string') walk(child, visit);
        }
    }
}

/**
 * @summary Collects static imports, re-exports, and string-literal dynamic imports from ESM source.
 * @param {String} source Module source text.
 * @returns {String[]}
 */
export function moduleSpecifiers(source) {
    const specifiers = [];

    walk(parse(source, {ecmaVersion: 'latest', sourceType: 'module'}), node => {
        if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) && node.source) {
            specifiers.push(node.source.value);
        } else if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
            specifiers.push(node.source.value);
        }
    });

    return specifiers;
}

/**
 * @summary Computes the transitive relative-file and npm-package closure for an MCP target or custom entrypoints.
 * @param {Object} [options={}]
 * @param {String} [options.root=brainRoot] Checkout or package root directory.
 * @param {String} [options.target='neural-link'] Named target key in {@link PACK_TARGETS}.
 * @param {String[]} [options.entrypoints] Explicit root-relative entrypoints overriding `target`.
 * @returns {{files: String[], packages: String[]}}
 */
export function collectClosure({root = brainRoot, target = 'neural-link', entrypoints} = {}) {
    const resolvedEntrypoints = entrypoints ?? PACK_TARGETS[target]?.entrypoints;

    if (!resolvedEntrypoints) {
        throw new Error(`collectClosure: unknown MCP server target "${target}"`);
    }

    const
        files    = new Set(),
        packages = new Set(),
        queue    = [...resolvedEntrypoints];

    while (queue.length) {
        const file = queue.shift();

        if (files.has(file)) continue;
        files.add(file);

        for (const specifier of moduleSpecifiers(fs.readFileSync(path.join(root, file), 'utf8'))) {
            if (specifier.startsWith('.')) {
                let targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));

                if (path.posix.basename(targetPath) === OVERLAY) {
                    const template = path.posix.join(path.posix.dirname(targetPath), TEMPLATE);

                    if (fs.existsSync(path.join(root, template))) targetPath = template;
                }

                if (!fs.existsSync(path.join(root, targetPath))) {
                    throw new Error(`${file} imports ${specifier}, which resolves to nothing at ${targetPath}`);
                }

                queue.push(targetPath);
            } else {
                const name = specifier.startsWith('@')
                    ? specifier.split('/').slice(0, 2).join('/')
                    : specifier.split('/')[0];

                if (!specifier.startsWith('node:') && !builtinModules.includes(name)) packages.add(name);
            }
        }
    }

    return {files: [...files].sort(), packages: [...packages].sort()};
}

/**
 * @summary Resolves the publishable npm range for a closure package dependency.
 * @param {Object} brain Root `package.json` manifest.
 * @param {String} name Package name.
 * @param {String} root Checkout root directory.
 * @returns {String}
 */
function publishedRange(brain, name, root) {
    const range = brain.dependencies?.[name];

    if (!range) {
        throw new Error(`the closure imports ${name}, which this repository's package.json does not declare`);
    }
    if (/^[~^]?\d/.test(range)) return range;

    return `^${JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version}`;
}

/**
 * @summary Throws before emitting artifacts if any forbidden runtime package enters a standalone closure.
 * @param {String} target Target identifier.
 * @param {String[]} packages Collected external npm dependencies.
 * @param {ReadonlyArray<String>} [forbidden=FORBIDDEN_RUNTIME_DEPS] Blocked runtime packages.
 */
export function assertNoForbiddenDeps(target, packages, forbidden = FORBIDDEN_RUNTIME_DEPS) {
    const blocked = new Set(forbidden);
    const hits    = packages.filter(name => blocked.has(name));

    if (hits.length > 0) {
        throw new Error(
            `packMcpServer (${target}): closure imports forbidden runtime dependencies: ${hits.join(', ')}`
        );
    }
}

/**
 * @summary Assembles a standalone MCP server package directory (and optional npm tarball) for the named target.
 * @param {Object} options
 * @param {String} [options.target='neural-link'] Target key (`'neural-link'` | `'memory-core'`).
 * @param {String} options.out Destination directory (replaced).
 * @param {String} [options.root=brainRoot] Checkout root directory.
 * @param {Boolean} [options.packTarball=false] Run `npm pack` inside `out` and return `tarballPath`.
 * @param {ReadonlyArray<String>} [options.forbiddenDeps=FORBIDDEN_RUNTIME_DEPS] Forbidden dependency list.
 * @returns {Promise<{files: String[], manifest: Object, packages: String[], tarballPath?: String}>}
 */
export async function packMcpServer({
    target        = 'neural-link',
    out,
    root          = brainRoot,
    packTarball   = false,
    forbiddenDeps = FORBIDDEN_RUNTIME_DEPS
} = {}) {
    const spec = PACK_TARGETS[target];

    if (!spec) throw new Error(`packMcpServer: unknown target "${target}" (expected: ${Object.keys(PACK_TARGETS).join(', ')})`);
    if (!out)  throw new Error(`packMcpServer (${target}): an output directory is required`);

    const
        server = JSON.parse(fs.readFileSync(path.join(root, spec.serverDir, 'server.json'), 'utf8')),
        npm    = server.packages?.find(entry => entry.registryType === 'npm');

    if (!npm) {
        throw new Error(`${spec.serverDir}/server.json declares no npm package; it owns the package's name and version`);
    }

    const
        brain             = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
        {files, packages} = collectClosure({root, target}),
        quiet             = {log() {}, warn() {}, error: console.error};

    assertNoForbiddenDeps(target, packages, forbiddenDeps);

    fs.rmSync(out, {force: true, recursive: true});

    for (const file of [...files, ...spec.assets]) {
        fs.mkdirSync(path.dirname(path.join(out, file)), {recursive: true});
        fs.copyFileSync(path.join(root, file), path.join(out, file));
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
        bin        : {[npm.identifier]: `${spec.serverDir}/standalone.mjs`},
        ...(spec.scripts ? {scripts: {...spec.scripts}} : {}),
        files       : [...new Set([...files, ...spec.assets].map(file => file.split('/')[0]))].sort(),
        dependencies: Object.fromEntries(packages.map(name => [name, publishedRange(brain, name, root)]))
    };

    fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(path.join(out, 'README.md'), spec.readme(manifest));

    if (!packTarball) {
        return {files, manifest, packages};
    }

    const filename = execFileSync('npm', ['pack', '--silent'], {
        cwd     : out,
        encoding: 'utf8'
    }).trim().split(/\r?\n/).pop();

    return {
        files,
        manifest,
        packages,
        tarballPath: path.join(out, filename)
    };
}

if (isEntryModule(import.meta.url)) {
    const opts = new Command()
        .option('-t, --target <server>', 'MCP server target (neural-link | memory-core)', 'neural-link')
        .option('-o, --out <dir>', 'directory the package is written into (replaced)')
        .option('--tarball', 'also run npm pack inside the output directory', false)
        .parse(process.argv)
        .opts();

    const resolvedOut = path.resolve(opts.out || path.join(os.tmpdir(), `neo-pack-${opts.target}`));
    const result      = await packMcpServer({
        target     : opts.target,
        out        : resolvedOut,
        packTarball: Boolean(opts.tarball)
    });

    console.log(
        `✅ ${result.manifest.name}@${result.manifest.version} → ${resolvedOut}: ${result.files.length} modules, ${result.packages.length} dependencies (${result.packages.join(', ')})`
    );
    if (result.tarballPath) {
        console.log(`📦 ${result.tarballPath}`);
    }
}
