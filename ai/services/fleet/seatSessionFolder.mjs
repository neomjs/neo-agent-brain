import fs   from 'fs';
import path from 'path';

/**
 * @module ai/services/fleet/seatSessionFolder
 * @summary Where a Claude Desktop seat's session opened, read from the seat's own profile.
 *
 * Claude Desktop cannot be launched into a folder (#669), and a session opened anywhere but the
 * managed checkout loads none of what the Fleet projects there while the process reads ready. The
 * seat's Desktop profile records each Code-tab session under
 * `claude-code-sessions/<account>/<org>/local_<id>.json` with the folder it opened in. The profile is
 * the seat's alone, which is why this reads it rather than the host's shared `~/.claude/projects`
 * transcripts: every session on the machine writes those, so they cannot say whose a session is.
 * The record format is Claude Desktop's own and undocumented, so a record set this reader cannot
 * read answers `unknown` with the reason and never `ok`.
 */

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
        // a record untouched since the launch was not active since it
        if (fileSystem.statSync(file).mtimeMs < launchedAt) continue;

        let record;

        try {
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
            ? unknown(`${unreadable} of the seat's session records since the launch could not be read`)
            : {state: 'pending', expected}
    }

    return path.resolve(current.folder) === path.resolve(expected)
        ? {state: 'ok', expected}
        : {state: 'wrong', expected, observed: current.folder}
}

export default readSeatSessionFolder;
