import fs                from 'fs';
import fsPromises        from 'fs/promises';
import path              from 'path';
import {parseEnv}        from 'util';
import {writeFileAtomic} from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/seatEnvFile
 * @summary A seat's own `.env`: one file in the seat folder, outside every clone, that the Fleet writes
 * and the operator extends.
 *
 * The file holds one delimited block the Fleet owns: non-secret keys a harness cannot take from the
 * child env, empty until a harness names one. Everything outside the block is the operator's, such as
 * a second forge's credential: the Fleet reads only its key names, never its values, and never rewrites
 * or reorders it. No Fleet secret ever lands in the file: the forge PAT, the plane bearer and the bridge
 * token reach a seat through the child env only, and Start refuses a file whose operator part sets one
 * of those slots (`FleetLifecycleService#start`). A server that needs the operator's keys loads the file
 * with Node's `--env-file`, which never overwrites a var already set, so the child env keeps precedence.
 *
 * The Fleet reads, writes and re-modes only a regular file at that path. A link or any other entry there
 * is refused before it is followed, so nothing outside the seat folder is touched through it.
 */

/**
 * The line that opens the Fleet's block.
 * @type {String}
 */
export const FLEET_BLOCK_START = '# >>> written by the Fleet at every Start; your own keys go below this block';

/**
 * The line that closes the Fleet's block.
 * @type {String}
 */
export const FLEET_BLOCK_END = '# <<< end of the Fleet block';

const
    ENV_KEY        = /^[A-Za-z_][A-Za-z0-9_]*$/,
    READ_NO_FOLLOW = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

/**
 * @summary The seat's `.env`: `<seatHome>/.env`.
 * @param {String} seatHome Absolute seat folder (`<fleet.agentsRoot>/<agent-id>`).
 * @returns {String}
 */
export function seatEnvFilePath(seatHome) {
    return path.join(seatHome, '.env')
}

/**
 * The code of the refusal for an entry at the seat's `.env` path that is not a regular file.
 * @type {String}
 */
export const SEAT_ENV_NOT_REGULAR = 'FLEET_SEAT_ENV_NOT_REGULAR';

/**
 * @summary The refusal for an entry at the seat's `.env` path that is not a regular file. Its message
 * names no path, so a caller may pass it on.
 * @returns {TypeError}
 * @private
 */
function notRegular() {
    return Object.assign(
        new TypeError("the seat's .env is a link or another entry, not a regular file; the Fleet does not follow it. Replace it with a regular file."),
        {code: SEAT_ENV_NOT_REGULAR}
    )
}

/**
 * @summary The operator's part of a seat `.env`: everything outside the Fleet's block, byte for byte. A
 * file without a whole block is the operator's entirely.
 * @param {String} content
 * @returns {String}
 */
function operatorPart(content) {
    const
        start = content.indexOf(`${FLEET_BLOCK_START}\n`),
        close = `${FLEET_BLOCK_END}\n`,
        end   = start === -1 ? -1 : content.indexOf(close, start);

    return end === -1 ? content : content.slice(0, start) + content.slice(end + close.length)
}

/**
 * @summary The keys an env text sets, read by the parser `--env-file` uses: a line inside a quoted value
 * belongs to that value and sets nothing.
 * @param {String} text
 * @returns {String[]}
 */
export function seatEnvKeys(text) {
    return Object.keys(parseEnv(text))
}

/**
 * @summary The keys the operator's part of a seat's `.env` sets, read fresh without following a link;
 * none while the file is absent.
 * @param {String} seatHome
 * @returns {String[]}
 * @throws {TypeError} When the path holds a link or another entry that is not a regular file.
 */
export function readSeatEnvOperatorKeys(seatHome) {
    const file = seatEnvFilePath(seatHome);

    let fd;

    try {
        if (!fs.lstatSync(file).isFile()) throw notRegular();

        fd = fs.openSync(file, READ_NO_FOLLOW)
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        if (error.code === 'ELOOP')  throw notRegular();

        throw error
    }

    try {
        return seatEnvKeys(operatorPart(fs.readFileSync(fd, 'utf8')))
    } finally {
        fs.closeSync(fd)
    }
}

/**
 * @summary Opens the seat's `.env` for reading if it is a regular file, without following a link.
 * @param {String} file
 * @param {Object} fileSystem The `fs/promises` surface.
 * @returns {Promise<Object|null>} A file handle, or `null` while the file is absent.
 * @private
 */
async function openRegular(file, fileSystem) {
    try {
        if (!(await fileSystem.lstat(file)).isFile()) throw notRegular();

        return await fileSystem.open(file, READ_NO_FOLLOW)
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.code === 'ELOOP')  throw notRegular();

        throw error
    }
}

/**
 * @summary Ensures a seat's `.env` exists, owner-only, with the Fleet's block holding exactly
 * `fleetKeys`; the operator's part stays byte-identical. A changed file is published through the
 * shared atomic write; an unchanged one is only re-moded, through its open handle.
 * @param {Object} options
 * @param {String} options.seatHome            Absolute seat folder.
 * @param {Object} [options.fleetKeys={}]      Non-secret keys a harness cannot take from the child env.
 * @param {Object} [options.fileSystem]        The `fs/promises` surface.
 * @returns {Promise<String>} The file's path.
 * @throws {TypeError} When a Fleet key is not a one-line key and value, or the path holds a link or
 *     another entry that is not a regular file.
 */
export async function ensureSeatEnvFile({seatHome, fleetKeys = {}, fileSystem = fsPromises}) {
    const
        file  = seatEnvFilePath(seatHome),
        lines = Object.entries(fleetKeys).map(([key, value]) => {
            if (!ENV_KEY.test(key) || typeof value !== 'string' || /[\n\r]/.test(value)) {
                throw new TypeError(`ensureSeatEnvFile: '${key}' is not a one-line env key and value.`)
            }

            return `${key}=${value}`
        });

    await fileSystem.mkdir(seatHome, {recursive: true, mode: 0o700});

    const handle = await openRegular(file, fileSystem);

    let next;

    try {
        const current = handle ? await handle.readFile('utf8') : '';

        next = [FLEET_BLOCK_START, ...lines, FLEET_BLOCK_END, ''].join('\n') + operatorPart(current);

        if (handle && next === current) {
            await handle.chmod(0o600);
            return file
        }
    } finally {
        await handle?.close()
    }

    await writeFileAtomic(file, next, {mode: 0o600, fsModule: fileSystem});

    return file
}
