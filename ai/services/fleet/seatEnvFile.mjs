import fs                 from 'fs';
import fsPromises         from 'fs/promises';
import path               from 'path';

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
    ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * @summary The seat's `.env`: `<seatHome>/.env`.
 * @param {String} seatHome Absolute seat folder (`<fleet.agentsRoot>/<agent-id>`).
 * @returns {String}
 */
export function seatEnvFilePath(seatHome) {
    return path.join(seatHome, '.env')
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
 * @summary The keys an env text sets (`KEY=` or `export KEY=`); comments and blank lines set none.
 * @param {String} text
 * @returns {String[]}
 */
export function seatEnvKeys(text) {
    return text.split('\n').map(line => ENV_ASSIGNMENT.exec(line)?.[1]).filter(Boolean)
}

/**
 * @summary The keys the operator's part of a seat's `.env` sets, read fresh; none while the file is
 * absent.
 * @param {String} seatHome
 * @returns {String[]}
 */
export function readSeatEnvOperatorKeys(seatHome) {
    let content;

    try {
        content = fs.readFileSync(seatEnvFilePath(seatHome), 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error
    }

    return seatEnvKeys(operatorPart(content))
}

/**
 * @summary Ensures a seat's `.env` exists, owner-only, with the Fleet's block holding exactly
 * `fleetKeys`; the operator's part stays byte-identical. Writes only when the file changes, atomically.
 * @param {Object} options
 * @param {String} options.seatHome            Absolute seat folder.
 * @param {Object} [options.fleetKeys={}]      Non-secret keys a harness cannot take from the child env.
 * @param {Object} [options.fileSystem]        The `fs/promises` surface.
 * @returns {Promise<String>} The file's path.
 */
export async function ensureSeatEnvFile({seatHome, fleetKeys = {}, fileSystem = fsPromises}) {
    const file = seatEnvFilePath(seatHome);

    let current = '';

    try {
        current = await fileSystem.readFile(file, 'utf8')
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }

    const lines = Object.entries(fleetKeys).map(([key, value]) => {
        if (!ENV_KEY.test(key) || typeof value !== 'string' || /[\n\r]/.test(value)) {
            throw new TypeError(`ensureSeatEnvFile: '${key}' is not a one-line env key and value.`)
        }

        return `${key}=${value}`
    });

    const next = [FLEET_BLOCK_START, ...lines, FLEET_BLOCK_END, ''].join('\n') + operatorPart(current);

    if (next !== current) {
        const scratch = `${file}.${process.pid}.tmp`;

        await fileSystem.mkdir(seatHome, {recursive: true, mode: 0o700});
        await fileSystem.writeFile(scratch, next, {mode: 0o600});
        await fileSystem.rename(scratch, file)
    }

    await fileSystem.chmod(file, 0o600);

    return file
}
