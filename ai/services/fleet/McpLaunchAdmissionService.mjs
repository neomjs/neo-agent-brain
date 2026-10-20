import crypto              from 'node:crypto';
import http                from 'node:http';
import path                from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import Base                from 'neo.mjs/src/core/Base.mjs';
import {
    LAUNCH_ADMISSION_OUTCOMES as OUTCOMES,
    LAUNCH_ADMISSION_REASONS  as REASONS,
    LAUNCH_ADMISSION_REFUSALS as REFUSALS,
    LAUNCH_ADMISSION_STATES   as STATES,
    isLaunchAdmissionProofReason
}                                 from '../../../src/fleet/contract/launchAdmission.mjs';
import {MCP_SERVERS, mcpCatalogFor, resolveMcpMatrix}                                        from '../../../src/fleet/contract/mcpServers.mjs';
import {launchRowEnvNames}                                                                   from './managedAgentWorkspacePlan.mjs';
import {isAdmissionSnapshot, openLaunchAdmissionJournal, RUNTIME_REFERENCE_SNAPSHOT_VERSION} from './launchAdmissionJournal.mjs';
import {runtimeGenerationPin}                                                                from './runtimeGeneration.mjs';
import {assertRuntimeGenerationReferences}                                                   from './runtimeGenerationLease.mjs';
import {isLaunchCredentialBinding, isResidentMcpBinding}                                     from './launchCredentialOwners.mjs';
import {
    LAUNCH_ADMISSION_MAX_BYTES,
    LAUNCH_ADMISSION_PATH,
    canonicalJson,
    isAdmissibleEnvName,
    isLaunchIdentity,
    launchRefusal,
    mintLaunchGrant,
    parseLaunchCapability,
    parseLaunchRequest,
    signLaunchResponse,
    verifyLaunchRequest
}                                 from './mcpLaunchAdmission.mjs';

// What a tenant row's launcher starts: the stdio bridge to the row's remote URL.
const BRIDGE_ENTRYPOINT = 'ai/mcp/client/stdioToStreamableHttp.mjs';

/**
 * @class Neo.ai.services.fleet.McpLaunchAdmissionService
 * @extends Neo.core.Base
 * @singleton
 *
 * @summary The issuer of native MCP launch admission: the Fleet side of the profile rows that let a Claude
 * Desktop seat start its Neo MCP servers in every folder. Its grants are their own credential class, never
 * a PAT, plane bearer, process bearer or Bridge token, and no Fleet wire method reaches them.
 *
 * Desktop starts each MCP child itself, with a stripped environment, so it cannot inherit what Start
 * resolved. Each owned profile row therefore runs Fleet's fixed launcher with a grant for that one server.
 * The launcher redeems the grant over a loopback hop this service owns
 * ({@link Neo.ai.services.fleet.mcpLaunchAdmission}) and receives exactly the values that server needs.
 *
 * **Generation.** One managed Start of one seat. {@link reserve} mints a grant for every enabled server
 * before preparation writes the rows, and publishes the generation at once, so every revocation from then
 * on reaches it. {@link activate} binds the grants after the seat is launched and leased: to the launched
 * process, to the owners of the seat's credentials and to the other values Start injected. Redemptions
 * repeat, concurrently and later, for as long as the generation is active. A redemption that arrives while
 * Start is still running waits for it, up to {@link pendingTimeoutMs}.
 *
 * **Revocation is sticky.** Stop intent, a failed Start or lease, the process's exit and a newer Start
 * end the generation. The registry's `definitionChange` ends it when the seat's harness, MCP target, launch
 * owner or launch override changes, and ends one server's grant when that server is switched off.
 * Nothing re-enables a grant: a server switched back on waits for a managed restart. A successor restores
 * only the positively proved original Start after a consumed clean handoff; every other survivor is stale.
 * During quit, {@link handoff} bounds survivor validation, proof drain and endpoint release under the
 * remaining `deadlineMs` passed by `cleanShutdown` (falling back to {@link proofTimeoutMs} when omitted),
 * while individual credential proofs continue to obey {@link proofTimeoutMs}.
 *
 * **Custody.** A seat credential stays with its owner: the registry holds the PAT; the explicit tenant
 * or the plane binding holds the plane credential. Each redemption resolves it from the owner Start
 * selected, proves that value, and hands over exactly the proved bytes. A missing or unproved value
 * refuses the child and never falls back to another credential class, so a changed registry PAT never
 * stands in for a plane credential. Packaged generations renew Bridge tokens under the original signer
 * and read resident inputs from their original config owners. Unclassified Start-held values cannot be
 * recovered. No new credential is persisted.
 *
 * **Audit.** Each redemption whose proof holds is recorded against its seat, server and generation. A
 * request that proves nothing is recorded without attribution, whatever it claims.
 */
class McpLaunchAdmissionService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.McpLaunchAdmissionService'
         * @protected
         */
        className: 'Neo.ai.services.fleet.McpLaunchAdmissionService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    // Plain fields: settings, seams and internal state, none of them change-propagating.

    /**
     * How long a redemption waits for the Start that reserved its grant to settle.
     * @member {Number} pendingTimeoutMs=30000
     */
    pendingTimeoutMs = 30000

    /**
     * How long a credential proof may take before it is unanswered, and the default bound for
     * {@link performHandoff} when no `deadlineMs` is supplied. Its AbortSignal caps each request's
     * AiConfig.fleet.tenantProbeTimeoutMs; that per-request ceiling cannot extend this overall proof budget.
     * With {@link pendingTimeoutMs}, it stays inside the launcher's per-attempt bound.
     * @member {Number} proofTimeoutMs=10000
     */
    proofTimeoutMs = 10000

    /**
     * How many redemptions each seat's audit, and the unattributed audit, keep.
     * @member {Number} auditLimit=20
     */
    auditLimit = 20

    /**
     * The newest generation per agent id.
     * @member {Map<String, Object>} generations
     * @private
     */
    generations = new Map()

    /**
     * Every grant of a current generation, by grant id: `{generation, key}`.
     * @member {Map<String, Object>} grants
     * @private
     */
    grants = new Map()

    /**
     * Per agent id, the non-Stop seat-wide revocations asked for, whether or not a generation existed to take them:
     * `{count, reason}` of the last one. A Start reads the count as it begins ({@link revocationMark}); Stop
     * cancellation is carried by that Start's AbortSignal instead.
     * @member {Map<String, Object>} revocations
     * @private
     */
    revocations = new Map()

    /**
     * Refusals of requests that proved no grant.
     * @member {Object[]} unattributed
     * @private
     */
    unattributed = []

    /**
     * Registries whose `definitionChange` this service follows.
     * @member {WeakSet<Object>} observedRegistries
     * @private
     */
    observedRegistries = new WeakSet()

    /**
     * The loopback listener, once {@link listen} started it.
     * @member {http.Server|null} httpServer=null
     * @private
     */
    httpServer = null

    /**
     * Resolves to the listener's origin.
     * @member {Promise<String>|null} listening=null
     * @private
     */
    listening = null

    /** @member {Object|null} journal Durable custody, attached by the lifecycle before managed Starts. @private */
    journal = null

    /** @member {Boolean} journalFailed A failed transition permanently freezes this issuer. @private */
    journalFailed = false

    /** @member {String|null} issuerOrigin The origin actually bound by this issuer. @private */
    issuerOrigin = null

    /**
     * @member {String} continuityPhase Boot recovery excludes new Starts until its evidence is settled
     * (`'pending-recovery'` before {@link recover} begins, `'recovering'` while it runs, `'ready'` once settled,
     * `'draining'` / `'handed-off'` during clean succession, or `'unavailable'` on failure/unclean close).
     * @private
     */
    continuityPhase = 'ready'

    /**
     * @member {Object|null} continuityRecord What boot recovery found: the previous issuer's exit
     * (`previousReason`: `null` after a proved handoff, else `unclean-issuer-exit` or `handoff-replayed`),
     * whether its handoff was proved, its origin, and each retained generation's disposition with the
     * check that kept it stale. `null` until {@link recover} has run.
     */
    continuityRecord = null

    /** @member {Promise|null} handoffPromise One terminal handoff attempt per issuer. @private */
    handoffPromise = null

    /** @member {Function|null} readSeatStarts Projection supplied by the existing lifecycle owner. @private */
    readSeatStarts = null

    /**
     * @summary Attaches exclusive durable custody before this issuer has minted any generations.
     * Previous records are evidence only; the lifecycle must separately validate clean succession.
     * @param {Object} options Explicit custody directory and injectable filesystem/durable primitives.
     * @param {Function} [options.readSeatStarts] Existing lifecycle's closed Start/retention projection.
     * @param {Boolean} [options.awaitRecovery=false] Fence Starts in `'pending-recovery'` until {@link recover} runs.
     * @returns {Object|null} Previous snapshot with its clean-handoff disposition.
     */
    openJournal({readSeatStarts = () => [], awaitRecovery = false, ...options}) {
        if (this.journal || this.generations.size) throw new Error('Launch admission custody must be attached before Start.');
        if (typeof readSeatStarts !== 'function') throw new TypeError('Seat Start projection must be a function.');
        this.readSeatStarts = readSeatStarts;
        this.journal = openLaunchAdmissionJournal({
            ...options, validateSnapshot: isAdmissionSnapshot, emptySnapshot: {version: RUNTIME_REFERENCE_SNAPSHOT_VERSION, generations: [], seats: []}
        });
        if (awaitRecovery) this.continuityPhase = 'pending-recovery';
        return this.journal.previous
    }

    /**
     * @summary Marks launch continuity unavailable when the running runtime generation fails payload verification
     * before {@link recover} can run, keeping this service the single writer of `continuityPhase`.
     */
    failRuntimeVerification() {
        this.continuityPhase = 'unavailable';
        this.grants.clear();
    }

    /**
     * @summary Restore only original active generations after the lifecycle proves their surviving seats.
     * Every previous generation is retained as non-authoritative evidence first. The callback owns process,
     * runtime and profile custody; this issuer checks the original bindings, tombstones and capabilities.
     * A failed seat stays stale. A conflict on the original endpoint blocks the issuer without a fallback.
     * @param {Object} options
     * @param {Object} options.registry Existing definition owner.
     * @param {Function} options.restoreSeat `(start, saved) => {capabilities, owners, residentInputs, probe}`.
     * @param {Object} options.runtimeReferenceGuard Live exclusion for every retained generation parent.
     * @returns {Promise<Object[]>} Per-seat admission disposition, without capabilities or owner values.
     */
    async recover({registry, restoreSeat, runtimeReferenceGuard}) {
        if (!this.journal || this.generations.size || this.listening ||
            (this.continuityPhase !== 'ready' && this.continuityPhase !== 'pending-recovery') ||
            typeof restoreSeat !== 'function') throw new Error('Launch recovery must precede admission and Start.');
        const previous = this.journal.previous;
        this.continuityRecord = {recoveredAt: new Date().toISOString(), previousReason: previous?.reason ?? null,
            handoffProved: previous?.handoffProved ?? null, origin: previous?.origin ?? null, seats: []};
        if (!previous) {
            this.continuityPhase = 'ready';
            return [];
        }
        const retainedRuntimes = [...previous.snapshot.generations.map(row => row.runtime),
            ...previous.snapshot.seats.map(row => row.start.runtime)].filter(Boolean);
        /** @summary Revalidates the same parent exclusion before publishing recovered authority. */
        const assertReferences = () => retainedRuntimes.forEach(runtime =>
            assertRuntimeGenerationReferences(runtimeReferenceGuard, path.dirname(runtime.directory)));
        assertReferences();
        this.continuityPhase = 'recovering';
        this.observeRegistry(registry);
        for (const saved of previous.snapshot.generations) {
            const agent      = registry.getDefinition(saved.agentId), current = agent ? projectDefinition(agent) : null;
            const definition = current && crypto.createHash('sha256').update(canonicalJson(current)).digest('hex') === saved.definitionHash
                ? current : null;
            this.generations.set(saved.agentId, {
                ...structuredClone(saved), definition, generationRoot: saved.runtime?.runtimeRoot ?? null,
                state  : saved.state === STATES.REVOKED ? STATES.REVOKED : STATES.STALE,
                reason : saved.state === STATES.REVOKED ? saved.reason : REASONS.RECOVERY_UNVERIFIED,
                detail : saved.state === STATES.REVOKED || previous.handoffProved ? null : previous.reason,
                servers: new Map(saved.servers.map(row => [row.key, {...row, secret: null,
                    state : row.state === STATES.REVOKED ? STATES.REVOKED : STATES.STALE,
                    reason: row.state === STATES.REVOKED ? row.reason : REASONS.RECOVERY_UNVERIFIED,
                    args  : null, env: null, owned: [], resident: [], required: []}])),
                owners: {}, residentInputs: {}, proofs: new Map(), probe: null, waiters: new Set(), audit: []
            });
        }
        try {
            if (previous.handoffProved) {
                if (previous.origin === null && previous.snapshot.generations.some(row => row.state === STATES.ACTIVE)) {
                    throw new Error('Active launch authority has no original issuer origin.');
                }
                for (const saved of previous.snapshot.generations) {
                    const generation = this.generations.get(saved.agentId);
                    if (saved.state !== STATES.ACTIVE) continue;
                    const seat = previous.snapshot.seats.find(row => row.start.agentId === saved.agentId);
                    try {
                        // Each check names itself: the one that fails is what the seat's row will say.
                        const unproved = !seat ? 'no seat record' : seat.state !== 'running' ? `seat state '${seat.state}'`
                            : seat.ownershipUnresolved ? 'seat ownership unresolved' : seat.cleanupUnresolved ? 'seat cleanup unresolved'
                            : seat.start.admissionGeneration !== saved.id ? 'admission generation mismatch'
                            : seat.start.identity !== saved.identity ? 'identity mismatch'
                            : seat.start.profile?.issuer !== previous.origin ? 'profile issuer is not the original origin'
                            : !isDeepStrictEqual(seat.start.runtime, saved.runtime) ? 'runtime pin mismatch' : null;
                        if (unproved) throw new Error(unproved);
                        const recovered = await restoreSeat(seat.start, saved);
                        if (generation.state === STATES.REVOKED) continue;
                        const agent      = registry.getDefinition(saved.agentId);
                        const definition = agent && projectDefinition(agent);
                        const changed    = !definition ? 'definition missing' : loginOf(agent) !== saved.identity ? 'identity changed'
                            : crypto.createHash('sha256').update(canonicalJson(definition)).digest('hex') !== saved.definitionHash ? 'definition changed'
                            : observeProcess(recovered.probe) !== 'live' ? 'process not live' : null;
                        if (changed) throw new Error(changed);
                        const effective = {...saved, servers: saved.servers.map(row => generation.servers.get(row.key).state === STATES.REVOKED
                            ? {...row, state: STATES.REVOKED, reason: generation.servers.get(row.key).reason} : row)};
                        const servers = this.recoverServers({saved: effective, start: seat.start, recovered});
                        Object.assign(generation, {definition, servers, state: STATES.ACTIVE, reason: null, detail: null,
                            owners: recovered.owners, residentInputs: recovered.residentInputs, probe: recovered.probe});
                    } catch (error) {
                        // One unproved survivor cannot authorize itself or discard another seat's evidence; it says which check failed.
                        generation.detail = error?.message || 'the original Start, its runtime pin or its inputs did not verify';
                    }
                }
                if (previous.origin !== null) await this.listen({origin: previous.origin});
            }
            assertReferences();
            this.journal.assertOwner();
            for (const generation of this.generations.values()) {
                if (generation.state !== STATES.ACTIVE) continue;
                if (observeProcess(generation.probe) !== 'live') {
                    Object.assign(generation, {state: STATES.STALE, reason: REASONS.RECOVERY_UNVERIFIED,
                        detail: 'process not live after recovery', owners: {}, residentInputs: {}, probe: null});
                    generation.servers.forEach(server => { server.secret = null; });
                    continue;
                }
                generation.servers.forEach(server => this.grants.set(server.grantId, {generation, key: server.key}));
            }
            this.persistAdmission();
            this.continuityPhase = 'ready';
            this.continuityRecord.seats = [...this.generations.values()].map(row => ({agentId: row.agentId, state: row.state, reason: row.reason, detail: row.detail ?? null}));
            return this.continuityRecord.seats.map(row => ({...row}));
        } catch (error) {
            this.continuityPhase = 'unavailable';
            this.grants.clear();
            for (const generation of this.generations.values()) {
                if (generation.state === STATES.REVOKED) continue;
                Object.assign(generation, {state: STATES.STALE, reason: REASONS.RECOVERY_UNVERIFIED, detail: error?.message || 'recovery failed', owners: {}, residentInputs: {}, probe: null});
                generation.servers.forEach(server => { server.secret = null; });
            }
            try {
                this.persistAdmission();
            } finally {
                if (this.httpServer) {
                    const server = this.httpServer;
                    this.httpServer = this.listening = this.issuerOrigin = null;
                    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
                }
            }
            throw error;
        }
    }

    /**
     * @summary Rebuild fixed server targets from original classified metadata, never a fresh plan or ambient env.
     * Only the targets the Start admitted are compared with the generation's servers: a Codex Desktop Start
     * plans every server but admits Neural Link alone, its other rows coming from its own env.
     * @param {Object} options Original journal row, Start record and the lifecycle's custody-checked inputs.
     * @returns {Map} Recovered server states; disabled grants stay revoked.
     * @protected
     */
    recoverServers({saved, start, recovered}) {
        const
            {capabilities, owners, residentInputs} = recovered,
            admitted                               = new Set(Object.keys(start.profile.grants)),
            servers                                = canonicalJson(saved.servers.map(row => row.key).sort());
        if (canonicalJson(Object.keys(capabilities).sort()) !== servers || canonicalJson([...admitted].sort()) !== servers ||
            canonicalJson(start.targets.map(row => row.key).filter(key => admitted.has(key)).sort()) !== servers) throw new Error('server set changed');
        for (const [name, owner] of Object.entries(owners)) {
            if (!isDeepStrictEqual(owner.binding, saved.credentialBindings[name]) || !owner.matches()) throw new Error(`credential owner changed: ${name}`);
        }
        for (const [key, input] of Object.entries(residentInputs)) {
            if (!isDeepStrictEqual({binding: input.binding, names: input.names}, saved.residentBindings[key]) || !input.matches()) throw new Error(`resident input changed: ${key}`);
        }
        return new Map(saved.servers.map(row => {
            const capability = capabilities[row.key], grant = parseLaunchCapability(capability), expected = start.profile.grants[row.key];
            if (!grant || grant.id !== row.grantId || expected.id !== row.grantId || expected.sha256 !== row.capabilityHash ||
                crypto.createHash('sha256').update(capability).digest('hex') !== row.capabilityHash) throw new Error(`capability changed: ${row.key}`);
            const target = start.targets.find(target => target.key === row.key);
            const owned  = [], resident = [], required = target.slots.filter(slot => slot.required).map(slot => slot.name);
            if (row.state !== STATES.REVOKED) {
                if (row.state !== STATES.ACTIVE) throw new Error(`server state changed: ${row.key}`);
                for (const slot of target.slots) {
                    if (slot.state === 'owner' && owners[slot.name]) owned.push(slot.name);
                    else if (slot.state === 'held' && residentInputs[row.key]?.names.includes(slot.name)) resident.push(slot.name);
                    else if (slot.state === 'owner') throw new Error(`credential owner missing: ${slot.name}`);
                    else if (slot.state === 'held') throw new Error(`resident input missing: ${slot.name}`);
                    else if (slot.state !== 'absent' || slot.required) throw new Error(`slot unaccounted: ${slot.name}`);
                }
            }
            return [row.key, {...row, secret: grant.secret, args: [...target.args], env: {}, owned, resident, required}];
        }));
    }

    /**
     * @summary Seal clean succession only after survivor/input checks, in-flight proofs and endpoint release.
     * The process owner must stop accepting control mutations before calling. A failed attempt closes
     * custody without a handoff; ordinary process Quit remains the caller's choice, never blocked here.
     * @param {Object} options
     * @param {Function} options.verifySeats `(witness) => Promise`: validates every surviving seat against its
     *     original Start, reporting each seat through the same witness as the stages.
     * @param {Function} [options.onStage] `(stage) => void`, called as each stage begins and once more on
     *     a refusal (`refused at <stage>: <reason>`), so a caller's log witnesses how far a handoff got
     *     even when the host kills the process mid-stage; never awaited, never trusted with control.
     * @param {Number} [options.deadlineMs] Remaining whole-quit budget in milliseconds; defaults to {@link proofTimeoutMs}.
     * @returns {Promise<Object>} Coalesced terminal disposition, without grants or input values.
     */
    handoff({verifySeats, onStage = null, deadlineMs}) {
        return this.handoffPromise ??= this.performHandoff(verifySeats, onStage, deadlineMs);
    }

    /** @summary One bounded terminal transition; only the owner-facing handoff method starts it. @private */
    async performHandoff(verifySeats, onStage = null, deadlineMs = this.proofTimeoutMs) {
        const witness = stage => { try { onStage?.(stage) } catch {} };
        if (!this.journal || this.journalFailed || this.continuityPhase !== 'ready' || typeof verifySeats !== 'function') {
            throw new Error('Fleet continuity refused: custody-unavailable.');
        }
        this.continuityPhase = 'draining';
        const budgetMs = Number.isFinite(deadlineMs) && deadlineMs >= 0 ? deadlineMs : this.proofTimeoutMs;
        let timer, stage = 'survivor-validation';
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('deadline')), budgetMs);
        });
        const bounded = work => Promise.race([work, deadline]);
        const release = () => new Promise((resolve, reject) => {
            if (!this.httpServer) return resolve();
            const server = this.httpServer;
            server.close(error => {
                if (error) return reject(error);
                this.httpServer = this.listening = null;
                resolve();
            });
            server.closeIdleConnections();
        });
        try {
            if ([...this.generations.values()].some(row => row.state === STATES.RESERVED)) {
                stage = 'pending-start';
                throw new Error('Fleet continuity refused: pending-start.');
            }
            if ([...this.generations.values()].some(row => row.state === STATES.ACTIVE) &&
                (!this.httpServer?.address() || this.issuerOrigin !== `http://127.0.0.1:${this.httpServer.address().port}`)) {
                stage = 'endpoint-binding';
                throw new Error('Fleet continuity refused: endpoint-binding.');
            }
            witness(stage);
            await bounded(Promise.resolve().then(() => verifySeats(witness)));
            stage = 'proof-drain';
            witness(stage);
            await bounded(Promise.all([...this.generations.values()].flatMap(row => [...row.proofs.values()])));
            this.persistAdmission();
            stage = 'endpoint-release';
            witness(stage);
            await bounded(release());
            stage = 'durable-handoff';
            witness(stage);
            this.journal.handoff(this.admissionSnapshot(), this.issuerOrigin);
            this.continuityPhase = 'handed-off';
            return {state: 'handed-off'};
        } catch (error) {
            witness(`refused at ${stage}${error?.message && !/^Fleet continuity refused/.test(error.message) ? `: ${error.message}` : ''}`);
            this.continuityPhase = 'unavailable';
            this.grants.clear();
            this.journal.close();
            if (this.httpServer) {
                const server = this.httpServer;
                this.httpServer = this.listening = null;
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
            throw new Error(`Fleet continuity refused: ${error?.message === 'deadline' ? `deadline at ${stage}` : stage}.`);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * @summary Projects lifecycle facts and capability hashes, never held environments or owner callbacks.
     * This initial record cannot authorize recovery until the original-Start bindings are attached.
     * @returns {Object} Closed, non-secret journal snapshot.
     * @protected
     */
    admissionSnapshot() {
        return {
            version    : RUNTIME_REFERENCE_SNAPSHOT_VERSION,
            seats      : this.readSeatStarts ? this.readSeatStarts() : [],
            generations: [...this.generations.values()].map(generation => ({
                id                : generation.id, agentId: generation.agentId, identity: generation.identity,
                state             : generation.state, reason: generation.reason,
                reservedAt        : generation.reservedAt, activatedAt: generation.activatedAt, revokedAt: generation.revokedAt,
                definitionHash    : generation.definition ? crypto.createHash('sha256').update(canonicalJson(generation.definition)).digest('hex') : generation.definitionHash,
                runtime           : generation.runtime ? {...generation.runtime} : null,
                credentialBindings: structuredClone(generation.credentialBindings),
                residentBindings  : structuredClone(generation.residentBindings),
                servers           : [...generation.servers.values()].map(server => ({
                    key           : server.key, grantId: server.grantId, state: server.state, reason: server.reason,
                    capabilityHash: server.capabilityHash
                }))
            }))
        }
    }

    /** @summary Publishes before a successful phase transition can escape to its caller. @protected */
    persistAdmission() {
        if (!this.journal) return;
        try {
            this.journal.write(this.admissionSnapshot(), this.issuerOrigin)
        } catch (error) {
            this.freezeAdmission();
            throw error
        }
    }

    /** @summary Fails every pending or active admission closed after a durability or ownership loss. @protected */
    freezeAdmission() {
        this.journalFailed = true;
        for (const generation of this.generations.values()) {
            if (generation.state !== STATES.REVOKED) {
                generation.state = STATES.STALE;
                generation.reason = REASONS.DURABILITY_FAILED;
            }
            this.releaseStartSignal(generation);
            this.settle(generation);
        }
    }

    /**
     * @summary Mint one grant per enabled server for a seat's next Start, ending the seat's previous
     * generation. The registry the definition came from is followed from here on.
     *
     * The generation is published before anything is awaited, so every revocation from then on reaches it.
     * What came before is caught up at once. Non-Stop seat-wide revocations since the caller's `since` mark
     * revoke it; a `startSignal` also revokes this exact generation when its managed Start is canceled. A
     * Start therefore answers for its whole attempt, not just the part after it reserved.
     * @param {Object} options
     * @param {Object} options.agent The raw registry definition.
     * @param {Object} [options.registry] Its registry, an Observable firing `definitionChange` that reads
     *     raw definitions through `getDefinition`.
     * @param {Number} [options.since] The {@link revocationMark} the Start read as it began.
     * @param {AbortSignal} [options.startSignal] The owning managed Start's cancellation signal.
     * @param {Object|null} [options.runtimeGeneration] The verified packaged runtime selected for this Start.
     * @param {Object} [options.runtimeReferenceGuard] Live parent exclusion for a packaged reservation.
     * @param {String[]|null} [options.servers] The enabled servers this seat starts through the issuer, when not
     *     all of them: a Codex Desktop seat starts only Neural Link this way and its other rows from its own env.
     * @returns {Promise<{generation: String, issuer: String, identity: String, grants: Object<String, String>}>}
     *     `grants` maps each such server to the capability its profile row carries; `identity` is the
     *     validated login the rows must name.
     */
    async reserve({agent, registry = null, since = null, startSignal = null, runtimeGeneration = null, runtimeReferenceGuard = null, servers = null}) {
        if (this.continuityPhase !== 'ready') throw new Error('Fleet launch continuity is not ready.');
        if (this.journalFailed) throw new Error('Launch admission issuer is frozen after a failed durable transition.');
        if (startSignal && (
            typeof startSignal.aborted !== 'boolean' ||
            typeof startSignal.addEventListener !== 'function' ||
            typeof startSignal.removeEventListener !== 'function'
        )) {
            throw new TypeError('McpLaunchAdmissionService.reserve: startSignal must be an AbortSignal.')
        }
        if (servers !== null && (!Array.isArray(servers) || !servers.every(key => MCP_SERVERS.some(row => row.key === key)))) {
            throw new TypeError('McpLaunchAdmissionService.reserve: servers must name catalog servers.')
        }

        const identity = loginOf(agent);

        if (!isLaunchIdentity(identity)) {
            throw new Error(`McpLaunchAdmissionService.reserve: agent '${agent?.id}' has no valid githubUsername identity.`)
        }

        const runtime = runtimeGeneration === null ? null : runtimeGenerationPin(runtimeGeneration);
        if (runtime) assertRuntimeGenerationReferences(runtimeReferenceGuard, path.dirname(runtime.directory));
        this.observeRegistry(registry);

        const
            previous   = this.generations.get(agent.id),
            definition = projectDefinition(agent),
            generation = {
                id                : crypto.randomUUID(),
                agentId           : agent.id,
                identity,
                state             : STATES.RESERVED,
                reason            : null,
                reservedAt        : new Date().toISOString(),
                activatedAt       : null,
                revokedAt         : null,
                definition,
                runtime,
                generationRoot    : null,
                servers           : new Map(),
                owners            : {},
                credentialBindings: {},
                residentInputs    : {},
                residentBindings  : {},
                proofs            : new Map(),
                probe             : null,
                waiters           : new Set(),
                audit             : []
            },
            grants     = {};

        if (previous) {
            this.revoke(agent.id, REASONS.REPLACED, {generation: previous.id});
            previous.servers.forEach(server => this.grants.delete(server.grantId))
        }

        for (const [key, enabled] of Object.entries(definition.matrix)) {
            if (!enabled || servers?.includes(key) === false) continue;

            const grant = mintLaunchGrant();

            generation.servers.set(key, {key, grantId: grant.id, secret: grant.secret,
                capabilityHash: crypto.createHash('sha256').update(grant.capability).digest('hex'), state: STATES.RESERVED, reason: null,
                args          : null, env: null, owned: [], resident: [], required: []});
            this.grants.set(grant.id, {generation, key});
            grants[key] = grant.capability
        }

        // Published before anything is awaited, then caught up with what fired before it could hear it
        this.generations.set(agent.id, generation);

        let issuer;

        try {
            this.bindStartSignal(generation, startSignal);

            if (since !== null && this.revocationMark(agent.id) !== since) {
                this.revoke(agent.id, this.revocations.get(agent.id).reason, {generation: generation.id})
            }

            registry?.getDefinition && this.onDefinitionChange({id: agent.id, next: registry.getDefinition(agent.id)});
            issuer = await this.listen();
            if (runtime) assertRuntimeGenerationReferences(runtimeReferenceGuard, path.dirname(runtime.directory));
            this.persistAdmission()
        } catch (error) {
            this.revoke(agent.id, REASONS.START_FAILED, {generation: generation.id});
            throw error
        }

        return {generation: generation.id, issuer, identity, grants}
    }

    /**
     * @summary Bind a reserved generation to the Start that launched and leased its seat. Each server
     * redeems its row's values ({@link Neo.ai.services.fleet.managedAgentWorkspacePlan.launchRowEnvNames}):
     * seat credentials and bound resident inputs from their original owners at each redemption,
     * other held values from the environment Start injected. It also gets the argv of its fixed target.
     * A server whose required value has neither is
     * revoked with `credential-missing`. A generation revoked or replaced meanwhile stays as it is.
     * @param {Object} options
     * @param {String} options.generation The id {@link reserve} returned.
     * @param {String} options.agentId
     * @param {Object[]} options.plan The bound MCP plan preparation returned.
     * @param {Object<String,String>} options.env The environment Start injected into the seat. A name that
     *     has an owner is never read from it.
     * @param {Object<String,Object>} [options.owners] The owner Start selected for each seat credential, by
     *     the name its value goes under: `{credential, resolve, prove}`, where `credential` is a
     *     `LAUNCH_ADMISSION_CREDENTIALS` value, `resolve()` returns what the owner holds now, and
     *     `prove(value, {signal})` answers `{verdict, reason}`. Legacy `{ok}` answers remain supported.
     * @param {Object} [options.residentInputs] Original resolved-config owners keyed by resident server.
     * @param {Function} options.probe `() => 'live'|'gone'|'unknown'`, whether the launched process is still
     *     the seat: the lifecycle's own process proof.
     * @returns {Object} The seat's admission status ({@link statusOf}).
     */
    activate({generation: id, agentId, plan, env, owners = {}, residentInputs = {}, probe}) {
        if (this.continuityPhase !== 'ready') throw new Error('Fleet launch continuity is not ready.');
        const generation = this.generations.get(agentId);

        if (generation?.id !== id || generation.state !== STATES.RESERVED) return this.statusOf(agentId);

        const roots          = [...new Set(plan.filter(row => row.enabled).map(row => row.sourceRoot))];
        const generationRoot = generation.runtime?.runtimeRoot ?? roots[0] ?? null;
        if (roots.length > 1 || roots.some(root => !path.isAbsolute(root || '')) ||
            generation.runtime && plan.some(row => row.sourceRoot !== generationRoot || row.command !== generation.runtime.executable)) {
            throw new Error('Launch admission targets do not bind the reserved runtime.')
        }
        const credentialBindings = {};
        for (const [name, owner] of Object.entries(owners)) {
            if (owner.binding !== undefined) {
                if (!isAdmissibleEnvName(name) || !isLaunchCredentialBinding(owner.binding) ||
                    owner.binding.agentId !== agentId || owner.binding.identity !== generation.identity) {
                    throw new Error('Launch admission credential binding is invalid.');
                }
                credentialBindings[name] = structuredClone(owner.binding);
            }
        }

        const residentBindings = {};
        for (const [key, input] of Object.entries(residentInputs)) {
            if (!plan.some(row => row.key === key && row.enabled && row.target === 'resident') ||
                !isResidentMcpBinding(input.binding) || input.binding.server !== key ||
                !Array.isArray(input.names) || new Set(input.names).size !== input.names.length ||
                !input.names.every(isAdmissibleEnvName) || typeof input.read !== 'function' || typeof input.matches !== 'function') {
                throw new Error('Launch admission resident input binding is invalid.');
            }
        }

        for (const server of generation.servers.values()) {
            const row = plan.find(entry => entry.key === server.key);

            if (server.state === STATES.REVOKED) continue;

            if (!row?.enabled) {
                revokeServer(server, REASONS.PLAN_CHANGED);
                continue
            }

            const
                names = launchRowEnvNames(row),
                owned = names.redeemed.filter(name => typeof owners[name]?.resolve === 'function' && typeof owners[name].prove === 'function'),
                held  = names.redeemed.filter(name => !owned.includes(name) && typeof env[name] === 'string');

            if (names.required.some(name => !owned.includes(name) && !held.includes(name))) {
                revokeServer(server, REASONS.CREDENTIAL_MISSING);
                continue
            }

            server.owned = owned;
            const resident = row.target === 'resident' ? residentInputs[server.key] : null;
            server.resident = resident ? held.filter(name => resident.names.includes(name)) : [];
            server.required = names.required;
            if (resident) residentBindings[server.key] = {binding: structuredClone(resident.binding), names: [...server.resident]};
            server.env   = Object.fromEntries(held.filter(name => !server.resident.includes(name)).map(name => [name, env[name]]));
            server.args  = row.target === 'tenant'
                ? [path.join(row.sourceRoot, BRIDGE_ENTRYPOINT), '--url', row.url, '--token-env', row.credentialEnvVar]
                : [...row.args];
            server.state = STATES.ACTIVE
        }

        Object.assign(generation, {state: STATES.ACTIVE, activatedAt: new Date().toISOString(), generationRoot,
            credentialBindings, residentBindings, residentInputs: {...residentInputs}, owners: {...owners}, probe});
        this.persistAdmission();
        this.releaseStartSignal(generation);
        this.settle(generation);

        return this.statusOf(agentId)
    }

    /**
     * @summary Revoke one server of an active generation, leaving the generation and its other servers active.
     * A surviving seat that cannot prove one server at handoff loses only that server's launch admission. The
     * persisted disposition then outlives any later observation of the seat.
     * @param {String} agentId
     * @param {String} key The server's catalog key.
     * @param {String} reason A `LAUNCH_ADMISSION_REASONS` value.
     * @param {Object} options
     * @param {String} options.generation Revoke only in this generation, never a newer one.
     * @returns {Boolean} Whether a grant was revoked by this call.
     */
    revokeServerGrant(agentId, key, reason, {generation: id}) {
        const generation = this.generations.get(agentId), server = generation?.servers.get(key);

        if (!server || generation.id !== id || generation.state !== STATES.ACTIVE || server.state === STATES.REVOKED) return false;

        revokeServer(server, reason);
        this.grants.delete(server.grantId);
        this.persistAdmission();

        return true
    }

    /**
     * @summary End a seat's generation for good: no grant of it admits again, and the values and owners it
     * held are dropped. Waiting redemptions are answered with the refusal. A non-Stop seat-wide revocation
     * is also counted when no generation takes it ({@link reserve}); Stop intent cancels through the
     * managed Start's signal and does not advance that shared mark.
     * @param {String} agentId
     * @param {String} reason A `LAUNCH_ADMISSION_REASONS` value.
     * @param {Object} [options]
     * @param {String} [options.generation] Revoke only this generation, never a newer one.
     * @returns {Boolean} Whether a generation was revoked by this call.
     */
    revoke(agentId, reason, {generation: id = null} = {}) {
        const generation = this.generations.get(agentId);

        // Pending Starts carry their own signal. STOP_REQUESTED still revokes the active generation but
        // does not advance the shared mark, which is reserved for non-Stop invalidations before reserve.
        if (!id && reason !== REASONS.STOP_REQUESTED) this.revocations.set(agentId, {count: this.revocationMark(agentId) + 1, reason});

        if (!generation || (id && generation.id !== id) || generation.state === STATES.REVOKED) return false;

        this.releaseStartSignal(generation);
        Object.assign(generation, {state: STATES.REVOKED, reason, revokedAt: new Date().toISOString(), probe: null, owners: {}, residentInputs: {}});
        generation.proofs.clear();
        generation.servers.forEach(server => revokeServer(server, server.state === STATES.REVOKED ? server.reason : reason));
        this.persistAdmission();
        this.settle(generation);

        return true
    }

    /**
     * @summary Attach cancellation to this exact reserved generation before `reserve` yields.
     * An already-aborted signal revokes synchronously; checking again after registration closes the
     * edge where an abort lands as the listener is installed.
     * @param {Object} generation The newly published reservation.
     * @param {AbortSignal|null} signal The owning Start's signal, if managed by Fleet.
     * @private
     */
    bindStartSignal(generation, signal) {
        if (!signal) return;

        const onAbort = () => this.revoke(generation.agentId, REASONS.STOP_REQUESTED, {generation: generation.id});

        generation.startSignal        = signal;
        generation.startAbortListener = onAbort;

        if (signal.aborted) {
            onAbort();
            return
        }

        signal.addEventListener('abort', onAbort, {once: true});

        if (signal.aborted) onAbort()
    }

    /**
     * @summary Detach and forget the pending-Start signal once this generation activates or ends.
     * @param {Object} generation A generation that no longer needs pending-Start cancellation.
     * @private
     */
    releaseStartSignal(generation) {
        if (generation.startSignal && generation.startAbortListener) {
            generation.startSignal.removeEventListener('abort', generation.startAbortListener)
        }

        delete generation.startSignal;
        delete generation.startAbortListener
    }

    /**
     * @summary How many non-Stop seat-wide revocations the seat has been asked for. A Start reads it as it
     * begins and hands it to {@link reserve}, so a plan or identity invalidation before a generation exists
     * still ends that Start's admission. Stop cancellation travels on that Start's signal.
     * @param {String} agentId
     * @returns {Number}
     */
    revocationMark(agentId) {
        return this.revocations.get(agentId)?.count ?? 0
    }

    /**
     * @summary The seat's admission as its card renders it ({@link module:src/fleet/contract/launchAdmission}).
     * @param {String} agentId
     * @param {Object} [options]
     * @param {Boolean} [options.running=false] Whether the lifecycle holds the seat as running. A running
     *     seat without a generation of this process is `stale`.
     * `detail` says why a stale row is stale in this process's own words: for a running seat this issuer
     * holds no generation for, the previous issuer's exit as boot recovery read it; for a retained
     * generation, the check that kept it stale.
     * @returns {{state: String, reason: String|null, detail: String|null, generation: String|null, since: String|null,
     *     servers: Object[], recent: Object[]}}
     */
    statusOf(agentId, {running = false} = {}) {
        const generation = this.generations.get(agentId);

        if (!generation) {
            return {
                state     : running ? STATES.STALE : STATES.NONE,
                reason    : running ? REASONS.ISSUER_REPLACED : null,
                detail    : running ? this.continuityRecord?.previousReason ?? null : null,
                generation: null,
                since     : null,
                servers   : [],
                recent    : []
            }
        }

        return {
            state     : generation.state,
            reason    : generation.reason,
            detail    : generation.detail ?? null,
            generation: generation.id,
            since     : generation.revokedAt ?? generation.activatedAt ?? generation.reservedAt,
            servers   : [...generation.servers.values()].map(({key, state, reason}) => ({key, state, reason})),
            recent    : generation.audit.map(entry => ({...entry}))
        }
    }

    /**
     * @param {String} agentId
     * @returns {Boolean} Whether this issuer holds a generation for the seat, current or ended.
     */
    holds(agentId) {
        return this.generations.has(agentId)
    }

    /**
     * @returns {Object[]} The newest refusals of requests that proved no grant, without attribution.
     */
    unattributedAudit() {
        return this.unattributed.map(entry => ({...entry}))
    }

    /**
     * @summary Answer one parsed request body. Every answer to a request whose proof holds is signed with its
     * grant's secret and audited against the seat.
     *
     * Each seat credential the server needs is resolved from its owner and proved now, and the child gets
     * exactly the value that proved. An owner holding nothing refuses `credential-missing`; a value that
     * does not prove refuses `credential-unproven`. Neither ends the generation. The final checks run after
     * every wait and proof, with nothing awaited between them and the answer, so a revocation can never be
     * overtaken.
     * @param {*} body
     * @returns {Promise<Object>} The answer payload.
     */
    async redeem(body) {
        const
            request = parseLaunchRequest(body),
            entry   = request && this.grants.get(request.grant),
            server  = entry?.generation.servers.get(entry.key);

        if (!request) return this.refuseUnattributed(REFUSALS.MALFORMED);
        if (!server)  return this.refuseUnattributed(REFUSALS.UNKNOWN_GRANT);
        if (!verifyLaunchRequest(server.secret, request)) return this.refuseUnattributed(REFUSALS.PROOF_MISMATCH);

        const
            {generation} = entry,
            answer       = payload => this.answer(generation, server, request, payload),
            refuse       = (code, reason) => answer({outcome: OUTCOMES.REFUSED, code, ...(reason ? {reason} : {})});

        if (request.server   !== server.key)          return refuse(REFUSALS.SERVER_MISMATCH);
        if (request.identity !== generation.identity) return refuse(REFUSALS.IDENTITY_MISMATCH);
        if (this.continuityPhase !== 'ready') return refuse(REFUSALS.ISSUER_UNAVAILABLE, REASONS.RECOVERY_UNVERIFIED);
        if (this.journalFailed) return refuse(REFUSALS.ISSUER_UNAVAILABLE, REASONS.DURABILITY_FAILED);

        if (server.state === STATES.RESERVED && generation.state === STATES.RESERVED && !await this.waitForSettlement(generation)) {
            return refuse(REFUSALS.PENDING_TIMEOUT)
        }

        const revoked = () => generation.state !== STATES.ACTIVE || server.state !== STATES.ACTIVE;

        if (revoked()) return refuse(REFUSALS.REVOKED, server.reason ?? generation.reason);

        const resident         = generation.residentInputs[server.key];
        const residentSnapshot = resident ? resident.read() : {};
        if (residentSnapshot === null) return refuse(REFUSALS.CREDENTIAL_UNPROVEN);
        if (server.resident.some(name => server.required.includes(name) && typeof residentSnapshot[name] !== 'string')) {
            return refuse(REFUSALS.CREDENTIAL_MISSING);
        }
        const residentEnv = Object.fromEntries(server.resident.filter(name => typeof residentSnapshot[name] === 'string')
            .map(name => [name, residentSnapshot[name]]));

        const
            owners      = server.owned.map(name => generation.owners[name]),
            credentials = server.owned.map((name, index) => readOwner(owners[index])),
            missing     = credentials.indexOf(null);

        if (missing > -1) return refuse(REFUSALS.CREDENTIAL_MISSING, ownerCredentialKind(owners[missing]));

        // This exact snapshot also becomes the child's env. Never re-read the port after proving it.
        const childEnv = {...server.env, ...residentEnv};
        const port     = typeof childEnv.NEO_NL_PORT === 'string' && /^[1-9][0-9]{0,4}$/.test(childEnv.NEO_NL_PORT)
            ? Number(childEnv.NEO_NL_PORT) : null;
        const proofs = await Promise.all(server.owned.map((name, index) => this.prove(generation, name, credentials[index], port)));
        if (this.journalFailed) return refuse(REFUSALS.ISSUER_UNAVAILABLE, REASONS.DURABILITY_FAILED);
        if (revoked()) return refuse(REFUSALS.REVOKED, server.reason ?? generation.reason);
        if (this.continuityPhase !== 'ready') return refuse(REFUSALS.ISSUER_UNAVAILABLE, REASONS.RECOVERY_UNVERIFIED);
        if (resident && !resident.matches()) return refuse(REFUSALS.CREDENTIAL_UNPROVEN);

        // A definite refusal wins over a concurrent unavailable proof; neither retires the generation.
        const failed  = proofs.findIndex(proof => proof.verdict === 'refused'),
              pending = proofs.findIndex(proof => proof.verdict === 'unanswered'),
              index   = failed > -1 ? failed : pending;

        if (index > -1) {
            return refuse(failed > -1 ? REFUSALS.CREDENTIAL_UNPROVEN : REFUSALS.PROOF_UNAVAILABLE,
                failed < 0 && isLaunchAdmissionProofReason(proofs[index].reason) ? proofs[index].reason : ownerCredentialKind(owners[index]))
        }

        const observed = observeProcess(generation.probe);

        if (observed === 'gone') {
            this.revoke(generation.agentId, REASONS.PROCESS_EXITED, {generation: generation.id});
            return refuse(REFUSALS.REVOKED, REASONS.PROCESS_EXITED)
        }

        if (observed !== 'live') return refuse(REFUSALS.PROCESS_UNKNOWN);

        try { this.journal?.assertOwner() } catch {
            this.freezeAdmission();
            return refuse(REFUSALS.ISSUER_UNAVAILABLE, REASONS.DURABILITY_FAILED)
        }

        return answer({
            outcome       : OUTCOMES.ADMITTED,
            generationRoot: generation.generationRoot,
            env           : {...childEnv, ...Object.fromEntries(server.owned.map((name, index) => [name, credentials[index]]))},
            args          : [...server.args]
        })
    }

    /**
     * @summary Prove one credential value with its owner. Concurrent redemptions proving the same value share
     * one proof. The owner classifies transport facts; a throw or deadline is unanswered. Expiry aborts
     * the owner's requests. Legacy `{ok}` owners remain supported, with a negative result terminal.
     * @param {Object} generation
     * @param {String} name The name the value goes under.
     * @param {String} value
     * @param {Number|null} port Port captured for this child, relevant only to the Bridge token owner.
     * @returns {Promise<{verdict: String, reason: (String|undefined)}>}
     * @protected
     */
    prove(generation, name, value, port = null) {
        const
            {owners, proofs} = generation,
            bridge           = ownerCredentialKind(owners[name]) === 'bridge-token',
            key              = `${name}\0${crypto.createHash('sha256').update(value).digest('base64url')}\0${bridge ? port : ''}`;

        if (!proofs.has(key)) {
            let timer;
            const controller = new AbortController();

            const proof = Promise.race([
                Promise.resolve().then(() => owners[name].prove(value, {signal: controller.signal,
                    ...(bridge ? {port, timeoutMs: this.proofTimeoutMs} : {})})),
                new Promise(resolve => {
                    timer = setTimeout(() => {
                        resolve({verdict: 'unanswered', reason: 'proof-timeout'});
                        controller.abort()
                    }, this.proofTimeoutMs);
                    timer.unref?.()
                })
            ])
                .then(result => ({
                    verdict: ['proved', 'refused', 'unanswered'].includes(result?.verdict)
                        ? result.verdict : result?.verdict === undefined && result?.ok === true ? 'proved' : 'refused',
                    ...(isLaunchAdmissionProofReason(result?.reason) ? {reason: result.reason} : {})
                }), () => ({verdict: 'unanswered', reason: 'proof-unavailable'}))
                .finally(() => {
                    clearTimeout(timer);
                    proofs.get(key) === proof && proofs.delete(key)
                });

            proofs.set(key, proof)
        }

        return proofs.get(key)
    }

    /**
     * @summary Bind a new issuer on an ephemeral port, or a proved successor on the exact original origin.
     * A recovery bind conflict never retries on another port or adopts the process holding the endpoint.
     * @param {Object} [options]
     * @param {String|null} [options.origin=null] Original custody-proved loopback origin for recovery only.
     * @returns {Promise<String>} The origin profile rows name.
     */
    listen({origin = null} = {}) {
        if (origin !== null && (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) ||
            Number(origin.split(':').at(-1)) > 65535)) throw new Error('Original launch issuer origin is invalid.');
        return this.listening ??= new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => void this.handle(req, res));

            server.once('error', () => reject(new Error(origin
                ? 'Original launch issuer endpoint could not be acquired; no alternate port selected.'
                : 'Launch issuer endpoint could not be acquired.')));
            server.listen(origin === null ? 0 : Number(origin.split(':').at(-1)), '127.0.0.1', () => {
                server.unref();
                this.httpServer = server;
                this.issuerOrigin = `http://127.0.0.1:${server.address().port}`;
                resolve(this.issuerOrigin)
            })
        })
    }

    /**
     * @summary Close the listener and drop every grant, then destroy the instance.
     */
    destroy() {
        try {
            if (this.continuityPhase !== 'handed-off') {
                this.generations.forEach(generation => this.revoke(generation.agentId, REASONS.REPLACED))
            }
        } finally {
            this.httpServer?.close();
            this.journal?.close();
            super.destroy()
        }
    }

    /** @summary Release this process's endpoint and lease without claiming a clean transition. */
    async closeUnclean() {
        if (this.continuityPhase === 'handed-off') return;
        this.continuityPhase = 'unavailable';
        this.grants.clear();
        this.journal?.close();
        if (this.httpServer) {
            const server = this.httpServer;
            this.httpServer = this.listening = null;
            await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        }
    }

    /**
     * @summary Follow a registry's committed definition writes (see {@link onDefinitionChange}).
     * @param {Object|null} registry
     * @protected
     */
    observeRegistry(registry) {
        if (typeof registry?.on !== 'function' || this.observedRegistries.has(registry)) return;

        this.observedRegistries.add(registry);
        registry.on('definitionChange', this.onDefinitionChange, this)
    }

    /**
     * @summary Revoke what a committed definition write invalidates: the whole generation for a removed seat
     * or a changed harness, MCP target, launch owner or launch override, one server's grant when that server
     * is switched off. A server switched on gets nothing.
     * @param {Object} event `{id, previous, next}`.
     * @protected
     */
    onDefinitionChange({id, next}) {
        const generation = this.generations.get(id);

        if (!generation || generation.state === STATES.REVOKED) return;
        if (!next) return void this.revoke(id, REASONS.AGENT_REMOVED);

        const before = generation.definition, after = projectDefinition(next);

        if (!before) return void this.revoke(id, REASONS.PLAN_CHANGED);

        if (after.harnessType !== before.harnessType || after.launchOwner !== before.launchOwner ||
            after.rawLaunch !== before.rawLaunch || !isDeepStrictEqual(after.mcpTarget, before.mcpTarget)) {
            return void this.revoke(id, REASONS.PLAN_CHANGED)
        }

        generation.servers.forEach(server => {
            if (!after.matrix[server.key] && server.state !== STATES.REVOKED) revokeServer(server, REASONS.SERVER_DISABLED)
        });

        generation.definition = after;
        this.persistAdmission()
    }

    /**
     * @summary Serve one HTTP request: `POST` on the one path, `Host` naming this listener, a bounded JSON
     * body. A redemption that is refused answers 403, a malformed one 400.
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     * @protected
     */
    async handle(req, res) {
        const reply = (status, payload) => {
            res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});
            res.end(JSON.stringify(payload))
        };

        if (req.method !== 'POST' || req.url !== LAUNCH_ADMISSION_PATH || req.headers.host !== `127.0.0.1:${this.httpServer?.address()?.port}`) {
            req.resume();
            return reply(404, this.refuseUnattributed(REFUSALS.MALFORMED))
        }

        let body;

        try {
            body = JSON.parse(await readBody(req))
        } catch {
            return reply(400, this.refuseUnattributed(REFUSALS.MALFORMED))
        }

        const payload = await this.redeem(body);

        reply(payload.outcome === OUTCOMES.ADMITTED ? 200 : payload.code === REFUSALS.MALFORMED ? 400 : 403, payload)
    }

    /**
     * @summary Record an answer against its seat and sign it with the grant's secret.
     * @protected
     */
    answer(generation, server, request, payload) {
        record(generation.audit, {at: new Date().toISOString(), server: server.key, outcome: payload.outcome, code: payload.code ?? null,
            reason: payload.reason ?? null, generationRoot: generation.generationRoot}, this.auditLimit);

        return signLaunchResponse(server.secret, request, payload)
    }

    /**
     * @summary Refuse a request that proved no grant, recording it without attribution.
     * @protected
     */
    refuseUnattributed(code) {
        record(this.unattributed, {at: new Date().toISOString(), outcome: OUTCOMES.REFUSED, code}, this.auditLimit);

        return launchRefusal(code)
    }

    /**
     * @summary Wait until a reserved generation settles, or until {@link pendingTimeoutMs} passes.
     * @param {Object} generation
     * @returns {Promise<Boolean>} Whether it settled.
     * @protected
     */
    waitForSettlement(generation) {
        return new Promise(resolve => {
            const
                done  = settled => {
                    clearTimeout(timer);
                    generation.waiters.delete(done);
                    resolve(settled)
                },
                timer = setTimeout(() => done(false), this.pendingTimeoutMs);

            timer.unref?.();
            generation.waiters.add(done)
        })
    }

    /**
     * @summary Release every redemption waiting on a generation, to re-check it.
     * @protected
     */
    settle(generation) {
        [...generation.waiters].forEach(done => done(true))
    }
}

/**
 * @summary The validated forge login a seat's rows and grants carry: never the Fleet id, which may differ.
 * @private
 */
function loginOf(agent) {
    return typeof agent?.githubUsername === 'string' ? agent.githubUsername.trim().replace(/^@/, '') : ''
}

/**
 * @summary The definition facts a generation was minted for.
 * @private
 */
function projectDefinition(definition) {
    return {
        harnessType: definition.harnessType ?? null,
        launchOwner: definition.launchOwner ?? null,
        rawLaunch  : Boolean(definition.metadata?.launch),
        mcpTarget  : definition.mcpTarget ?? null,
        matrix     : resolveMcpMatrix(definition.mcpServers, mcpCatalogFor(definition.forge))
    }
}

/** @private */
function revokeServer(server, reason) {
    Object.assign(server, {state: STATES.REVOKED, reason, env: null, args: null, owned: []})
}

/**
 * @summary What a credential's owner holds now: a non-blank string, else `null`. An owner that throws holds
 * nothing.
 * @private
 */
function readOwner(owner) {
    try {
        const value = owner.resolve();

        return typeof value === 'string' && value.trim() ? value : null
    } catch {
        return null
    }
}

/** @summary Return a fixed credential-type label, never an owner-supplied value. @param {Object} owner @returns {String|undefined} */
function ownerCredentialKind(owner) {
    if (owner.credential === 'seat-pat') return 'seat-pat';
    if (owner.credential === 'plane-bearer') return 'plane-bearer';
    if (owner.credential === 'bridge-token') return 'bridge-token'
}

/**
 * @summary Ask the lifecycle's process proof; a probe that is missing or throws observes nothing.
 * @private
 */
function observeProcess(probe) {
    try {
        return typeof probe === 'function' ? probe() : 'unknown'
    } catch {
        return 'unknown'
    }
}

/** @private */
function record(ring, entry, limit) {
    ring.push(entry);
    ring.length > limit && ring.splice(0, ring.length - limit)
}

/**
 * @summary Read a request body up to the protocol's bound.
 * @private
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let   size   = 0;

        req.on('data', chunk => {
            size += chunk.length;

            if (size > LAUNCH_ADMISSION_MAX_BYTES) {
                req.destroy();
                reject(new RangeError('body too large'))
            } else {
                chunks.push(chunk)
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject)
    })
}

export default Neo.setupClass(McpLaunchAdmissionService);
