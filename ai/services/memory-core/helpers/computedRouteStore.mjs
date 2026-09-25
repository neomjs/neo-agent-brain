import fs                              from 'fs-extra';
import {validateComputedRouteResult}   from '../../graph/computedRouteResult.mjs';
import {
    CORPUS_PROJECTION_CONSUMER,
    evaluateCorpusProjectionAdmission
} from '../../graph/corpusProjectionContract.mjs';
import {readCorpusProjectionReceipt}   from '../../graph/corpusProjectionReceiptStore.mjs';

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * @summary Reads the computed Golden Path (`computed-route.json`, the `computed-route.v1` sidecar
 * beside the Sandman handoff) with the corpus-projection admission for its consumer.
 *
 * The sidecar is the synthesizer's typed route: written beside the handoff on the plane's handoff
 * volume, which only the Memory Core process mounts. A cockpit on the host reads the plane through
 * the operation boundary, so this reader is the file-contract half of the `get_computed_route` MCP
 * tool — the sibling of `readSandmanHandoff` for the route the handoff's prose derives from.
 *
 * Two things are answered, each as itself: the route, validated against the producer's contract
 * and passed through as written (a missing, oversized, unreadable or contract-invalid sidecar is a
 * typed status with a stable reason, never a throw and never an empty route), and the projection
 * admission for the `computed-golden-path` consumer — current, or last-known-good with the
 * contract's reason — evaluated from the projection receipt on the same plane.
 *
 * @param {Object} options
 * @param {String} options.filePath Resolved sidecar path (beside the `handoffFilePath` config leaf).
 * @param {Boolean} options.projectionEnabled The `orchestrator.corpusProjection.enabled` leaf.
 * @param {String} [options.receiptPath] The projection receipt path when the gate is on.
 * @param {String} [options.sourceRepository] The consumer-configured source repository.
 * @param {String} [options.sourceRef] The consumer-configured source ref.
 * @param {Function} [options.readReceipt=readCorpusProjectionReceipt]
 * @param {Number} [options.now=Date.now()] Freshness evaluation clock.
 * @param {Number} [options.maxBytes=262144] Hard read-size cap.
 * @returns {Promise<Object>} `{status, reason, details, path, mtimeMs, route, admission}` — `status` is
 *          `available` | `missing` | `unreadable` | `invalid`; `route` is the validated sidecar or `null`.
 */
export async function readComputedRoute({
    filePath,
    projectionEnabled,
    receiptPath,
    sourceRepository,
    sourceRef,
    readReceipt = readCorpusProjectionReceipt,
    now         = Date.now(),
    maxBytes    = DEFAULT_MAX_BYTES
} = {}) {
    const admission = await readAdmission({projectionEnabled, receiptPath, sourceRepository, sourceRef, readReceipt, now});

    if (!filePath) {
        return unavailable({status: 'missing', reason: 'route-path-unconfigured', admission})
    }

    let stat;

    try {
        stat = await fs.stat(filePath)
    } catch (error) {
        return error.code === 'ENOENT'
            ? unavailable({filePath, status: 'missing', reason: 'route-not-found', admission})
            : unavailable({filePath, status: 'unreadable', reason: 'route-read-failed', details: {message: error.message}, admission})
    }

    if (stat.size > maxBytes) {
        return unavailable({filePath, status: 'unreadable', reason: 'route-too-large', details: {size: stat.size, maxBytes}, admission})
    }

    let route;

    try {
        route = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
        return unavailable({filePath, status: 'unreadable', reason: 'route-read-failed', details: {message: error.message}, admission})
    }

    const {valid, errors} = validateComputedRouteResult(route);

    if (!valid) {
        return unavailable({filePath, status: 'invalid', reason: 'route-contract-invalid', details: {errors}, admission})
    }

    return {
        status : 'available',
        reason : null,
        details: null,
        path   : filePath,
        mtimeMs: stat.mtimeMs,
        route,
        admission
    }
}

/**
 * @summary The projection admission for the computed Golden Path — the contract the Context
 * Frontier read applies, for this consumer. A disabled gate admits by the contract's own word; an
 * unreadable receipt is evaluated as absent, which the contract refuses on its own terms.
 * @param {Object} options
 * @returns {Promise<Object>}
 * @private
 */
async function readAdmission({projectionEnabled, receiptPath, sourceRepository, sourceRef, readReceipt, now}) {
    if (!projectionEnabled) {
        return {
            admitted      : true,
            fallback      : 'current',
            reasonCode    : 'projection-gate-disabled',
            requiredFacets: ['issues', 'discussions'],
            staleFacets   : []
        }
    }

    let receipt = null;

    try {
        receipt = await readReceipt(receiptPath)
    } catch {
        // an unreadable receipt is an absent receipt: the contract names the refusal itself
    }

    return evaluateCorpusProjectionAdmission({
        consumer                : CORPUS_PROJECTION_CONSUMER.computedGoldenPath,
        receipt,
        expectedSourceRepository: sourceRepository,
        expectedSourceRef       : sourceRef,
        now
    })
}

function unavailable({filePath = null, status, reason, details = null, admission}) {
    return {
        status,
        reason,
        details,
        path   : filePath,
        mtimeMs: null,
        route  : null,
        admission
    }
}
