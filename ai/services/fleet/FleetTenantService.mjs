import crypto                from 'node:crypto';
import fs                    from 'node:fs';
import path                  from 'node:path';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';
import {
    InitializeResultSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/sdk/types.js';
import Base                        from 'neo.mjs/src/core/Base.mjs';
import AiConfig                    from '../../config.mjs';
import {resolveFleetCredentialKey} from './FleetRegistryService.mjs';
import {assertSeatSegment}         from './deriveAgentRepoPath.mjs';
import {httpProofVerdict}          from './mcpLaunchAdmission.mjs';
import {
    normalizeAgentIdentity,
    normalizeSecureMcpEndpoint,
    parseMcpEnvelope,
    planeMcpResources,
    readMcpToolPayload
} from './mcpWireParsing.mjs';

// The loopback-http exception, URL-credential rejection, canonical endpoint form and the two
// resource URLs beneath it live in ./mcpWireParsing.mjs — one endpoint-boundary policy shared with
// the plane mailbox client and the seat's plane target.

const
    TENANT_CREDENTIALS     = 'tenant-credentials.enc',
    SEAT_PLANE_CREDENTIALS = 'seat-plane-credentials.enc';

/**
 * @summary The CLOSED public vocabulary for a failed connect.
 *
 * The probe is a collaborator — an injected seam in tests, and in production a function whose
 * `reason` is shaped by whatever the remote tenant returned. Echoing its text to the caller would
 * hand an untrusted party a channel into a public surface. So the outcome is derived from the one
 * field we can bound (the HTTP status) and the collaborator's prose is discarded, not sanitized:
 * an allowlist of our own sentences cannot leak what it never carries.
 * @param {Number} [status] The probe's HTTP status, when it reported one.
 * @param {String} [subject='tenant'] Who refused: a connected tenant, or the plane a seat proves itself on.
 * @returns {String}
 */
function rejectionReasonFor(status, subject = 'tenant') {
    if (status === 401 || status === 403) return `${subject} rejected the credential`;

    return Number.isInteger(status) ? `${subject} MCP readiness failed (${status})` : `${subject} authentication failed`;
}


/**
 * @class Neo.ai.services.fleet.FleetTenantService
 * @extends Neo.core.Base
 * @singleton
 *
 * @summary
 * The Brain-side (Node-only) remote-tenant connection registry — the "connect and go" half of the
 * Fleet Manager's entry story: a design partner points the cockpit at a HOSTED Agent-OS tenant
 * (a tenant URL + its provider bearer) instead of standing up the full local stack.
 *
 * **Two-hemisphere credential boundary (non-negotiable, mirroring `FleetRegistryService`):** the
 * plane bearer is a Node-side secret. It rides IN through {@link #connectTenant}, authenticates the
 * remote transport probe, and is stored reversibly encrypted (AES-256-GCM, `0600`, the same
 * `NEO_FLEET_SECRET_KEY` / generated-keyfile discipline as the agent-credential store) because the
 * remote transport must present the real bearer. It is **never** returned, never included in a
 * public descriptor, and never persists or returns through Body state — every read surface serves
 * the public projection only (`{id, endpoint, status, deploymentClass, connectedAt}`).
 *
 * Stated precisely, because the looser claim ("never transits the browser") is false and worth not
 * believing: the bearer necessarily ARRIVES through the allowlisted Body→Brain connect request. The
 * boundary this class holds is one-way — inbound once, never back out, and never into anything the
 * Body can read.
 *
 * **Fail-closed:** a malformed URL, an unreachable endpoint, or a rejected bearer never persists a
 * descriptor and never throws raw transport errors upward — the caller gets a controlled
 * `{status: 'rejected', reason}` outcome. Connecting records `deploymentClass: 'cloud-tenant'` on
 * the descriptor: the posture marker downstream isolation rules key off.
 *
 * Storage layout (under the same data-dir precedent as the registry):
 * - `tenants.json`             — public descriptors only; safe to render anywhere.
 * - `tenant-credentials.enc`   — the encrypted `{tenantId: providerBearer}` map (AES-256-GCM, `0600`).
 * - `seat-plane-credentials.enc` — each seat's own credential per plane, `{endpoint: {agentId:
 *   {credential, plane}}}`, written only after a probe proves it is the seat's, with the `plane.id` and
 *   `plane.dataRoot` that answered that probe (same encryption and mode).
 */
class FleetTenantService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.FleetTenantService'
         * @protected
         */
        className: 'Neo.ai.services.fleet.FleetTenantService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Optional instance-local data-root override for tenant isolation and tests. `null` resolves
     * through {@link getDataDir} to the canonical `AiConfig.fleet.dataDir` plane member, keeping
     * descriptors, credentials, and shared keys co-located with the registry.
     * @member {String|null} dataDir=null
     */
    dataDir = null
    /**
     * Transport-probe seam:
     * `({endpoint, credential, expectedIdentity?, servedPlane?}) =>
     * Promise<{ok: Boolean, status?: Number, resources?: Object}>`.
     * Defaults (via {@link getProbeFn}) to {@link probeTenantEndpoint} — authenticated MCP
     * initialization against BOTH MC and KB. Any `reason` a stub returns is IGNORED: the public failure vocabulary is
     * derived from `status` alone ({@link rejectionReasonFor}). Inject a stub in tests so no spec
     * ever needs a live tenant or a real provider bearer. Plain field, mirroring
     * `FleetLifecycleService.spawnFn`.
     * @member {Function|null} probeFn=null
     */
    probeFn = null

    /**
     * @summary Connect a remote Agent-OS tenant: validate the URL, authenticate the transport with
     * the provider bearer, persist the descriptor (+ the encrypted credential), and return the
     * PUBLIC result.
     *
     * The returned object never carries the credential — the secret-omission boundary is the same
     * one `defineAgent` enforces for agent credentials. Reconnecting an existing endpoint updates its
     * descriptor + credential in place (re-auth is the point of a reconnect).
     * @param {Object} params
     * @param {String} params.tenantUrl  The hosted tenant's base URL. `https` required; plain `http`
     *     is accepted for loopback development only (the bearer must not cross a network in clear).
     * @param {String} params.credential The selected plane's provider bearer — stored encrypted,
     *     never returned.
     * @returns {Promise<Object>} `{id, endpoint, status: 'connected', deploymentClass,
     *     connectedAt}` on success; `{status: 'rejected', reason}` — reason drawn from a closed
     *     vocabulary — on any validation, auth, or persistence failure.
     */
    async connectTenant({tenantUrl, credential} = {}) {
        const endpoint = this.normalizeEndpoint(tenantUrl);

        if (!endpoint) {
            return {status: 'rejected', reason: 'tenantUrl must be a valid http(s) URL'};
        }

        if (typeof credential !== 'string' || credential.trim() === '') {
            return {status: 'rejected', reason: 'credential (plane provider bearer) is required'};
        }

        let probe;

        try {
            probe = await this.getProbeFn()({endpoint, credential});
        } catch (error) {
            // The probe's own failure text can carry the endpoint's internals — keep the outcome
            // bounded and endpoint-scoped; the secret never appears in any reason string.
            return {status: 'rejected', reason: 'tenant endpoint unreachable'};
        }

        if (!probe?.ok) {
            return {status: 'rejected', reason: rejectionReasonFor(probe?.status)};
        }

        const descriptor = {
            id             : this.tenantIdFor(endpoint),
            endpoint,
            status         : 'connected',
            deploymentClass: 'cloud-tenant',
            connectedAt    : new Date().toISOString()
        };

        // Mutation preflight is tri-state: absent stores are empty; existing unreadable or non-record
        // stores ABORT before either side changes. Treating corruption as `{}` here would turn a
        // connect into destructive recovery authority and silently erase older tenant state.
        let previousCredentials, previousDescriptors;

        try {
            previousCredentials = this.readCredentialsForMutation();
            previousDescriptors = this.readDescriptorsForMutation()
        } catch {
            return {status: 'rejected', reason: 'tenant connection could not be persisted'}
        }

        // Two-store connect transaction, mirroring `FleetRegistryService.defineAgent`: credential
        // FIRST, public descriptor LAST. The descriptor is the surface that claims `connected`, so
        // publishing it before the credential it depends on is what strands a tenant that reads as
        // live and cannot authenticate. Reversed, the worst case is an encrypted credential with no
        // descriptor — invisible, harmless, and overwritten by the next connect.
        let   credentialPublished = false;

        try {
            this.writeCredential(descriptor.id, credential, previousCredentials);
            credentialPublished = true;
            this.writeDescriptor(descriptor, previousDescriptors)
        } catch (error) {
            // The credential write is atomic, so a failure before it returns leaves the old snapshot
            // untouched and needs no compensating write. A descriptor failure happens after the new
            // credential landed, so only that branch restores the pre-connect snapshot. A failed
            // rollback cannot be repaired synchronously here; keep the public outcome bounded.
            if (credentialPublished) {
                try {
                    this.writeCredentials(previousCredentials)
                } catch (rollbackError) {}
            }

            return {status: 'rejected', reason: 'tenant connection could not be persisted'};
        }

        return {...descriptor};
    }

    /**
     * @summary The public tenant descriptors — safe to render on any surface; never a credential.
     * @returns {Object[]}
     */
    listTenants() {
        return Object.values(this.readDescriptors()).map(descriptor => ({
            id             : descriptor.id,
            endpoint       : descriptor.endpoint,
            status         : descriptor.status,
            deploymentClass: descriptor.deploymentClass,
            connectedAt    : descriptor.connectedAt
        }))
    }

    /**
     * @summary Resolve a connected tenant into the fixed, non-secret MC/KB resource descriptor used
     * by workspace generation. Brain-internal: no wire method exposes it. Missing, disconnected, or
     * malformed rows fail closed to `null`.
     * @param {String} tenantId
     * @returns {Object|null} `{tenantId, endpoint, resources}` with no credential.
     */
    resolveMcpResources(tenantId) {
        const
            descriptor = this.readDescriptors()[tenantId],
            endpoint   = this.normalizeEndpoint(descriptor?.endpoint);

        if (!descriptor ||
            descriptor.id !== tenantId ||
            descriptor.status !== 'connected' ||
            !endpoint ||
            endpoint !== descriptor.endpoint) {
            return null
        }

        return {
            tenantId,
            endpoint,
            resources: planeMcpResources(endpoint)
        }
    }

    /**
     * @summary Resolve the selected tenant's encrypted provider bearer for the remote MC/KB child-env
     * slot. Brain-internal only: this method is not wire-allowlisted and returns a value only while
     * the matching public descriptor is still canonical and connected.
     * @param {String} tenantId
     * @returns {String|null}
     */
    resolveMcpCredential(tenantId) {
        if (!this.resolveMcpResources(tenantId)) return null;

        const credential = this.getCredential(tenantId);

        return typeof credential === 'string' && credential.trim() ? credential : null
    }

    /**
     * @summary Authenticate the selected tenant's provider credential against BOTH selected tenant
     * resources before any checkout or config mutation. Repository and plane credentials are
     * intentionally resolved by different services: a GitHub checkout PAT is not remote-plane
     * authority, even when one deployment happens to use GitHub as its identity provider.
     * @param {Object} options
     * @param {String} options.tenantId
     * @param {String} options.credential Plane credential resolved once from this tenant service.
     * @param {String} options.expectedIdentity Canonical seat identity the provider credential must
     *     resolve to. A valid credential for a different provider subject fails closed.
     * @param {AbortSignal} [options.signal] Issuer's overall proof budget.
     * @returns {Promise<Object>} Bounded `{ok,status,verdict,resources}`; never remote prose or a token.
     */
    async probeSeatCredential({tenantId, credential, expectedIdentity, signal}={}) {
        const
            resolved          = this.resolveMcpResources(tenantId),
            canonicalIdentity = normalizeAgentIdentity(expectedIdentity);

        if (!resolved ||
            typeof credential !== 'string' ||
            !credential.trim() ||
            !canonicalIdentity) {
            return {ok: false, verdict: 'refused'}
        }

        try {
            const readiness = await this.getProbeFn()({
                endpoint        : resolved.endpoint,
                credential,
                expectedIdentity: canonicalIdentity,
                signal
            });

            if (readiness?.ok && readiness.resources?.['memory-core']?.identity !== canonicalIdentity) {
                return {...readiness, ok: false, verdict: 'refused'}
            }

            return readiness
        } catch {
            return {ok: false, verdict: 'unanswered'}
        }
    }

    /**
     * @summary Stores one seat's accepted credential for one plane, after proving that it resolves to
     * that seat. For the default plane, Start supplies the PAT already held by the registry; this
     * binding records its plane purpose and proof, not a requirement for another token. Explicit tenant
     * credentials remain in their tenant store and are never substituted with the registry PAT. Nothing
     * persists before the probe proves the identity; the credential is kept encrypted beside the tenant
     * bearers and never returned. The plane that answered the probe is stored with it, and each start
     * must meet that plane again ({@link probeSeatPlaneCredential}). Storing again rebinds the seat to
     * the plane serving now.
     * @param {Object} params
     * @param {String} params.planeBase The plane the credential is for.
     * @param {String} params.agentId Registry agent id.
     * @param {String} params.identity The seat's identity the credential must resolve to.
     * @param {String} params.credential Never returned.
     * @param {Boolean} [params.ifAbsent=false] Retain a valid existing row at the mutation snapshot
     *     instead of replacing it. Used by Start because another writer may finish while proof awaits.
     *     Malformed selected state is refused; the caller must re-read and prove a retained row.
     * @returns {Promise<Object>} `{status: 'stored', endpoint, agentId}`, or `{status: 'rejected',
     *     reason}` with a reason from a closed vocabulary.
     */
    async storeSeatPlaneCredential({planeBase, agentId, identity, credential, ifAbsent=false} = {}) {
        const
            endpoint = this.normalizeEndpoint(planeBase),
            expected = normalizeAgentIdentity(identity);

        if (!endpoint) {
            return {status: 'rejected', reason: 'planeBase must be a valid http(s) URL'}
        }

        try {
            assertSeatSegment(agentId, 'agentId', 'FleetTenantService.storeSeatPlaneCredential')
        } catch {
            return {status: 'rejected', reason: 'a seat id and its identity are required'}
        }

        if (!expected) {
            return {status: 'rejected', reason: 'a seat id and its identity are required'}
        }

        if (typeof credential !== 'string' || credential.trim() === '') {
            return {status: 'rejected', reason: 'credential (the seat\'s own plane credential) is required'}
        }

        const proof = await this.proveSeatOnPlane({endpoint, credential, identity: expected});

        if (!proof.ok) {
            return {status: 'rejected', reason: proof.reason}
        }

        try {
            const
                record   = this.readSeatPlaneCredentialsForMutation(),
                existing = record[endpoint];

            if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
                throw new TypeError('FleetTenantService: the selected plane credential record is malformed.')
            }

            // Start's first binding is create-only: a manual setter or another Start may have written
            // this seat while the proof above was awaiting. Retain that row so the caller can re-read
            // and prove it; explicit set/rebind calls keep the default replacement behavior.
            if (ifAbsent === true && existing && Object.hasOwn(existing, agentId)) {
                const selected = existing[agentId];

                if (!selected || typeof selected !== 'object' || Array.isArray(selected) ||
                    typeof selected.credential !== 'string' || !selected.credential.trim() ||
                    typeof selected.plane?.id !== 'string' || !selected.plane.id.trim() ||
                    typeof selected.plane.dataRoot !== 'string' || !selected.plane.dataRoot.trim()) {
                    return {status: 'rejected', reason: 'seat plane credential could not be persisted'}
                }

                return {status: 'stored', endpoint, agentId}
            }

            record[endpoint] = {...existing, [agentId]: {credential, plane: proof.plane}};
            this.publishAtomically(path.join(this.getDataDir(), SEAT_PLANE_CREDENTIALS), this.encrypt(JSON.stringify(record)))
        } catch {
            return {status: 'rejected', reason: 'seat plane credential could not be persisted'}
        }

        return {status: 'stored', endpoint, agentId}
    }

    /**
     * @summary The stored plane credential of one seat and the plane it was proven on, for the
     * Node-side start that presents it. Brain-internal only: this method is NOT on any wire allowlist
     * and must never be added to one.
     * @param {Object} params
     * @param {String} params.planeBase
     * @param {String} params.agentId
     * @returns {Object|null} `{credential, plane: {id, dataRoot}}`; `null` for an unknown plane or seat,
     *     or an unreadable store.
     */
    resolveSeatPlaneCredential({planeBase, agentId} = {}) {
        const endpoint = this.normalizeEndpoint(planeBase);

        if (!endpoint) return null;

        let record;

        try {
            record = this.readSeatPlaneCredentialsForMutation()
        } catch {
            return null
        }

        const {credential, plane} = record[endpoint]?.[agentId] ?? {};

        return typeof credential === 'string' && credential.trim() && plane?.id
            ? {credential, plane: {id: plane.id, dataRoot: plane.dataRoot}}
            : null
    }

    /**
     * @summary Proves a stored seat credential again before a start: it must still resolve to the
     * seat, on the plane it was stored against. An endpoint is only where a plane is reached. A plane
     * recreated behind the same URL serves another `plane.id`, or the same id over other storage, and a
     * credential proven on the old one does not carry over to it.
     * @param {Object} params
     * @param {String} params.planeBase
     * @param {String} params.credential From {@link resolveSeatPlaneCredential}.
     * @param {String} params.expectedIdentity The seat's identity.
     * @param {Object} params.expectedPlane `{id, dataRoot}` stored with the credential.
     * @param {AbortSignal} [params.signal] Issuer's overall proof budget.
     * @returns {Promise<Object>} `{ok,verdict,reason?}`. The machine verdict survives unavailable transport;
     *     the reason is producer-owned display text, never a classification input.
     */
    async probeSeatPlaneCredential({planeBase, credential, expectedIdentity, expectedPlane, signal} = {}) {
        const
            endpoint = this.normalizeEndpoint(planeBase),
            identity = normalizeAgentIdentity(expectedIdentity);

        if (!endpoint || !identity || typeof credential !== 'string' || !credential.trim() || !expectedPlane?.id) {
            return {ok: false, verdict: 'refused', reason: 'the seat holds no proven plane credential'}
        }

        const proof = await this.proveSeatOnPlane({endpoint, credential, identity, signal});

        if (!proof.ok) return proof;

        if (proof.plane.id !== expectedPlane.id || proof.plane.dataRoot !== expectedPlane.dataRoot) {
            return {ok: false, verdict: 'refused', reason: 'the plane at this endpoint is not the one the credential was stored for'}
        }

        return {ok: true, verdict: 'proved'}
    }

    /**
     * @summary Proves on the plane at `endpoint` that `credential` resolves to the seat, and reads which
     * plane answered. Memory Core and Knowledge Base must name the same plane: one router can front
     * another plane's server.
     * @param {Object} params
     * @param {String} params.endpoint Canonical plane endpoint.
     * @param {String} params.credential
     * @param {String} params.identity Canonical `@login`.
     * @param {AbortSignal} [params.signal] Issuer's overall proof budget.
     * @returns {Promise<Object>} `{ok,verdict,plane?,reason?}` with bounded producer-owned diagnostics.
     * @protected
     */
    async proveSeatOnPlane({endpoint, credential, identity, signal}) {
        let probe;

        try {
            probe = await this.getProbeFn()({endpoint, credential, expectedIdentity: identity, servedPlane: true, signal})
        } catch {
            return {ok: false, verdict: 'unanswered', reason: 'plane endpoint unreachable'}
        }

        const
            mc = probe?.resources?.['memory-core'],
            kb = probe?.resources?.['knowledge-base'];

        if (mc?.anotherIdentity || (probe?.ok && mc?.identity !== identity)) {
            return {ok: false, verdict: 'refused', reason: 'the credential resolves to another identity'}
        }

        if (!probe?.ok) {
            const reason = probe?.verdict === 'unanswered' && !Number.isInteger(probe.status)
                ? 'plane endpoint unreachable' : rejectionReasonFor(probe?.status, 'plane');
            return {ok: false, verdict: probe?.verdict ?? 'refused', reason}
        }

        if (!mc.plane?.id || !kb?.plane?.id) {
            return {ok: false, verdict: 'refused', reason: 'the plane did not identify itself'}
        }

        if (mc.plane.id !== kb.plane.id || mc.plane.dataRoot !== kb.plane.dataRoot) {
            return {ok: false, verdict: 'refused', reason: 'the Memory Core and Knowledge Base at this endpoint belong to different planes'}
        }

        return {ok: true, verdict: 'proved', plane: {id: mc.plane.id, dataRoot: mc.plane.dataRoot}}
    }

    /**
     * @summary Resolve one tenant's stored provider bearer for the Node-side transport that presents it.
     * Brain-internal only: this method is NOT on any wire allowlist and must never be added to one.
     * @param {String} tenantId
     * @returns {String|null}
     * @protected
     */
    getCredential(tenantId) {
        const map = this.readCredentials();

        return map[tenantId] ?? null;
    }

    /**
     * @summary Normalizes + validates the tenant URL: http/https only, no credentials-in-URL, and a
     * canonical origin+path form (no trailing slash) so one endpoint maps to one tenant id.
     * @param {*} tenantUrl
     * @returns {String|null}
     * @protected
     */
    normalizeEndpoint(tenantUrl) {
        // The provider bearer rides to this endpoint as a header (see `probeTenantEndpoint`), so the
        // endpoint's scheme decides whether the credential crosses the wire in cleartext — the shared
        // boundary policy enforces TLS-off-loopback and rejects URL-embedded secrets outright.
        return normalizeSecureMcpEndpoint(tenantUrl);
    }

    /**
     * @summary Stable tenant id from the endpoint: host plus a short endpoint digest — readable in
     * a roster row, collision-safe across paths on one host.
     * @param {String} endpoint
     * @returns {String}
     * @protected
     */
    tenantIdFor(endpoint) {
        const digest = crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 8);

        return `${new URL(endpoint).host}-${digest}`;
    }

    // ---- storage (public descriptors + encrypted credentials) ---------------

    /**
     * @summary Resolve the Fleet-owned durable root from the explicit instance/test override or
     * the canonical `AiConfig.fleet.dataDir` plane member. Both Fleet storage owners therefore
     * consume the same config coordinate without env re-derivation or service-local defaults.
     * @returns {String}
     * @protected
     */
    getDataDir() {
        return this.dataDir || AiConfig.fleet.dataDir;
    }

    /**
     * @returns {Function} the transport probe (injected stub or {@link probeTenantEndpoint}).
     * @protected
     */
    getProbeFn() {
        return this.probeFn || probeTenantEndpoint;
    }

    /**
     * @returns {Object} `{tenantId: descriptor}` from `tenants.json`; `{}` when absent/corrupt (fail-closed read).
     * @protected
     */
    readDescriptors() {
        try {
            return this.readDescriptorsForMutation()
        } catch {
            return {};
        }
    }

    /**
     * @summary Strict mutation snapshot for `tenants.json`: missing is an empty record; an existing
     * unreadable, null, scalar, or array payload throws so a connect cannot overwrite it.
     * @returns {Object} Null-prototype descriptor record.
     * @protected
     */
    readDescriptorsForMutation() {
        const file = path.join(this.getDataDir(), 'tenants.json');
        let   source;

        try {
            source = fs.readFileSync(file, 'utf8')
        } catch (error) {
            if (error?.code === 'ENOENT') return Object.create(null);

            throw error
        }

        const parsed = JSON.parse(source);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError('FleetTenantService: tenants.json must contain a descriptor record.')
        }

        return Object.assign(Object.create(null), parsed)
    }

    /**
     * @summary Upserts one public descriptor, published atomically; `0600` like every fleet store file.
     * @param {Object} descriptor
     * @param {Object} [snapshot] Strict preflight snapshot.
     * @protected
     */
    writeDescriptor(descriptor, snapshot=this.readDescriptorsForMutation()) {
        const map = Object.assign(Object.create(null), snapshot);

        map[descriptor.id] = descriptor;

        this.publishAtomically(
            path.join(this.getDataDir(), 'tenants.json'),
            JSON.stringify(map, null, 4)
        );
    }

    /**
     * @summary Write-then-rename, the `FleetRegistryService.writeRegistry` precedent.
     *
     * `writeFileSync` onto a live path truncates before it writes: a crash mid-write leaves a
     * half-file that the fail-closed readers here would silently parse as an EMPTY store — every
     * tenant descriptor or credential gone, indistinguishable from a fresh install. A rename is
     * atomic on POSIX, so a reader sees either the whole prior file or the whole new one.
     * @param {String} file
     * @param {String|Buffer} contents
     * @protected
     */
    publishAtomically(file, contents) {
        // This site was already correct — pid+UUID scratch, 0o600, cleanup on throw. It is one of the
        // two exemplars the owned primitive was modelled on; the call replaces the copy, not the care.
        writeFileAtomicSync(file, contents)
    }

    /**
     * @returns {Object} the decrypted `{tenantId: providerBearer}` map; `{}` when absent/locked/corrupt — the
     * fail-closed read discipline of the agent-credential store.
     * @protected
     */
    readCredentials() {
        try {
            return this.readCredentialsForMutation()
        } catch {
            return {};
        }
    }

    /**
     * @summary Strict mutation snapshot for the encrypted credential record.
     * @returns {Object} Null-prototype credential record.
     * @protected
     */
    readCredentialsForMutation() {
        return this.readEncryptedRecord(TENANT_CREDENTIALS)
    }

    /**
     * @summary Strict mutation snapshot of the seat plane credentials, `{endpoint: {agentId: credential}}`.
     * @returns {Object} Null-prototype record.
     * @protected
     */
    readSeatPlaneCredentialsForMutation() {
        return this.readEncryptedRecord(SEAT_PLANE_CREDENTIALS)
    }

    /**
     * @summary Strict snapshot of one encrypted record under the data dir. Missing is empty; existing
     * unreadable/wrong-key/non-record ciphertext throws and must remain byte-identical.
     * @param {String} filename
     * @returns {Object} Null-prototype record.
     * @protected
     */
    readEncryptedRecord(filename) {
        let raw;

        try {
            raw = fs.readFileSync(path.join(this.getDataDir(), filename))
        } catch (error) {
            if (error?.code === 'ENOENT') return Object.create(null);

            throw error
        }

        const parsed = JSON.parse(this.decrypt(raw));

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new TypeError(`FleetTenantService: ${filename} must contain a credential record.`)
        }

        return Object.assign(Object.create(null), parsed)
    }

    /**
     * @summary Upserts one encrypted credential; the map is re-encrypted whole (AES-256-GCM, `0600`).
     * @param {String} tenantId
     * @param {String} credential
     * @param {Object} [snapshot] Strict preflight snapshot.
     * @protected
     */
    writeCredential(tenantId, credential, snapshot=this.readCredentialsForMutation()) {
        const map = Object.assign(Object.create(null), snapshot);

        map[tenantId] = credential;

        this.writeCredentials(map);
    }

    /**
     * @summary Encrypt + atomically publish the WHOLE credential map — the rollback seam.
     *
     * Separate from {@link writeCredential} because a rollback must restore a prior snapshot
     * wholesale, not upsert one entry: re-adding the key we just wrote is not the inverse of
     * writing it.
     * @param {Object} map `{tenantId: providerBearer}`
     * @protected
     */
    writeCredentials(map) {
        this.publishAtomically(
            path.join(this.getDataDir(), TENANT_CREDENTIALS),
            this.encrypt(JSON.stringify(map))
        );
    }

    // ---- crypto (AES-256-GCM, the FleetRegistryService discipline) ----------

    /**
     * @param {String} plaintext
     * @returns {Buffer} `iv(12) | authTag(16) | ciphertext`
     * @protected
     */
    encrypt(plaintext) {
        const iv     = crypto.randomBytes(12),
              cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv),
              enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

        return Buffer.concat([iv, cipher.getAuthTag(), enc]);
    }

    /**
     * @param {Buffer} payload `iv(12) | authTag(16) | ciphertext`
     * @returns {String}
     * @protected
     */
    decrypt(payload) {
        const iv       = payload.subarray(0, 12),
              tag      = payload.subarray(12, 28),
              data     = payload.subarray(28),
              decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), iv);

        decipher.setAuthTag(tag);

        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }

    /**
     * @summary Resolve the 32-byte AES key: `NEO_FLEET_SECRET_KEY` (hex or base64) if set, else the
     * generated `fleet.key` dev file — the SAME key source as the agent-credential store, so one
     * operator secret governs both reversible credential classes.
     * @returns {Buffer}
     * @protected
     */
    getKey() {
        return resolveFleetCredentialKey({
            dataDir    : this.getDataDir(),
            serviceName: 'FleetTenantService'
        })
    }
}

// normalizeAgentIdentity / parseMcpEnvelope / readMcpToolPayload live in ./mcpWireParsing.mjs —
// the fleet subsystem's one MCP-wire parsing authority, shared with planeMailboxClient.

/**
 * @summary Call one MCP tool inside an initialized session and preserve the transport verdict.
 * @param {Object} options
 * @param {String} options.url
 * @param {String} options.credential
 * @param {String} options.sessionId
 * @param {String} options.protocolVersion Negotiated initialize response version.
 * @param {Number} options.id JSON-RPC request id.
 * @param {String} options.name Tool name.
 * @param {Object} [options.args={}] Tool arguments.
 * @param {AbortSignal} [options.signal] Overall proof budget.
 * @returns {Promise<Object>} `{ok, status, verdict, payload}`; the payload is structured JSON or `null`.
 * @private
 */
async function callMcpTool({url, credential, sessionId, protocolVersion, id, name, args = {}, signal}) {
    const response = await fetch(url, {
        method : 'POST',
        headers: {
            Accept                : 'application/json, text/event-stream',
            Authorization         : `Bearer ${credential}`,
            'Content-Type'        : 'application/json',
            'mcp-protocol-version': protocolVersion,
            'mcp-session-id'      : sessionId
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method : 'tools/call',
            params : {name, arguments: args}
        }),
        signal: probeSignal(signal)
    });

    return {
        ok     : response.ok,
        status : response.status,
        verdict: httpProofVerdict(response.ok, response.status),
        payload: readMcpToolPayload(parseMcpEnvelope(await response.text()))
    }
}

/**
 * @summary Ask Memory Core for the request-bound caller identity inside the initialized session.
 * `list_permissions` is read-only, health-exempt, defaults to the bound caller, and returns the
 * canonical identity it actually used. A valid bearer for the wrong provider subject therefore
 * cannot pass this gate.
 * @param {Object} options
 * @param {String} options.url
 * @param {String} options.credential
 * @param {String} options.sessionId
 * @param {String} options.protocolVersion Negotiated initialize response version.
 * @param {String} options.expectedIdentity
 * @param {AbortSignal} [options.signal] Overall proof budget.
 * @returns {Promise<Object>} Bounded `{ok,status,identity}`, plus `anotherIdentity: true` when the
 *     server named a valid identity that is not the expected one. The other identity is never carried.
 * @private
 */
async function probeMcpIdentity({url, credential, sessionId, protocolVersion, expectedIdentity, signal}) {
    const {ok, status, payload, verdict} = await callMcpTool({url, credential, sessionId, protocolVersion, id: 2, name: 'list_permissions', signal});

    const
        identity = normalizeAgentIdentity(payload?.identity),
        matches  = ok && identity === expectedIdentity;

    return {
        ok      : matches,
        status,
        verdict : ok ? matches ? 'proved' : 'refused' : verdict,
        identity: matches ? expectedIdentity : null,
        ...(ok && identity && !matches ? {anotherIdentity: true} : {})
    }
}

/**
 * @summary Ask which plane serves this authenticated session, without a full health probe. An older server
 * may ignore the scope and return full health; only its bounded identity block is consumed. Missing identity
 * remains distinct from an unanswered transport, so the caller retains the refusal/retry decision.
 * @param {Object} options
 * @param {String} options.url
 * @param {String} options.credential
 * @param {String} options.sessionId
 * @param {String} options.protocolVersion Negotiated initialize response version.
 * @param {AbortSignal} [options.signal] Overall proof budget.
 * @returns {Promise<Object>} `{ok, status?, verdict, plane}`; plane is `{id,dataRoot}` or null.
 * @private
 */
async function readServedPlane({url, credential, sessionId, protocolVersion, signal}) {
    const bounded = value => typeof value === 'string' && value.trim() !== '' && value.length <= 1024;

    try {
        const {ok, status, payload, verdict} = await callMcpTool({url, credential, sessionId, protocolVersion, id: 3, name: 'healthcheck', args: {scope: 'plane'}, signal});
        const plane                          = payload?.plane;

        return {ok, status, verdict, plane: ok && bounded(plane?.id) && bounded(plane?.dataRoot) ? {id: plane.id, dataRoot: plane.dataRoot} : null}
    } catch {
        return {ok: false, verdict: 'unanswered', plane: null}
    }
}

/**
 * @summary Complete the MCP initialize handshake with the negotiated version before any tool call.
 * A server may accept `initialize` yet correctly reject calls until this notification arrives.
 * @param {Object} options
 * @param {String} options.url
 * @param {String} options.credential
 * @param {String|null} options.sessionId
 * @param {String} options.protocolVersion Negotiated initialize response version.
 * @param {AbortSignal} [options.signal] Overall proof budget.
 * @returns {Promise<Object>} Bounded `{ok,status,verdict}`.
 * @private
 */
async function notifyMcpInitialized({url, credential, sessionId, protocolVersion, signal}) {
    const headers = {
        Accept                : 'application/json, text/event-stream',
        Authorization         : `Bearer ${credential}`,
        'Content-Type'        : 'application/json',
        'mcp-protocol-version': protocolVersion
    };

    if (sessionId) headers['mcp-session-id'] = sessionId;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body  : JSON.stringify({
            jsonrpc: '2.0',
            method : 'notifications/initialized'
        }),
        signal: probeSignal(signal)
    });

    await response.text();

    return {ok: response.ok, status: response.status, verdict: httpProofVerdict(response.ok, response.status)}
}

/**
 * @summary Probe one MCP resource with the protocol's authenticated `initialize` request. A plain
 * health endpoint can stay green while auth or one plane is broken, so readiness is established at
 * the same route and protocol the generated seat will consume.
 * @param {Object} options
 * @param {String} options.url
 * @param {String} options.credential
 * @param {String|null} [options.expectedIdentity] Memory Core caller identity to prove.
 * @param {Boolean} [options.servedPlane=false] Also read which plane serves the resource.
 * @param {AbortSignal} [options.signal] Overall proof budget.
 * @returns {Promise<Object>} `{ok,status,verdict,identity?,anotherIdentity?,plane?}` with no remote prose.
 */
async function initializeMcpResource({url, credential, expectedIdentity=null, servedPlane=false, signal}) {
    const requestedProtocolVersion = '2024-11-05';
    const headers                  = {
        Accept        : 'application/json, text/event-stream',
        Authorization : `Bearer ${credential}`,
        'Content-Type': 'application/json'
    };
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body  : JSON.stringify({
            jsonrpc: '2.0',
            id     : 1,
            method : 'initialize',
            params : {
                protocolVersion: requestedProtocolVersion,
                capabilities   : {},
                clientInfo     : {name: 'neo-fleet-readiness', version: '1'}
            }
        }),
        signal: probeSignal(signal)
    });

    const sessionId = response.headers.get('mcp-session-id');
    let   protocolVersion;

    try {
        // Consume + validate the exact InitializeResult shape so a mismatched JSON-RPC response,
        // reverse-proxy payload, or arbitrary canned result cannot masquerade as MCP readiness.
        // The remote text never crosses into a public reason.
        const
            envelope     = parseMcpEnvelope(await response.text()),
            parsedResult = InitializeResultSchema.safeParse(envelope?.result),
            result       = parsedResult.success ? parsedResult.data : null;

        protocolVersion = result?.protocolVersion;

        const initialized = response.ok &&
            envelope?.jsonrpc === '2.0' &&
            envelope?.id === 1 &&
            result &&
            SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion);

        let observation = {ok: !!initialized, status: response.status, verdict: httpProofVerdict(!!initialized, response.status)};

        if (observation.ok) {
            const notification = await notifyMcpInitialized({
                url,
                credential,
                sessionId,
                protocolVersion,
                signal
            });

            observation = {
                ok     : notification.ok,
                status : notification.ok ? response.status : notification.status,
                verdict: notification.verdict
            }
        }

        if (observation.ok && expectedIdentity) {
            observation = sessionId
                ? await probeMcpIdentity({url, credential, sessionId, protocolVersion, expectedIdentity, signal})
                : {ok: false, status: response.status, verdict: 'refused', identity: null}
        }

        if (observation.ok && servedPlane) {
            const planeRead = sessionId ? await readServedPlane({url, credential, sessionId, protocolVersion, signal}) : {plane: null};
            observation = {...observation, ...planeRead}
        }

        return observation
    } finally {
        if (sessionId) {
            try {
                const closeResponse = await fetch(url, {
                    method : 'DELETE',
                    headers: {
                        ...headers,
                        'mcp-protocol-version': protocolVersion || requestedProtocolVersion,
                        'mcp-session-id'      : sessionId
                    },
                    signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(2_000)]) : AbortSignal.timeout(2_000)
                });

                await closeResponse.text()
            } catch {
                // Readiness failed or was already established. Cleanup remains bounded best effort.
            }
        }
    }
}

/**
 * @summary The default tenant probe: authenticate and initialize BOTH fixed MC and KB MCP routes in
 * parallel. Both must be ready; the aggregate exposes per-plane bounded observations for capture
 * evidence while never carrying response text.
 *
 * Reports `{ok, status, resources}` and deliberately NO prose. The caller owns the public failure vocabulary
 * ({@link rejectionReasonFor}) because a probe's text is shaped by the remote tenant; a `reason`
 * field here would be an open invitation for the next author to forward it, which is the boundary
 * this split exists to close.
 * @param {Object} options
 * @param {String} options.endpoint   Normalized tenant base URL (TLS, or loopback for development).
 * @param {String} options.credential The tenant bearer (used for the probe only; never logged).
 * @param {String|null} [options.expectedIdentity] Canonical seat identity to verify through MC.
 * @param {Boolean} [options.servedPlane=false] Also read the plane each ready resource names; it
 *     never treats dependency health as identity proof.
 * @param {AbortSignal} [options.signal] Overall proof budget; every request also obeys its configured ceiling.
 * @returns {Promise<Object>} `{ok, status, verdict, resources}`. A refused resource outranks an unanswered one.
 */
export async function probeTenantEndpoint({endpoint, credential, expectedIdentity=null, servedPlane=false, signal}) {
    const resources = planeMcpResources(endpoint);
    const entries   = await Promise.all(Object.entries(resources).map(async ([key, {url}]) => {
        try {
            return [key, await initializeMcpResource({
                url,
                credential,
                expectedIdentity: key === 'memory-core' ? expectedIdentity : null,
                servedPlane,
                signal
            })]
        } catch {
            return [key, {ok: false, verdict: 'unanswered'}]
        }
    }));
    const observations = Object.fromEntries(entries);
    const failed       = entries.find(([, observation]) => observation.verdict === 'refused')?.[1]
        ?? entries.find(([, observation]) => !observation.ok)?.[1];

    return {
        ok       : !failed,
        status   : failed ? failed.status : 200,
        verdict  : failed?.verdict ?? 'proved',
        resources: observations
    };
}

/**
 * @summary A request may use the configured probe timeout only within its caller's proof budget.
 * @param {AbortSignal} [signal] Issuer proof deadline/cancellation; absent for ordinary readiness callers.
 * @returns {AbortSignal}
 */
function probeSignal(signal) {
    const timeout = AbortSignal.timeout(AiConfig.fleet.tenantProbeTimeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export default Neo.setupClass(FleetTenantService);
