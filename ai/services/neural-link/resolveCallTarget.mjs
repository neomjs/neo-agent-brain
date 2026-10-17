/**
 * @summary Resolve the target session for an outbound Neural Link call, deprecating silent auto-targeting.
 *
 * Pure target-resolution rule for `ConnectionService.call()`, extracted as a side-effect-free function so it
 * is testable without standing up the Bridge-connected service singleton.
 *
 * An explicit `sessionId` is always honored. With no explicit target the legacy path auto-picked the
 * most-recently-connected session — safe for a single writer, but a silent cross-writer footgun once two
 * agents share the Bridge (a call meant for one session could land on whichever connected last). So when
 * **more than one** session is live an explicit target is now mandatory and this throws rather than guessing;
 * a single live session still resolves implicitly (back-compatible), and zero live sessions throws as before.
 * The refusal names each live session — its app and who addressed it last — so the caller can pick in the
 * same turn instead of guessing after a second call.
 *
 * @param {String|null} sessionId The explicit target session id, or a falsy value to resolve implicitly.
 * @param {Array<String|Object>} liveSessions Currently-live sessions: ids, or rows
 * `{id, appName, lastAddressedBy: {agentId, at}|null}` (e.g. `connectionService.describeSessions()`).
 * @returns {String} The resolved target session id.
 * @throws {Error} When no explicit target is given and either zero or more-than-one sessions are live.
 */
export function resolveCallTarget(sessionId, liveSessions) {
    if (sessionId) {
        return sessionId
    }

    const ids = liveSessions.map(session => typeof session === 'string' ? session : session.id);

    if (ids.length === 0) {
        throw new Error('No active App Worker sessions found.')
    }

    if (ids.length > 1) {
        throw new Error(
            `Auto-targeting is disabled with ${ids.length} live sessions: pass an explicit ` +
            'sessionId. Silent most-recent targeting is unsafe with concurrent writers. ' +
            `Live: ${liveSessions.map(session => describeSession(session)).join('; ')}`
        )
    }

    return ids[0]
}

/**
 * @summary One live session as the refusal names it: `<id> · <app> · last addressed by <agent> <n>s ago`, or `untouched`.
 * @param {String|Object} session
 * @param {Number} [now=Date.now()]
 * @returns {String}
 */
function describeSession(session, now = Date.now()) {
    if (typeof session === 'string') {
        return session
    }

    const {id, appName, lastAddressedBy} = session,
          who                            = lastAddressedBy ?
              `last addressed by ${lastAddressedBy.agentId} ${Math.max(0, Math.round((now - lastAddressedBy.at) / 1000))}s ago` :
              'untouched';

    return `${id} · ${appName ?? 'unknown app'} · ${who}`
}
