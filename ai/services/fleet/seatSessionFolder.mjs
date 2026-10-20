import crypto                from 'crypto';
import fs                    from 'fs';
import path                  from 'path';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/seatSessionFolder
 * @summary Converges a Claude Desktop seat's local session presets to its provisioned checkout before
 * spawn, and reads where the running seat's session opened from the seat's own profile.
 *
 * Claude Desktop passes only `--user-data-dir=<instanceHome>` on the command line and opens the
 * folder recorded in `<instanceHome>/ccd-session-presets.json`. Before spawn (while the app is
 * stopped), {@link convergeSeatSessionPreset} rewrites any stale local preset (`target.kind` absent or
 * `'local'`) to the provisioned checkout, leaves non-local presets untouched, seeds one preset when a
 * signed-in profile has none, returns `'no-account'` without writing when the profile has no signed-in
 * account yet, and leaves the file byte-identical when its local presets already name the checkout.
 *
 * Once running, the seat's Desktop profile records each Code-tab session under
 * `claude-code-sessions/<account>/<org>/local_<id>.json` with the folder it opened in. The profile is
 * the seat's alone, which is why {@link readSeatSessionFolder} reads it rather than the host's shared
 * `~/.claude/projects` transcripts: every session on the machine writes those, so they cannot say
 * whose a session is. The record format is Claude Desktop's own and undocumented, so a record set this
 * reader cannot read answers `unknown` with the reason and never `ok`.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @private */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @summary Discover the signed-in account UUID recorded in a Claude Desktop profile, if any.
 * @param {String} instanceHome
 * @param {Object} fileSystem
 * @returns {String|null}
 * @private
 */
function discoverAccountKey(instanceHome, fileSystem) {
    const readJson = file => {
        try {
            return JSON.parse(fileSystem.readFileSync(path.join(instanceHome, file), 'utf8'))
        } catch {
            return null
        }
    };

    const configAccount = readJson('config.json')?.lastKnownAccountUuid;
    if (typeof configAccount === 'string' && UUID_PATTERN.test(configAccount)) return configAccount;

    const cliOpsAccount = readJson('cowork-enabled-cli-ops.json')?.ownerAccountId;
    if (typeof cliOpsAccount === 'string' && UUID_PATTERN.test(cliOpsAccount)) return cliOpsAccount;

    const registry = readJson('ant-device-registry.json');
    if (isPlainObject(registry)) {
        const key = Object.keys(registry).find(candidate => UUID_PATTERN.test(candidate));
        if (key) return key
    }

    for (const dirName of ['claude-code-sessions', 'local-agent-mode-sessions']) {
        try {
            const entry = fileSystem.readdirSync(path.join(instanceHome, dirName), {withFileTypes: true})
                .find(item => item.isDirectory() && UUID_PATTERN.test(item.name));
            if (entry) return entry.name
        } catch {}
    }

    return null
}

/**
 * @summary Create one local session preset pointing at `cwd`.
 * @param {String} cwd
 * @returns {Object}
 * @private
 */
function createSessionPreset(cwd) {
    const now = Date.now();

    return {
        id        : crypto.randomUUID(),
        name      : path.basename(cwd) || cwd,
        createdAt : now,
        lastUsedAt: now,
        target    : {
            kind: 'local',
            cwd
        }
    }
}

/**
 * @summary Create one account bucket with a single preset pointing at `cwd`.
 * @param {String} cwd
 * @returns {Object}
 * @private
 */
function createAccountBucket(cwd) {
    return {
        presets        : [createSessionPreset(cwd)],
        builtIns       : {},
        seededFromDraft: true
    }
}

/** @private */
function writePresetFile(filePath, content, {mode = 0o600, preserveMode = false} = {}, fileSystem = fs) {
    if (fileSystem === fs) {
        writeFileAtomicSync(filePath, content, {mode, preserveMode});
        return
    }

    fileSystem.writeFileSync(filePath, content, {mode})
}

/**
 * @summary Converge `<instanceHome>/ccd-session-presets.json` to the provisioned checkout `cwd` before
 * spawning Claude Desktop. Rewrites any stale local preset (`target.kind` absent or `'local'`) to `cwd`,
 * leaves non-local presets untouched, seeds one preset when a signed-in profile has no preset file (or
 * an empty account bucket), returns `'no-account'` without writing when the profile has no signed-in
 * account yet, and leaves the file byte-identical when its local presets already name `cwd`.
 * @param {Object} options
 * @param {String} options.instanceHome The seat's Claude Desktop profile directory.
 * @param {String} options.cwd          The absolute provisioned checkout path.
 * @param {Object} [options.fileSystem=fs]
 * @returns {{path: String, status: 'created'|'updated'|'unchanged'|'no-account', cwd: String}}
 */
export function convergeSeatSessionPreset({instanceHome, cwd, fileSystem = fs} = {}) {
    if (typeof instanceHome !== 'string' || !path.isAbsolute(instanceHome)) {
        throw new Error(`convergeSeatSessionPreset: 'instanceHome' must be an absolute path for claude-desktop, received '${instanceHome}'.`)
    }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
        throw new Error("convergeSeatSessionPreset: 'cwd' must be an absolute provisioned checkout for claude-desktop.")
    }

    const presetPath = path.join(instanceHome, 'ccd-session-presets.json');
    let   stat       = null;

    try {
        stat = fileSystem.lstatSync(presetPath)
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }

    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(`convergeSeatSessionPreset: '${presetPath}' must be a regular file.`)
    }

    if (!stat) {
        const accountKey = discoverAccountKey(instanceHome, fileSystem);

        if (!accountKey) {
            return {path: presetPath, status: 'no-account', cwd}
        }

        const content = `${JSON.stringify({byAccount: {[accountKey]: createAccountBucket(cwd)}}, null, '\t')}\n`;

        fileSystem.mkdirSync(instanceHome, {recursive: true});
        writePresetFile(presetPath, content, {mode: 0o600}, fileSystem);
        return {path: presetPath, status: 'created', cwd}
    }

    const raw = fileSystem.readFileSync(presetPath, 'utf8');
    let   parsed;

    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error(`convergeSeatSessionPreset: '${presetPath}' is not valid JSON.`)
    }

    if (!isPlainObject(parsed) || (parsed.byAccount !== undefined && !isPlainObject(parsed.byAccount))) {
        throw new Error(`convergeSeatSessionPreset: '${presetPath}' has an invalid byAccount root.`)
    }

    const
        byAccount     = isPlainObject(parsed.byAccount) ? {...parsed.byAccount} : {},
        discoveredKey = discoverAccountKey(instanceHome, fileSystem),
        accountKeys   = Object.keys(byAccount);
    let changed = !isPlainObject(parsed.byAccount);

    if (accountKeys.length === 0) {
        if (!discoveredKey) {
            return {path: presetPath, status: 'no-account', cwd}
        }
        byAccount[discoveredKey] = createAccountBucket(cwd);
        changed = true
    }

    for (const [accountKey, bucket] of Object.entries(byAccount)) {
        if (!isPlainObject(bucket) || !Array.isArray(bucket.presets) || bucket.presets.length === 0) {
            byAccount[accountKey] = {
                ...(isPlainObject(bucket) ? bucket : {}),
                presets        : [createSessionPreset(cwd)],
                builtIns       : isPlainObject(bucket?.builtIns) ? bucket.builtIns : {},
                seededFromDraft: typeof bucket?.seededFromDraft === 'boolean' ? bucket.seededFromDraft : true
            };
            changed = true;
            continue
        }

        let   bucketChanged = false;
        const presets       = bucket.presets.map(preset => {
            if (!isPlainObject(preset)) {
                bucketChanged = true;
                return createSessionPreset(cwd)
            }

            const target = isPlainObject(preset.target) ? preset.target : null;

            if (target && target.kind !== undefined && target.kind !== 'local') {
                return preset
            }

            const targetCwd = target?.cwd;

            if (target && targetCwd === cwd) {
                return preset
            }

            bucketChanged = true;
            const nextTarget = target ? {...target, cwd} : {kind: 'local', cwd};

            return {...preset, target: nextTarget}
        });

        if (bucketChanged) {
            byAccount[accountKey] = {...bucket, presets};
            changed = true
        }
    }

    if (!changed) {
        return {path: presetPath, status: 'unchanged', cwd}
    }

    const
        indent  = /^[{[]\r?\n([ \t]+)/.exec(raw)?.[1],
        newline = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '',
        content = JSON.stringify({...parsed, byAccount}, null, indent) + newline;

    writePresetFile(presetPath, content, {preserveMode: true, mode: stat.mode & 0o777}, fileSystem);
    return {path: presetPath, status: 'updated', cwd}
}

/**
 * @summary The record files of a profile's session store: two levels of real folders, then
 * `local_*.json` files. Links are skipped.
 * @param {String} root
 * @param {Object} fileSystem
 * @returns {String[]}
 * @throws {Error} `ENOENT` when the store does not exist.
 */
function recordFiles(root, fileSystem) {
    const folders = dir => fileSystem.readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name));

    return folders(root).flatMap(folders).flatMap(dir => fileSystem.readdirSync(dir, {withFileTypes: true})
        .filter(entry => entry.isFile() && /^local_.+\.json$/.test(entry.name))
        .map(entry => path.join(dir, entry.name)))
}

/**
 * @summary The folder a Claude Desktop seat's current session opened in, against the managed checkout
 * it was launched for. The session is the record most recently active since the launch: Desktop
 * reopens a profile's earlier sessions on relaunch, so creation time alone would miss them. Archived
 * sessions are skipped. The folder is `originCwd`, else `cwd`, because a worktree session moves `cwd`
 * while `originCwd` keeps where it opened.
 * @param {Object} options
 * @param {String} options.instanceHome The seat's Desktop profile.
 * @param {String} options.expected     The managed checkout the seat was launched in.
 * @param {String} options.since        The launch's `startedAt`, ISO.
 * @param {Object} [options.fileSystem=fs]
 * @returns {{state: 'pending'|'ok'|'wrong'|'unknown', expected: String, observed?: String, reason?: String}}
 */
export function readSeatSessionFolder({instanceHome, expected, since, fileSystem = fs}) {
    const
        launchedAt = Date.parse(since),
        unknown    = reason => ({state: 'unknown', expected, reason});

    let files;

    try {
        files = recordFiles(path.join(instanceHome, 'claude-code-sessions'), fileSystem)
    } catch (error) {
        return error.code === 'ENOENT'
            ? {state: 'pending', expected}
            : unknown(`the seat's session records could not be listed (${error.code ?? error.message})`)
    }

    let current    = null,
        unreadable = 0;

    for (const file of files) {
        let record;

        // a record that vanished after the listing, or refuses its metadata or its bytes, is
        // unreadable: a throw here would reject every seat's status, not just this one's
        try {
            // a record untouched since the launch was not active since it
            if (fileSystem.statSync(file).mtimeMs < launchedAt) continue;

            record = JSON.parse(fileSystem.readFileSync(file, 'utf8'))
        } catch {
            unreadable++;
            continue
        }

        const
            folder = record?.originCwd ?? record?.cwd,
            active = Math.max(...[record?.lastActivityAt, record?.lastFocusedAt, record?.createdAt].filter(Number.isFinite));

        if (typeof folder !== 'string' || !Number.isFinite(active)) {
            unreadable++;
            continue
        }

        if (record.isArchived === true || active < launchedAt) continue;

        if (!current || active > current.active) current = {folder, active}
    }

    if (!current) {
        return unreadable
            ? unknown(`${unreadable} of the seat's session records could not be read`)
            : {state: 'pending', expected}
    }

    return path.resolve(current.folder) === path.resolve(expected)
        ? {state: 'ok', expected}
        : {state: 'wrong', expected, observed: current.folder}
}

export default readSeatSessionFolder;
