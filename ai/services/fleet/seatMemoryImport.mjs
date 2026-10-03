import fs                                             from 'fs/promises';
import os                                             from 'os';
import path                                           from 'path';
import {deriveAgentInstanceHome, deriveAgentMemoryDir} from './deriveAgentInstanceHome.mjs';
import {deriveCodexHome}                              from './deriveHarnessLaunchSpec.mjs';
import {writeFileAtomic}                              from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/seatMemoryImport
 * @summary An adopted seat's markdown memory: where an existing agent keeps it, where the seat's family
 * loads it from, the copy that converges it at Start, and the refusal when a consented import left the
 * seat empty.
 *
 * The consent is the registry row's `memoryImport`: a source path or `'none'`, recorded at birth by
 * `defineAgent`. A seat with no consent is a fresh one and starts empty by design. The destination is
 * never a field: it is a function of the seat's family ({@link memoryDestination}). The copy never moves
 * the source, which stays the rollback. Its receipt beside the seat's other convergence receipts is
 * provenance only: it keeps a later Start from copying again over memory the seat has written since.
 * Whether the seat HAS its memory is always a fresh read of the destination.
 */

/**
 * @summary The consent that declines an import: the seat starts empty.
 * @type {String}
 */
export const MEMORY_IMPORT_NONE = 'none';

/**
 * @summary The import receipt's file name, in the seat's harness home.
 * @type {String}
 */
export const MEMORY_IMPORT_RECEIPT = '.neo-fleet-seat-memory-import.json';

const
    CLAUDE_FAMILIES = new Set(['claude-code', 'claude-desktop']),
    CODEX_FAMILIES  = new Set(['codex', 'codex-desktop']);

/**
 * @summary Whether `source` is an agent's memory folder under `homeDir`: a Claude project's `memory`,
 * the Codex home's `memories`, or a Codex instance's. `defineAgent` is a wire verb, so the consent may
 * name nothing else: the import reads agent memory, never an arbitrary host directory.
 * @param {String} source  A resolved absolute path.
 * @param {String} homeDir
 * @returns {Boolean}
 */
function isMemoryFolder(source, homeDir) {
    const [first, second, third, fourth, ...rest] = path.relative(homeDir, source).split(path.sep);

    if (rest.length) return false;

    return (first === '.claude' && second === 'projects' && !!third && !third.startsWith('.') && fourth === 'memory') ||
           (first === '.codex' && second === 'memories' && third === undefined) ||
           (first === '.codex-instances' && !!second && !second.startsWith('.') && third === 'memories' && fourth === undefined)
}

/**
 * @summary Validates one `memoryImport` consent: `'none'`, or an agent's memory folder under the home
 * directory (`~/.claude/projects/<project>/memory`, `~/.codex/memories`, `~/.codex-instances/<name>/memories`).
 * @param {*} value
 * @param {Object} [options]
 * @param {String} [options.homeDir=os.homedir()]
 * @returns {String} The consent, a path resolved.
 * @throws {TypeError} For anything else.
 */
export function normalizeMemoryImport(value, {homeDir = os.homedir()} = {}) {
    if (value === MEMORY_IMPORT_NONE) return value;

    const source = typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) ? path.resolve(value) : null;

    if (!source || !isMemoryFolder(source, homeDir)) {
        throw new TypeError(`'memoryImport' must be '${MEMORY_IMPORT_NONE}' or an agent's memory folder: ~/.claude/projects/<project>/memory, ~/.codex/memories or ~/.codex-instances/<name>/memories.`)
    }

    return source
}

/**
 * @summary The folder a seat's family loads its markdown memory from: `<agentsRoot>/<id>/memory` for a
 * Claude seat (its pinned `autoMemoryDirectory`), `<CODEX_HOME>/memories` for a Codex seat.
 * @param {Object} options
 * @param {String} options.instanceRoot The absolute agents root.
 * @param {String} options.agentId
 * @param {String} options.harnessType
 * @returns {String|null} `null` for a family that keeps no markdown memory.
 */
export function memoryDestination({instanceRoot, agentId, harnessType}) {
    if (CLAUDE_FAMILIES.has(harnessType)) return deriveAgentMemoryDir({instanceRoot, agentId});

    if (CODEX_FAMILIES.has(harnessType)) {
        return path.join(deriveCodexHome({harnessType, instanceHome: deriveAgentInstanceHome({instanceRoot, agentId, harnessType})}), 'memories')
    }

    return null
}

/**
 * @summary The regular files beneath `dir`, as sorted relative paths. Links are neither followed nor
 * counted.
 * @param {String} dir
 * @param {Object} fileSystem The `fs/promises` surface.
 * @returns {Promise<String[]|null>} `null` when `dir` does not exist.
 */
async function regularFiles(dir, fileSystem) {
    let entries;

    try {
        entries = await fileSystem.readdir(dir, {withFileTypes: true, recursive: true})
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    }

    return entries
        .filter(entry => entry.isFile())
        .map(entry => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
        .sort()
}

/**
 * @summary The real directories one level beneath `dir`, by name; links are skipped.
 * @param {String} dir
 * @param {Object} fileSystem
 * @returns {Promise<String[]>}
 */
async function childDirectories(dir, fileSystem) {
    try {
        return (await fileSystem.readdir(dir, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error
    }
}

/**
 * @summary Existing markdown memory an adopted seat could import, read-only: every folder
 * {@link normalizeMemoryImport} accepts that holds files, with its file count, most files first.
 * @param {Object} [options]
 * @param {String} [options.homeDir=os.homedir()]
 * @param {Object} [options.fileSystem=fs]
 * @returns {Promise<Array<{family: String, path: String, files: Number}>>}
 */
export async function detectMemoryCandidates({homeDir = os.homedir(), fileSystem = fs} = {}) {
    const
        projects  = path.join(homeDir, '.claude', 'projects'),
        instances = path.join(homeDir, '.codex-instances'),
        folders   = [
            ...(await childDirectories(projects, fileSystem)).map(name => ({family: 'claude', path: path.join(projects, name, 'memory')})),
            {family: 'codex', path: path.join(homeDir, '.codex', 'memories')},
            ...(await childDirectories(instances, fileSystem)).map(name => ({family: 'codex', path: path.join(instances, name, 'memories')}))
        ],
        candidates = [];

    for (const folder of folders.filter(({path: dir}) => isMemoryFolder(dir, homeDir))) {
        const files = await regularFiles(folder.path, fileSystem);

        files?.length && candidates.push({...folder, files: files.length})
    }

    return candidates.sort((a, b) => b.files - a.files)
}

/**
 * @summary Converges an adopted seat's memory at Start, then reads it fresh. With a source consented
 * and no receipt, the source is copied into the family's destination (never moved, links skipped,
 * same-named files the seat already has kept), proven identical and receipted. Then the destination
 * must hold memory, or Start refuses, naming the source, the destination and the step.
 * @param {Object} options
 * @param {Object} options.agent        The registry row (`id`, `harnessType`, `memoryImport`).
 * @param {String} options.instanceRoot The absolute agents root.
 * @param {String} [options.homeDir=os.homedir()] The home the consented memory folder lies under.
 * @param {Object} [options.fileSystem=fs]
 * @param {Function} [options.now]      The receipt's clock.
 * @returns {Promise<{state: 'none'|'copied'|'present', source?: String, destination?: String, files?: Number}>}
 * @throws {Error} `FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED` when a consented import left the destination empty.
 */
export async function importSeatMemory({agent, instanceRoot, homeDir = os.homedir(), fileSystem = fs, now = () => new Date().toISOString()}) {
    const source = agent.memoryImport;

    if (!source || source === MEMORY_IMPORT_NONE) return {state: 'none'};

    const destination = memoryDestination({instanceRoot, agentId: agent.id, harnessType: agent.harnessType});

    if (!destination) throw unconverged(agent, source, null, `the '${agent.harnessType}' family keeps no markdown memory`);

    try {
        normalizeMemoryImport(source, {homeDir})
    } catch {
        throw unconverged(agent, source, destination, 'the consent names no agent memory folder')
    }

    // the folder itself, never a link it stands for: the copy reads agent memory and nothing else
    const sourceEntry = await fileSystem.lstat(source).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error
    });

    if (sourceEntry && !sourceEntry.isDirectory()) throw unconverged(agent, source, destination, 'the source is not a real folder');

    const
        instanceHome = deriveAgentInstanceHome({instanceRoot, agentId: agent.id, harnessType: agent.harnessType}),
        receiptPath  = path.join(instanceHome, MEMORY_IMPORT_RECEIPT),
        receipt      = await fileSystem.readFile(receiptPath, 'utf8').then(JSON.parse, error => {
            if (error.code === 'ENOENT') return null;
            throw error
        });

    let copied = false;

    if (!receipt && path.resolve(source) !== destination) {
        const sourceFiles = await regularFiles(source, fileSystem);

        if (sourceFiles?.length) {
            await fileSystem.mkdir(destination, {recursive: true, mode: 0o700});
            await fileSystem.cp(source, destination, {
                recursive         : true,
                force             : false,
                errorOnExist      : false,
                preserveTimestamps: true,
                filter            : async entry => !(await fileSystem.lstat(entry)).isSymbolicLink()
            });

            const identical = await Promise.all(sourceFiles.map(async file =>
                (await fileSystem.readFile(path.join(source, file))).equals(await fileSystem.readFile(path.join(destination, file)))
            ));

            if (identical.every(Boolean)) {
                await fileSystem.mkdir(instanceHome, {recursive: true});
                await writeFileAtomic(receiptPath, `${JSON.stringify({source, destination, files: sourceFiles.length, copiedAt: now()}, null, 2)}\n`, {mode: 0o600});
                copied = true
            }
        }
    }

    const present = await regularFiles(destination, fileSystem);

    if (!present?.length) {
        throw unconverged(agent, source, destination, receipt ? 'it was imported once and is empty now' : 'the source holds no memory to copy')
    }

    return {state: copied ? 'copied' : 'present', source, destination, files: present.length}
}

/**
 * @summary The Start refusal for a consented import that left the seat without memory.
 * @param {Object}      agent
 * @param {String}      source
 * @param {String|null} destination
 * @param {String}      why
 * @returns {Error}
 */
function unconverged(agent, source, destination, why) {
    return Object.assign(new Error(
        `startAgentProvisioned: agent '${agent.id}' consented to import its memory from '${source}', but ` +
        `${destination ? `'${destination}'` : 'its seat'} holds none (${why}). The memory-import step did not converge; ` +
        'copy the memory there before starting it.'
    ), {code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, destination, step: 'memory import'})
}
