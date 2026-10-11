import crypto                                                   from 'crypto';
import fs                                                       from 'fs';
import path                                                     from 'path';
import aiConfig                                                 from '../../config.mjs';
import Base                                                     from 'neo.mjs/src/core/Base.mjs';
import Observable                                               from 'neo.mjs/src/core/Observable.mjs';
import {HARNESS_TYPES}                                          from '../../../src/fleet/contract/harnessTypes.mjs';
import {writeFileAtomicSync}                                    from '../shared/atomicFileWrite.mjs';
import {mcpCatalogFor, normalizeMcpOverrides, resolveMcpMatrix} from '../../../src/fleet/contract/mcpServers.mjs';
import {REPO_FORGES}                                            from './deriveAgentRepoPath.mjs';
import {mcpDeclarationRefusal}                                  from './managedAgentWorkspacePlan.mjs';
import {normalizeMcpTarget}                                     from './mcpServers.mjs';
import {normalizeMemoryImport}                                  from './seatMemoryImport.mjs';
import {normalizeGitIdentityDeclaration}                        from './seatGitIdentity.mjs';
import {normalizeSeatModelDeclaration}                          from './seatModelDeclaration.mjs';
import SeatOperatorRegistryService, {isOwnerPrincipal}          from './SeatOperatorRegistryService.mjs';

const
    // a refused operator claim in the operator's words: the store's own reason can name a host path
    CLAIM_REFUSALS          = Object.freeze({
        busy               : "another change to the seats' operators is in progress; try again",
        'no-principal'     : 'the admission carries no owner principal',
        'store-unavailable': "the seats' operator record cannot be trusted and needs repair on the plane host"
    }),
    FORGE_HOSTNAME_RE       = /^(?:[a-z0-9._-]+|\[[0-9a-f:]+\])$/,
    LAUNCH_OWNERS           = Object.freeze(['external', 'fleet']),
    OPERATOR_FIELDS         = Object.freeze(['operatedBy', 'ownerPrincipal']),
    RETIRED_TARGET_FIELD    = ['mcp', 'Transport'].join(''),
    PUBLIC_SENSITIVE_KEY_RE = /^(?:credentials?|secrets?|tokens?|(?:github)?pats?|passwords?|authorization|(?:api|client|private)(?:key|token|secret|credential|password)s?|personalaccess(?:key|token|secret|credential|password)s?|(?:access|auth|bearer|github|id|oauth|refresh|session)(?:key|token|secret|credential|password)s?|launch|command|args|argv|env|environment)$/;

/**
 * @summary Resolve the one AES-256 key shared by Fleet's repository-credential and remote-plane
 * credential stores. The canonical on-disk encoding is 32 raw bytes. The earlier tenant store wrote
 * the same logical key as 64 ASCII hex bytes; that legacy form is decoded and atomically migrated
 * in place so existing ciphertext remains decryptable. Any other existing shape fails loud and is
 * never overwritten.
 *
 * Creation is race-safe: `wx` elects one writer, and losers read + validate the winner. Migration
 * uses a `0600` temporary sibling followed by atomic rename; concurrent legacy migrations publish
 * the same decoded key.
 *
 * @param {Object} options
 * @param {String} options.dataDir Absolute Fleet data directory.
 * @param {Object} [options.env=process.env] Environment authority.
 * @param {String} [options.serviceName='Fleet credential store'] Error-message owner.
 * @returns {Buffer} Exactly 32 key bytes.
 */
export function resolveFleetCredentialKey({
    dataDir,
    env         = process.env,
    serviceName = 'Fleet credential store'
} = {}) {
    const envKey = env.NEO_FLEET_SECRET_KEY;

    if (envKey) {
        const key = Buffer.from(envKey, /^[0-9a-fA-F]{64}$/.test(envKey) ? 'hex' : 'base64');

        if (key.length !== 32) {
            throw new Error(`${serviceName}: NEO_FLEET_SECRET_KEY must decode to 32 bytes (AES-256).`)
        }

        return key
    }

    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
        throw new Error(`${serviceName}: dataDir must be an absolute path.`)
    }

    const
        keyFile         = path.join(dataDir, 'fleet.key'),
        readExistingKey = () => {
            const raw = fs.readFileSync(keyFile);

            if (raw.length === 32) return raw;

            const legacyHex = raw.toString('ascii');

            if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(legacyHex)) {
                const key = Buffer.from(legacyHex, 'hex');

                // Binary payload: `encoding: null` so the key is written as bytes, not re-encoded.
                writeFileAtomicSync(keyFile, key, {encoding: null});

                return key
            }

            throw new Error(
                `${serviceName}: fleet.key must contain exactly 32 raw bytes or legacy 64-character hex.`
            )
        };

    try {
        return readExistingKey()
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }

    fs.mkdirSync(dataDir, {recursive: true});

    const key = crypto.randomBytes(32);

    try {
        fs.writeFileSync(keyFile, key, {flag: 'wx', mode: 0o600});
        return key
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;

        return readExistingKey()
    }
}

/**
 * @summary Returns whether a normalized public-definition key carries credential or launch
 * authority. Anchoring is deliberate: `refreshToken` and `client_secret` are denied, while benign
 * descriptive fields such as `credentialState`, `tokenBudget`, and `commandLabel` survive.
 * @param {String} key
 * @returns {Boolean}
 */
function isPublicSensitiveKey(key) {
    const normalized = key.replaceAll('-', '').replaceAll('_', '').toLowerCase();

    return PUBLIC_SENSITIVE_KEY_RE.test(normalized)
}

/**
 * @summary A seat home is an absolute path or nothing — a relative value would be re-rooted by
 * whoever reads it, which is the silent re-homing the record exists to prevent.
 * @param {*}      value
 * @param {String} caller The registry method name, for the error.
 * @private
 */
function assertSeatHome(value, caller) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error(`FleetRegistryService.${caller}: seatHome must be an absolute path.`)
    }
}

/**
 * @summary Recursively remove credential/launch vocabulary from a caller-owned public projection.
 * Registry metadata is intentionally extensible, so redaction must guard nested legacy entries as
 * well as the current top-level fields. Keys normalize hyphens/underscores and case before lookup.
 * @param {*} value Structured-cloned public value.
 * @param {WeakSet<Object>} [seen]
 * @returns {*} The same redacted value.
 */
function redactPublicFields(value, seen=new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
        return value
    }

    seen.add(value);

    Object.keys(value).forEach(key => {
        if (isPublicSensitiveKey(key)) {
            delete value[key]
        } else {
            redactPublicFields(value[key], seen)
        }
    });

    return value
}

/**
 * @summary Canonicalize one persisted target without letting a corrupt row acquire tenant
 * authority. Absence and invalid stored shapes both fail closed to the resident target.
 * @param {*} target
 * @returns {Object|null}
 */
function normalizeStoredMcpTarget(target) {
    try {
        return normalizeMcpTarget(target ?? null)
    } catch {
        return null
    }
}

/**
 * @summary The forge account a seat's PAT belongs to, as its definition records it. GitHub is the default and
 * records nothing, so its PAT is presented to `https://github.com` only. A GitLab PAT records its instance's
 * origin, because a self-hosted host cannot be derived. Only {@link Neo.ai.services.fleet.FleetRegistryService#defineAgent}
 * writes these fields, beside the PAT, so no scoped verb (`setRepo` among them) can re-point where a clone
 * presents it. The hostname is letters, digits, `.`, `_` and `-` (an IDN arrives as punycode), or a bracketed IPv6
 * literal, which the parser serializes as hex and `:`. Either way the origin can key git's credential config
 * verbatim: a URL parser admits `=` in a host, which would split git's `-c key=value`.
 * @param {String} forge       `github` or `gitlab`.
 * @param {*}      [forgeHost] The GitLab instance's bare `https` origin.
 * @returns {Object} `{}` for GitHub, `{forge: 'gitlab', forgeHost}` with the normalized origin for GitLab.
 * @throws {Error} On an unknown forge, a host given with GitHub, or a GitLab host that is not a bare `https`
 * origin. The refusal never echoes the host, which could carry a token in its userinfo.
 */
function forgeAccount(forge, forgeHost) {
    if (!REPO_FORGES.includes(forge)) {
        throw new Error(`FleetRegistryService.defineAgent: 'forge' must be one of ${REPO_FORGES.join(', ')}.`)
    }

    if (forge === 'github') {
        if (forgeHost != null) {
            throw new Error("FleetRegistryService.defineAgent: 'forgeHost' names a GitLab instance; a GitHub PAT belongs to github.com.")
        }

        return {}
    }

    let url = null;

    try {
        url = new URL(forgeHost)
    } catch {}

    if (url?.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !FORGE_HOSTNAME_RE.test(url.hostname)) {
        throw new Error("FleetRegistryService.defineAgent: a GitLab seat's 'forgeHost' must be its instance's https origin, such as 'https://gitlab.example.com'.")
    }

    return {forge, forgeHost: url.origin}
}

/**
 * @summary The commit identity a definition declares, validated for the verb that writes it
 * ({@link module:ai/services/fleet/seatGitIdentity.normalizeGitIdentityDeclaration}).
 * @param {String} method The writing verb, which prefixes a refusal.
 * @param {Object} fields `{gitName, gitEmail}`.
 * @returns {{gitName: String, gitEmail: String}|null} `null` when neither field is given.
 * @throws {TypeError} On half a pair or a malformed field.
 */
function gitIdentityDeclaration(method, fields) {
    try {
        return normalizeGitIdentityDeclaration(fields)
    } catch (error) {
        throw new TypeError(`FleetRegistryService.${method}: ${error.message}`)
    }
}

/**
 * @summary The model and reasoning effort an intent declares, validated for the seat's harness
 * ({@link module:ai/services/fleet/seatModelDeclaration.normalizeSeatModelDeclaration}).
 * @param {String} method      The writing verb, which prefixes a refusal.
 * @param {String} harnessType The seat's harness family once the change applies.
 * @param {Object} fields      The intent.
 * @returns {{model?: String|null, reasoningEffort?: String|null}} The fields the intent names.
 * @throws {TypeError} On a malformed value, or on a value for a harness that takes none.
 */
function seatModelDeclaration(method, harnessType, fields) {
    try {
        return normalizeSeatModelDeclaration(harnessType, fields)
    } catch (error) {
        throw new TypeError(`FleetRegistryService.${method}: ${error.message}`)
    }
}

/**
 * @class Neo.ai.services.fleet.FleetRegistryService
 * @extends Neo.core.Base
 * @singleton
 *
 * @summary
 * The Brain-side (Node-only) registry of Fleet Manager agent definitions and their credentials.
 * This is the first leaf of the Fleet Manager MVP: the `define` surface of the operator loop
 * *define agents → start/stop → repos managed under the hood*.
 *
 * An **agent definition** is `{id, githubUsername, harnessType, modelProvider, mcpServers,
 * mcpTarget, launchOwner, metadata, createdAt, updatedAt}`, plus `forge` and `forgeHost` for a GitLab seat and
 * `gitName` and `gitEmail` for a seat whose commit identity is declared, and `model` and `reasoningEffort` for one
 * whose harness starts on a declared model — never a secret. `modelProvider` (the agent's model-provider login) resolves via the AiConfig
 * `modelProvider` SSOT leaf when not supplied — read-only, no service-local default shadow. The associated **credential** (the seat's
 * forge PAT: GitHub's, or a GitLab instance's) is stored separately, encrypted at
 * rest, and is the load-bearing security boundary of this service:
 *
 * **Two-hemisphere security rule** (the graduated Agent Harness design rule): the PAT is a
 * Node-side secret. It is written *in* via {@link defineAgent}, stored encrypted, and
 * is **never** returned by the public read API ({@link getAgent} / {@link listAgents}). Only the
 * dedicated Brain-internal {@link resolveCredential} accessor decrypts it — for the instance spawner
 * (a later FM leaf) — so the Body-side settings pane can never read a PAT back.
 *
 * **Two credential classes, deliberately separated at the store + method level:** (1) the
 * GitHub **PAT** above — *reversibly* encrypted, because the spawner must inject the real token into
 * a harness env; served only by {@link resolveCredential}. (2) the **Bridge session token**
 * ({@link mintBridgeToken}) — a registry-minted, short-lived, **asymmetrically-signed** credential
 * for agent↔Neural-Link-Bridge transport auth. It is stateless (nothing persisted): an Ed25519
 * signature over `{agentId, expiresAt}` that the network-facing Bridge verifies with only the
 * **public** key ({@link getBridgePublicKey}) — so a Bridge compromise can neither read the PAT
 * store nor forge a token. The private signing key ({@link getSigningKey}) never decrypts the PAT
 * store; the two credential classes stay key-separated.
 *
 * **Storage** lives under `dataDir` (the canonical `AiConfig.fleet.dataDir` plane member, with an
 * explicit instance/test override seam — the per-tenant data root is the multi-tenant isolation
 * seam):
 * - `registry.json`    — agent definitions (no secrets), human-readable JSON.
 * - `credentials.enc`  — the encrypted `{agentId: pat}` map (AES-256-GCM, `0600`).
 * - `fleet.key`        — dev-only generated `0600` AES key file, used when `NEO_FLEET_SECRET_KEY`
 *                        is not set. Production deployments SHOULD provide the env key.
 * - `signing.key`      — dev-only generated `0600` Ed25519 signing key (PKCS8 PEM), used when
 *                        `NEO_FLEET_SIGNING_KEY` is not set. Only its PUBLIC half goes to the Bridge.
 *
 * **Fail-closed:** an absent / locked / corrupt credential store never throws into the define/list
 * path and never surfaces plaintext — {@link resolveCredential} returns `null`.
 *
 * **Launch ownership** (`launchOwner`) says who starts a seat: `fleet` when this fleet is its only
 * launcher, `external` when it runs in a harness the fleet did not start. It decides whether a seat
 * with no process record may be read as stopped, so it enables a Brain-credentialed spawn and is kept
 * out of `metadata`: {@link defineAgent} takes it as creation intent — an explicit value is an ownership
 * act and records `launchOwnerSince` in the same write — {@link setLaunchOwner} is the one write after
 * that, and a row without it reads `external` with no act recorded. A seat released to its own harness
 * by either act is never started by this fleet until it is adopted, whatever process record it holds
 * ({@link launchRefusalOf}).
 *
 * **Seat home** (`seatHome`) is where a seat's files live — the absolute `<agentsRoot>/<id>` that holds
 * its clone and harness home. Fleet derives that path from the agents root at every start, so the row
 * records it at birth ({@link defineAgent}, under {@link getAgentsRoot}) and the start composer
 * ({@link Neo.ai.services.fleet.startAgentProvisioned}) refuses a derivation that differs from the
 * record instead of provisioning a second, empty seat under a changed root. A row older than the
 * record names none and stays refused until it is bound; the move and that first bind are the one
 * write after birth ({@link relocateSeatHome}), never an adoption of whatever directory exists.
 *
 * **Change event:** each committed definition write fires `definitionChange` with `{id, previous, next}`,
 * synchronously and after the registry file holds it (`previous` is `null` for a created row, `next` for a
 * removed one). Native launch admission revokes a running seat's grants from it, so no write path can
 * leave a grant standing for a server it switched off.
 */
class FleetRegistryService extends Base {
    /**
     * @member {Boolean} observable=true
     * @static
     */
    static observable = true

    static config = {
        /**
         * @member {String} className='Neo.ai.services.fleet.FleetRegistryService'
         * @protected
         */
        className: 'Neo.ai.services.fleet.FleetRegistryService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true,
        /**
         * @member {String|null} dataDir_=null
         * @summary Optional instance-local Fleet data-root override for isolation and tests.
         * Production leaves this null so {@link getDataDir} reads the canonical
         * `AiConfig.fleet.dataDir` plane member at the use site. Changing it transparently reloads
         * the in-memory registry on the next call.
         */
        dataDir_: null,
        /**
         * @member {String|null} agentsRoot_=null
         * @summary Optional override of the agents root a new row's `seatHome` is recorded under, for
         * isolation and tests. Production leaves this null so {@link getAgentsRoot} reads the canonical
         * `AiConfig.fleet.agentsRoot` leaf at the use site — the leaf the Fleet entrypoint also injects
         * as the manager's managed root and the lifecycle's instance root.
         */
        agentsRoot_: null
    }

    /**
     * Whitelist of supported harness types an agent definition may declare — derived from the ONE
     * client contract (`src/fleet/contract/harnessTypes.mjs`): adding a harness there updates this
     * validation set and the catalog exposed to installed-package consumers.
     * @member {String[]} harnessTypes
     * @protected
     */
    harnessTypes = HARNESS_TYPES.map(entry => entry.type)

    /**
     * Default lifetime of a minted Bridge session token, in milliseconds (1h). Short-lived by
     * design — rotation falls out of expiry. Overridable per call via `mintBridgeToken(id, {ttlMs})`.
     * @member {Number} bridgeTokenTtlMs=3600000
     * @protected
     */
    bridgeTokenTtlMs = 60 * 60 * 1000

    /**
     * In-memory cache of agent definitions (no secrets), keyed by agent id.
     * @member {Map<String,Object>} agents
     * @private
     */
    agents = new Map()

    /**
     * The resolved `dataDir` the in-memory `agents` cache was last loaded from; guards transparent
     * reloads when `dataDir` changes (e.g. across tests / tenants).
     * @member {String|null} loadedDir=null
     * @private
     */
    loadedDir = null

    /**
     * Why the last registry read failed, or null after a clean (or absent) read: an unreadable registry
     * loads empty, and this keeps that emptiness from passing for "no such seat".
     * @member {String|null} registryUnreadable=null
     * @private
     */
    registryUnreadable = null

    // ---- public API ---------------------------------------------------------

    /**
     * Create an agent and store its credential. Every agent holds its forge's PAT (GitHub's unless
     * `forge` says GitLab): a GitHub seat started without one runs `gh` untokened, and `gh` falls back
     * to the machine's keyring account. Existing
     * ids reject: every edit of an established resident must use a scoped authority
     * (`configureAgent`, `setRepo`, `setAvatar`, or the Brain-only launch override), never replay this
     * credential-bearing creation surface. A credential store this Fleet cannot read refuses the create
     * before anything is written, so the other seats' PATs survive it.
     * @param {Object}  opts
     * @param {String}  opts.githubUsername     The agent's GitHub username (required).
     * @param {String}  opts.harnessType        One of {@link harnessTypes} (required).
     * @param {String}  opts.credential         The forge PAT (required) — stored Node-side encrypted; never echoed back.
     * @param {String} [opts.forge='github']    `gitlab` for a seat whose PAT belongs to a GitLab instance.
     * @param {String} [opts.forgeHost]         That instance's bare `https` origin, required with `gitlab`. It binds
     *     the PAT: a clone presents it to this origin only (see `forgeAccount`).
     * @param {String} [opts.id=githubUsername] Stable id; pass an explicit id to register multiple instances per user.
     * @param {Object} [opts.metadata={}]       Free-form non-secret metadata.
     * @param {String} [opts.modelProvider]     The agent's model-provider login (e.g. `openAiCompatible`, `ollama`). Resolves via the AiConfig `modelProvider` SSOT leaf when omitted — no service-local default shadow. Non-secret; carried in the public definition.
     * @param {Object|null} [opts.mcpServers]   Sparse MCP overrides shared with configureAgent; omitted/null follows defaults.
     * @param {Object|null} [opts.mcpTarget] Resident (`null` / `{kind:'resident'}`) or
     *     `{kind:'tenant', tenantId}`. No transport, URL, header, env, command, or credential bag.
     * @param {String} [opts.launchOwner='external'] `fleet` for a seat this fleet launches from birth,
     *     `external` for one that runs in its own harness. Passing either is an ownership act and records
     *     `launchOwnerSince` with the row; omitting it records no act, so the seat's process record stays
     *     its only start gate.
     * @param {String} [opts.memoryImport] The seat adopts an existing agent: that agent's memory folder
     *     ({@link module:ai/services/fleet/seatMemoryImport.normalizeMemoryImport}), or `'none'` to start
     *     empty. Start copies it into the family's own memory folder and refuses while it reads empty.
     *     Omitted, the seat is a fresh one.
     * @param {String} [opts.gitName]  The name the seat's commits carry, declared with `gitEmail`. Omitted, Start
     *     derives the identity from the seat's forge account ({@link module:ai/services/fleet/seatGitIdentity.resolveSeatGitIdentity}).
     * @param {String} [opts.gitEmail] The email the seat's commits carry, declared with `gitName`.
     * @param {Object} [admission={}]   The wire's admission for this create, never the caller's input.
     * @param {String} [admission.ownerPrincipal] The forge-resolved principal the new seat records as its
     *     operator ({@link Neo.ai.services.fleet.SeatOperatorRegistryService#claim}), before anything else is
     *     written. Without one the seat has no operator until the plane host assigns it. A refused claim
     *     refuses the create.
     * @returns {Object} The public agent definition (no credential).
     */
    defineAgent(options={}, admission={}) {
        if (Object.hasOwn(options || {}, RETIRED_TARGET_FIELD)) {
            throw new TypeError(
                "FleetRegistryService.defineAgent: retired target-as-transport input is not accepted; use 'mcpTarget'."
            )
        }

        if (OPERATOR_FIELDS.some(field => Object.hasOwn(options || {}, field))) {
            throw new Error("FleetRegistryService.defineAgent: a seat's operator is never named by the caller; it is the admitted principal.")
        }

        const {
            githubUsername,
            harnessType,
            credential,
            forge,
            forgeHost,
            gitEmail,
            gitName,
            id,
            launchOwner='external',
            memoryImport,
            metadata={},
            modelProvider,
            mcpServers,
            mcpTarget
        } = options || {};

        if (!githubUsername) throw new Error("FleetRegistryService.defineAgent: 'githubUsername' is required.");

        let consent = null;

        if (memoryImport != null) {
            try {
                consent = normalizeMemoryImport(memoryImport)
            } catch (error) {
                throw new Error(`FleetRegistryService.defineAgent: ${error.message}`)
            }
        }
        if (!harnessType)    throw new Error("FleetRegistryService.defineAgent: 'harnessType' is required.");

        if (!LAUNCH_OWNERS.includes(launchOwner)) {
            throw new Error(`FleetRegistryService.defineAgent: invalid launchOwner '${launchOwner}'. Must be one of: ${LAUNCH_OWNERS.join(', ')}.`)
        }

        if (!this.harnessTypes.includes(harnessType)) {
            throw new Error(`FleetRegistryService.defineAgent: invalid harnessType '${harnessType}'. Must be one of: ${this.harnessTypes.join(', ')}.`);
        }

        const
            account     = forgeAccount(forge ?? 'github', forgeHost),
            declaration = gitIdentityDeclaration('defineAgent', {gitName, gitEmail});

        // SECURITY STOP-LINE (mechanical): `metadata.launch` is executed with Brain credentials by
        // the lifecycle service, and `defineAgent` is a wire-allowlisted verb — accepting a launch
        // payload here would make remote code execution with credentials a Body-reachable normal
        // form. Rejected at the storage boundary, never stripped silently: the Brain/operator-only
        // write path is {@link setLaunchOverride}, which no bridge and no wire allowlist exposes.
        if (metadata && Object.hasOwn(metadata, 'launch')) {
            throw new Error("FleetRegistryService.defineAgent: 'metadata.launch' is not definable through this surface — wire callers send curated harnessType intent only. Brain/operator launch overrides go through setLaunchOverride.");
        }

        const
            agentId = id || githubUsername,
            now     = new Date().toISOString(),
            catalog = mcpCatalogFor(account.forge),
            matrix  = mcpServers === undefined ? null : normalizeMcpOverrides(mcpServers, catalog),
            target  = mcpTarget === undefined ? null : normalizeMcpTarget(mcpTarget);

        const refusal = mcpDeclarationRefusal({harnessType, mcpMatrix: resolveMcpMatrix(matrix, catalog), tenant: !!target, forge: account.forge});

        if (refusal) {
            throw new TypeError(`FleetRegistryService.defineAgent: ${refusal}`)
        }

        this.ensureLoaded();

        if (this.agents.has(agentId)) {
            throw new Error(`FleetRegistryService.defineAgent: id '${agentId}' already exists; use a scoped update operation.`)
        }

        const tenantAssignee = target && this.findMcpTenantAssignee(target.tenantId);

        if (tenantAssignee) {
            throw new Error(`FleetRegistryService.defineAgent: MCP tenant '${target.tenantId}' is already assigned to agent '${tenantAssignee}'.`)
        }

        if (typeof credential !== 'string' || credential.trim() === '') {
            throw new Error(`FleetRegistryService.defineAgent: 'credential' is required — every agent holds its ${account.forge === 'gitlab' ? 'GitLab' : 'GitHub'} PAT.`)
        }

        // read before the claim: an unreadable store refuses while nothing, not even the operator, is recorded
        let previousCredentials;

        try {
            previousCredentials = this.readCredentialsForMutation()
        } catch {
            throw new Error("FleetRegistryService.defineAgent: the credential store cannot be read, so no seat was added and no stored PAT was touched. If it was written with another key, restore that key (NEO_FLEET_SECRET_KEY, or the key file in the Fleet's data folder), then add the seat again.")
        }

        // the operator before anything else is written: a create never succeeds without it recorded
        const claimed = SeatOperatorRegistryService.claim({principal: admission?.ownerPrincipal ?? null, seatId: agentId});

        if (!claimed.ok) {
            throw new Error(`FleetRegistryService.defineAgent: the seat's operator could not be recorded: ${CLAIM_REFUSALS[claimed.refused] ?? claimed.refused}.`)
        }

        const
            def        = {
                id            : agentId,
                githubUsername,
                harnessType,
                ...account,
                // provider-login resolves via the AiConfig SSOT leaf when unset (no service-local
                // default shadow); an explicit arg wins on creation.
                modelProvider: modelProvider || aiConfig.modelProvider,
                metadata,
                mcpServers   : matrix,
                mcpTarget    : target,
                // where the seat will live, recorded at birth: a start under a changed root then refuses
                // instead of provisioning a second seat; rows older than the record name none and are
                // bound once, deliberately, through `relocateSeatHome`
                seatHome     : path.resolve(this.getAgentsRoot(), agentId),
                launchOwner,
                // an explicit owner is an ownership act, the fact `launchRefusalOf` keys on; the omitted
                // default records none, so the process record stays that seat's only start gate
                ...((options || {}).launchOwner != null ? {launchOwnerSince: now} : {}),
                // an adoption is recorded with the seat's birth; no consent means a fresh seat
                ...(consent ? {memoryImport: consent} : {}),
                ...declaration,
                createdAt: now,
                updatedAt: now
            },
            nextAgents = new Map(this.agents);

        nextAgents.set(agentId, def);

        // Three-store create transaction: the operator claimed above, the credential next, the registry row
        // last. A credential failure cannot strand an unrecoverable create-only resident. If registry publish
        // fails, restore the prior credential snapshot. If rollback itself fails or the process dies between
        // files, the next create for the id carries a credential and an operator claim of its own and
        // overwrites both orphans; an orphaned claim names no defined seat, so no lookup reads it as operated.
        this.writeCredentials(Object.assign(Object.create(null), previousCredentials, {[agentId]: credential}));

        try {
            this.writeRegistry(nextAgents)
        } catch (error) {
            try {
                this.writeCredentials(previousCredentials)
            } catch (rollbackError) {}

            throw error
        }

        this.agents = nextAgents;
        this.announceDefinition(agentId, null, def);

        return this.toPublic(def);
    }

    /**
     * Partially update an existing agent definition: merge `metadata` (does NOT replace it) and
     * override `modelProvider` if given, preserving every other field, `createdAt`, and the stored
     * credential. This narrow patch path is distinct from {@link defineAgent}'s create-only
     * boundary — control verbs (e.g. `FleetManager.setRepo`) mutate one facet without replaying
     * identity or credentials. Non-destructive to on-disk checkout and credential. No-op-safe: an
     * unknown id returns `null` rather than creating a partial definition.
     * @param {String}  id
     * @param {Object}  patch
     * @param {Object} [patch.metadata]      Metadata keys merged into the existing metadata.
     * @param {String} [patch.modelProvider] New model-provider login.
     * @returns {Object|null} The updated public definition, or `null` when the agent doesn't exist.
     */
    updateAgent(id, {metadata, modelProvider} = {}) {
        // The same mechanical stop-line as {@link defineAgent}: scoped wire verbs (`setRepo`,
        // `setAvatar`) patch metadata through here, so the launch key is equally unwritable on the
        // patch path. Brain/operator launch overrides go through {@link setLaunchOverride}.
        if (metadata && Object.hasOwn(metadata, 'launch')) {
            throw new Error("FleetRegistryService.updateAgent: 'metadata.launch' is not patchable through this surface. Brain/operator launch overrides go through setLaunchOverride.");
        }

        this.ensureLoaded();

        const existing = this.agents.get(id);
        if (!existing) return null;

        const def = {
            ...existing,
            metadata     : metadata ? {...existing.metadata, ...metadata} : existing.metadata,
            modelProvider: modelProvider || existing.modelProvider,
            updatedAt    : new Date().toISOString()
        };

        const nextAgents = new Map(this.agents);
        nextAgents.set(id, def);
        this.writeRegistry(nextAgents);
        this.agents = nextAgents;
        this.announceDefinition(id, existing, def);

        return this.toPublic(def);
    }

    /**
     * Configure an existing agent through the ONE wire-serializable curated intent. Only `id`,
     * `harnessType`, sparse `mcpServers` overrides, the narrow `mcpTarget` intent, the declared commit
     * identity (`gitName` with `gitEmail`, or both `null` to return to derivation) and the declared `model`
     * and `reasoningEffort` (each `null` to hand it back to the harness's own configuration) are accepted. A model names one
     * family's model, so a harness change withdraws both unless the same intent declares them again; credentials,
     * URLs, headers, launch fields, wake, hooks, the provider identity (`githubUsername`), and generic config
     * bags are mechanically rejected. Unspecified fields are preserved. The returned public definition is canonical persisted readback, never request
     * echo. Controlled validation failures use the method prefix so FleetControlBridge can expose a
     * safe rejected-domain reason while unexpected storage failures remain transport-sanitized. A
     * declaration the seat's harness cannot carry is one of them, with the reason Start would give
     * ({@link mcpDeclarationRefusal}). A `memoryImport` consent is the one {@link defineAgent} records,
     * given late; FleetControlBridge accepts it only while the seat holds no memory yet.
     * @param {Object} intent
     * @param {String} intent.id Existing registry id.
     * @param {String} [intent.harnessType] Registered durable harness key.
     * @param {Object|null} [intent.mcpServers] Complete sparse MCP override set; null follows defaults.
     * @param {Object|null} [intent.mcpTarget] `null`/resident or `{kind:'tenant', tenantId}`.
     * @param {String|null} [intent.gitName]  The name the seat's commits carry, given with `gitEmail`; `null` with
     *     `gitEmail: null` removes the declaration.
     * @param {String|null} [intent.gitEmail] The email the seat's commits carry, given with `gitName`.
     * @param {String|null} [intent.model] The model the seat's harness starts on, read at the next Start
     *     ({@link module:ai/services/fleet/seatModelDeclaration.normalizeSeatModelDeclaration}).
     * @param {String|null} [intent.reasoningEffort] The reasoning effort it starts on.
     * @param {String|null} [intent.memoryImport] An agent's memory folder or `'none'`
     *     ({@link module:ai/services/fleet/seatMemoryImport.normalizeMemoryImport}); `null` withdraws the consent.
     * @returns {Object|null} Updated public definition, or `null` when the id is not registered.
     */
    configureAgent(intent={}) {
        const reject = reason => {
            throw new TypeError(`FleetRegistryService.configureAgent: ${reason}`)
        };

        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
            reject('intent must be an object.')
        }

        const
            allowed                                  = new Set(['id', 'harnessType', 'mcpServers', 'mcpTarget', 'gitName', 'gitEmail', 'model', 'reasoningEffort', 'memoryImport']),
            unknown                                  = Object.keys(intent).find(key => !allowed.has(key)),
            {id, harnessType, mcpServers, mcpTarget} = intent,
            declaring                                = Object.hasOwn(intent, 'gitName') || Object.hasOwn(intent, 'gitEmail'),
            seating                                  = Object.hasOwn(intent, 'model') || Object.hasOwn(intent, 'reasoningEffort'),
            consenting                               = Object.hasOwn(intent, 'memoryImport');

        if (unknown) {
            reject(`unsupported field '${unknown}'.`)
        }
        if (typeof id !== 'string' || !id.trim()) {
            reject("'id' is required.")
        }
        if (!Object.hasOwn(intent, 'harnessType') &&
            !Object.hasOwn(intent, 'mcpServers') &&
            !Object.hasOwn(intent, 'mcpTarget') &&
            !declaring &&
            !seating &&
            !consenting) {
            reject('at least one configuration field is required.')
        }

        const declaration = declaring ? gitIdentityDeclaration('configureAgent', intent) : null;

        this.ensureLoaded();

        const existing = this.agents.get(id);
        if (!existing) return null;

        if (Object.hasOwn(intent, 'harnessType') && !this.harnessTypes.includes(harnessType)) {
            reject(`invalid harnessType '${harnessType}'. Must be one of: ${this.harnessTypes.join(', ')}.`)
        }

        const nextHarnessType = Object.hasOwn(intent, 'harnessType') ? harnessType : existing.harnessType;

        let consent = null;

        if (consenting && intent.memoryImport !== null) {
            try {
                consent = normalizeMemoryImport(intent.memoryImport, {
                    agent: {...existing, harnessType: nextHarnessType}, instanceRoot: this.getAgentsRoot()
                })
            } catch (error) {
                reject(error.message)
            }
        }

        const catalog = mcpCatalogFor(existing.forge);

        let
            matrix = existing.mcpServers ?? null,
            target = normalizeStoredMcpTarget(existing.mcpTarget);

        if (Object.hasOwn(intent, 'mcpServers')) {
            try {
                matrix = normalizeMcpOverrides(mcpServers, catalog)
            } catch (error) {
                reject(error.message)
            }
        }

        if (Object.hasOwn(intent, 'mcpTarget')) {
            try {
                target = normalizeMcpTarget(mcpTarget)
            } catch (error) {
                reject(error.message)
            }
        }

        const seat = seatModelDeclaration('configureAgent', nextHarnessType, intent);

        const refusal = mcpDeclarationRefusal({harnessType: nextHarnessType, mcpMatrix: resolveMcpMatrix(matrix, catalog), tenant: !!target, forge: existing.forge});

        if (refusal) {
            reject(refusal)
        }

        const tenantAssignee = target && this.findMcpTenantAssignee(target.tenantId, id);

        if (tenantAssignee) {
            reject(`MCP tenant '${target.tenantId}' is already assigned to agent '${tenantAssignee}'.`)
        }

        const def = {
            ...existing,
            harnessType: nextHarnessType,
            mcpServers : matrix,
            mcpTarget  : target,
            ...declaration,
            updatedAt  : new Date().toISOString()
        };

        // both fields `null`: the declaration is withdrawn and Start derives the identity again
        if (declaring && !declaration) {
            delete def.gitName;
            delete def.gitEmail
        }

        // a model names one family's model: another harness starts on its own default unless declared again
        if (nextHarnessType !== existing.harnessType) {
            delete def.model;
            delete def.reasoningEffort
        }

        for (const [key, value] of Object.entries(seat)) {
            value === null ? delete def[key] : def[key] = value
        }

        if (consenting) {
            consent === null ? delete def.memoryImport : def.memoryImport = consent
        }

        const nextAgents = new Map(this.agents);
        nextAgents.set(id, def);
        this.writeRegistry(nextAgents);
        this.agents = nextAgents;
        this.announceDefinition(id, existing, def);

        return this.toPublic(def);
    }

    /**
     * @summary Records who launches a seat from now on — the one write of `launchOwner` after
     * {@link defineAgent}. `fleet` makes this fleet the seat's only sanctioned launcher, so a seat with no
     * process record reads as stopped; `external` hands it back to its own harness, and the fleet refuses
     * to start it from then on ({@link launchRefusalOf}). The change carries its own time,
     * `launchOwnerSince`, beside `updatedAt`.
     * @param {String} id    Registry agent id.
     * @param {String} owner `fleet` or `external`.
     * @returns {Object|null} The updated public definition, or `null` when the agent doesn't exist.
     */
    setLaunchOwner(id, owner) {
        if (!LAUNCH_OWNERS.includes(owner)) {
            throw new Error(`FleetRegistryService.setLaunchOwner: invalid launchOwner '${owner}'. Must be one of: ${LAUNCH_OWNERS.join(', ')}.`)
        }

        this.ensureLoaded();

        const existing = this.agents.get(id);
        if (!existing) return null;

        const
            now        = new Date().toISOString(),
            def        = {...existing, launchOwner: owner, launchOwnerSince: now, updatedAt: now},
            nextAgents = new Map(this.agents);

        nextAgents.set(id, def);
        this.writeRegistry(nextAgents);
        this.agents = nextAgents;
        this.announceDefinition(id, existing, def);

        return this.toPublic(def);
    }

    /**
     * @summary The one write of `seatHome` after {@link defineAgent}: the deliberate move, or the
     * binding of a row that predates the record. The caller names the current record exactly
     * (compare-and-set — `null` for a row that has none), so a stale or guessed `from` never re-homes
     * a seat. The files move outside this registry; this write is what lets the next start accept the
     * path it names. No automatic adoption exists: a directory that happens to exist under the current
     * root carries no binding authority, so an unbound row stays refused until this act names its home.
     * A move records the home it left as `previousSeatHome`. The start re-derives every Fleet-owned file
     * still exactly as Fleet rendered it there, so a copied seat names its new home.
     * @param {String}      id        Registry agent id.
     * @param {Object}      move
     * @param {String|null} move.from The seat home the row records now, `null` for a row without one.
     * @param {String}      move.to   The absolute seat directory the files live in.
     * @returns {Object|null} The updated public definition, or `null` when the agent doesn't exist.
     * @throws {Error} when `to` is not an absolute path, or `from` is not the recorded seat home.
     */
    relocateSeatHome(id, {from, to} = {}) {
        assertSeatHome(to, 'relocateSeatHome');
        this.ensureLoaded();

        const existing = this.agents.get(id);
        if (!existing) return null;

        if ((existing.seatHome ?? null) !== (from ?? null)) {
            throw new Error(`FleetRegistryService.relocateSeatHome: agent '${id}' records seat home '${existing.seatHome ?? 'none'}', not '${from ?? 'none'}'.`)
        }

        const
            def        = {...existing, seatHome: to, ...(from && from !== to && {previousSeatHome: from}), updatedAt: new Date().toISOString()},
            nextAgents = new Map(this.agents);

        nextAgents.set(id, def);
        this.writeRegistry(nextAgents);
        this.agents = nextAgents;
        this.announceDefinition(id, existing, def);

        return this.toPublic(def);
    }

    /**
     * @summary The Brain/operator-only write path for a raw launch override — the compatibility
     * escape hatch the wire can never reach: this method exists on the registry only (no
     * `FleetControlBridge` member, no `FLEET_WIRE_METHODS` entry — the dispatch allowlist spec pins
     * that), so a launch payload can only be authored by Brain-side code or an operator process.
     * The lifecycle service executes a stored `metadata.launch` with Brain credentials, which is
     * exactly why {@link defineAgent} / {@link updateAgent} reject it: whatever can author THIS is
     * trusted with arbitrary-command execution already. `null` clears the override (the agent falls
     * back to its curated family template).
     * @param {String}      id     Registry agent id.
     * @param {Object|null} launch `{command, args, env}` — validated for shape by the lifecycle
     *                             service at resolve time; `null` removes the override.
     * @returns {Object|null} The updated RAW definition (Brain-facing, launch visible — the public
     *                        projection redacts launch, so it could not confirm this write), or
     *                        `null` when the agent doesn't exist.
     */
    setLaunchOverride(id, launch) {
        this.ensureLoaded();

        const existing = this.agents.get(id);
        if (!existing) return null;

        const metadata = {...existing.metadata};
        if (launch == null) {
            delete metadata.launch;
        } else {
            metadata.launch = launch;
        }

        const def = {...existing, metadata, updatedAt: new Date().toISOString()};

        this.agents.set(id, def);
        this.writeRegistry();
        this.announceDefinition(id, existing, def);

        return this.getDefinition(id);
    }

    /**
     * List all agent definitions (no credentials).
     * @returns {Object[]}
     */
    listAgents() {
        this.ensureLoaded();
        return [...this.agents.values()].map(def => this.toPublic(def));
    }

    /**
     * Get a single agent definition (no credential).
     * @param {String} id
     * @returns {Object|null}
     */
    getAgent(id) {
        this.ensureLoaded();
        const def = this.agents.get(id);
        return def ? this.toPublic(def) : null;
    }

    /**
     * @summary Brain-internal raw definition read — the ONLY read surface that carries
     * `metadata.launch`. Same authority posture as {@link setLaunchOverride}: registry-only method,
     * no `FleetControlBridge` member, no `FLEET_WIRE_METHODS` entry (the dispatch allowlist spec
     * pins that); the lifecycle spawn path is its consumer. Returns a deep clone (minus secrets) so
     * no caller can mutate the registry cache through the result.
     * @param {String} id
     * @returns {Object|null}
     */
    getDefinition(id) {
        this.ensureLoaded();

        const def = this.agents.get(id);
        if (!def) return null;

        const {credential, pat, ...rest} = def;
        return structuredClone({...rest, mcpTarget: normalizeStoredMcpTarget(rest.mcpTarget)});
    }

    /**
     * @summary Does this principal operate this seat? The one server-owned lookup the operator relation
     * answers: the seat must be defined here, and the operator store, read fresh, must name this principal
     * for it. A store that cannot be read answers `unavailable`, never `unknown-seat` or `unowned`.
     * @param {String|null} principal An admitted owner principal. Anything else, such as a login, an
     *     `@identity` or a path, is no principal.
     * @param {String}      seatId
     * @returns {{operates: true}|{operates: false, reason: 'no-principal'|'unavailable'|'unknown-seat'|'unowned'|'other-operator'}}
     */
    operatesSeat(principal, seatId) {
        if (!isOwnerPrincipal(principal)) return {operates: false, reason: 'no-principal'};

        this.ensureLoaded();

        if (this.registryUnreadable)  return {operates: false, reason: 'unavailable'};
        if (!this.agents.has(seatId)) return {operates: false, reason: 'unknown-seat'};

        const operator = SeatOperatorRegistryService.operatorOf(seatId);

        if (operator.state === 'unavailable') return {operates: false, reason: 'unavailable'};
        if (!operator.principal)              return {operates: false, reason: 'unowned'};

        return operator.principal === principal ? {operates: true} : {operates: false, reason: 'other-operator'}
    }

    /**
     * @summary The defined seats one principal operates, read fresh: the inverse of {@link operatesSeat}.
     * @param {String} principal An admitted owner principal.
     * @returns {{state: 'ok', seats: String[]}|{state: 'unavailable', reason: String}}
     */
    seatsOperatedBy(principal) {
        this.ensureLoaded();

        if (this.registryUnreadable) return {reason: this.registryUnreadable, state: 'unavailable'};

        const operated = SeatOperatorRegistryService.seatsOf(principal);

        if (operated.state === 'unavailable') return operated;

        return {seats: operated.seats.filter(seatId => this.agents.has(seatId)), state: 'ok'}
    }

    /**
     * Remove an agent definition and its stored credential.
     * @param {String} id
     * @returns {Object} `{success, id}`
     */
    removeAgent(id) {
        this.ensureLoaded();
        const previous = this.agents.get(id) ?? null;
        const existed  = this.agents.delete(id);
        if (existed) {
            this.writeRegistry();
            this.announceDefinition(id, previous, null);
            // tidiness, not the guarantee: the next create of this id claims its operator anew
            const released = SeatOperatorRegistryService.release({seatId: id});
            released.ok || console.warn(`[FleetRegistryService] seat '${id}' was removed; its operator record stays until the id is created again: ${released.reason}`)
        }
        // The PAT dies with the agent. The Bridge token is a stateless *signed* credential (no
        // store), so it can't be revoked at remove-time — it self-expires within bridgeTokenTtlMs
        // (the accepted ≤1h lag; immediate eviction of a compromised agent is a later additive
        // Bridge revocation-denylist). WriteGuard's no-clobber invariant denies
        // an overlapping cross-agent write on the agentId regardless of token age in the interim.
        this.removeCredential(id);
        return {success: existed, id};
    }

    /**
     * Brain-internal credential accessor — the ONLY path that returns a raw PAT. Intended for the
     * instance spawner (a later FM leaf), never the Body-side settings pane. Fails closed.
     * @param {String} id
     * @returns {String|null} The decrypted PAT, or `null` if absent / unreadable.
     */
    resolveCredential(id) {
        const credentials = this.readCredentials();
        // own-property lookup only: an id like `toString` / `constructor` must fail closed to null,
        // never resolve to an inherited Object.prototype member.
        return Object.hasOwn(credentials, id) ? credentials[id] : null;
    }

    /**
     * @summary Mint a short-lived, **asymmetrically-signed** Bridge session token for
     * agent↔Neural-Link-Bridge transport auth. The token is a self-contained, stateless credential:
     * a compact `<base64url(payload)>.<base64url(signature)>` where `payload` is
     * `{agentId, expiresAt}` and the signature is Ed25519 over those exact payload bytes
     * ({@link getSigningKey}). Nothing is persisted — there is no per-token store.
     *
     * **Why signed, not hash-stored (the recorded ticket decision):** the Bridge runs as a separate,
     * network-facing process. A store-read verifier would have to hold the registry's master key
     * (the same `getKey()` that decrypts `credentials.enc` = every PAT), so a Bridge compromise would
     * leak all PATs. An asymmetric signature lets the Bridge verify statelessly with only the
     * **public** key ({@link getBridgePublicKey}) — zero secret material + zero store access on the
     * exposed surface, and it cannot forge tokens. The cost is a ≤`bridgeTokenTtlMs` revocation lag
     * (a removed agent's token stays valid until expiry); accepted because WriteGuard's no-clobber
     * invariant denies an overlapping cross-agent write on the `agentId` regardless of token age.
     * Immediate eviction of a *compromised* agent is a later additive Bridge revocation-denylist.
     *
     * The verified `agentId` rides **inside** the signed payload — so the Bridge trusts identity from
     * the signature, never the connection's `?id=` query claim (the spoofing hole this closes).
     * @param {String}  id          The agent id the token is minted for (signed into the payload).
     * @param {Object} [opts]
     * @param {Number} [opts.ttlMs] Token lifetime in ms; defaults to {@link bridgeTokenTtlMs}.
     * @returns {Object} `{token, expiresAt}` — the signed token (caller keeps it; nothing persisted) + its epoch-ms expiry.
     */
    mintBridgeToken(id, {ttlMs}={}) {
        const
            now       = Date.now(),
            expiresAt = now + (ttlMs ?? this.bridgeTokenTtlMs),
            payload   = Buffer.from(JSON.stringify({agentId: id, expiresAt})),
            signature = crypto.sign(null, payload, this.getSigningKey()),
            token     = `${payload.toString('base64url')}.${signature.toString('base64url')}`;

        return {token, expiresAt};
    }

    // ---- internals ----------------------------------------------------------

    /**
     * @summary Find the one other agent already bound to a tenant credential. One current tenant
     * descriptor owns one provider subject; permitting two agents to select it would silently
     * collapse both canonical seats onto the same remote identity.
     * @param {String} tenantId
     * @param {String|null} [exceptId=null]
     * @returns {String|null}
     * @private
     */
    findMcpTenantAssignee(tenantId, exceptId=null) {
        for (const [agentId, definition] of this.agents) {
            if (agentId === exceptId) continue;

            const target = normalizeStoredMcpTarget(definition.mcpTarget);

            if (target?.kind === 'tenant' && target.tenantId === tenantId) {
                return agentId
            }
        }

        return null
    }

    /**
     * @summary The public projection: secrets stripped AND the Brain/operator-only launch override
     * redacted. The result is a DEEP CLONE — a shallow spread would hand every get/list/wire caller
     * the internal metadata object by shared reference, so mutating a returned definition would
     * mutate the registry cache, and the launch redaction would be bypassable through the alias.
     * The spawn path reads the launch through {@link getDefinition} instead.
     * @param {Object} def
     * @returns {Object} A deep-cloned definition, guaranteed to carry no secret and no launch override.
     * @private
     */
    toPublic(def) {
        return redactPublicFields(structuredClone({
            ...def,
            launchOwner: def.launchOwner || 'external',
            mcpTarget  : normalizeStoredMcpTarget(def.mcpTarget)
        }))
    }

    /**
     * Lazily (re)load the in-memory registry from disk when `dataDir` changes.
     * @private
     */
    ensureLoaded() {
        const dir = this.getDataDir();
        if (this.loadedDir === dir) return;
        this.agents    = this.readRegistry();
        this.loadedDir = dir;
    }

    /**
     * @returns {Map<String,Object>} Agent definitions read from `registry.json` (empty on miss/corrupt).
     *     A corrupt or malformed read (no `agents` table) is remembered in {@link registryUnreadable}, so a
     *     lookup can say the seats are unknowable rather than absent.
     * @private
     */
    readRegistry() {
        const file = this.registryPath();

        this.registryUnreadable = null;

        if (!fs.existsSync(file)) return new Map();

        let data;

        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
            console.warn(`[FleetRegistryService] Unreadable registry at ${file}; starting empty.`, error.message);
            this.registryUnreadable = `the seat registry cannot be read (${error.message})`;
            return new Map();
        }

        const isTable = value => value !== null && typeof value === 'object' && !Array.isArray(value);

        if (!isTable(data) || (data.agents !== undefined && !isTable(data.agents))) {
            console.warn(`[FleetRegistryService] Malformed registry at ${file}; starting empty.`);
            this.registryUnreadable = 'the seat registry has no agents table';
            return new Map();
        }

        return new Map(Object.entries(data.agents || {}))
    }

    /**
     * Persist the in-memory registry to `registry.json` (no secrets).
     * @private
     */
    writeRegistry(agents=this.agents) {
        this.ensureDataDir();

        const payload = {agents: Object.fromEntries(agents)};

        writeFileAtomicSync(this.registryPath(), JSON.stringify(payload, null, 2))
    }

    /**
     * @summary Fire `definitionChange` for one committed write (see the class summary).
     * @param {String} id
     * @param {Object|null} previous The raw definition before the write.
     * @param {Object|null} next The raw definition after it.
     * @protected
     */
    announceDefinition(id, previous, next) {
        this.fire('definitionChange', {id, previous, next})
    }

    /**
     * @returns {Object} The decrypted `{agentId: pat}` map as a **null-prototype** object (empty +
     * warned on absent/corrupt — fail-closed). Null-prototype is the security invariant: credential
     * ids are untrusted keys, so an absent id can never alias an inherited `Object.prototype` member
     * (`toString` / `constructor` / `__proto__` …) on lookup, store, or remove.
     * @private
     */
    readCredentials() {
        try {
            return this.readCredentialsForMutation()
        } catch (error) {
            console.warn('[FleetRegistryService] Credential store unreadable; failing closed.', error.message);
            return Object.create(null)
        }
    }

    /**
     * @summary The credential map a write starts from. A missing store is empty. A store this Fleet
     * cannot read or decrypt, or one that holds no record, throws and stays byte-identical: a write
     * over it would replace every other seat's PAT with the one being written.
     * @returns {Object} The decrypted `{agentId: pat}` map, null-prototype.
     * @private
     */
    readCredentialsForMutation() {
        let raw;

        try {
            raw = fs.readFileSync(this.credentialsPath(), 'utf8')
        } catch (error) {
            if (error?.code === 'ENOENT') return Object.create(null);

            throw error
        }

        const record = JSON.parse(this.decrypt(raw));

        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new TypeError('FleetRegistryService: credentials.enc must contain a credential record.')
        }

        return Object.assign(Object.create(null), record)
    }

    /**
     * Encrypt + persist a single credential, merged into the existing store; throws over a store
     * that cannot be read ({@link readCredentialsForMutation}).
     * @param {String} id
     * @param {String} pat
     * @private
     */
    storeCredential(id, pat) {
        const map = this.readCredentialsForMutation();
        map[id] = pat;
        this.writeCredentials(map);
    }

    /**
     * Remove a single credential from the store (no-op if absent). The lenient read is enough here:
     * over a store that cannot be read the id is absent, so nothing is written.
     * @param {String} id
     * @private
     */
    removeCredential(id) {
        const map = this.readCredentials();
        if (Object.hasOwn(map, id)) {
            delete map[id];
            this.writeCredentials(map);
        }
    }

    /**
     * Encrypt + atomically publish the full credential map to `credentials.enc` (`0600`).
     * @param {Object} map
     * @private
     */
    writeCredentials(map) {
        this.ensureDataDir();

        writeFileAtomicSync(this.credentialsPath(), this.encrypt(JSON.stringify(map)))
    }

    // ---- crypto (AES-256-GCM) ----------------------------------------------

    /**
     * @param {String} plaintext
     * @returns {String} base64( iv(12) ‖ authTag(16) ‖ ciphertext )
     * @private
     */
    encrypt(plaintext) {
        const
            iv     = crypto.randomBytes(12),
            cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv),
            enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]),
            tag    = cipher.getAuthTag();
        return Buffer.concat([iv, tag, enc]).toString('base64');
    }

    /**
     * @param {String} payload base64( iv(12) ‖ authTag(16) ‖ ciphertext )
     * @returns {String} plaintext
     * @private
     */
    decrypt(payload) {
        const
            raw      = Buffer.from(payload, 'base64'),
            iv       = raw.subarray(0, 12),
            tag      = raw.subarray(12, 28),
            data     = raw.subarray(28),
            decipher = crypto.createDecipheriv('aes-256-gcm', this.getKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }

    /**
     * Resolve the 32-byte AES key: `NEO_FLEET_SECRET_KEY` (hex or base64) if set, else a generated
     * `0600` dev key file under `dataDir`. Production SHOULD set the env key.
     * @returns {Buffer}
     * @private
     */
    getKey() {
        return resolveFleetCredentialKey({
            dataDir    : this.getDataDir(),
            serviceName: 'FleetRegistryService'
        })
    }

    /**
     * Resolve the Ed25519 **private** signing key for Bridge session tokens: `NEO_FLEET_SIGNING_KEY`
     * (a PKCS8 PEM) if set, else a generated `0600` `signing.key` file under `dataDir`. Distinct from
     * {@link getKey} (the AES master key) — this private key never decrypts the PAT/token stores, and
     * only its PUBLIC half ({@link getBridgePublicKey}) is provisioned to the network-facing Bridge.
     * Production SHOULD set the env key. Returns a {@link crypto.KeyObject}.
     * @returns {Object}
     * @private
     */
    getSigningKey() {
        const envKey = process.env.NEO_FLEET_SIGNING_KEY;
        if (envKey) return crypto.createPrivateKey(envKey);

        const file = this.signingKeyPath();
        if (fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));

        this.ensureDataDir();
        const {privateKey} = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(file, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
        return privateKey;
    }

    /**
     * @returns {String} The Ed25519 **public** verify key (SPKI PEM) matching {@link getSigningKey}.
     * Non-secret — this is the only key material the network-facing Bridge needs to verify token
     * signatures statelessly. Provisioned to the Bridge at startup via `NEO_FLEET_BRIDGE_PUBLIC_KEY`,
     * a trusted harness/operator-set value — **never** supplied by a connecting agent.
     * @private
     */
    getBridgePublicKey() {
        return crypto.createPublicKey(this.getSigningKey()).export({type: 'spki', format: 'pem'});
    }

    // ---- paths --------------------------------------------------------------

    /**
     * @summary Resolve the Fleet-owned durable root from the explicit instance/test override or
     * the canonical `AiConfig.fleet.dataDir` plane member. No service-local default or env read is
     * permitted: registry, tenant, keys, and ciphertext must stay co-located.
     * @returns {String} The resolved Fleet data directory.
     * @private
     */
    getDataDir() {
        return this.dataDir || aiConfig.fleet.dataDir;
    }

    /**
     * @summary The agents root a new row's `seatHome` is recorded under: the injected override, else
     * the canonical `AiConfig.fleet.agentsRoot` leaf — the root the Fleet derives every seat path from.
     * @returns {String}
     */
    getAgentsRoot() {
        return this.agentsRoot || aiConfig.fleet.agentsRoot;
    }

    /** @returns {String} @private */
    registryPath() { return path.join(this.getDataDir(), 'registry.json'); }

    /** @returns {String} @private */
    credentialsPath() { return path.join(this.getDataDir(), 'credentials.enc'); }

    /** @returns {String} The Ed25519 signing-key file (PKCS8 PEM) — a generated `0600` dev key when
     * `NEO_FLEET_SIGNING_KEY` is unset. Distinct from {@link keyPath} (the AES master key). @private */
    signingKeyPath() { return path.join(this.getDataDir(), 'signing.key'); }

    /** @returns {String} @private */
    keyPath() { return path.join(this.getDataDir(), 'fleet.key'); }

    /**
     * Ensure the data directory exists.
     * @private
     */
    ensureDataDir() {
        fs.mkdirSync(this.getDataDir(), {recursive: true});
    }
}

export default Neo.setupClass(FleetRegistryService);
