import crypto                                           from 'node:crypto';
import memoryCoreConfig                                 from '../../mcp/server/memory-core/config.mjs';
import {OPTION_REVALIDATION_LEDGER, deriveCalibratedPolicy} from '../../scripts/maintenance/communityActivityPolicyCalibrationCore.mjs';

/**
 * @module ai/services/memory-core/communityStewardWakeLease
 * @summary Tenant- and source-scoped TTL-bound community-steward wake lease and coalesced count-only
 * wake evaluator.
 *
 * Implements Stage 2 of Option J:
 * - Runs in shadow-only mode (`mode: 'shadow'`, `stewardActivation: false`) by default while
 *   activation thresholds in `AiConfig` (`communityStewardWake.*`) remain `null` (`unset`),
 *   recording steward vacancy (`vacancy_count`), would-be coalesced count-only wakes
 *   (`shadow_would_wake_count`), and observed payload bytes (`max_shadow_payload_bytes`) while
 *   emitting no live wakes (`shouldWake: false`).
 * - No numeric threshold literal lives outside `AiConfig` leaves. Live wake activation
 *   (`stewardActivation: true`) fails closed (`COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:*`) unless
 *   every numeric threshold leaf (`stewardLeaseTtlMs`, `wakeCoalesceWindowMs`,
 *   `vacancyFallbackCooldownMs`, `minUnclaimedEligibleCount`, `wakeAmplificationCap`,
 *   `maxWakePayloadBytes`) is populated with a measured positive integer.
 * - Lease state is persisted in SQLite (`mc_community_steward_lease`) with hashed holder tokens and
 *   monotonic fencing epochs so contention, expiry, reclaim, and stale-holder rejection are explicit.
 * - Wake payloads (`community-steward-wake.v1`) are count-only and coalesced, carrying
 *   `notAuthority: true` and zero prose, titles, bodies, excerpts, URLs, actor handles, ranking, or
 *   task assignments.
 * - Vacancy fallback routes only to a single explicit same-tenant fallback target under a measured
 *   cooldown (`vacancyFallbackCooldownMs`), refusing wildcard/all-resident broadcasts, cross-tenant
 *   targets, and global maintainer roster identities.
 */

export const COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION = 'community-steward-wake.v1';

export const STEWARD_LEASE_STATES = Object.freeze({
    held    : 'held',
    released: 'released'
});

export const CALIBRATED_STEWARD_WAKE_REPORT_ID =
    'dd78a28718cf0db9a526876c271053c674e713c9dc4b0fe99882f410ee7f2664';

const CALIBRATED_BASELINE_POLICY = deriveCalibratedPolicy();

export const REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS = Object.freeze([
    'stewardLeaseTtlMs',
    'wakeCoalesceWindowMs',
    'vacancyFallbackCooldownMs',
    'minUnclaimedEligibleCount',
    'wakeAmplificationCap',
    'maxWakePayloadBytes'
]);

export const CALIBRATED_STEWARD_WAKE_POLICY = Object.freeze({
    calibrationReportId       : CALIBRATED_STEWARD_WAKE_REPORT_ID,
    disposition               : OPTION_REVALIDATION_LEDGER.J.disposition,
    maxWakePayloadBytes       : CALIBRATED_BASELINE_POLICY.thresholds.maxWakePayloadBytes.value,
    minUnclaimedEligibleCount : CALIBRATED_BASELINE_POLICY.thresholds.minUnclaimedEligibleCount.value,
    mode                      : 'shadow',
    shadowExperimentAuthorized: OPTION_REVALIDATION_LEDGER.J.disposition.startsWith('shadow-only'),
    stewardActivation         : Boolean(CALIBRATED_BASELINE_POLICY.thresholds.stewardActivation.value),
    stewardLeaseTtlMs         : CALIBRATED_BASELINE_POLICY.thresholds.stewardLeaseTtlMs.value,
    vacancyFallbackCooldownMs : CALIBRATED_BASELINE_POLICY.thresholds.vacancyFallbackCooldownMs.value,
    wakeAmplificationCap      : CALIBRATED_BASELINE_POLICY.thresholds.wakeAmplificationCap.value,
    wakeCoalesceWindowMs      : CALIBRATED_BASELINE_POLICY.thresholds.wakeCoalesceWindowMs.value
});

const FORBIDDEN_GLOBAL_ROSTER_HANDLES = new Set([
    '@neo-fable',
    '@neo-fable-clio',
    '@neo-gemini-julia',
    '@neo-gemini-maryam',
    '@neo-gemini-pro',
    '@neo-gpt',
    '@neo-gpt-emmy',
    '@neo-gpt-euclid',
    '@neo-gpt-sophie',
    '@neo-opus-ada',
    '@neo-opus-grace',
    '@neo-opus-vega'
]);

const FORBIDDEN_WAKE_PAYLOAD_KEYS = new Set([
    'actorId',
    'actors',
    'assignedTo',
    'assignee',
    'body',
    'comment',
    'excerpt',
    'htmlUrl',
    'items',
    'priorityScore',
    'prose',
    'rank',
    'ranking',
    'summary',
    'taskId',
    'title',
    'url'
]);

function defaultMintToken() {
    return crypto.randomBytes(24).toString('base64url')
}

function defaultHashToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex')
}

function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0
}

/**
 * @summary Reads the current resolved `communityStewardWake` leaves from the Memory Core `AiConfig`
 * Provider at the use site.
 * @returns {Object}
 */
function readConfiguredStewardWakeLeaves() {
    const leaves = memoryCoreConfig.communityStewardWake;

    return {
        maxWakePayloadBytes      : leaves.maxWakePayloadBytes,
        minUnclaimedEligibleCount: leaves.minUnclaimedEligibleCount,
        stewardActivation        : Boolean(leaves.stewardActivation),
        stewardLeaseTtlMs        : leaves.stewardLeaseTtlMs,
        vacancyFallbackCooldownMs: leaves.vacancyFallbackCooldownMs,
        wakeAmplificationCap     : leaves.wakeAmplificationCap,
        wakeCoalesceWindowMs     : leaves.wakeCoalesceWindowMs
    }
}

/**
 * @summary Ensures the steward lease and wake-coalescing tables exist in SQLite.
 * @param {Object} db Open better-sqlite3 handle.
 */
export function ensureStewardWakeLeaseSchema(db) {
    if (!db) throw new TypeError('COMMUNITY_STORAGE_UNAVAILABLE');

    db.exec(`
        CREATE TABLE IF NOT EXISTS mc_community_steward_lease (
            lease_scope_key TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            source_scope_json TEXT NOT NULL,
            fencing_epoch INTEGER NOT NULL,
            holder_principal_id TEXT,
            holder_token_hash TEXT,
            acquired_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('held', 'released'))
        );
        CREATE INDEX IF NOT EXISTS idx_mc_community_steward_lease_tenant
            ON mc_community_steward_lease(tenant_id, state, expires_at);

        CREATE TABLE IF NOT EXISTS mc_community_steward_wake_state (
            lease_scope_key TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            last_woken_watermark TEXT,
            last_wake_at INTEGER,
            last_vacancy_wake_at INTEGER,
            window_started_at INTEGER,
            window_wake_count INTEGER NOT NULL DEFAULT 0,
            last_fencing_epoch INTEGER,
            vacancy_count INTEGER NOT NULL DEFAULT 0,
            shadow_would_wake_count INTEGER NOT NULL DEFAULT 0,
            max_shadow_payload_bytes INTEGER NOT NULL DEFAULT 0
        );
    `)
}

/**
 * @summary Canonicalizes a tenant + source-filter scope into a deterministic lease key.
 * @param {String} tenantId
 * @param {String[]|null} [sourceInstanceIds=null]
 * @returns {{leaseScopeKey: String, normalizedSourceIds: String[]|null, sourceScopeJson: String}}
 */
export function buildStewardLeaseScopeKey(tenantId, sourceInstanceIds = null) {
    if (typeof tenantId !== 'string' || !tenantId.trim()) {
        throw new Error('COMMUNITY_TENANT_UNRESOLVED')
    }
    if (sourceInstanceIds !== null) {
        if (!Array.isArray(sourceInstanceIds) || sourceInstanceIds.length === 0 ||
            sourceInstanceIds.some(id => typeof id !== 'string' || !id.trim())) {
            throw new Error('COMMUNITY_SOURCE_FILTER_INVALID')
        }
    }

    const normalizedSourceIds = sourceInstanceIds === null
        ? null
        : [...new Set(sourceInstanceIds.map(id => id.trim()))].sort();
    const sourceScopeJson = JSON.stringify(normalizedSourceIds);
    const scopeSuffix     = normalizedSourceIds === null
        ? 'ALL'
        : crypto.createHash('sha256').update(sourceScopeJson).digest('hex').slice(0, 24);

    return {
        leaseScopeKey: `tenant:${tenantId.trim()}:sources:${scopeSuffix}`,
        normalizedSourceIds,
        sourceScopeJson
    }
}

/**
 * @summary Validates a tenant-scoped steward or vacancy-fallback principal, rejecting broadcasts,
 * global Neo maintainer roster handles, and cross-tenant principals.
 * @param {Object|String} candidate
 * @param {String} expectedTenantId
 * @param {String} roleLabel
 * @returns {{principalId: String, tenantId: String}}
 */
export function validateTenantScopedPrincipal(candidate, expectedTenantId, roleLabel = 'steward') {
    if (!candidate || Array.isArray(candidate)) {
        throw new Error(`COMMUNITY_STEWARD_PRINCIPAL_INVALID:${roleLabel}`)
    }

    const principalId = typeof candidate === 'string'
        ? candidate.trim()
        : typeof candidate.principalId === 'string' ? candidate.principalId.trim() : '';
    const candidateTenantId = typeof candidate === 'object' && candidate !== null && typeof candidate.tenantId === 'string'
        ? candidate.tenantId.trim()
        : expectedTenantId;
    const candidateScope = typeof candidate === 'object' && candidate !== null && typeof candidate.scope === 'string'
        ? candidate.scope.trim()
        : 'tenant';

    if (!principalId) {
        throw new Error(`COMMUNITY_STEWARD_PRINCIPAL_INVALID:${roleLabel}`)
    }
    if (principalId === '*' || principalId.includes('*') || principalId.toUpperCase() === 'ALL' ||
        principalId.toUpperCase().startsWith('AGENT:*') || candidate.broadcast === true) {
        throw new Error('COMMUNITY_STEWARD_ALL_RESIDENT_BROADCAST_FORBIDDEN')
    }
    if (candidateScope === 'global-roster' || FORBIDDEN_GLOBAL_ROSTER_HANDLES.has(principalId.toLowerCase())) {
        throw new Error('COMMUNITY_STEWARD_GLOBAL_ROSTER_FORBIDDEN')
    }
    if (candidateTenantId !== expectedTenantId) {
        throw new Error('COMMUNITY_STEWARD_CROSS_TENANT_FORBIDDEN')
    }

    return {
        principalId,
        tenantId: expectedTenantId
    }
}

/**
 * @summary Resolves and validates the steward wake policy from `AiConfig` leaves and optional test/runtime overrides.
 *
 * When `stewardActivation` is `false` (the default), the evaluator runs in `'shadow'` mode: numeric
 * thresholds may remain `null` (`unset`), and any supplied non-null threshold must be a positive safe
 * integer. When `stewardActivation` is `true`, every numeric threshold in
 * {@link REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS} MUST be a positive safe integer; any `null` or invalid
 * threshold fails closed.
 *
 * @param {Object} [policyOverride={}]
 * @returns {Object}
 */
export function resolveValidatedStewardWakePolicy(policyOverride = {}) {
    if (!policyOverride || typeof policyOverride !== 'object') {
        throw new Error('COMMUNITY_STEWARD_POLICY_INVALID')
    }

    const configuredLeaves = readConfiguredStewardWakeLeaves();
    const merged           = {
        ...CALIBRATED_STEWARD_WAKE_POLICY,
        ...configuredLeaves,
        ...policyOverride
    };

    if (merged.shadowExperimentAuthorized !== true || merged.calibrationReportId !== CALIBRATED_STEWARD_WAKE_REPORT_ID) {
        throw new Error('COMMUNITY_STEWARD_WAKE_NOT_AUTHORIZED')
    }

    const stewardActivation = Boolean(merged.stewardActivation);

    for (const key of REQUIRED_LIVE_STEWARD_THRESHOLD_KEYS) {
        const value = merged[key];

        if (value === null || value === undefined) {
            if (stewardActivation) {
                throw new Error(`COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:${key}`)
            }
            continue
        }

        if (!isPositiveSafeInteger(value)) {
            throw new Error(`COMMUNITY_STEWARD_POLICY_INVALID:${key}`)
        }
    }

    return {
        ...merged,
        mode             : stewardActivation ? 'live' : 'shadow',
        stewardActivation
    }
}

/**
 * @summary Acquires or reclaims a tenant/source-scoped TTL-bound steward wake lease.
 * @param {Object} params
 * @returns {Object}
 */
export function acquireStewardWakeLease({
    db,
    hashToken         = defaultHashToken,
    holderPrincipal,
    leaseTtlMs,
    mintToken         = defaultMintToken,
    now,
    policy            = {},
    sourceInstanceIds = null,
    tenantId
} = {}) {
    ensureStewardWakeLeaseSchema(db);

    if (!Number.isFinite(now) || now <= 0) {
        throw new Error('COMMUNITY_STEWARD_CLOCK_REQUIRED')
    }

    const validatedPolicy = resolveValidatedStewardWakePolicy(
        leaseTtlMs === undefined ? policy : {...policy, stewardLeaseTtlMs: leaseTtlMs}
    );

    if (!isPositiveSafeInteger(validatedPolicy.stewardLeaseTtlMs)) {
        throw new Error('COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:stewardLeaseTtlMs')
    }

    const {leaseScopeKey, normalizedSourceIds, sourceScopeJson} = buildStewardLeaseScopeKey(tenantId, sourceInstanceIds);
    const holder                                                = validateTenantScopedPrincipal(holderPrincipal, tenantId.trim(), 'holder');

    if (normalizedSourceIds !== null) {
        const ownedRows = db.prepare('SELECT source_instance_id FROM mc_source_registration WHERE tenant_id = ?').all(tenantId.trim());
        const ownedSet  = new Set(ownedRows.map(row => row.source_instance_id));

        if (normalizedSourceIds.some(id => !ownedSet.has(id))) {
            throw new Error('COMMUNITY_SOURCE_NOT_OWNED')
        }
    }

    const tx = db.transaction(() => {
        const existing = db.prepare(
            'SELECT * FROM mc_community_steward_lease WHERE lease_scope_key = ?'
        ).get(leaseScopeKey);

        const activeHold = existing &&
            existing.state === STEWARD_LEASE_STATES.held &&
            Number(existing.expires_at) > now;

        if (activeHold) {
            return {
                acquired         : false,
                contention       : true,
                expiresAt        : Number(existing.expires_at),
                fencingEpoch     : Number(existing.fencing_epoch),
                holderPrincipalId: existing.holder_principal_id,
                leaseScopeKey,
                mode             : validatedPolicy.mode,
                normalizedSourceIds,
                notAuthority     : true,
                retryAfterMs     : Math.max(0, Number(existing.expires_at) - now),
                state            : STEWARD_LEASE_STATES.held,
                tenantId         : holder.tenantId
            }
        }

        const reclaimed    = Boolean(existing && existing.state === STEWARD_LEASE_STATES.held && Number(existing.expires_at) <= now);
        const fencingEpoch = (existing ? Number(existing.fencing_epoch) : 0) + 1;
        const token        = mintToken();
        const expiresAt    = now + validatedPolicy.stewardLeaseTtlMs;

        db.prepare(`
            INSERT INTO mc_community_steward_lease (
                lease_scope_key,
                tenant_id,
                source_scope_json,
                fencing_epoch,
                holder_principal_id,
                holder_token_hash,
                acquired_at,
                expires_at,
                state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held')
            ON CONFLICT(lease_scope_key) DO UPDATE SET
                tenant_id           = excluded.tenant_id,
                source_scope_json   = excluded.source_scope_json,
                fencing_epoch       = excluded.fencing_epoch,
                holder_principal_id = excluded.holder_principal_id,
                holder_token_hash   = excluded.holder_token_hash,
                acquired_at         = excluded.acquired_at,
                expires_at          = excluded.expires_at,
                state               = 'held'
        `).run(
            leaseScopeKey,
            holder.tenantId,
            sourceScopeJson,
            fencingEpoch,
            holder.principalId,
            hashToken(token),
            now,
            expiresAt
        );

        return {
            acquired           : true,
            acquiredAt         : now,
            calibrationReportId: validatedPolicy.calibrationReportId,
            contention         : false,
            expiresAt,
            fencingEpoch,
            holderPrincipalId  : holder.principalId,
            leaseScopeKey,
            leaseTtlMs         : validatedPolicy.stewardLeaseTtlMs,
            mode               : validatedPolicy.mode,
            normalizedSourceIds,
            notAuthority       : true,
            reclaimed,
            state              : STEWARD_LEASE_STATES.held,
            tenantId           : holder.tenantId,
            token
        }
    });

    return tx.immediate()
}

/**
 * @summary Releases a steward wake lease only when token and fencingEpoch match the active holder.
 * @param {Object} params
 * @returns {Object}
 */
export function releaseStewardWakeLease({
    db,
    fencingEpoch,
    hashToken         = defaultHashToken,
    sourceInstanceIds = null,
    tenantId,
    token
} = {}) {
    ensureStewardWakeLeaseSchema(db);

    const {leaseScopeKey} = buildStewardLeaseScopeKey(tenantId, sourceInstanceIds);

    const tx = db.transaction(() => {
        const row = db.prepare(
            'SELECT * FROM mc_community_steward_lease WHERE lease_scope_key = ? AND tenant_id = ?'
        ).get(leaseScopeKey, tenantId.trim());

        if (!row || row.state !== STEWARD_LEASE_STATES.held) {
            return {leaseScopeKey, released: false, reason: 'not-held'}
        }
        if (Number(row.fencing_epoch) !== Number(fencingEpoch)) {
            return {leaseScopeKey, released: false, reason: 'superseded-epoch'}
        }
        if (typeof token !== 'string' || !token || row.holder_token_hash !== hashToken(token)) {
            return {leaseScopeKey, released: false, reason: 'foreign-token'}
        }

        db.prepare(`
            UPDATE mc_community_steward_lease
            SET state = 'released', holder_token_hash = NULL, expires_at = 0
            WHERE lease_scope_key = ? AND fencing_epoch = ? AND holder_token_hash = ?
        `).run(leaseScopeKey, Number(fencingEpoch), hashToken(token));

        return {
            fencingEpoch: Number(fencingEpoch),
            leaseScopeKey,
            released    : true
        }
    });

    return tx.immediate()
}

/**
 * @summary Asserts that a count-only steward wake payload obeys zero-prose/zero-authority rules and
 * any configured `maxWakePayloadBytes` leaf bound.
 * @param {Object} wakePayload
 * @param {Number|null} [maxWakePayloadBytes]
 * @returns {Number} Serialized UTF-8 byte length.
 */
export function assertCountOnlyWakePayload(
    wakePayload,
    maxWakePayloadBytes = memoryCoreConfig.communityStewardWake.maxWakePayloadBytes
) {
    if (!wakePayload || typeof wakePayload !== 'object') {
        throw new Error('COMMUNITY_STEWARD_WAKE_PAYLOAD_INVALID')
    }
    if (wakePayload.schemaVersion !== COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION || wakePayload.notAuthority !== true) {
        throw new Error('COMMUNITY_STEWARD_WAKE_PAYLOAD_INVALID')
    }

    for (const key of Object.keys(wakePayload)) {
        if (FORBIDDEN_WAKE_PAYLOAD_KEYS.has(key)) {
            throw new Error(`COMMUNITY_STEWARD_WAKE_PROSE_OR_AUTHORITY_FORBIDDEN:${key}`)
        }
    }

    const byteLength = Buffer.byteLength(JSON.stringify(wakePayload), 'utf8');

    if (maxWakePayloadBytes !== null && maxWakePayloadBytes !== undefined) {
        if (!isPositiveSafeInteger(maxWakePayloadBytes)) {
            throw new Error('COMMUNITY_STEWARD_POLICY_INVALID:maxWakePayloadBytes')
        }
        if (byteLength > maxWakePayloadBytes) {
            throw new Error(`COMMUNITY_STEWARD_WAKE_PAYLOAD_TOO_LARGE:${byteLength}>${maxWakePayloadBytes}`)
        }
    }

    return byteLength
}

/**
 * @summary Evaluates a tenant/source count projection in shadow mode (`shouldWake: false`, recording
 * vacancy and would-be coalesced count-only wakes) or live mode (`shouldWake: true` when
 * `stewardActivation` and all threshold leaves are configured).
 * @param {Object} params
 * @returns {Object}
 */
export function evaluateStewardWake({
    attentionCounts,
    db,
    hashToken             = defaultHashToken,
    holderProof           = null,
    now,
    policy                = {},
    sourceInstanceIds     = null,
    tenantId,
    vacancyFallbackTarget = null
} = {}) {
    ensureStewardWakeLeaseSchema(db);

    if (!Number.isFinite(now) || now <= 0) {
        throw new Error('COMMUNITY_STEWARD_CLOCK_REQUIRED')
    }
    if (!attentionCounts || typeof attentionCounts !== 'object' || attentionCounts.notAuthority !== true) {
        throw new Error('COMMUNITY_STEWARD_COUNTS_REQUIRED')
    }

    const validatedPolicy                      = resolveValidatedStewardWakePolicy(policy);
    const isShadowMode                         = validatedPolicy.mode === 'shadow';
    const {leaseScopeKey, normalizedSourceIds} = buildStewardLeaseScopeKey(tenantId, sourceInstanceIds);

    const tx = db.transaction(() => {
        const leaseRow = db.prepare(
            'SELECT * FROM mc_community_steward_lease WHERE lease_scope_key = ? AND tenant_id = ?'
        ).get(leaseScopeKey, tenantId.trim());

        if (holderProof !== null) {
            if (!leaseRow || leaseRow.state !== STEWARD_LEASE_STATES.held) {
                return {
                    leaseScopeKey,
                    mode        : validatedPolicy.mode,
                    notAuthority: true,
                    reason      : 'lease-not-held',
                    shouldWake  : false
                }
            }
            if (Number(leaseRow.fencing_epoch) !== Number(holderProof.fencingEpoch)) {
                return {
                    leaseScopeKey,
                    mode        : validatedPolicy.mode,
                    notAuthority: true,
                    reason      : 'stale-lease-holder',
                    shouldWake  : false
                }
            }
            if (typeof holderProof.token !== 'string' || !holderProof.token ||
                leaseRow.holder_token_hash !== hashToken(holderProof.token)) {
                return {
                    leaseScopeKey,
                    mode        : validatedPolicy.mode,
                    notAuthority: true,
                    reason      : 'foreign-lease-token',
                    shouldWake  : false
                }
            }
            if (Number(leaseRow.expires_at) <= now) {
                return {
                    leaseScopeKey,
                    mode        : validatedPolicy.mode,
                    notAuthority: true,
                    reason      : 'lease-expired',
                    shouldWake  : false
                }
            }
        }

        if (attentionCounts.status !== 'fresh') {
            return {
                coverageStatus: attentionCounts.status,
                leaseScopeKey,
                mode          : validatedPolicy.mode,
                notAuthority  : true,
                reason        : `coverage-${attentionCounts.status}`,
                shouldWake    : false
            }
        }

        const countIsEligible = isPositiveSafeInteger(validatedPolicy.minUnclaimedEligibleCount)
            ? Number.isSafeInteger(attentionCounts.count) && attentionCounts.count >= validatedPolicy.minUnclaimedEligibleCount
            : Number.isSafeInteger(attentionCounts.count) && attentionCounts.count > 0;

        if (!countIsEligible) {
            return {
                count       : attentionCounts.count ?? 0,
                leaseScopeKey,
                mode        : validatedPolicy.mode,
                notAuthority: true,
                reason      : 'below-min-unclaimed-count',
                shouldWake  : false
            }
        }

        const leaseActive = Boolean(
            leaseRow &&
            leaseRow.state === STEWARD_LEASE_STATES.held &&
            Number(leaseRow.expires_at) > now &&
            leaseRow.holder_principal_id
        );
        const stewardVacant = !leaseActive;

        const wakeState = db.prepare(
            'SELECT * FROM mc_community_steward_wake_state WHERE lease_scope_key = ? AND tenant_id = ?'
        ).get(leaseScopeKey, tenantId.trim());

        let routingMode       = 'leased-steward',
            targetPrincipalId = null,
            fencingEpoch      = leaseRow ? Number(leaseRow.fencing_epoch) : 0;

        if (leaseActive) {
            const validatedHolder = validateTenantScopedPrincipal(
                leaseRow.holder_principal_id,
                tenantId.trim(),
                'leased-holder'
            );
            targetPrincipalId = validatedHolder.principalId
        } else {
            if (vacancyFallbackTarget === null || vacancyFallbackTarget === undefined) {
                if (isShadowMode) {
                    const nextVacancyCount = (wakeState ? Number(wakeState.vacancy_count) : 0) + 1;
                    db.prepare(`
                        INSERT INTO mc_community_steward_wake_state (
                            lease_scope_key,
                            tenant_id,
                            vacancy_count,
                            shadow_would_wake_count,
                            max_shadow_payload_bytes
                        ) VALUES (?, ?, ?, 0, 0)
                        ON CONFLICT(lease_scope_key) DO UPDATE SET
                            vacancy_count = excluded.vacancy_count
                    `).run(leaseScopeKey, tenantId.trim(), nextVacancyCount)
                }

                return {
                    leaseScopeKey,
                    mode           : validatedPolicy.mode,
                    notAuthority   : true,
                    reason         : 'steward-vacant-no-fallback-target',
                    shadowWouldWake: false,
                    shouldWake     : false,
                    stewardVacant  : true
                }
            }

            const validatedFallback = validateTenantScopedPrincipal(
                vacancyFallbackTarget,
                tenantId.trim(),
                'vacancy-fallback'
            );
            routingMode       = 'vacancy-fallback';
            targetPrincipalId = validatedFallback.principalId
        }

        if (wakeState && wakeState.last_woken_watermark === attentionCounts.sourceWatermark) {
            return {
                leaseScopeKey,
                mode           : validatedPolicy.mode,
                notAuthority   : true,
                reason         : 'watermark-already-woken',
                routingMode,
                shadowWouldWake: false,
                shouldWake     : false,
                sourceWatermark: attentionCounts.sourceWatermark,
                stewardVacant
            }
        }

        if (routingMode === 'vacancy-fallback' &&
            isPositiveSafeInteger(validatedPolicy.vacancyFallbackCooldownMs) &&
            wakeState &&
            Number.isFinite(Number(wakeState.last_vacancy_wake_at)) &&
            Number(wakeState.last_vacancy_wake_at) > 0) {
            const elapsedVacancyMs = now - Number(wakeState.last_vacancy_wake_at);

            if (elapsedVacancyMs < validatedPolicy.vacancyFallbackCooldownMs) {
                return {
                    leaseScopeKey,
                    mode           : validatedPolicy.mode,
                    notAuthority   : true,
                    reason         : 'vacancy-fallback-cooldown',
                    retryAfterMs   : validatedPolicy.vacancyFallbackCooldownMs - elapsedVacancyMs,
                    routingMode,
                    shadowWouldWake: false,
                    shouldWake     : false,
                    stewardVacant
                }
            }
        }

        const coalesceWindowConfigured = isPositiveSafeInteger(validatedPolicy.wakeCoalesceWindowMs);
        const inCoalesceWindow         = Boolean(
            coalesceWindowConfigured &&
            wakeState &&
            Number.isFinite(Number(wakeState.window_started_at)) &&
            (now - Number(wakeState.window_started_at)) < validatedPolicy.wakeCoalesceWindowMs
        );
        const currentWindowCount = inCoalesceWindow ? Number(wakeState.window_wake_count) : 0;

        if (inCoalesceWindow &&
            isPositiveSafeInteger(validatedPolicy.wakeAmplificationCap) &&
            currentWindowCount >= validatedPolicy.wakeAmplificationCap) {
            return {
                leaseScopeKey,
                mode           : validatedPolicy.mode,
                notAuthority   : true,
                reason         : 'coalesce-window-amplification-cap',
                retryAfterMs   : validatedPolicy.wakeCoalesceWindowMs - (now - Number(wakeState.window_started_at)),
                routingMode,
                shadowWouldWake: false,
                shouldWake     : false,
                stewardVacant
            }
        }

        const wakePayload = {
            calibrationReportId: validatedPolicy.calibrationReportId,
            coalesceWindowMs   : validatedPolicy.wakeCoalesceWindowMs,
            count              : attentionCounts.count,
            coverageStatus     : attentionCounts.status,
            fencingEpoch,
            leaseScopeKey,
            mode               : validatedPolicy.mode,
            notAuthority       : true,
            oldestOccurredAt   : attentionCounts.oldestOccurredAt ?? null,
            routingMode,
            schemaVersion      : COMMUNITY_STEWARD_WAKE_SCHEMA_VERSION,
            sourceCount        : attentionCounts.coverage?.sourceCount ?? 0,
            sourceScopeIds     : normalizedSourceIds,
            sourceWatermark    : attentionCounts.sourceWatermark,
            targetPrincipalId,
            tenantId           : tenantId.trim()
        };

        const payloadBytes            = assertCountOnlyWakePayload(wakePayload, validatedPolicy.maxWakePayloadBytes);
        const nextWindowStart         = inCoalesceWindow ? Number(wakeState.window_started_at) : now;
        const nextWindowCount         = currentWindowCount + 1;
        const nextVacancyWakeAt       = routingMode === 'vacancy-fallback'
            ? now
            : (wakeState ? wakeState.last_vacancy_wake_at : null);
        const nextVacancyCount        = (wakeState ? Number(wakeState.vacancy_count) : 0) + (stewardVacant ? 1 : 0);
        const nextShadowWouldWake     = (wakeState ? Number(wakeState.shadow_would_wake_count) : 0) + (isShadowMode ? 1 : 0);
        const nextMaxShadowBytes      = Math.max(
            wakeState ? Number(wakeState.max_shadow_payload_bytes) : 0,
            isShadowMode ? payloadBytes : 0
        );

        db.prepare(`
            INSERT INTO mc_community_steward_wake_state (
                lease_scope_key,
                tenant_id,
                last_woken_watermark,
                last_wake_at,
                last_vacancy_wake_at,
                window_started_at,
                window_wake_count,
                last_fencing_epoch,
                vacancy_count,
                shadow_would_wake_count,
                max_shadow_payload_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(lease_scope_key) DO UPDATE SET
                last_woken_watermark     = excluded.last_woken_watermark,
                last_wake_at             = excluded.last_wake_at,
                last_vacancy_wake_at     = excluded.last_vacancy_wake_at,
                window_started_at        = excluded.window_started_at,
                window_wake_count        = excluded.window_wake_count,
                last_fencing_epoch       = excluded.last_fencing_epoch,
                vacancy_count            = excluded.vacancy_count,
                shadow_would_wake_count  = excluded.shadow_would_wake_count,
                max_shadow_payload_bytes = excluded.max_shadow_payload_bytes
        `).run(
            leaseScopeKey,
            tenantId.trim(),
            attentionCounts.sourceWatermark,
            now,
            nextVacancyWakeAt,
            nextWindowStart,
            nextWindowCount,
            fencingEpoch,
            nextVacancyCount,
            nextShadowWouldWake,
            nextMaxShadowBytes
        );

        if (isShadowMode) {
            return {
                leaseScopeKey,
                mode           : 'shadow',
                notAuthority   : true,
                payloadBytes,
                reason         : routingMode === 'leased-steward' ? 'shadow-leased-steward-would-wake' : 'shadow-vacancy-would-wake',
                routingMode,
                shadowWouldWake: true,
                shouldWake     : false,
                stewardVacant,
                wakePayload
            }
        }

        return {
            leaseScopeKey,
            mode           : 'live',
            notAuthority   : true,
            payloadBytes,
            reason         : routingMode === 'leased-steward' ? 'leased-steward-wake' : 'vacancy-fallback-wake',
            routingMode,
            shadowWouldWake: false,
            shouldWake     : true,
            stewardVacant,
            wakePayload
        }
    });

    return tx.immediate()
}
