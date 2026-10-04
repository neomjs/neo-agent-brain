import {spawn} from 'node:child_process';

/**
 * @module ai/services/fleet/codexModelCatalog
 * @summary Reads the models and reasoning efforts a Codex seat's harness offers, through its app-server's own
 * `model/list` in the seat's home: what Configuration offers, and what Start checks a declaration against.
 *
 * The app-server speaks one JSON message per line on stdio: `initialize`, the `initialized` notification, then
 * `model/list` pages followed through `nextCursor`, hidden entries included. A read starts the server, so it
 * writes the server's state into the home it is given, and it is over only when that process is: the answer waits
 * for the child's exit, so nothing the read started still owns the home when a caller goes on. A caller reads a
 * seat's home before that seat's harness starts, never beside it, and one read at a time. The answer is the
 * harness's catalog, not an entitlement receipt: a home without a login answers a bundled one.
 */

/**
 * How long a whole read may take before it counts as unanswered.
 * @type {Number}
 */
const READ_TIMEOUT_MS = 15000;

/**
 * How long a told app-server has to exit, once after SIGTERM and once more after SIGKILL.
 * @type {Number}
 */
const EXIT_GRACE_MS = 2000;

/**
 * Pages followed before a catalog counts as incomplete: a cursor that never ends must not hold Start.
 * @type {Number}
 */
const MAX_PAGES = 20;

/**
 * @summary One model as Configuration offers it, or `null` for an entry this reader cannot read: an id that is not
 * a string, or efforts that are not a list of named levels.
 * @param {Object} model One `model/list` entry
 * @returns {{id: String, slug: String, efforts: String[], defaultEffort: String|null, hidden: Boolean, isDefault: Boolean}|null}
 */
function offeredModel(model) {
    const efforts = model?.supportedReasoningEfforts ?? [];

    if (typeof model?.id !== 'string' || !model.id || !Array.isArray(efforts) || efforts.some(option => typeof option?.reasoningEffort !== 'string')) {
        return null
    }

    return {
        id           : model.id,
        slug         : typeof model.model === 'string' && model.model ? model.model : model.id,
        efforts      : efforts.map(option => option.reasoningEffort),
        defaultEffort: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : null,
        hidden       : model.hidden === true,
        isDefault    : model.isDefault === true
    }
}

/**
 * @summary Reads a Codex harness's model catalog in one home.
 * @param {Object}   options
 * @param {String}   options.binaryPath The Codex CLI whose app-server answers
 * @param {String}   options.codexHome  The seat's Codex home, its `CODEX_HOME`
 * @param {Function} [options.spawnFn]  Child-process seam
 * @param {Number}   [options.timeoutMs]
 * @param {Number}   [options.graceMs]  How long the app-server has to exit after each signal
 * @returns {Promise<{state: 'complete'|'partial'|'unavailable', models: Object[], reason: String|null, stillRunning?: Boolean}>}
 * Settles after the app-server exited. `partial` when pages were read before the read failed, and a failed, partial
 * or unreadable read never says a model is missing. `stillRunning` when the app-server outlived both signals: its home
 * is not free.
 */
export function readCodexModelCatalog({binaryPath, codexHome, spawnFn = spawn, timeoutMs = READ_TIMEOUT_MS, graceMs = EXIT_GRACE_MS}) {
    return new Promise(resolve => {
        const
            models = [],
            // the seat's home and what a CLI needs to run, never the Brain's own environment
            env    = Object.fromEntries(Object.entries({CODEX_HOME: codexHome, HOME: process.env.HOME, PATH: process.env.PATH}).filter(([, value]) => value)),
            child  = spawnFn(binaryPath, ['app-server'], {env, stdio: ['pipe', 'pipe', 'ignore']});

        let answer = null, buffer = '', exited = false, pages = 0;

        const
            send     = message => child.stdin.write(`${JSON.stringify(message)}\n`),
            exit     = ms => new Promise(done => {
                if (exited) return done(true);

                const timer = setTimeout(() => done(false), ms);

                child.once('exit', () => {clearTimeout(timer); done(true)})
            }),
            // the answer is fixed at the first outcome; it is handed over once no process of this read is left
            finish   = async (state, reason = null) => {
                if (answer) return;

                answer = {state: state !== 'complete' && models.length === 0 ? 'unavailable' : state, models, reason};
                clearTimeout(timer);

                // a child that never started has no process to wait for
                if (child.pid !== undefined && !exited) {
                    child.kill('SIGTERM');
                    await exit(graceMs) || (child.kill('SIGKILL'), await exit(graceMs))
                }

                resolve(child.pid === undefined || exited
                    ? answer
                    : {state: 'unavailable', models: [], reason: 'the app-server did not exit when told to, so the seat\'s home is still in use', stillRunning: true})
            },
            listPage = cursor => send({id: 2 + pages, method: 'model/list', params: {includeHidden: true, cursor}}),
            timer    = setTimeout(() => finish('partial', `the catalog read took longer than ${timeoutMs} ms`), timeoutMs);

        const read = message => {
            if (message.error) {
                return finish('partial', `the app-server refused '${message.id === 1 ? 'initialize' : 'model/list'}': ${message.error.message ?? 'no reason given'}`)
            }

            if (message.id === 1) {
                send({method: 'initialized'});
                listPage(null)
            } else if (message.id === 2 + pages) {
                // a page is read whole or not at all: pages read before an unreadable one stay, as a partial catalog
                const
                    page   = message.result,
                    rows   = Array.isArray(page?.data) ? page.data.map(offeredModel) : null,
                    cursor = page?.nextCursor ?? null;

                if (!rows || rows.includes(null) || (cursor !== null && typeof cursor !== 'string')) {
                    return finish('partial', 'the app-server answered a model list this Fleet cannot read')
                }

                models.push(...rows);
                pages++;

                if (!cursor) return finish('complete');
                if (pages >= MAX_PAGES) return finish('partial', `the catalog did not end within ${MAX_PAGES} pages`);

                listPage(cursor)
            }
        };

        child.on('error', error => finish('unavailable', `the app-server did not start: ${error.message}`));
        child.on('exit', code => {
            exited = true;
            finish('partial', `the app-server exited (${code}) before the catalog was read`)
        });
        child.stdin.on('error', () => {});

        child.stdout.on('data', chunk => {
            buffer += chunk;

            let index;

            while (!answer && (index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);

                if (!line) continue;

                let message;

                try {
                    message = JSON.parse(line)
                } catch {
                    return finish('partial', 'the app-server answered a line that is not JSON')
                }

                try {
                    read(message)
                } catch (error) {
                    return finish('partial', `the catalog read failed: ${error.message}`)
                }
            }
        });

        send({id: 1, method: 'initialize', params: {clientInfo: {name: 'neo-fleet', title: null, version: '1'}, capabilities: null}})
    })
}
