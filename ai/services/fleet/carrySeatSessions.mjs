import Database          from 'better-sqlite3';
import fs                from 'node:fs/promises';
import os                from 'node:os';
import path              from 'node:path';
import {pathToFileURL}   from 'node:url';
import {writeFileAtomic} from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/carrySeatSessions
 * @summary Carries a seat's harness sessions from its previous folder to its new one, so that after a rename the
 * seat resumes the very same sessions. Each harness indexes its sessions by the absolute folder they ran in, and
 * each keeps that index somewhere else:
 * - Claude Desktop lists sessions from its own records (`claude-code-sessions/`; a new session's folder in
 *   `ccd-session-presets.json`) and finds their transcripts in the shared `~/.claude/projects`, in a folder named
 *   after the session's folder. Claude Code keeps those folders in its own config home.
 * - Codex lists threads from its state database (each thread's folder and the rollout it appends to, each
 *   project's root); its global state names projects and its host by path, and `config.toml` paths in the seat.
 *   The rollouts stay byte-identical: its thread history indexes them by byte offset.
 * - Antigravity keeps conversations outside the seat, by the project the Fleet registered. The project keeps its
 *   id under the new name and folder, so the next Start verifies the same project.
 *
 * Only a value that is the previous folder or a path inside it changes; text that mentions it stays. Each step
 * leaves what is already carried as it is, so a re-run completes an interrupted one.
 */

/**
 * @summary Carries one seat's sessions after its folder moved from `from` to `to`.
 * @param {Object} options
 * @param {String} options.harnessType  The seat's harness.
 * @param {String} options.instanceHome The seat's harness home, under its new folder.
 * @param {String} options.from         The seat's previous folder.
 * @param {String} options.to           Its new folder.
 * @param {String} options.previousId   The seat's previous id.
 * @param {String} options.id           Its new id.
 * @param {String} [options.homeDir]    The home of the account the harnesses run as.
 * @returns {Promise<Object|null>} What was carried, per harness; `null` for a harness whose sessions the Fleet does
 *     not know where to find.
 */
export async function carrySeatSessions({harnessType, instanceHome, from, to, previousId, id, homeDir = os.homedir()}) {
    switch (harnessType) {
        case 'claude-code':
            return {transcripts: await carryTranscripts({projects: path.join(instanceHome, 'projects'), from, to})};
        case 'claude-desktop':
            return {
                records    : await carryClaudeDesktopRecords({instanceHome, from, to}),
                transcripts: await carryTranscripts({projects: path.join(homeDir, '.claude', 'projects'), from, to})
            };
        case 'codex':
            return carryCodexHome({codexHome: instanceHome, from, to});
        case 'codex-desktop':
            return carryCodexHome({codexHome: path.join(instanceHome, 'codex-home'), from, to});
        case 'antigravity':
            return carryAntigravityProject({instanceHome, from, to, previousId, id, homeDir});
        default:
            return null
    }
}

/**
 * @summary `value` with the folder `from` replaced by `to` when the value is that folder or a path inside it,
 * spelled as a path, as a `file:` URL, or behind Codex Desktop's `local:` host prefix. Any other value is returned
 * as it is.
 * @param {*}      value
 * @param {String} from
 * @param {String} to
 * @returns {*}
 */
export function rehomePath(value, from, to) {
    if (typeof value !== 'string') return value;

    for (const [head, next] of [[from, to], [`local:${from}`, `local:${to}`], [pathToFileURL(from).href, pathToFileURL(to).href]]) {
        if (value === head || value.startsWith(`${head}/`)) return next + value.slice(head.length)
    }

    return value
}

/**
 * @summary Claude's folder name for sessions that ran in `folder`: every character but letters and digits
 * becomes `-`.
 * @param {String} folder
 * @returns {String}
 */
export function claudeSlug(folder) {
    return folder.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * @summary Renames the transcript folders of sessions that ran inside the previous folder. A folder is matched by
 * the `cwd` its own transcripts record, never by its name alone: a slug loses the separators, so the folder of
 * `neo-fable-clio/neomjs` and that of `neo-fable/clio/neomjs` share one name. A folder whose new name is taken
 * stays as it is.
 * @param {Object} options
 * @param {String} options.projects The `projects` folder of the Claude config home.
 * @param {String} options.from
 * @param {String} options.to
 * @returns {Promise<String[]>} The renamed folders, as `old → new` names.
 * @private
 */
async function carryTranscripts({projects, from, to}) {
    const carried = [], prefix = claudeSlug(from);

    for (const entry of await readdirOrEmpty(projects)) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;

        const cwd = await sessionFolderOf(path.join(projects, entry.name));

        // a carried folder keeps transcripts that record the old cwd, so its name no longer matches that cwd
        if (!cwd || claudeSlug(cwd) !== entry.name) continue;

        const moved = rehomePath(cwd, from, to), name = claudeSlug(moved);

        if (moved === cwd || await lstatOrNull(path.join(projects, name))) continue;

        await fs.rename(path.join(projects, entry.name), path.join(projects, name));
        carried.push(`${entry.name} → ${name}`)
    }

    return carried
}

/**
 * @summary The folder the sessions of one transcript folder ran in, read from the first transcript line that
 * records a `cwd`.
 * @param {String} folder
 * @returns {Promise<String|null>}
 * @private
 */
async function sessionFolderOf(folder) {
    const transcripts = (await readdirOrEmpty(folder)).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort();

    for (const name of transcripts.slice(0, 3)) {
        const handle = await fs.open(path.join(folder, name), 'r');

        try {
            const {buffer, bytesRead} = await handle.read({buffer: Buffer.alloc(65536), position: 0});

            for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
                try {
                    const cwd = JSON.parse(line)?.cwd;

                    if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd
                } catch {
                    // a line cut by the read, or not JSON
                }
            }
        } finally {
            await handle.close()
        }
    }

    return null
}

/**
 * @summary Points Claude Desktop's session records, and the folder its new sessions open in, at the new folder.
 * @param {Object} options
 * @param {String} options.instanceHome
 * @param {String} options.from
 * @param {String} options.to
 * @returns {Promise<Number>} How many files changed.
 * @private
 */
async function carryClaudeDesktopRecords({instanceHome, from, to}) {
    const
        sessions = path.join(instanceHome, 'claude-code-sessions'),
        files    = (await readdirOrEmpty(sessions, {recursive: true}))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => path.join(entry.parentPath, entry.name));

    let changed = 0;

    for (const file of [...files, path.join(instanceHome, 'ccd-session-presets.json')]) {
        await rewriteJsonFile(file, value => rehomeJson(value, from, to)) && changed++
    }

    return changed
}

/**
 * @summary Points Codex Desktop's threads, projects and config at the new folder.
 * @param {Object} options
 * @param {String} options.codexHome
 * @param {String} options.from
 * @param {String} options.to
 * @returns {Promise<{threads: Number, files: String[]}>} How many database values changed, and which files.
 * @private
 */
async function carryCodexHome({codexHome, from, to}) {
    const names   = (await readdirOrEmpty(codexHome)).map(entry => entry.name), files = [];
    let   threads = 0;

    for (const name of names.filter(name => /^state_\d+\.sqlite$/.test(name))) {
        threads += rehomeStateDatabase(path.join(codexHome, name), from, to)
    }

    for (const name of ['.codex-global-state.json', '.codex-global-state.json.bak']) {
        await rewriteJsonFile(path.join(codexHome, name), value => rehomeJson(value, from, to, {keys: true})) && files.push(name)
    }

    await rewriteTextFile(path.join(codexHome, 'config.toml'), text => rehomeText(text, from, to)) && files.push('config.toml');

    return {threads, files}
}

/**
 * @summary Rewrites the path columns of one Codex state database in one transaction: each thread's `cwd` and
 * `rollout_path`, each project root's `path`. A column the database does not have is left out, so a later
 * schema changes only what it still names.
 * @param {String} file
 * @param {String} from
 * @param {String} to
 * @returns {Number} How many values changed.
 * @private
 */
function rehomeStateDatabase(file, from, to) {
    const db = new Database(file, {fileMustExist: true});

    try {
        const has     = (table, column) => db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined;
        let   changed = 0;

        db.transaction(() => {
            for (const [table, column] of [['threads', 'cwd'], ['threads', 'rollout_path'], ['project_roots', 'path']]) {
                if (!has(table, column)) continue;

                const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);

                for (const {key, value} of db.prepare(`SELECT rowid AS key, "${column}" AS value FROM "${table}"`).all()) {
                    const next = rehomePath(value, from, to);

                    if (next !== value) {
                        update.run(next, key);
                        changed++
                    }
                }
            }
        })();

        return changed
    } finally {
        db.close()
    }
}

/**
 * @summary Keeps the project the Fleet registered for an Antigravity seat: its receipt and Antigravity's own
 * record of it take the new name and folder, under the same project id.
 * @param {Object} options
 * @param {String} options.instanceHome
 * @param {String} options.from
 * @param {String} options.to
 * @param {String} options.previousId
 * @param {String} options.id
 * @param {String} options.homeDir
 * @returns {Promise<{receipt: String, project: String}>} Each `repointed`, `current` or `absent`.
 * @private
 */
async function carryAntigravityProject({instanceHome, from, to, previousId, id, homeDir}) {
    const
        receiptPath = path.join(instanceHome, '.neo-fleet-project-binding.json'),
        projectId   = (await readJsonOrNull(receiptPath))?.projectId,
        rename      = name => name === previousId ? id : name,
        outcome     = changed => changed === null ? 'absent' : changed ? 'repointed' : 'current';

    // the receipt names the project file, so an id that is no UUID names no file of the Fleet's
    if (typeof projectId !== 'string' || !/^[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(projectId)) {
        return {receipt: 'absent', project: 'absent'}
    }

    return {
        receipt: outcome(await rewriteJsonFile(receiptPath, value => ({...value, projectName: rename(value.projectName), projectRoot: rehomePath(value.projectRoot, from, to)}))),
        project: outcome(await rewriteJsonFile(path.join(homeDir, '.gemini', 'config', 'projects', `${projectId}.json`),
            value => ({...value, name: rename(value.name), projectResources: rehomeJson(value.projectResources, from, to)})))
    }
}

/**
 * @summary `value` with every string, and with `keys` every object key, passed through {@link rehomePath}.
 * @param {*}       value
 * @param {String}  from
 * @param {String}  to
 * @param {Object}  [options]
 * @param {Boolean} [options.keys=false]
 * @returns {*}
 * @private
 */
function rehomeJson(value, from, to, {keys = false} = {}) {
    if (typeof value === 'string')  return rehomePath(value, from, to);
    if (Array.isArray(value))       return value.map(item => rehomeJson(item, from, to, {keys}));
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? rehomePath(key, from, to) : key, rehomeJson(item, from, to, {keys})]))
}

/**
 * @summary The previous folder replaced wherever it stands whole in a config file: after a quote, a separator or
 * the line start, and before a `/`, a quote, a `:` or the line end.
 * @param {String} text
 * @param {String} from
 * @param {String} to
 * @returns {String}
 * @private
 */
function rehomeText(text, from, to) {
    const folder = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return text.replace(new RegExp(`(?<=^|["'\\s:=])${folder}(?=$|["'/:])`, 'gm'), to)
}

/**
 * @summary Rewrites one JSON file through `map`, keeping its indentation, its final newline and its mode.
 * @param {String}   file
 * @param {Function} map
 * @returns {Promise<Boolean|null>} Whether it changed; `null` when there is no such file.
 * @private
 */
async function rewriteJsonFile(file, map) {
    return rewriteTextFile(file, text => {
        const value = JSON.parse(text), next = map(value);

        if (JSON.stringify(next) === JSON.stringify(value)) return text;

        return JSON.stringify(next, null, /^[{[]\r?\n([ \t]+)/.exec(text)?.[1]) + (text.endsWith('\n') ? '\n' : '')
    })
}

/**
 * @summary Rewrites one text file through `map`, atomically and keeping its mode.
 * @param {String}   file
 * @param {Function} map
 * @returns {Promise<Boolean|null>} Whether it changed; `null` when there is no such file.
 * @private
 */
async function rewriteTextFile(file, map) {
    let text;

    try {
        text = await fs.readFile(file, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error
    }

    const next = map(text);

    if (next === text) return false;

    await writeFileAtomic(file, next, {preserveMode: true});

    return true
}

/** @private */
async function readJsonOrNull(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error
    }
}

/** @private */
async function readdirOrEmpty(folder, options = {}) {
    try {
        return await fs.readdir(folder, {withFileTypes: true, ...options})
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error
    }
}

// moveSeatHomes has the same helper, but importing it would load the Neo runtime into this file-only module
/** @private */
function lstatOrNull(file) {
    return fs.lstat(file).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error
    })
}
