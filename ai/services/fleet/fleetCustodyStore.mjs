/**
 * @module ai/services/fleet/fleetCustodyStore
 * @summary Fleet-side social credential custody store (`<userData>/brain/fleet`), secret scrubber,
 * and single-flight X OAuth 2.0 `offline.access` refresh-token rotation with atomic `0o600` persistence.
 */

import fsPromises from 'node:fs/promises';
import path       from 'node:path';

/**
 * Closed v1 outbound publishing channels.
 * @type {Readonly<{x: 'x', linkedin: 'linkedin'}>}
 */
export const PUBLISH_CHANNELS = Object.freeze({
    x       : 'x',
    linkedin: 'linkedin'
});

/**
 * Four legal switch states per `(peer, channel)` pair, ordered from strictest (`0`) to most permissive (`3`).
 * @type {Readonly<{approveEach: 'approve each', approveBatch: 'approve the batch', autoApproveAttested: 'auto-approve after a cross-family review attestation', autoApprove: 'auto-approve'}>}
 */
export const SWITCH_STATES = Object.freeze({
    approveEach        : 'approve each',
    approveBatch       : 'approve the batch',
    autoApproveAttested: 'auto-approve after a cross-family review attestation',
    autoApprove        : 'auto-approve'
});

/**
 * Numeric rank per switch state (`0` = strictest `'approve each'`, `3` = `'auto-approve'`).
 * @type {Readonly<Record<String, Number>>}
 */
export const SWITCH_STATE_RANK = Object.freeze({
    [SWITCH_STATES.approveEach]        : 0,
    [SWITCH_STATES.approveBatch]       : 1,
    [SWITCH_STATES.autoApproveAttested]: 2,
    [SWITCH_STATES.autoApprove]        : 3
});

/**
 * Named refusal codes emitted by the Fleet publish executor and custody store.
 * @type {Readonly<Record<String, String>>}
 */
export const REFUSAL_CODES = Object.freeze({
    credential                   : 'refused: credential',
    switch                       : 'refused: switch',
    switchMoved                  : 'refused: switch-moved',
    reason                       : 'refused: reason',
    state                        : 'refused: state',
    expectedFrom                 : 'refused: expectedFrom',
    peer                         : 'refused: peer',
    digest                       : 'refused: digest',
    attestation                  : 'refused: attestation',
    replyClassificationUnresolved: 'refused: reply-classification-unresolved',
    alreadyPublished             : 'refused: already-published',
    unresolved                   : 'refused: unresolved',
    publishingInFlight           : 'refused: publishing-in-flight',
    channel                      : 'refused: channel',
    notFound                     : 'refused: not-found'
});

/**
 * LinkedIn page-admin token maximum lifetime in milliseconds (60 days).
 * @type {Number}
 */
export const LINKEDIN_TOKEN_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Pre-expiry safety margin in milliseconds (60 seconds) before rotating a refreshable X access
 * token so an in-flight platform call never races the token's final seconds of validity.
 * @type {Number}
 */
export const X_REFRESH_MARGIN_MS = 60 * 1000;

const SECRET_KEY_PATTERN = /(token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token)/i;

/**
 * @summary Scrubs known secret values and Bearer tokens from strings, errors, and objects so no
 * verb, log line, or refusal reason ever leaks a platform credential.
 * @param {*}        value
 * @param {String[]} [secrets=[]]
 * @returns {*}
 */
export function scrubSecrets(value, secrets = []) {
    const activeSecrets = secrets.filter(item => typeof item === 'string' && item.length > 0);

    const scrubString = text => {
        let output = String(text).replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
        for (const secret of activeSecrets) {
            output = output.split(secret).join('[REDACTED]');
        }
        return output;
    };

    if (typeof value === 'string') {
        return scrubString(value);
    }

    if (value instanceof Error) {
        return scrubString(value.message || String(value));
    }

    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => scrubSecrets(item, activeSecrets));
    }

    if (value && typeof value === 'object') {
        const clone = {};
        for (const [key, entry] of Object.entries(value)) {
            if (SECRET_KEY_PATTERN.test(key)) {
                continue;
            }
            clone[key] = scrubSecrets(entry, activeSecrets);
        }
        return clone;
    }

    return value;
}

/**
 * @summary Creates a Fleet custody credential reader over `<userData>/brain/fleet` (or an injected
 * credentials map/directory). Tokens are read by `{channel, account}`, checked for presence,
 * revocation, and expiry (including LinkedIn's 60-day token window and single-flight X
 * `offline.access` refresh rotation), and never logged or returned by any public executor verb.
 * @param {Object}   [options={}]
 * @param {String}   [options.custodyDir] Directory under `<userData>/brain/fleet`.
 * @param {Object}   [options.credentials] Optional in-memory map keyed by `${channel}:${account}` or `account`.
 * @param {Object}   [options.fsModule=fsPromises]
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {Function} [options.fetch]
 * @param {String}   [options.xTokenUrl='https://api.x.com/2/oauth2/token']
 * @param {Number}   [options.refreshMarginMs=X_REFRESH_MARGIN_MS]
 * @param {Function} [options.now=Date.now]
 * @returns {{readCredential: Function}}
 */
export function createFleetCustodyStore({
    custodyDir      = null,
    credentials     = null,
    fsModule        = fsPromises,
    fetchImpl       = globalThis.fetch,
    fetch           = undefined,
    xTokenUrl       = 'https://api.x.com/2/oauth2/token',
    refreshMarginMs = X_REFRESH_MARGIN_MS,
    now             = () => Date.now()
} = {}) {
    const customFetch       = fetch !== undefined,
          fetchFn           = fetch ?? fetchImpl,
          inFlightRefreshes = new Map();
    let   writeChain    = Promise.resolve(),
          atomicCounter = 0;

    function enqueueWrite(task) {
        const next = writeChain.then(task, task);
        writeChain = next.catch(() => {});
        return next;
    }

    function resolveCustodyPaths(channel, account) {
        if (!custodyDir) {
            return {perAccount: null, bundlePath: null};
        }
        const safeAccount = String(account).replace(/[^a-zA-Z0-9._-]/g, '_');
        return {
            perAccount: path.join(custodyDir, 'social-credentials', channel, `${safeAccount}.json`),
            bundlePath: path.join(custodyDir, 'social-credentials.json')
        };
    }

    async function loadRawRecord(channel, account) {
        if (credentials && typeof credentials === 'object') {
            const compositeKey = `${channel}:${account}`;
            if (Object.hasOwn(credentials, compositeKey)) {
                return {record: credentials[compositeKey], sourceKind: 'memory-composite', key: compositeKey};
            }
            if (credentials[channel] && typeof credentials[channel] === 'object' && Object.hasOwn(credentials[channel], account)) {
                return {record: credentials[channel][account], sourceKind: 'memory-nested', key: account};
            }
            if (Object.hasOwn(credentials, account)) {
                return {record: credentials[account], sourceKind: 'memory-account', key: account};
            }
        }

        if (!custodyDir) {
            return {record: null, sourceKind: 'none'};
        }

        const {perAccount, bundlePath} = resolveCustodyPaths(channel, account);

        try {
            const raw = await fsModule.readFile(perAccount, 'utf8');
            return {record: JSON.parse(raw), sourceKind: 'per-account', filePath: perAccount};
        } catch {
            // Fall through to aggregate custody file if present.
        }

        try {
            const raw    = await fsModule.readFile(bundlePath, 'utf8'),
                  parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                const compositeKey = `${channel}:${account}`;
                if (Object.hasOwn(parsed, compositeKey)) {
                    return {record: parsed[compositeKey], sourceKind: 'bundle-composite', filePath: bundlePath, key: compositeKey};
                }
                if (parsed[channel] && typeof parsed[channel] === 'object' && Object.hasOwn(parsed[channel], account)) {
                    return {record: parsed[channel][account], sourceKind: 'bundle-nested', filePath: bundlePath, key: account};
                }
            }
            return {record: null, sourceKind: 'none'};
        } catch {
            return {record: null, sourceKind: 'none'};
        }
    }

    async function writeAtomic0600(filePath, payload, nowMs) {
        const dir     = path.dirname(filePath),
              seq     = ++atomicCounter,
              tmpPath = `${filePath}.${process.pid}.${nowMs}.${seq}.tmp`,
              body    = JSON.stringify(payload, null, 2);

        await fsModule.mkdir(dir, {recursive: true});
        await fsModule.writeFile(tmpPath, body, {encoding: 'utf8', mode: 0o600});
        if (typeof fsModule.chmod === 'function') {
            await fsModule.chmod(tmpPath, 0o600);
        }
        await fsModule.rename(tmpPath, filePath);
        if (typeof fsModule.chmod === 'function') {
            await fsModule.chmod(filePath, 0o600);
        }
    }

    async function persistRotatedRecord(channel, account, loaded, rotatedRecord, nowMs) {
        if (credentials && typeof credentials === 'object') {
            if (loaded.sourceKind === 'memory-composite') {
                credentials[loaded.key] = rotatedRecord;
            } else if (loaded.sourceKind === 'memory-nested' && credentials[channel]) {
                credentials[channel][account] = rotatedRecord;
            } else if (loaded.sourceKind === 'memory-account') {
                credentials[account] = rotatedRecord;
            }
        }

        if (!custodyDir) {
            return;
        }

        await enqueueWrite(async () => {
            const {perAccount, bundlePath} = resolveCustodyPaths(channel, account);

            if (loaded.sourceKind === 'bundle-composite' || loaded.sourceKind === 'bundle-nested') {
                let latestBundle = null;
                try {
                    const raw    = await fsModule.readFile(bundlePath, 'utf8'),
                          parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        latestBundle = parsed;
                    }
                } catch (err) {
                    if (err?.code === 'ENOENT') {
                        latestBundle = {};
                    }
                }

                if (!latestBundle) {
                    await writeAtomic0600(perAccount, rotatedRecord, nowMs);
                    return;
                }

                if (loaded.sourceKind === 'bundle-composite') {
                    const nextBundle = {...latestBundle, [loaded.key]: rotatedRecord};
                    await writeAtomic0600(bundlePath, nextBundle, nowMs);
                    return;
                }

                const existingChannel = latestBundle[channel];
                const nextBundle      = {
                    ...latestBundle,
                    [channel]: {
                        ...(existingChannel && typeof existingChannel === 'object' && !Array.isArray(existingChannel) ? existingChannel : {}),
                        [account]: rotatedRecord
                    }
                };
                await writeAtomic0600(bundlePath, nextBundle, nowMs);
                return;
            }

            await writeAtomic0600(loaded.filePath || perAccount, rotatedRecord, nowMs);
        });
    }

    function extractRefreshConfig(record) {
        const refreshToken = typeof record?.refreshToken === 'string'
                  ? record.refreshToken.trim()
                  : (typeof record?.refresh_token === 'string' ? record.refresh_token.trim() : ''),
              clientId     = typeof record?.clientId === 'string'
                  ? record.clientId.trim()
                  : (typeof record?.client_id === 'string' ? record.client_id.trim() : ''),
              clientSecret = typeof record?.clientSecret === 'string'
                  ? record.clientSecret.trim()
                  : (typeof record?.client_secret === 'string' ? record.client_secret.trim() : ''),
              tokenEndpoint = record?.tokenUrl || xTokenUrl,
              canRotate     = Boolean(refreshToken) && typeof fetchFn === 'function' && (Boolean(clientId) || customFetch || Boolean(record?.tokenUrl));

        return {refreshToken, clientId, clientSecret, tokenEndpoint, canRotate};
    }

    async function rotateExpiredXCredential(channel, account, loaded, nowMs, currentToken) {
        const record                                                           = loaded.record,
              {refreshToken, clientId, clientSecret, tokenEndpoint, canRotate} = extractRefreshConfig(record),
              secrets                                                          = [currentToken, refreshToken, clientSecret].filter(Boolean);

        if (!canRotate) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.credential,
                reason: `${REFUSAL_CODES.credential} — Fleet custody token for ${channel}:${account} is expired`
            };
        }

        const params = new URLSearchParams({
            grant_type   : 'refresh_token',
            refresh_token: refreshToken
        });
        if (clientId) {
            params.set('client_id', clientId);
        }

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept        : 'application/json'
        };
        if (clientId && clientSecret) {
            const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            headers.Authorization = `Basic ${basic}`;
            secrets.push(basic);
        }

        let response, payload;
        try {
            response = await fetchFn(tokenEndpoint, {
                method: 'POST',
                headers,
                body  : params.toString()
            });
            payload = typeof response?.json === 'function' ? await response.json() : null;
        } catch (error) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.credential,
                reason: scrubSecrets(`${REFUSAL_CODES.credential} — X OAuth 2.0 refresh failed for ${channel}:${account}: ${error?.message || String(error)}`, secrets)
            };
        }

        const nextAccessToken = typeof payload?.access_token === 'string'
            ? payload.access_token.trim()
            : (typeof payload?.accessToken === 'string' ? payload.accessToken.trim() : '');
        const nextRefreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token.trim()
            ? payload.refresh_token.trim()
            : (typeof payload?.refreshToken === 'string' && payload.refreshToken.trim() ? payload.refreshToken.trim() : refreshToken);

        if (nextAccessToken) secrets.push(nextAccessToken);
        if (nextRefreshToken) secrets.push(nextRefreshToken);

        if (!response?.ok || !nextAccessToken) {
            const statusText = response?.status ? `HTTP ${response.status}` : 'invalid response',
                  errorDesc  = payload?.error_description || payload?.error || statusText;
            return {
                ok    : false,
                code  : REFUSAL_CODES.credential,
                reason: scrubSecrets(`${REFUSAL_CODES.credential} — X OAuth 2.0 refresh failed for ${channel}:${account} (${errorDesc})`, secrets)
            };
        }

        const expiresInSec  = Number(payload?.expires_in ?? payload?.expiresIn),
              nextExpiresAt = Number.isFinite(expiresInSec) && expiresInSec > 0
                  ? new Date(nowMs + expiresInSec * 1000).toISOString()
                  : new Date(nowMs + 2 * 60 * 60 * 1000).toISOString(),
              updatedAt     = new Date(nowMs).toISOString(),
              rotatedRecord = {
                  ...record,
                  accessToken : nextAccessToken,
                  refreshToken: nextRefreshToken,
                  expiresAt   : nextExpiresAt,
                  updatedAt
              };

        try {
            await persistRotatedRecord(channel, account, loaded, rotatedRecord, nowMs);
        } catch (error) {
            return {
                ok    : false,
                code  : REFUSAL_CODES.credential,
                reason: scrubSecrets(`${REFUSAL_CODES.credential} — failed to persist rotated X credential for ${channel}:${account}: ${error?.message || String(error)}`, secrets)
            };
        }

        return {
            ok     : true,
            rotated: true,
            token  : nextAccessToken,
            record : {
                channel,
                account,
                scopes   : Array.isArray(rotatedRecord.scopes) ? [...rotatedRecord.scopes] : [],
                expiresAt: rotatedRecord.expiresAt,
                issuedAt : rotatedRecord.issuedAt ?? null,
                updatedAt
            }
        };
    }

    function rotateExpiredXCredentialSingleFlight(channel, account, loaded, nowMs, currentToken) {
        const flightKey = `${channel}:${account}`;
        if (inFlightRefreshes.has(flightKey)) {
            return inFlightRefreshes.get(flightKey);
        }

        const flightPromise = rotateExpiredXCredential(channel, account, loaded, nowMs, currentToken)
            .finally(() => {
                inFlightRefreshes.delete(flightKey);
            });

        inFlightRefreshes.set(flightKey, flightPromise);
        return flightPromise;
    }

    return {
        /**
         * @summary Reads and validates the custody credential for `{channel, account}` at `now()`.
         * @param {Object} params
         * @param {String} params.channel
         * @param {String} params.account
         * @param {Number} [params.nowMs]
         * @returns {Promise<{ok: Boolean, token?: String, record?: Object, rotated?: Boolean, code?: String, reason?: String}>}
         */
        async readCredential({channel, account, nowMs = now()}) {
            if (!channel || !account) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — channel and account are required to resolve Fleet custody`
                };
            }

            const flightKey = `${channel}:${account}`;
            if (inFlightRefreshes.has(flightKey)) {
                return inFlightRefreshes.get(flightKey);
            }

            const loaded = await loadRawRecord(channel, account),
                  record = typeof loaded?.record === 'string'
                      ? {accessToken: loaded.record}
                      : (loaded?.record ?? null);

            if (!record || typeof record !== 'object') {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — no Fleet custody token registered for ${channel}:${account}`
                };
            }

            if (record.revoked === true) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — Fleet custody token for ${channel}:${account} is marked revoked`
                };
            }

            const token = typeof record.accessToken === 'string'
                ? record.accessToken.trim()
                : (typeof record.token === 'string' ? record.token.trim() : '');

            if (!token) {
                return {
                    ok    : false,
                    code  : REFUSAL_CODES.credential,
                    reason: `${REFUSAL_CODES.credential} — Fleet custody record for ${channel}:${account} holds no access token`
                };
            }

            if (record.expiresAt != null) {
                const expiresMs = typeof record.expiresAt === 'number'
                    ? record.expiresAt
                    : Date.parse(String(record.expiresAt));
                const {canRotate} = extractRefreshConfig(record),
                      margin      = canRotate && Number.isFinite(refreshMarginMs) && refreshMarginMs > 0 ? refreshMarginMs : 0;

                if (!Number.isFinite(expiresMs) || expiresMs <= (nowMs + margin)) {
                    if (channel === PUBLISH_CHANNELS.x) {
                        return rotateExpiredXCredentialSingleFlight(channel, account, loaded, nowMs, token);
                    }
                    return {
                        ok    : false,
                        code  : REFUSAL_CODES.credential,
                        reason: `${REFUSAL_CODES.credential} — Fleet custody token for ${channel}:${account} is expired`
                    };
                }
            }

            if (channel === PUBLISH_CHANNELS.linkedin && record.issuedAt != null) {
                const issuedMs = typeof record.issuedAt === 'number'
                    ? record.issuedAt
                    : Date.parse(String(record.issuedAt));

                if (!Number.isFinite(issuedMs) || (nowMs - issuedMs) >= LINKEDIN_TOKEN_MAX_AGE_MS) {
                    return {
                        ok    : false,
                        code  : REFUSAL_CODES.credential,
                        reason: `${REFUSAL_CODES.credential} — LinkedIn page-admin token for ${account} exceeded the 60-day custody lifetime`
                    };
                }
            }

            return {
                ok    : true,
                token,
                record: {
                    channel,
                    account,
                    scopes   : Array.isArray(record.scopes) ? [...record.scopes] : [],
                    expiresAt: record.expiresAt ?? null,
                    issuedAt : record.issuedAt ?? null
                }
            };
        }
    };
}

/**
 * @summary Canonicalizes a peer or operator identity to its `@<login>` form.
 * @param {*} value
 * @returns {String|null}
 * @private
 */
function canonicalizePeerId(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim().replace(/^@+/, '');
    if (!trimmed) {
        return null;
    }
    return `@${trimmed}`;
}

/**
 * @summary Normalizes a raw switch entry into `{peer, channel, state, updatedAt, updatedBy, audit, proposal}`.
 * @param {*}      raw
 * @param {String} canonicalPeer
 * @param {String} channel
 * @returns {Object}
 * @private
 */
function normalizeSwitchRecord(raw, canonicalPeer, channel) {
    if (typeof raw === 'string' && Object.hasOwn(SWITCH_STATE_RANK, raw)) {
        return {
            peer     : canonicalPeer,
            channel,
            state    : raw,
            updatedAt: null,
            updatedBy: null,
            audit    : [],
            proposal : null
        };
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const state = Object.hasOwn(SWITCH_STATE_RANK, raw.state)
            ? raw.state
            : SWITCH_STATES.approveEach;

        return {
            peer     : canonicalPeer,
            channel,
            state,
            updatedAt: raw.updatedAt ?? null,
            updatedBy: raw.updatedBy ?? null,
            audit    : Array.isArray(raw.audit) ? raw.audit.map(entry => ({...entry})) : [],
            proposal : raw.proposal ?? null
        };
    }

    return {
        peer     : canonicalPeer,
        channel,
        state    : SWITCH_STATES.approveEach,
        updatedAt: null,
        updatedBy: null,
        audit    : [],
        proposal : null
    };
}

/**
 * @summary Creates a Fleet-side per-`(peer, channel)` outbound publish switch store backed by
 * `<custodyDir>/publish-switches.json` with atomic `0o600` temp-file-and-rename persistence (or an
 * in-memory `switches` map when `custodyDir` is null).
 *
 * Enforces:
 * - Default `'approve each'` whenever a `(peer, channel)` record is absent (never falls back to a channel-only key).
 * - Optimistic concurrency via `expectedFrom` (`refused: switch-moved` on mismatch).
 * - Mandatory non-empty `reason` whenever promoting a switch (`SWITCH_STATE_RANK[to] > SWITCH_STATE_RANK[current.state]`).
 * - Append-only `{who, when, from, to, reason}` audit log per `(peer, channel)`.
 *
 * @param {Object}   [options={}]
 * @param {String}   [options.custodyDir=null]
 * @param {Object}   [options.switches=null]
 * @param {Object}   [options.fsModule=fsPromises]
 * @param {Function} [options.now=Date.now]
 * @returns {{getSwitchState: Function, read: Function, readPeerSwitches: Function, setSwitch: Function}}
 */
export function createPublishSwitchStore({
    custodyDir = null,
    switches   = null,
    fsModule   = fsPromises,
    now        = () => Date.now()
} = {}) {
    const memorySwitches = (switches && typeof switches === 'object' && !Array.isArray(switches))
        ? switches
        : {};
    let writeChain    = Promise.resolve(),
        atomicCounter = 0;

    function enqueueWrite(task) {
        const next = writeChain.then(task, task);
        writeChain = next.catch(() => {});
        return next;
    }

    function resolveSwitchesFilePath() {
        return custodyDir ? path.join(custodyDir, 'publish-switches.json') : null;
    }

    async function writeAtomic0600(filePath, payload, nowMs) {
        const dir     = path.dirname(filePath),
              seq     = ++atomicCounter,
              tmpPath = `${filePath}.${process.pid}.${nowMs}.${seq}.tmp`,
              body    = JSON.stringify(payload, null, 2);

        await fsModule.mkdir(dir, {recursive: true});
        await fsModule.writeFile(tmpPath, body, {encoding: 'utf8', mode: 0o600});
        if (typeof fsModule.chmod === 'function') {
            await fsModule.chmod(tmpPath, 0o600);
        }
        await fsModule.rename(tmpPath, filePath);
        if (typeof fsModule.chmod === 'function') {
            await fsModule.chmod(filePath, 0o600);
        }
    }

    async function loadStoreMap() {
        const filePath = resolveSwitchesFilePath();
        if (!filePath) {
            return memorySwitches;
        }

        try {
            const raw    = await fsModule.readFile(filePath, 'utf8'),
                  parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // Fall through to in-memory seed or empty store when file does not exist yet.
        }

        return {...memorySwitches};
    }

    function lookupRawEntry(storeMap, canonicalPeer, channel) {
        if (!storeMap || typeof storeMap !== 'object') {
            return undefined;
        }
        const barePeer         = canonicalPeer.slice(1),
              canonicalCompKey = `${canonicalPeer}:${channel}`,
              bareCompKey      = `${barePeer}:${channel}`;

        if (Object.hasOwn(storeMap, canonicalCompKey)) {
            return storeMap[canonicalCompKey];
        }
        if (Object.hasOwn(storeMap, bareCompKey)) {
            return storeMap[bareCompKey];
        }
        if (storeMap[canonicalPeer] && typeof storeMap[canonicalPeer] === 'object' && Object.hasOwn(storeMap[canonicalPeer], channel)) {
            return storeMap[canonicalPeer][channel];
        }
        if (storeMap[barePeer] && typeof storeMap[barePeer] === 'object' && Object.hasOwn(storeMap[barePeer], channel)) {
            return storeMap[barePeer][channel];
        }
        return undefined;
    }

    async function getChannelRecord(canonicalPeer, channel) {
        const storeMap = await loadStoreMap(),
              raw      = lookupRawEntry(storeMap, canonicalPeer, channel);
        return normalizeSwitchRecord(raw, canonicalPeer, channel);
    }

    async function getSwitchState({peer, channel} = {}) {
        const canonicalPeer = canonicalizePeerId(peer);
        if (!canonicalPeer || !Object.values(PUBLISH_CHANNELS).includes(channel)) {
            return SWITCH_STATES.approveEach;
        }
        const record = await getChannelRecord(canonicalPeer, channel);
        return record.state;
    }

    async function readPeerSwitches({peer} = {}) {
        const canonicalPeer = canonicalizePeerId(peer);
        if (!canonicalPeer) {
            return {
                ok     : false,
                state  : 'rejected',
                refused: REFUSAL_CODES.peer,
                code   : REFUSAL_CODES.peer,
                reason : `${REFUSAL_CODES.peer} — peer must be a non-empty string`
            };
        }

        const storeMap = await loadStoreMap(),
              channels = {};

        for (const channel of Object.values(PUBLISH_CHANNELS)) {
            const raw = lookupRawEntry(storeMap, canonicalPeer, channel);
            channels[channel] = normalizeSwitchRecord(raw, canonicalPeer, channel);
        }

        return {
            state: 'ok',
            peer : canonicalPeer,
            channels
        };
    }

    async function read({peer, channel} = {}) {
        if (channel !== undefined && channel !== null) {
            return getSwitchState({peer, channel});
        }
        return readPeerSwitches({peer});
    }

    async function setSwitch({
        peer,
        channel,
        to,
        expectedFrom,
        reason   = '',
        who      = '@tobiu',
        proposal = undefined,
        nowMs    = now()
    } = {}) {
        const canonicalPeer = canonicalizePeerId(peer);
        if (!canonicalPeer) {
            return {
                ok     : false,
                refused: REFUSAL_CODES.peer,
                code   : REFUSAL_CODES.peer,
                reason : `${REFUSAL_CODES.peer} — peer must be a non-empty string`
            };
        }

        if (!Object.values(PUBLISH_CHANNELS).includes(channel)) {
            return {
                ok     : false,
                refused: REFUSAL_CODES.channel,
                code   : REFUSAL_CODES.channel,
                reason : `${REFUSAL_CODES.channel} — unsupported publish channel '${String(channel)}'`
            };
        }

        if (!Object.hasOwn(SWITCH_STATE_RANK, to)) {
            return {
                ok     : false,
                refused: REFUSAL_CODES.state,
                code   : REFUSAL_CODES.state,
                reason : `${REFUSAL_CODES.state} — invalid target switch state '${String(to)}'`
            };
        }

        if (!Object.hasOwn(SWITCH_STATE_RANK, expectedFrom)) {
            return {
                ok     : false,
                refused: REFUSAL_CODES.expectedFrom,
                code   : REFUSAL_CODES.expectedFrom,
                reason : `${REFUSAL_CODES.expectedFrom} — expectedFrom must be a valid switch state`
            };
        }

        return enqueueWrite(async () => {
            const storeMap = await loadStoreMap(),
                  raw      = lookupRawEntry(storeMap, canonicalPeer, channel),
                  current  = normalizeSwitchRecord(raw, canonicalPeer, channel);

            if (current.state !== expectedFrom) {
                return {
                    ok          : false,
                    refused     : REFUSAL_CODES.switchMoved,
                    code        : REFUSAL_CODES.switchMoved,
                    currentState: current.state,
                    reason      : `${REFUSAL_CODES.switchMoved} — switch for ${canonicalPeer} × ${channel} is currently '${current.state}', expected '${expectedFrom}'`
                };
            }

            const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
            if (SWITCH_STATE_RANK[to] > SWITCH_STATE_RANK[current.state] && !trimmedReason) {
                return {
                    ok     : false,
                    refused: REFUSAL_CODES.reason,
                    code   : REFUSAL_CODES.reason,
                    reason : `${REFUSAL_CODES.reason} — a reason is required to promote a publish switch`
                };
            }

            const canonicalWho = canonicalizePeerId(who) ?? '@tobiu',
                  isoNow       = new Date(nowMs).toISOString(),
                  nextAudit    = [
                      ...current.audit,
                      {
                          who   : canonicalWho,
                          when  : isoNow,
                          from  : current.state,
                          to,
                          reason: trimmedReason
                      }
                  ],
                  nextRecord = {
                      peer     : canonicalPeer,
                      channel,
                      state    : to,
                      updatedAt: isoNow,
                      updatedBy: canonicalWho,
                      audit    : nextAudit,
                      proposal : proposal !== undefined ? proposal : current.proposal
                  },
                  compKey  = `${canonicalPeer}:${channel}`,
                  bareKey  = `${canonicalPeer.slice(1)}:${channel}`,
                  filePath = resolveSwitchesFilePath();

            const nextStoreMap = {...storeMap};
            delete nextStoreMap[bareKey];
            if (nextStoreMap[canonicalPeer] && typeof nextStoreMap[canonicalPeer] === 'object') {
                nextStoreMap[canonicalPeer] = {...nextStoreMap[canonicalPeer], [channel]: nextRecord};
            }
            nextStoreMap[compKey] = nextRecord;

            memorySwitches[compKey] = nextRecord;
            delete memorySwitches[bareKey];

            if (filePath) {
                await writeAtomic0600(filePath, nextStoreMap, nowMs);
            }

            return {
                ok    : true,
                switch: nextRecord,
                record: nextRecord
            };
        });
    }

    return {
        getSwitchState,
        read,
        readPeerSwitches,
        setSwitch
    };
}
