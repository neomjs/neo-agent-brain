import crypto                     from 'node:crypto';
import http                       from 'node:http';
import path                       from 'node:path';
import {isDeepStrictEqual}        from 'node:util';
import Base                       from 'neo.mjs/src/core/Base.mjs';
import {
    LAUNCH_ADMISSION_OUTCOMES as OUTCOMES,
    LAUNCH_ADMISSION_REASONS  as REASONS,
    LAUNCH_ADMISSION_REFUSALS as REFUSALS,
    LAUNCH_ADMISSION_STATES   as STATES
}                                 from '../../../src/fleet/contract/launchAdmission.mjs';
import {mcpCatalogFor, resolveMcpMatrix} from '../../../src/fleet/contract/mcpServers.mjs';
import {launchRowEnvNames}        from './managedAgentWorkspacePlan.mjs';
import {
    LAUNCH_ADMISSION_MAX_BYTES,
    LAUNCH_ADMISSION_PATH,
    isLaunchIdentity,
    launchRefusal,
    mintLaunchGrant,
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
 * Nothing re-enables a grant: a server switched back on waits for a managed restart. A new Fleet process
 * holds no generation, so a seat it adopts reads `stale` until it is restarted.
 *
 * **Custody.** A seat credential stays with its owner: the registry holds the PAT; the explicit tenant
 * or the plane binding holds the plane credential. Each redemption resolves it from the owner Start
 * selected, proves that value, and hands over exactly the proved bytes. A missing or unproved value
 * refuses the child and never falls back to another credential class, so a changed registry PAT never
 * stands in for a plane credential. The issuer holds only what Start itself or the Fleet's configuration
 * produced, such as the Bridge token, for the generation's lifetime, and drops it at revocation. No new
 * credential is persisted.
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
     * How long a credential proof may take before it counts as unproved. With {@link pendingTimeoutMs}, it
     * stays inside the launcher's own bound.
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
     * Per agent id, the seat-wide revocations asked for, whether or not a generation existed to take them:
     * `{count, reason}` of the last one. A Start reads the count as it begins ({@link revocationMark}).
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

    /**
     * @summary Mint one grant per enabled server for a seat's next Start, ending the seat's previous
     * generation. The registry the definition came from is followed from here on.
     *
     * The generation is published before anything is awaited, so every revocation from then on reaches it.
     * What came before is caught up at once. A Stop asked for since the Start's `since` mark revokes it,
     * and so does a definition write since the caller's read. A Start therefore answers for its whole
     * attempt, not just the part after it reserved.
     * @param {Object} options
     * @param {Object} options.agent The raw registry definition.
     * @param {Object} [options.registry] Its registry, an Observable firing `definitionChange` that reads
     *     raw definitions through `getDefinition`.
     * @param {Number} [options.since] The {@link revocationMark} the Start read as it began.
     * @returns {Promise<{generation: String, issuer: String, identity: String, grants: Object<String, String>}>}
     *     `grants` maps each enabled server to the capability its profile row carries; `identity` is the
     *     validated login the rows must name.
     */
    async reserve({agent, registry = null, since = null}) {
        const identity = loginOf(agent);

        if (!isLaunchIdentity(identity)) {
            throw new Error(`McpLaunchAdmissionService.reserve: agent '${agent?.id}' has no valid githubUsername identity.`)
        }

        this.observeRegistry(registry);

        const
            previous   = this.generations.get(agent.id),
            definition = projectDefinition(agent),
            generation = {
                id         : crypto.randomUUID(),
                agentId    : agent.id,
                identity,
                state      : STATES.RESERVED,
                reason     : null,
                reservedAt : new Date().toISOString(),
                activatedAt: null,
                revokedAt  : null,
                definition,
                servers    : new Map(),
                owners     : {},
                proofs     : new Map(),
                probe      : null,
                waiters    : new Set(),
                audit      : []
            },
            grants     = {};

        if (previous) {
            this.revoke(agent.id, REASONS.REPLACED, {generation: previous.id});
            previous.servers.forEach(server => this.grants.delete(server.grantId))
        }

        for (const [key, enabled] of Object.entries(definition.matrix)) {
            if (!enabled) continue;

            const grant = mintLaunchGrant();

            generation.servers.set(key, {key, grantId: grant.id, secret: grant.secret, state: STATES.RESERVED, reason: null, args: null, env: null, owned: []});
            this.grants.set(grant.id, {generation, key});
            grants[key] = grant.capability
        }

        // Published before anything is awaited, then caught up with what fired before it could hear it
        this.generations.set(agent.id, generation);

        if (since !== null && this.revocationMark(agent.id) !== since) {
            this.revoke(agent.id, this.revocations.get(agent.id).reason, {generation: generation.id})
        }

        registry?.getDefinition && this.onDefinitionChange({id: agent.id, next: registry.getDefinition(agent.id)});

        let issuer;

        try {
            issuer = await this.listen()
        } catch (error) {
            this.revoke(agent.id, REASONS.START_FAILED, {generation: generation.id});
            throw error
        }

        return {generation: generation.id, issuer, identity, grants}
    }

    /**
     * @summary Bind a reserved generation to the Start that launched and leased its seat. Each server
     * redeems its row's values ({@link Neo.ai.services.fleet.managedAgentWorkspacePlan.launchRowEnvNames}):
     * a seat credential from its owner at each redemption, every other value from the environment Start
     * injected. It also gets the argv of its fixed target. A server whose required value has neither is
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
     *     `prove(value)` answers `{ok}`.
     * @param {Function} options.probe `() => 'live'|'gone'|'unknown'`, whether the launched process is still
     *     the seat: the lifecycle's own process proof.
     * @returns {Object} The seat's admission status ({@link statusOf}).
     */
    activate({generation: id, agentId, plan, env, owners = {}, probe}) {
        const generation = this.generations.get(agentId);

        if (generation?.id !== id || generation.state !== STATES.RESERVED) return this.statusOf(agentId);

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
            server.env   = Object.fromEntries(held.map(name => [name, env[name]]));
            server.args  = row.target === 'tenant'
                ? [path.join(row.sourceRoot, BRIDGE_ENTRYPOINT), '--url', row.url, '--token-env', row.credentialEnvVar]
                : [...row.args];
            server.state = STATES.ACTIVE
        }

        Object.assign(generation, {state: STATES.ACTIVE, activatedAt: new Date().toISOString(), owners: {...owners}, probe});
        this.settle(generation);

        return this.statusOf(agentId)
    }

    /**
     * @summary End a seat's generation for good: no grant of it admits again, and the values and owners it
     * held are dropped. Waiting redemptions are answered with the refusal. A revocation of the seat rather
     * than of one generation is also counted when no generation takes it, so the reservation of a Start
     * already under way catches it up ({@link reserve}).
     * @param {String} agentId
     * @param {String} reason A `LAUNCH_ADMISSION_REASONS` value.
     * @param {Object} [options]
     * @param {String} [options.generation] Revoke only this generation, never a newer one.
     * @returns {Boolean} Whether a generation was revoked by this call.
     */
    revoke(agentId, reason, {generation: id = null} = {}) {
        const generation = this.generations.get(agentId);

        if (!id) this.revocations.set(agentId, {count: this.revocationMark(agentId) + 1, reason});

        if (!generation || (id && generation.id !== id) || generation.state === STATES.REVOKED) return false;

        Object.assign(generation, {state: STATES.REVOKED, reason, revokedAt: new Date().toISOString(), probe: null, owners: {}});
        generation.proofs.clear();
        generation.servers.forEach(server => revokeServer(server, server.state === STATES.REVOKED ? server.reason : reason));
        this.settle(generation);

        return true
    }

    /**
     * @summary How many seat-wide revocations the seat has been asked for. A Start reads it as it begins and
     * hands it to {@link reserve}, so a Stop asked for while the Start provisions, before any generation
     * exists to take it, still ends that Start's admission.
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
     * @returns {{state: String, reason: String|null, generation: String|null, since: String|null,
     *     servers: Object[], recent: Object[]}}
     */
    statusOf(agentId, {running = false} = {}) {
        const generation = this.generations.get(agentId);

        if (!generation) {
            return {
                state     : running ? STATES.STALE : STATES.NONE,
                reason    : running ? REASONS.ISSUER_REPLACED : null,
                generation: null,
                since     : null,
                servers   : [],
                recent    : []
            }
        }

        return {
            state     : generation.state,
            reason    : generation.reason,
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

        if (server.state === STATES.RESERVED && generation.state === STATES.RESERVED && !await this.waitForSettlement(generation)) {
            return refuse(REFUSALS.PENDING_TIMEOUT)
        }

        const revoked = () => generation.state !== STATES.ACTIVE || server.state !== STATES.ACTIVE;

        if (revoked()) return refuse(REFUSALS.REVOKED, server.reason ?? generation.reason);

        const
            owners      = server.owned.map(name => generation.owners[name]),
            credentials = server.owned.map((name, index) => readOwner(owners[index])),
            missing     = credentials.indexOf(null);

        if (missing > -1) return refuse(REFUSALS.CREDENTIAL_MISSING, owners[missing].credential);

        const unproven = (await Promise.all(server.owned.map((name, index) => this.prove(generation, name, credentials[index])))).indexOf(false);

        if (unproven > -1) return refuse(REFUSALS.CREDENTIAL_UNPROVEN, owners[unproven].credential);

        if (revoked()) return refuse(REFUSALS.REVOKED, server.reason ?? generation.reason);

        const observed = observeProcess(generation.probe);

        if (observed === 'gone') {
            this.revoke(generation.agentId, REASONS.PROCESS_EXITED, {generation: generation.id});
            return refuse(REFUSALS.REVOKED, REASONS.PROCESS_EXITED)
        }

        if (observed !== 'live') return refuse(REFUSALS.PROCESS_UNKNOWN);

        return answer({
            outcome: OUTCOMES.ADMITTED,
            env    : {...server.env, ...Object.fromEntries(server.owned.map((name, index) => [name, credentials[index]]))},
            args   : [...server.args]
        })
    }

    /**
     * @summary Prove one credential value with its owner. Concurrent redemptions proving the same value share
     * one proof; a proof that throws, answers anything but `ok: true`, or outlasts {@link proofTimeoutMs} did
     * not prove.
     * @param {Object} generation
     * @param {String} name The name the value goes under.
     * @param {String} value
     * @returns {Promise<Boolean>}
     * @protected
     */
    prove(generation, name, value) {
        const
            {owners, proofs} = generation,
            key              = `${name}\0${crypto.createHash('sha256').update(value).digest('base64url')}`;

        if (!proofs.has(key)) {
            let timer;

            const proof = Promise.race([
                Promise.resolve().then(() => owners[name].prove(value)),
                new Promise(resolve => (timer = setTimeout(resolve, this.proofTimeoutMs, null)).unref?.())
            ])
                .then(result => result?.ok === true, () => false)
                .finally(() => {
                    clearTimeout(timer);
                    proofs.get(key) === proof && proofs.delete(key)
                });

            proofs.set(key, proof)
        }

        return proofs.get(key)
    }

    /**
     * @summary Start the loopback listener once, on an ephemeral port. A new Fleet process gets a new port,
     * so a row written by an earlier one reaches no issuer.
     * @returns {Promise<String>} The origin profile rows name.
     */
    listen() {
        return this.listening ??= new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => void this.handle(req, res));

            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.unref();
                this.httpServer = server;
                resolve(`http://127.0.0.1:${server.address().port}`)
            })
        })
    }

    /**
     * @summary Close the listener and drop every grant, then destroy the instance.
     */
    destroy() {
        this.generations.forEach(generation => this.revoke(generation.agentId, REASONS.REPLACED));
        this.httpServer?.close();

        super.destroy()
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

        if (after.harnessType !== before.harnessType || after.launchOwner !== before.launchOwner ||
            after.rawLaunch !== before.rawLaunch || !isDeepStrictEqual(after.mcpTarget, before.mcpTarget)) {
            return void this.revoke(id, REASONS.PLAN_CHANGED)
        }

        generation.servers.forEach(server => {
            if (!after.matrix[server.key] && server.state !== STATES.REVOKED) revokeServer(server, REASONS.SERVER_DISABLED)
        });

        generation.definition = after
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
        record(generation.audit, {at: new Date().toISOString(), server: server.key, outcome: payload.outcome, code: payload.code ?? null, reason: payload.reason ?? null}, this.auditLimit);

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
        let size = 0;

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
