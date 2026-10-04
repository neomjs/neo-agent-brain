import {spawn} from 'node:child_process';

/**
 * @module ai/services/fleet/codexModelCatalog
 * @summary Reads the models and reasoning efforts a Codex seat's harness offers, through its app-server's own
 * `model/list` in the seat's home: what Configuration offers, and what Start checks a declaration against.
 *
 * The app-server speaks one JSON message per line on stdio: `initialize`, the `initialized` notification, then
 * `model/list` pages followed through `nextCursor`, hidden entries included. A read starts the server, so it
 * writes the server's state into the home it is given. A caller reads a seat's home before that seat's harness
 * starts, never beside it. The answer is the harness's catalog, not an entitlement receipt: a home without a
 * login answers a bundled one.
 */

/**
 * How long a whole read may take before it counts as unanswered.
 * @type {Number}
 */
const READ_TIMEOUT_MS = 15000;

/**
 * Pages followed before a catalog counts as incomplete: a cursor that never ends must not hold Start.
 * @type {Number}
 */
const MAX_PAGES = 20;

/**
 * @summary One model as Configuration offers it.
 * @param {Object} model One `model/list` entry
 * @returns {{id: String, slug: String, efforts: String[], defaultEffort: String|null, hidden: Boolean, isDefault: Boolean}}
 */
function offeredModel(model) {
    return {
        id           : model.id,
        slug         : model.model ?? model.id,
        efforts      : (model.supportedReasoningEfforts ?? []).map(option => option.reasoningEffort),
        defaultEffort: model.defaultReasoningEffort ?? null,
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
 * @returns {Promise<{state: 'complete'|'partial'|'unavailable', models: Object[], reason: String|null}>} `partial`
 * when pages were read before the read failed; a failed or partial read never says a model is missing.
 */
export function readCodexModelCatalog({binaryPath, codexHome, spawnFn = spawn, timeoutMs = READ_TIMEOUT_MS}) {
    return new Promise(resolve => {
        const
            models = [],
            // the seat's home and what a CLI needs to run, never the Brain's own environment
            env    = Object.fromEntries(Object.entries({CODEX_HOME: codexHome, HOME: process.env.HOME, PATH: process.env.PATH}).filter(([, value]) => value)),
            child  = spawnFn(binaryPath, ['app-server'], {env, stdio: ['pipe', 'pipe', 'ignore']});

        let buffer = '', pages = 0, settled = false;

        const
            send   = message => child.stdin.write(`${JSON.stringify(message)}\n`),
            finish = (state, reason = null) => {
                if (settled) return;

                settled = true;
                clearTimeout(timer);
                child.kill('SIGTERM');
                resolve({state: state !== 'complete' && models.length === 0 ? 'unavailable' : state, models, reason})
            },
            listPage = cursor => send({id: 2 + pages, method: 'model/list', params: {includeHidden: true, cursor}}),
            timer    = setTimeout(() => finish('partial', `the catalog read took longer than ${timeoutMs} ms`), timeoutMs);

        child.on('error', error => finish('unavailable', `the app-server did not start: ${error.message}`));
        child.on('exit', code => finish('partial', `the app-server exited (${code}) before the catalog was read`));
        child.stdin.on('error', () => {});

        child.stdout.on('data', chunk => {
            buffer += chunk;

            let index;

            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);

                if (!line) continue;

                let message;

                try {
                    message = JSON.parse(line)
                } catch {
                    return finish('partial', 'the app-server answered a line that is not JSON')
                }

                if (message.error) {
                    return finish('partial', `the app-server refused '${message.id === 1 ? 'initialize' : 'model/list'}': ${message.error.message ?? 'no reason given'}`)
                }

                if (message.id === 1) {
                    send({method: 'initialized'});
                    listPage(null)
                } else if (message.id === 2 + pages && message.result) {
                    models.push(...(message.result.data ?? []).map(offeredModel));
                    pages++;

                    if (!message.result.nextCursor) return finish('complete');
                    if (pages >= MAX_PAGES) return finish('partial', `the catalog did not end within ${MAX_PAGES} pages`);

                    listPage(message.result.nextCursor)
                }
            }
        });

        send({id: 1, method: 'initialize', params: {clientInfo: {name: 'neo-fleet', title: null, version: '1'}, capabilities: null}})
    })
}
