import {constants}                                             from 'node:fs';
import {createRequire}                                         from 'node:module';
import path                                                    from 'node:path';
import {generate, readSupported}                               from 'neo-agent-skills/agents-md';
import {MEMORY_LAYER_BOOT_FILES, renderCodexMemoryBootSection} from './seatMemoryLayerTemplate.mjs';

/**
 * @summary What becomes of a seat's instructions file. `projected`: Fleet writes maintainer instructions, Codex
 * seat memory, or both into the harness home. `not-applicable`: the harness has no witnessed user-scope slot, or
 * the Skills source declares no such repository. `repository-supplied`: the checkout carries the loaded file.
 * @member {Object}
 */
export const SEAT_INSTRUCTION_STATES = Object.freeze({
    NOT_APPLICABLE     : 'not-applicable',
    PROJECTED          : 'projected',
    REPOSITORY_SUPPLIED: 'repository-supplied'
});

/**
 * @summary The user-scope instruction file each harness reads from its home in every session. A harness joins
 * only once a first session has been seen loading it there.
 * @member {Object}
 */
export const HOME_INSTRUCTION_FILES = Object.freeze({
    'claude-code'  : 'CLAUDE.md',
    'codex'        : 'AGENTS.md',
    'codex-desktop': 'AGENTS.md'
});

/**
 * The checkout files each harness loads as project instructions. A checkout carrying one already supplies the
 * seat's rules, and a home copy beside it loads them twice: Claude reads user and project files under no shared
 * cap, and Codex reads its home file whole, outside the byte budget its project files share.
 */
const REPOSITORY_INSTRUCTION_FILES = Object.freeze({
    'claude-code'  : Object.freeze(['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]),
    'codex'        : Object.freeze(['AGENTS.override.md', 'AGENTS.md']),
    'codex-desktop': Object.freeze(['AGENTS.override.md', 'AGENTS.md'])
});

/**
 * The organization whose repositories the Skills source declares: the one that publishes it. Derived from the
 * package's own metadata, so Fleet names no tenant.
 */
const SKILLS_OWNER = /github\.com[/:]([^/]+)\//.exec(createRequire(import.meta.url)('neo-agent-skills/package.json').repository?.url ?? '')?.[1] ?? null;

const {NOT_APPLICABLE, PROJECTED, REPOSITORY_SUPPLIED} = SEAT_INSTRUCTION_STATES;

/**
 * @summary Projects a seat's maintainer instructions and, for Codex, its boot memory into the harness home.
 * It reads the checkout and memory files and writes nothing; the preparer converges what it returns.
 *
 * Every state of a harness with a home slot names that slot as `filePath`, so the preparer can also retire a
 * file Fleet wrote earlier when the seat no longer takes it. A checkout entry supplies instructions only when
 * it is a file the harness can read, a symlink to one included; a directory, a link to nothing or an
 * unreadable file cannot, so the composition is written and the entry is named in `ignored`.
 * @param {Object}      options
 * @param {String}      options.harnessType
 * @param {String}      options.homeRoot       The harness's home: `instanceHome`, or the Codex home inside it
 * @param {String|null} options.repoSlug       The seat's repository, `<owner>/<name>`
 * @param {String}      options.targetRepoRoot The seat's checkout
 * @param {String}      [options.memoryDir]    Seat memory directory; Codex boot files are projected inline
 * @param {Object}      options.fileSystem     `fs/promises`-shaped; reads `stat`, `lstat`, `access` and `readFile`
 * @returns {Promise<Object>} `{state, reason, filePath?, content?, ignored?}`: `content` only when `projected`
 */
export async function projectSeatInstructions({harnessType, homeRoot, repoSlug, targetRepoRoot, memoryDir, fileSystem}) {
    const fileName = HOME_INSTRUCTION_FILES[harnessType];

    if (!fileName) {
        return {state: NOT_APPLICABLE, reason: `'${harnessType}' has no witnessed user-scope instruction file`}
    }

    const
        filePath      = path.join(homeRoot, fileName),
        isCodex       = harnessType === 'codex' || harnessType === 'codex-desktop',
        [owner, name] = typeof repoSlug === 'string' ? repoSlug.split('/') : [];

    let memorySection = null;

    if (isCodex && memoryDir) {
        const bootFiles = await readCodexBootFiles(memoryDir, fileSystem);

        if (bootFiles) {
            await refuseShadowedCodexHome({homeRoot, fileSystem});
            memorySection = renderCodexMemoryBootSection({bootFiles, memoryDir})
        }
    }

    if (!SKILLS_OWNER || owner !== SKILLS_OWNER || !readSupported().repos.has(name)) {
        if (memorySection) {
            return {
                state  : PROJECTED,
                reason : `the Skills source declares no repository '${repoSlug}', so Fleet projects seat memory only`,
                filePath,
                content: memorySection
            }
        }

        return {state: NOT_APPLICABLE, reason: `the Skills source declares no repository '${repoSlug}'`, filePath}
    }

    const ignored = [];

    for (const file of REPOSITORY_INSTRUCTION_FILES[harnessType]) {
        const usable = await inspectCheckoutFile(path.join(targetRepoRoot, file), fileSystem);

        if (usable === true) {
            if (memorySection) {
                return {
                    state  : PROJECTED,
                    reason : `the checkout carries ${file}; Fleet projects seat memory only`,
                    filePath,
                    content: memorySection
                }
            }

            return {state: REPOSITORY_SUPPLIED, reason: `the checkout carries ${file}`, filePath}
        }

        usable && ignored.push(`${file} (${usable})`)
    }

    const content = generate({audience: 'maintainer', repos: [name]}).text;

    return {
        state : PROJECTED,
        reason: ignored.length
            ? `the checkout's ${ignored.join(', ')} cannot supply instructions, so Fleet writes the composition for '${name}'`
            : `Fleet writes the composition for '${name}'`,
        filePath,
        content: memorySection ? `${content}\n\n${memorySection}` : content,
        ...(ignored.length ? {ignored} : {})
    }
}

/**
 * @summary Reads the complete Codex boot-file set. Missing or unreadable files fail closed when a memory
 * directory was supplied, so a disappearing scaffold cannot silently remove a previous memory projection.
 * @param {String} memoryDir
 * @param {Object} fileSystem
 * @returns {Promise<Object|null>}
 */
async function readCodexBootFiles(memoryDir, fileSystem) {
    const bootFiles = {};

    for (const file of MEMORY_LAYER_BOOT_FILES) {
        const filePath = path.join(memoryDir, file);
        let contents;

        try {
            contents = await fileSystem.readFile(filePath, 'utf8')
        } catch (error) {
            const failure = new Error('Codex seat memory boot files could not be read; refusing an incomplete home instruction projection.');

            Object.assign(failure, {
                code    : 'FLEET_WORKSPACE_DIVERGENT',
                artifact: {
                    path  : filePath,
                    reason: error?.code === 'ENOENT' ? 'seat memory boot file is missing' : 'seat memory boot file unreadable'
                }
            });

            throw failure
        }

        bootFiles[file] = typeof contents === 'string' ? contents : contents.toString('utf8')
    }

    return bootFiles
}

/**
 * @summary Refuses to put memory in AGENTS.md when a non-empty home override shadows that slot.
 * The override is only statted; Fleet does not read, write, or claim it.
 * @param {Object} options
 * @param {String} options.homeRoot
 * @param {Object} options.fileSystem
 * @returns {Promise<void>}
 */
async function refuseShadowedCodexHome({homeRoot, fileSystem}) {
    const overridePath = path.join(homeRoot, 'AGENTS.override.md');
    let stats;

    try {
        stats = await fileSystem.stat(overridePath)
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error
    }

    // A file with an unknown size is treated as non-empty: projection must not claim a loader slot it
    // cannot prove is effective. A directory is not an instruction file Codex can load here.
    if (stats.isFile() && stats.size !== 0) {
        const error = new Error('A non-empty home AGENTS.override.md shadows the Codex memory projection.');

        Object.assign(error, {
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: overridePath, reason: 'home instruction override shadows AGENTS.md'}
        });

        throw error
    }
}

/**
 * @summary Whether a checkout entry is a file the harness can read. `null`: nothing is there. `true`: a
 * readable file, through a symlink or not. Otherwise the reason it cannot supply instructions. Only `ENOENT`
 * means absent and only `EACCES` or `EPERM` means unreadable; any other error is a failed observation and throws.
 * @param {String} filePath
 * @param {Object} fileSystem
 * @returns {Promise<Boolean|String|null>}
 */
async function inspectCheckoutFile(filePath, fileSystem) {
    let stats;

    try {
        stats = await fileSystem.stat(filePath)
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        try {
            await fileSystem.lstat(filePath)
        } catch (entryError) {
            if (entryError?.code === 'ENOENT') return null;
            throw entryError
        }

        return 'a link to nothing'
    }

    if (!stats.isFile()) return 'not a file';

    try {
        await fileSystem.access(filePath, constants.R_OK)
    } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'unreadable';
        throw error
    }

    return true
}
