import {projectOpenWork} from './fleetOpenWorkSource.mjs';

/**
 * @module ai/services/fleet/wireFleetOpenWorkCopy
 * @summary The host half of the plane's open-work copy. After each producer pulse it publishes every tracked seat's
 * open work (`publish_open_work_copy`), so a seat's wake digest reads it from the plane, not from GitHub.
 */

/**
 * @summary The row a digest names: the pull request, its CI and verdict, whether it is stale, and who holds it.
 * @param {Object} row One projected row.
 * @returns {Object}
 * @private
 */
function digestRowOf({repo, number, title, ci, verdict, stale, holder}) {
    return {repo, number, title, ci, verdict, stale, holder: {role: holder?.role ?? null, kind: holder?.kind ?? null}}
}

/**
 * @summary The publication for one producer state: every seat the projection holds is tracked, each with its own rows.
 * A projection that is unavailable publishes nothing, so the plane's copy ages on its own.
 * @param {Object|null} state The producer's state.
 * @param {Object}   options
 * @param {Function} options.now `() → epoch ms`.
 * @returns {Object|null} The `publish_open_work_copy` arguments, or null.
 */
export function openWorkPublicationOf(state, {now}) {
    const projection = projectOpenWork(state, {now});

    if (projection.state === 'unavailable') return null;

    return {
        observedAt: projection.observedAt,
        coverage  : projection.coverage,
        reason    : projection.reason,
        tracked   : Object.keys(projection.seats),
        seats     : Object.fromEntries(Object.entries(projection.seats).map(([seat, work]) =>
            [seat, {authored: work.authored.map(digestRowOf), reviewing: work.reviewing.map(digestRowOf)}]))
    }
}

/**
 * @summary The pulse hook that publishes the copy. A failed publication leaves the plane's previous copy, which then
 * reads stale by its own observation; it is logged once per distinct failure and never fails the pulse.
 * @param {Object}   options
 * @param {Function} options.publish `args → Promise`: the plane client's `publish_open_work_copy` call.
 * @param {Function} [options.now]
 * @param {Object}   [options.log=console]
 * @returns {Function} `state → Promise<void>`.
 */
export function wireFleetOpenWorkCopy({publish, now = () => Date.now(), log = console}) {
    let lastFailure = null;

    return async state => {
        const publication = openWorkPublicationOf(state, {now});

        if (!publication) return;

        try {
            const {refused = []} = await publish(publication) ?? {};

            refused.length && log.warn(`[fleet] the open-work copy refused ${refused.map(entry => entry.seat).join(', ')}`);
            lastFailure = null
        } catch (error) {
            const failure = String(error?.message ?? error);

            failure !== lastFailure && log.warn(`[fleet] the open-work copy was not published: ${failure}`);
            lastFailure = failure
        }
    }
}
