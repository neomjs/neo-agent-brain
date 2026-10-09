import fs                                              from 'fs/promises';
import os                                              from 'os';
import path                                            from 'path';
import {deriveAgentInstanceHome, deriveAgentMemoryDir} from './deriveAgentInstanceHome.mjs';
import {writeFileAtomic}                               from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/seatMemoryImport
 * @summary An adopted seat's markdown memory: where an existing agent keeps it, where the seat's family
 * loads it from, the copy that converges it at Start, and the refusal when a consented import did not
 * converge.
 *
 * The consent is the registry row's `memoryImport`: a source path or `'none'`, recorded at birth by
 * `defineAgent`, or later through `configureAgent` while the seat neither runs nor holds its memory
 * ({@link seatHoldsMemory}). A seat with no consent is a fresh one and starts empty by design. The destination is
 * never a field: supported families share the seat-owned folder ({@link memoryDestination}). The copy never moves
 * the source, which stays the rollback. Its receipt beside that folder is
 * provenance only: it keeps a later Start from copying again over memory the seat has written since.
 * Whether the seat HAS its memory is always a fresh read of the destination.
 */

/**
 * @summary The consent that declines an import: the seat starts empty.
 * @type {String}
 */
export const MEMORY_IMPORT_NONE = 'none';

/**
 * @summary The receipt beside `<seat>/memory`; legacy harness-home receipts remain readable.
 * @type {String}
 */
export const MEMORY_IMPORT_RECEIPT = '.neo-fleet-seat-memory-import.json';

const MEMORY_FAMILIES = new Set(['claude-code', 'claude-desktop', 'codex', 'codex-desktop', 'kimi-code', 'opencode']);

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
 * @summary The seat-owned folder a memory-capable family loads its markdown memory from.
 * @param {Object} options
 * @param {String} options.instanceRoot The absolute agents root.
 * @param {String} options.agentId
 * @param {String} options.harnessType
 * @returns {String|null} `null` for a family that keeps no markdown memory.
 */
export function memoryDestination({instanceRoot, agentId, harnessType}) {
    if (MEMORY_FAMILIES.has(harnessType)) return deriveAgentMemoryDir({instanceRoot, agentId});

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
 * @summary The first path beneath `homeDir` on the way down to `dir` that is not a real folder: a link
 * or a file. The consent is judged by its words, so a link on any segment would carry an agent memory
 * path into some other tree.
 * @param {String} homeDir
 * @param {String} dir        A path {@link isMemoryFolder} accepts.
 * @param {Object} fileSystem
 * @returns {Promise<String|null>} `null` when every segment that exists is a real folder.
 */
async function firstNonFolder(homeDir, dir, fileSystem) {
    let current = homeDir;

    for (const segment of path.relative(homeDir, dir).split(path.sep)) {
        current = path.join(current, segment);

        const entry = await fileSystem.lstat(current).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error
        });

        if (!entry) return null;
        if (!entry.isDirectory()) return current
    }

    return null
}

/**
 * @summary Finds the first existing symlink or non-directory on a path, or a non-file at a file leaf.
 * @param {String} pathname
 * @param {String} instanceRoot Trusted agents-root anchor; ancestors above it may be symlinks.
 * @param {Object} fileSystem
 * @param {'directory'|'file'} [leafType='directory']
 * @returns {Promise<String|null>}
 */
async function firstUnsafePathEntry(pathname, instanceRoot, fileSystem, leafType = 'directory') {
    const
        absolute = path.resolve(pathname),
        anchor   = path.resolve(instanceRoot),
        relative = path.relative(anchor, absolute);

    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return absolute;

    const anchorEntry = await fileSystem.lstat(anchor).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error
    });

    if (!anchorEntry) return null;
    if (anchorEntry.isSymbolicLink() || !anchorEntry.isDirectory()) return anchor;
    if (!relative) return leafType === 'directory' ? null : anchor;

    const segments = relative.split(path.sep).filter(Boolean);

    let current = anchor;

    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);

        const entry = await fileSystem.lstat(current).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error
        });

        if (!entry) return null;
        if (entry.isSymbolicLink()) return current;

        const isLeaf = index === segments.length - 1;

        if (isLeaf ? (leafType === 'directory' ? !entry.isDirectory() : !entry.isFile()) : !entry.isDirectory()) {
            return current
        }
    }

    return null
}

/**
 * @summary Finds symlinks and special files inside an existing destination tree without following them.
 * @param {String} dir
 * @param {Object} fileSystem
 * @returns {Promise<String|null>}
 */
async function firstUnsafeTreeEntry(dir, fileSystem) {
    let entries;

    try {
        entries = await fileSystem.readdir(dir, {withFileTypes: true})
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    }

    for (const entry of entries) {
        const child = path.join(dir, entry.name);

        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return child;
        if (entry.isDirectory()) {
            const nested = await firstUnsafeTreeEntry(child, fileSystem);

            if (nested) return nested
        }
    }

    return null
}

/**
 * @summary Refuses a destination or receipt path that leaves the seat tree or crosses a symlink/non-folder.
 * @param {Object} options
 * @param {String} options.instanceRoot
 * @param {String} options.agentId
 * @param {String} options.destination
 * @param {Object} options.fileSystem
 * @returns {Promise<Boolean>}
 */
async function hasUnsafeImportPath({instanceRoot, agentId, destination, fileSystem}) {
    const seatRoot            = path.resolve(instanceRoot, agentId),
          destinationRelative = path.relative(seatRoot, path.resolve(destination));

    if (!destinationRelative || destinationRelative === '..' || destinationRelative.startsWith(`..${path.sep}`) || path.isAbsolute(destinationRelative)) {
        return true
    }

    if (await firstUnsafePathEntry(destination, instanceRoot, fileSystem) || await firstUnsafeTreeEntry(destination, fileSystem)) {
        return true
    }

    return false
}

/**
 * @summary A receipt's destination relative to its seat root, including legacy absolute receipt paths.
 * @param {*} recordedDestination
 * @param {String} seatRoot
 * @param {String} agentId
 * @returns {String|null}
 */
function receiptDestinationRelative(recordedDestination, seatRoot, agentId) {
    if (typeof recordedDestination !== 'string' || !recordedDestination) return null;

    if (!path.isAbsolute(recordedDestination)) {
        const relative = path.normalize(recordedDestination);

        return relative !== '.' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
            ? relative
            : null
    }

    const absolute = path.resolve(recordedDestination),
          current  = path.relative(seatRoot, absolute);

    if (current && current !== '..' && !current.startsWith(`..${path.sep}`) && !path.isAbsolute(current)) return current;

    // Legacy receipts only stored an absolute destination. After a seat-root move, the old root is
    // unknown, so recognize the exact seat-relative shapes Fleet has previously produced.
    const segments  = absolute.split(path.sep).filter(Boolean),
          seatIndex = segments.lastIndexOf(agentId),
          legacy    = seatIndex < 0 ? null : segments.slice(seatIndex + 1).join(path.sep);

    return legacy === 'memory' ? legacy : null
}

/**
 * @summary Whether a receipt names the current destination relative to this seat, independent of its root.
 * @param {Object|null} receipt
 * @param {String} destination
 * @param {String} seatRoot
 * @param {String} agentId
 * @returns {Boolean}
 */
function receiptMatchesDestination(receipt, destination, seatRoot, agentId) {
    const current = path.relative(seatRoot, path.resolve(destination));

    if (!current || current === '..' || current.startsWith(`..${path.sep}`) || path.isAbsolute(current)) return false;

    return receiptDestinationRelative(receipt?.destination, seatRoot, agentId) === current
}

/**
 * @summary Reads one receipt without following links and validates its stable envelope.
 * @param {String} receiptPath
 * @param {String} instanceRoot Trusted agents-root anchor.
 * @param {Object} fileSystem
 * @returns {Promise<{exists: Boolean, receipt?: Object, invalid?: Boolean}>}
 */
async function readMemoryImportReceipt(receiptPath, instanceRoot, fileSystem) {
    if (await firstUnsafePathEntry(receiptPath, instanceRoot, fileSystem, 'file')) {
        return {exists: true, invalid: true}
    }

    const raw = await fileSystem.readFile(receiptPath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error
    });

    if (raw === null) return {exists: false};

    let receipt;

    try {
        receipt = JSON.parse(raw)
    } catch {
        return {exists: true, invalid: true}
    }

    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        typeof receipt.source !== 'string' || typeof receipt.destination !== 'string' ||
        !Number.isInteger(receipt.files) || typeof receipt.copiedAt !== 'string') {
        return {exists: true, invalid: true}
    }

    return {exists: true, receipt}
}

/**
 * @summary Reads the canonical receipt first, then searches legacy harness homes only when it is absent.
 * @param {Object} options
 * @param {Object} options.agent
 * @param {String} options.instanceRoot
 * @param {String} options.destination
 * @param {String} options.canonicalPath
 * @param {Object} options.fileSystem
 * @returns {Promise<{receipt: Object|null, legacy: Boolean, invalid: Boolean}>}
 */
async function findMemoryImportReceipt({agent, instanceRoot, destination, canonicalPath, fileSystem}) {
    const canonical = await readMemoryImportReceipt(canonicalPath, instanceRoot, fileSystem);

    if (canonical.exists) {
        return {
            receipt: canonical.receipt ?? null,
            legacy : false,
            invalid: !!canonical.invalid
        }
    }

    const harnessTypes = [agent.harnessType, ...[...MEMORY_FAMILIES].filter(type => type !== agent.harnessType)];

    for (const harnessType of harnessTypes) {
        const legacyPath = path.join(
            deriveAgentInstanceHome({instanceRoot, agentId: agent.id, harnessType}),
            MEMORY_IMPORT_RECEIPT
        );

        if (legacyPath === canonicalPath) continue;

        const candidate = await readMemoryImportReceipt(legacyPath, instanceRoot, fileSystem);

        if (!candidate.exists || candidate.invalid || !receiptMatchesDestination(candidate.receipt, destination, path.resolve(instanceRoot, agent.id), agent.id)) {
            continue
        }

        return {receipt: candidate.receipt, legacy: true, invalid: false}
    }

    return {receipt: null, legacy: false, invalid: false}
}

/**
 * @summary How each of `files` stands in the seat against the source: `'same'` bytes, `'missing'` or
 * `'different'`.
 * @param {String[]} files       Paths relative to both folders.
 * @param {String}   source
 * @param {String}   destination
 * @param {Object}   fileSystem
 * @returns {Promise<String[]>} One state per file, in order.
 */
function compareFiles(files, source, destination, fileSystem) {
    return Promise.all(files.map(async file => {
        const held = await fileSystem.readFile(path.join(destination, file)).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error
        });

        if (!held) return 'missing';

        return held.equals(await fileSystem.readFile(path.join(source, file))) ? 'same' : 'different'
    }))
}

/**
 * @summary The name a memory candidate is offered by: derived from its folder, never its path. A Codex
 * instance is its folder's name, and the Codex home is `codex`. A Claude project folder is a slug, the
 * project's absolute path with every character outside `[A-Za-z0-9]` written as `-`; its name is the
 * slug without the home directory's own encoding when the project lies inside it (`~` for the home
 * itself), and otherwise without its leading dash.
 * @param {String} source A candidate {@link isMemoryFolder} accepts.
 * @param {String} homeDir
 * @returns {String}
 */
function candidateName(source, homeDir) {
    const
        [first, second, slug] = path.relative(homeDir, source).split(path.sep),
        home                  = homeDir.replace(/[^A-Za-z0-9]/g, '-');

    if (first === '.codex')           return 'codex';
    if (first === '.codex-instances') return second;
    if (slug === home)                return '~';

    return (slug.startsWith(`${home}-`) ? slug.slice(home.length + 1) : slug.replace(/^-+/, '')) || slug
}

/**
 * @summary Existing markdown memory an adopted seat could import, read-only: every folder
 * {@link normalizeMemoryImport} accepts that holds files and lies under real folders only, most notes
 * first. Each candidate carries what the operator chooses by — its name ({@link candidateName}), its
 * note count and its newest change — and the `source` a `memoryImport` consent names. No file's
 * contents are read.
 * @param {Object} [options]
 * @param {String} [options.homeDir=os.homedir()]
 * @param {Object} [options.fileSystem=fs]
 * @returns {Promise<Array<{family: String, source: String, name: String, notes: Number, lastChanged: String}>>}
 */
export async function detectMemoryCandidates({homeDir = os.homedir(), fileSystem = fs} = {}) {
    const
        projects  = path.join(homeDir, '.claude', 'projects'),
        instances = path.join(homeDir, '.codex-instances'),
        folders   = [
            ...(await childDirectories(projects, fileSystem)).map(name => ({family: 'claude', source: path.join(projects, name, 'memory')})),
            {family: 'codex', source: path.join(homeDir, '.codex', 'memories')},
            ...(await childDirectories(instances, fileSystem)).map(name => ({family: 'codex', source: path.join(instances, name, 'memories')}))
        ],
        candidates = [];

    for (const {family, source} of folders.filter(folder => isMemoryFolder(folder.source, homeDir))) {
        if (await firstNonFolder(homeDir, source, fileSystem)) continue;

        const files = await regularFiles(source, fileSystem);

        if (!files?.length) continue;

        const changed = await Promise.all(files.map(async file => (await fileSystem.lstat(path.join(source, file))).mtimeMs));

        candidates.push({
            family,
            source,
            name       : candidateName(source, homeDir),
            notes      : files.length,
            lastChanged: new Date(Math.max(...changed)).toISOString()
        })
    }

    return candidates.sort((a, b) => b.notes - a.notes)
}

/**
 * @summary Whether a seat already holds its memory: a receipt for its current destination, or any file in
 * that destination. A consent can still be given or withdrawn only while this reads `false`; from then on
 * the memory is the seat's own, and an import would copy over what it has written.
 * @param {Object} options
 * @param {Object} options.agent        The registry row (`id`, `harnessType`).
 * @param {String} options.instanceRoot The absolute agents root.
 * @param {Object} [options.fileSystem=fs]
 * @returns {Promise<Boolean>}
 */
export async function seatHoldsMemory({agent, instanceRoot, fileSystem = fs}) {
    const
        destination = memoryDestination({instanceRoot, agentId: agent.id, harnessType: agent.harnessType}),
        seatRoot    = path.resolve(instanceRoot, agent.id),
        receiptPath = path.join(seatRoot, MEMORY_IMPORT_RECEIPT);

    if (!destination) return false;

    if (await hasUnsafeImportPath({instanceRoot, agentId: agent.id, destination, fileSystem})) {
        throw unconverged(agent.memoryImport ?? MEMORY_IMPORT_NONE, destination, 'the seat memory path contains a link or a non-folder')
    }

    const {receipt, invalid} = await findMemoryImportReceipt({agent, instanceRoot, destination, canonicalPath: receiptPath, fileSystem});

    if (invalid) throw unconverged(agent.memoryImport ?? MEMORY_IMPORT_NONE, destination, 'the seat memory receipt is invalid');

    return receiptMatchesDestination(receipt, destination, seatRoot, agent.id) || !!(await regularFiles(destination, fileSystem))?.length
}

/**
 * @summary Converges an adopted seat's memory at Start, then reads it fresh. With a source consented
 * and no matching receipt, the first import must complete: the source is copied into the seat's destination
 * (never moved, links skipped, the folder owner-only), proven identical and receipted. A source that
 * holds nothing, or a file the seat already holds with other bytes, refuses before anything is copied.
 * A matching receipt survives root, home and harness changes without re-reading the old source.
 * Legacy harness-home receipts are retained and normalized beside memory. The destination must
 * still hold memory. Every refusal names the source, the destination and the step.
 * @param {Object} options
 * @param {Object} options.agent        The registry row (`id`, `harnessType`, `memoryImport`).
 * @param {String} options.instanceRoot The absolute agents root.
 * @param {String} [options.homeDir=os.homedir()] The home the consented memory folder lies under.
 * @param {Object} [options.fileSystem=fs]
 * @param {Function} [options.now]      The receipt's clock.
 * @returns {Promise<{state: 'none'|'copied'|'present', source?: String, destination?: String, files?: Number}>}
 * @throws {Error} `FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED` when a consented import did not converge.
 */
export async function importSeatMemory({agent, instanceRoot, homeDir = os.homedir(), fileSystem = fs, now = () => new Date().toISOString()}) {
    const source = agent.memoryImport;

    if (!source || source === MEMORY_IMPORT_NONE) return {state: 'none'};

    const destination = memoryDestination({instanceRoot, agentId: agent.id, harnessType: agent.harnessType});

    if (!destination) throw unconverged(source, null, `the '${agent.harnessType}' family keeps no markdown memory`);

    const
        seatRoot    = path.resolve(instanceRoot, agent.id),
        receiptPath = path.join(seatRoot, MEMORY_IMPORT_RECEIPT);

    if (await hasUnsafeImportPath({instanceRoot, agentId: agent.id, destination, fileSystem})) {
        throw unconverged(source, destination, 'the seat memory path contains a link or a non-folder')
    }

    const {receipt, legacy, invalid} = await findMemoryImportReceipt({agent, instanceRoot, destination, canonicalPath: receiptPath, fileSystem});

    if (invalid) throw unconverged(source, destination, 'the seat memory receipt is invalid');

    const receiptMatches = receiptMatchesDestination(receipt, destination, seatRoot, agent.id);

    if (receiptMatches && legacy) {
        await writeFileAtomic(receiptPath, `${JSON.stringify({...receipt, destination: path.relative(seatRoot, destination)}, null, 2)}\n`, {mode: 0o600})
    }

    if (!receiptMatches) {
        try {
            normalizeMemoryImport(source, {homeDir})
        } catch {
            throw unconverged(source, destination, 'the consent names no agent memory folder')
        }

        if (await firstNonFolder(homeDir, source, fileSystem)) {
            throw unconverged(source, destination, 'a part of the source path is a link or a file, not a real folder')
        }
    }

    let copied = false;

    if (!receiptMatches && path.resolve(source) !== destination) {
        const sourceFiles = await regularFiles(source, fileSystem);

        if (!sourceFiles?.length) throw unconverged(source, destination, 'the source holds no memory to copy');

        const held      = await compareFiles(sourceFiles, source, destination, fileSystem),
              conflicts = sourceFiles.filter((file, index) => held[index] === 'different');

        if (conflicts.length) {
            throw unconverged(source, destination, `the seat already holds a different ${conflicts.join(', ')}; reconcile the seat's copy with the source, then start again`)
        }

        await fileSystem.mkdir(destination, {recursive: true, mode: 0o700});
        // mkdir leaves a folder the family's preparation already made at its mode
        await fileSystem.chmod(destination, 0o700);
        await fileSystem.cp(source, destination, {
            recursive         : true,
            force             : false,
            errorOnExist      : false,
            preserveTimestamps: true,
            filter            : async entry => !(await fileSystem.lstat(entry)).isSymbolicLink()
        });

        const arrived    = await compareFiles(sourceFiles, source, destination, fileSystem),
              unverified = sourceFiles.filter((file, index) => arrived[index] !== 'same');

        if (unverified.length) throw unconverged(source, destination, `the copy did not arrive identical: ${unverified.join(', ')}`);

        await writeFileAtomic(receiptPath, `${JSON.stringify({source, destination: path.relative(seatRoot, destination), files: sourceFiles.length, copiedAt: now()}, null, 2)}\n`, {mode: 0o600});
        copied = true
    }

    const present = await regularFiles(destination, fileSystem);

    if (!present?.length) {
        throw unconverged(source, destination, receiptMatches ? "the seat's memory folder holds none (it was imported once and is empty now)" : "the seat's memory folder holds none")
    }

    return {state: copied ? 'copied' : 'present', source, destination, files: present.length}
}

/**
 * @summary The Start refusal for a consented import that did not converge. Its reason leads with the step
 * and why it stopped, and names neither the seat (the card is the seat) nor a host path: the source and
 * the destination travel as the error's fields, which the start rejection carries beside the reason.
 * @param {String}      source
 * @param {String|null} destination
 * @param {String}      why         What stands in the way, in words the operator can act on.
 * @returns {Error}
 */
function unconverged(source, destination, why) {
    return Object.assign(new Error(`startAgentProvisioned: the memory import did not converge: ${why}. The seat does not start.`),
        {code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, destination, step: 'memory import'})
}
