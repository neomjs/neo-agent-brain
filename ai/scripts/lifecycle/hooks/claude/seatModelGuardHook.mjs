import fs              from 'node:fs';
import path            from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * @module ai/scripts/lifecycle/hooks/claude/seatModelGuardHook
 * @summary Claude Desktop guard: a seat does not work on a model family its account picked for another seat.
 *
 * Claude Desktop starts a new Code session on the model picker's remembered choice, and that choice is
 * account state. Seats that share an account therefore open on whichever model the other seat picked
 * last, and Fleet has no launch input that sets it. The guard does not correct the start; it
 * keeps a session from working on a model family the seat did not run before:
 *
 * - `prompt` (UserPromptSubmit) reads the session's current model from the app's session record and
 *   blocks while its family differs from the seat's last-run family. A prompt starting with `model-ok`
 *   runs anyway, and `stop` then records that model, so the block does not repeat. It only blocks when
 *   another seat shares the account: on an account no other seat uses, the remembered pick is always the
 *   seat's own, so a family change is a deliberate switch.
 * - `stop` (Stop) records the family the seat actually ran, read from the transcript.
 *
 * The record is found without any projected path: Desktop starts its bundled CLI from
 * `<userData>/claude-code/…` (`CLAUDE_CODE_EXECPATH`) and names the session in
 * `CLAUDE_CODE_HOST_SESSION_ID`, and the record is `<userData>/claude-code-sessions/<…>/<…>/<id>.json`.
 * That layout is the app's and undocumented, so every step fails open: anything missing or unexpected
 * lets the prompt run. The guard reads the record's `model` and `cliSessionId` only, writes nothing of the
 * app's, and keeps its own state and log in `<userData>/neo-seat-guard/`, without session ids.
 */

/**
 * @summary The prefix that runs a blocked prompt on purpose.
 * @type {String}
 */
export const MODEL_OK = 'model-ok';

/**
 * @summary The model families the guard compares. Anything else is unknown and never blocks.
 * @type {String[]}
 */
export const MODEL_FAMILIES = ['opus', 'fable', 'sonnet', 'haiku'];

/**
 * @summary The guard's own folder beneath the app's user-data directory.
 * @type {String}
 */
export const GUARD_DIR = 'neo-seat-guard';

/**
 * @summary How much of the transcript's tail `stop` reads to find the last assistant model.
 * @type {Number}
 */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const
    HOST_SESSION_ID = /^local_[0-9a-f-]{8,}$/i,
    // A bare alias or `claude-<family>-<version>`, each optionally `[1m]`. Anything else is unknown, so an
    // id that merely contains a family name never gains the authority to block.
    MODEL_ID        = new RegExp(`^(?:claude-)?(${MODEL_FAMILIES.join('|')})(?:-\\d[0-9a-z.-]*)?(?:\\[1m\\])?$`, 'i');

/**
 * @summary Maps a model id or alias to its family: `claude-opus-5-5[1m]` and `opus` are both `opus`.
 * @param {*} model
 * @returns {String|null} `null` for anything that is not a supported id or alias.
 */
export function modelFamily(model) {
    if (typeof model !== 'string') return null;

    return MODEL_ID.exec(model.trim())?.[1].toLowerCase() ?? null
}

/**
 * @summary The app's user-data directory, derived from the path of the CLI it bundles.
 * @param {*} execPath `CLAUDE_CODE_EXECPATH`, e.g. `<userData>/claude-code/2.1.295/<hash>/claude.app/…`.
 * @returns {String|null}
 */
export function resolveUserDataDir(execPath) {
    if (typeof execPath !== 'string' || !path.isAbsolute(execPath)) return null;

    const index = execPath.lastIndexOf(`${path.sep}claude-code${path.sep}`);

    return index > 0 ? execPath.slice(0, index) : null
}

/**
 * @summary Decides one prompt. Pure.
 * @param {Object} options
 * @param {String|null} options.currentModel  The session record's `model`.
 * @param {String|null} options.expectedModel The seat's last-run model.
 * @param {*}           options.prompt        The submitted prompt; anything but a string never blocks.
 * @returns {{block: Boolean, reason?: String, expected?: String, current?: String}}
 */
export function decideSeatModelGuard({currentModel, expectedModel, prompt}) {
    const
        current  = modelFamily(currentModel),
        expected = modelFamily(expectedModel);

    if (typeof prompt !== 'string' || !current || !expected || current === expected) return {block: false};

    if (prompt.trimStart().toLowerCase().startsWith(MODEL_OK)) return {block: false};

    return {
        block : true,
        current,
        expected,
        reason: `This seat expects ${expected}; this session runs ${current}, the account's last pick. ` +
            `Switch the model picker to ${expected} and resend (if you just switched, resend). ` +
            `To run ${current} on purpose, start the prompt with \`${MODEL_OK}\`.`
    }
}

/**
 * @summary Reads the session's current model and account folder from the app's record, joined on the
 * hook's `session_id`.
 * @param {String} userDataDir
 * @param {*}      hostSessionId `CLAUDE_CODE_HOST_SESSION_ID`.
 * @param {*}      sessionId     The hook input's `session_id`.
 * @returns {{model: String, account: String}|null} `null` when the record is missing, unreadable or
 * belongs to another session.
 */
export function readSessionRecord(userDataDir, hostSessionId, sessionId) {
    if (!HOST_SESSION_ID.test(hostSessionId ?? '') || typeof sessionId !== 'string') return null;

    const
        root = path.join(userDataDir, 'claude-code-sessions'),
        file = `${hostSessionId}.json`;

    for (const account of safeReaddir(root)) {
        for (const scope of safeReaddir(path.join(root, account))) {
            const candidate = path.join(root, account, scope, file);

            if (!fs.existsSync(candidate)) continue;

            const record = parseJson(safeRead(candidate));

            return record?.cliSessionId === sessionId && typeof record.model === 'string' ? {model: record.model, account} : null
        }
    }

    return null
}

/**
 * @summary Whether another seat under the same agents root has sessions under this account. Only a real
 * directory entry in a readable listing counts: a file, a symbolic link or a listing that fails is no
 * evidence of sharing, so the guard fails open. Reads directory listings only, never a file.
 * @param {String} userDataDir The seat's `<agentsRoot>/<agentId>/harness/claude-desktop`.
 * @param {String} account     The account folder of this session's record.
 * @returns {Boolean} `false` for an unrecognized layout, so the guard fails open.
 */
export function accountSharedWithAnotherSeat(userDataDir, account) {
    const harnessDir = path.dirname(userDataDir);

    if (path.basename(userDataDir) !== 'claude-desktop' || path.basename(harnessDir) !== 'harness') return false;

    const
        seatDir    = path.dirname(harnessDir),
        agentsRoot = path.dirname(seatDir);

    return realDirectories(agentsRoot).some(seat => seat !== path.basename(seatDir) &&
        realDirectories(path.join(agentsRoot, seat, 'harness', 'claude-desktop', 'claude-code-sessions')).includes(account))
}

/**
 * @summary The names of a directory's real subdirectories; `Dirent.isDirectory()` is false for a symbolic
 * link, and an unreadable listing yields none.
 * @param {String} dir
 * @returns {String[]}
 */
function realDirectories(dir) {
    try {
        return fs.readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
        return []
    }
}

/**
 * @summary The model of the transcript's last assistant message, read from a bounded tail.
 * @param {*} transcriptPath
 * @returns {String|null} `null` for a synthetic message or an unreadable transcript.
 */
export function readLastRunModel(transcriptPath) {
    if (typeof transcriptPath !== 'string') return null;

    let tail;

    try {
        const
            fd    = fs.openSync(transcriptPath, 'r'),
            size  = fs.fstatSync(fd).size,
            start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES),
            buf   = Buffer.alloc(size - start);

        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        tail = buf.toString('utf8')
    } catch {
        return null
    }

    const lines = tail.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseJson(lines[i]);

        if (entry?.type === 'assistant' && modelFamily(entry.message?.model)) return entry.message.model
    }

    return null
}

function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}

function safeRead(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

function parseJson(raw) {
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data',  chunk => data += chunk);
        process.stdin.on('end',   ()    => resolve(data));
        process.stdin.on('error', reject);
    });
}

/**
 * @summary Runs one event against the live environment. Returns the exit code.
 * @param {String} event   `prompt` or `stop`.
 * @param {Object} payload The hook's parsed stdin.
 * @param {Object} [env=process.env]
 * @returns {Number} `2` blocks the prompt; anything else lets the turn proceed.
 */
export function runSeatModelGuard(event, payload, env = process.env) {
    if (env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop') return 0;

    const userDataDir = resolveUserDataDir(env.CLAUDE_CODE_EXECPATH);

    if (!userDataDir) return 0;

    const
        guardDir  = path.join(userDataDir, GUARD_DIR),
        stateFile = path.join(guardDir, 'model.json');

    if (event === 'stop') {
        const model = readLastRunModel(payload?.transcript_path);

        if (model) {
            fs.mkdirSync(guardDir, {recursive: true});
            fs.writeFileSync(stateFile, JSON.stringify({lastRunModel: model, recordedAt: new Date().toISOString()}))
        }

        return 0
    }

    if (event !== 'prompt') return 0;

    const record = readSessionRecord(userDataDir, env.CLAUDE_CODE_HOST_SESSION_ID, payload?.session_id);

    if (!record || !accountSharedWithAnotherSeat(userDataDir, record.account)) return 0;

    const decision = decideSeatModelGuard({
        currentModel : record.model,
        expectedModel: parseJson(safeRead(stateFile))?.lastRunModel ?? null,
        prompt       : payload?.prompt
    });

    if (!decision.block) return 0;

    fs.mkdirSync(guardDir, {recursive: true});
    fs.appendFileSync(path.join(guardDir, 'model.log'),
        `${new Date().toISOString()}\texpected=${decision.expected}\tcurrent=${decision.current}\tapp=${env.CLAUDE_CODE_DESKTOP_APP_VERSION ?? 'unknown'}\n`);
    process.stderr.write(`${decision.reason}\n`);

    return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let code = 0;

    try {
        code = runSeatModelGuard(process.argv[2], parseJson(await readStdin()))
    } catch {
        code = 0
    }

    process.exit(code)
}
