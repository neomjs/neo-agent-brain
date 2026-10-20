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
 *   `ccd-session-presets.json`, cached repo paths in `git-worktrees.json`) and finds their transcripts in the shared
 *   `~/.claude/projects`, in a folder named after the session's folder. Claude Code keeps those folders in its own
 *   config home.
 * - Codex lists threads from its state database (each thread's folder and the rollout it appends to, each
 *   project's root); its global state names projects and its host by path, and `config.toml` paths in the seat.
 *   The rollouts stay byte-identical: its thread history indexes them by byte offset.
 * - Antigravity keeps conversations outside the seat, by the project the Fleet registered. The project keeps its
 *   id under the new name and folder, so the next Start verifies the same project. Each existing conversation's
 *   protobuf record in `~/.gemini/antigravity/conversations` keeps the workspace URI it started with, so the seat
 *   starts a new conversation after the rename.
 *
 * Only a value that is the previous folder or a path inside it changes; text that mentions it stays. Each step
 * leaves what is already carried as it is, so a re-run completes an interrupted one.
 */

/**
 * @summary Carries one seat's sessions after its folder moved from `from` to `to`.
 * @param {Object}  options
 * @param {String}  options.harnessType   The seat's harness.
 * @param {String}  options.instanceHome  The seat's harness home, under its new folder (or its current folder on a dry run).
 * @param {String}  options.from          The seat's previous folder.
 * @param {String}  options.to            Its new folder.
 * @param {String}  options.previousId    The seat's previous id.
 * @param {String}  options.id            Its new id.
 * @param {String}  [options.homeDir]     The home of the account the harnesses run as.
 * @param {Boolean} [options.dryRun=false] Report what would be carried and change nothing.
 * @returns {Promise<Object|null>} What was carried, per harness (including a normalized `count` and any
 *     post-rename `nextStep`); `null` for a harness whose sessions the Fleet does not know where to find.
 */
export async function carrySeatSessions({harnessType, instanceHome, from, to, previousId, id, homeDir = os.homedir(), dryRun = false}) {
    switch (harnessType) {
        case 'claude-code': {
            const transcripts = await carryTranscripts({projects: path.join(instanceHome, 'projects'), from, to, dryRun});

            return {transcripts, count: transcripts.filter(item => !item.includes(' → kept:')).length}
        }
        case 'claude-desktop': {
            const
                records     = await carryClaudeDesktopRecords({instanceHome, from, to, dryRun}),
                transcripts = await carryTranscripts({projects: path.join(homeDir, '.claude', 'projects'), from, to, dryRun});

            return {records, transcripts, count: transcripts.filter(item => !item.includes(' → kept:')).length}
        }
        case 'codex':
            return carryCodexHome({codexHome: instanceHome, from, to, dryRun});
        case 'codex-desktop':
            return carryCodexHome({codexHome: path.join(instanceHome, 'codex-home'), from, to, dryRun});
        case 'antigravity':
            return carryAntigravityProject({instanceHome, from, to, previousId, id, homeDir, dryRun});
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
 * stays as it is, and the result says so: its sessions stay listed under the old folder.
 * @param {Object}  options
 * @param {String}  options.projects      The `projects` folder of the Claude config home.
 * @param {String}  options.from
 * @param {String}  options.to
 * @param {Boolean} [options.dryRun=false]
 * @returns {Promise<String[]>} By folder name, each renamed folder as `old → new` and each kept one as
 *     `old → kept: new exists`.
 * @private
 */
async function carryTranscripts({projects, from, to, dryRun = false}) {
    const carried = [], prefix = claudeSlug(from);

    for (const entry of (await readdirOrEmpty(projects)).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;

        const cwd = await sessionFolderOf(path.join(projects, entry.name));

        // a carried folder keeps transcripts that record the old cwd, so its name no longer matches that cwd
        if (!cwd || claudeSlug(cwd) !== entry.name) continue;

        const moved = rehomePath(cwd, from, to), name = claudeSlug(moved);

        if (moved === cwd) continue;

        if (await lstatOrNull(path.join(projects, name))) {
            carried.push(`${entry.name} → kept: ${name} exists`);
            continue
        }

        !dryRun && await fs.rename(path.join(projects, entry.name), path.join(projects, name));
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
 * @summary Points Claude Desktop's session records, the folder its new sessions open in, and its worktree cache
 * at the new folder.
 * @param {Object}  options
 * @param {String}  options.instanceHome
 * @param {String}  options.from
 * @param {String}  options.to
 * @param {Boolean} [options.dryRun=false]
 * @returns {Promise<Number>} How many files changed.
 * @private
 */
async function carryClaudeDesktopRecords({instanceHome, from, to, dryRun = false}) {
    const
        sessions = path.join(instanceHome, 'claude-code-sessions'),
        files    = (await readdirOrEmpty(sessions, {recursive: true}))
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => path.join(entry.parentPath, entry.name));

    let changed = 0;

    for (const file of [...files, path.join(instanceHome, 'ccd-session-presets.json'), path.join(instanceHome, 'git-worktrees.json')]) {
        await rewriteJsonFile(file, value => rehomeJson(value, from, to, {keys: true}), {dryRun}) && changed++
    }

    return changed
}

/**
 * @summary Points Codex Desktop's threads, projects and config at the new folder.
 * @param {Object}  options
 * @param {String}  options.codexHome
 * @param {String}  options.from
 * @param {String}  options.to
 * @param {Boolean} [options.dryRun=false]
 * @returns {Promise<{threads: Number, count: Number, files: String[]}>} How many database values changed, how many
 *     thread rows changed, and which files.
 * @private
 */
async function carryCodexHome({codexHome, from, to, dryRun = false}) {
    const names   = (await readdirOrEmpty(codexHome)).map(entry => entry.name), files = [];
    let   threads = 0, count = 0;

    for (const name of names.filter(name => /^state_\d+\.sqlite$/.test(name))) {
        const {values, rows} = rehomeStateDatabase(path.join(codexHome, name), from, to, {dryRun});

        threads += values;
        count   += rows
    }

    for (const name of ['.codex-global-state.json', '.codex-global-state.json.bak']) {
        await rewriteJsonFile(path.join(codexHome, name), value => rehomeJson(value, from, to, {keys: true}), {dryRun}) && files.push(name)
    }

    await rewriteTextFile(path.join(codexHome, 'config.toml'), text => rehomeText(text, from, to), {dryRun}) && files.push('config.toml');

    return {threads, count, files}
}

/**
 * @summary Rewrites the path columns of one Codex state database in one transaction: each thread's `cwd` and
 * `rollout_path`, each project root's `path`. A column the database does not have is left out, so a later
 * schema changes only what it still names.
 * @param {String}  file
 * @param {String}  from
 * @param {String}  to
 * @param {Object}  [options]
 * @param {Boolean} [options.dryRun=false]
 * @returns {{values: Number, rows: Number}} How many values and distinct `threads` rows changed.
 * @private
 */
function rehomeStateDatabase(file, from, to, {dryRun = false} = {}) {
    const db = new Database(file, {fileMustExist: true, readonly: dryRun});

    try {
        const
            has  = (table, column) => db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined,
            walk = () => {
                const threadRows = new Set();
                let   values     = 0;

                for (const [table, column] of [['threads', 'cwd'], ['threads', 'rollout_path'], ['project_roots', 'path']]) {
                    if (!has(table, column)) continue;

                    const update = dryRun ? null : db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);

                    for (const {key, value} of db.prepare(`SELECT rowid AS key, "${column}" AS value FROM "${table}"`).all()) {
                        const next = rehomePath(value, from, to);

                        if (next !== value) {
                            update?.run(next, key);
                            values++;
                            table === 'threads' && threadRows.add(key)
                        }
                    }
                }

                return {values, rows: threadRows.size}
            };

        return dryRun ? walk() : db.transaction(walk)()
    } finally {
        db.close()
    }
}

/**
 * @summary Keeps the project the Fleet registered for an Antigravity seat: its receipt and Antigravity's own
 * record of it take the new name and folder, under the same project id. Per-conversation protobuf trajectories
 * under `~/.gemini/antigravity/conversations` embed the workspace URI at their original byte length and cannot
 * be rewritten safely, so the result reports that a new conversation is needed.
 * @param {Object}  options
 * @param {String}  options.instanceHome
 * @param {String}  options.from
 * @param {String}  options.to
 * @param {String}  options.previousId
 * @param {String}  options.id
 * @param {String}  options.homeDir
 * @param {Boolean} [options.dryRun=false]
 * @returns {Promise<{receipt: String, project: String, count: Number, conversations?: String, nextStep?: String}>}
 *     Each `repointed`, `current` or `absent`.
 * @private
 */
async function carryAntigravityProject({instanceHome, from, to, previousId, id, homeDir, dryRun = false}) {
    const
        receiptPath = path.join(instanceHome, '.neo-fleet-project-binding.json'),
        projectId   = (await readJsonOrNull(receiptPath))?.projectId,
        rename      = name => name === previousId ? id : name,
        outcome     = changed => changed === null ? 'absent' : changed ? 'repointed' : 'current';

    // the receipt names the project file, so an id that is no UUID names no file of the Fleet's
    if (typeof projectId !== 'string' || !/^[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(projectId)) {
        return {receipt: 'absent', project: 'absent', count: 0}
    }

    const
        receipt = outcome(await rewriteJsonFile(receiptPath,
            value => ({...value, projectName: rename(value.projectName), projectRoot: rehomePath(value.projectRoot, from, to)}), {dryRun})),
        project = outcome(await rewriteJsonFile(path.join(homeDir, '.gemini', 'config', 'projects', `${projectId}.json`),
            value => ({...value, name: rename(value.name), projectResources: rehomeJson(value.projectResources, from, to)}), {dryRun}));

    return {
        receipt,
        project,
        count        : receipt === 'repointed' || project === 'repointed' ? 1 : 0,
        conversations: 'kept: ~/.gemini/antigravity/conversations protobufs keep the old workspace URI; start a new conversation',
        nextStep     : 'start a new conversation'
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
 * @param {Object}   [options]
 * @param {Boolean}  [options.dryRun=false]
 * @returns {Promise<Boolean|null>} Whether it changed; `null` when there is no such file.
 * @private
 */
async function rewriteJsonFile(file, map, {dryRun = false} = {}) {
    return rewriteTextFile(file, text => {
        const value = JSON.parse(text), next = map(value);

        if (JSON.stringify(next) === JSON.stringify(value)) return text;

        return JSON.stringify(next, null, /^[{[]\r?\n([ \t]+)/.exec(text)?.[1]) + (text.endsWith('\n') ? '\n' : '')
    }, {dryRun})
}

/**
 * @summary Rewrites one text file through `map`, atomically and keeping its mode.
 * @param {String}   file
 * @param {Function} map
 * @param {Object}   [options]
 * @param {Boolean}  [options.dryRun=false]
 * @returns {Promise<Boolean|null>} Whether it changed; `null` when there is no such file.
 * @private
 */
async function rewriteTextFile(file, map, {dryRun = false} = {}) {
    let text;

    try {
        text = await fs.readFile(file, 'utf8')
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error
    }

    const next = map(text);

    if (next === text) return false;

    !dryRun && await writeFileAtomic(file, next, {preserveMode: true});

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
