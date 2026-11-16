import Base                                                                from 'neo.mjs/src/core/Base.mjs';
import aiConfig                                                            from '../../mcp/server/memory-core/config.mjs';
import GraphService                                                        from './GraphService.mjs';
import {compileIdentityPublicationBoot, decodeIdentityPublicationBootJson} from './helpers/identityPublicationBoot.mjs';
import {validateFoundingFamilySeed}                                        from '../../graph/identityFoundingSeed.mjs';

/**
 * @summary Composes one MC boot generation with the protected physical publication owner.
 * Configuration is compiled only at server boot. Requests read the physical owner's current
 * fence and lineage; this service neither caches family history nor provisions from a request.
 * @class Neo.ai.services.memory-core.IdentityPublicationService
 * @extends Neo.core.Base
 * @singleton
 */
class IdentityPublicationService extends Base {
    static config = {
        className: 'Neo.ai.services.memory-core.IdentityPublicationService',
        singleton: true
    }

    #generation = null;
    #bootFailure = 'publication-boot-unavailable';
    #bootEpoch = 0;

    /**
     * @summary Captures the explicitly configured public boot generation after custom config loads.
     * This narrow bootstrap snapshot binds the verifier and physical owner to the same input;
     * changing trust requires another server composition. It performs no storage mutation.
     * @returns {Object|null} The fixed-purpose AuthService boundary, or null when unprovisioned.
     */
    configureBoot() {
        this.#bootEpoch++;
        this.#generation = null;
        this.#bootFailure = 'publication-boot-unavailable';
        const bootText = aiConfig.identityPublicationBoot;
        const target   = Object.freeze({planeId: aiConfig.plane.id, dataRoot: aiConfig.plane.dataRoot});
        const compiled = compileIdentityPublicationBoot(bootText, target);
        const founding = aiConfig.identityPublicationFounding === null ? null :
            decodeIdentityPublicationBootJson(aiConfig.identityPublicationFounding);
        if (founding !== null && (!compiled || !founding || typeof founding !== 'object' ||
            Array.isArray(founding) || Object.keys(founding).length !== 2 ||
            !Object.hasOwn(founding, 'seed') || !Object.hasOwn(founding, 'sourceRevision') ||
            typeof founding.sourceRevision !== 'string' || !founding.sourceRevision.trim() ||
            !validateFoundingFamilySeed(founding.seed))) {
            throw new Error('Identity publication founding input requires reviewed sourceRevision and a complete valid seed.');
        }
        this.#generation = compiled ? {bootText, target, compiled, founding} : null;
        return this.getBoundary();
    }

    /**
     * @summary Consumes trusted boot input once the graph owner is ready; never called by a request.
     * The server treats a storage refusal as publication degradation while preserving WAL-local MCP.
     * @returns {Promise<Object>} The committed reservation/trust witness, or the unprovisioned state.
     * @throws {Error} Bounded code/message with the original exception retained only as a local cause.
     */
    async start() {
        if (!this.#generation) return this.#unprovisioned();
        const generation = this.#generation, epoch = this.#bootEpoch;
        this.#bootFailure = 'publication-boot-unavailable';
        try {
            await GraphService.ready();
            if (epoch !== this.#bootEpoch || generation !== this.#generation) {
                throw new Error('publication-boot-canceled');
            }
            const {bootText, target, founding} = generation;
            const result                       = GraphService.consumeIdentityPublicationBoot(bootText, target);
            if (!['reserved', 'bound'].includes(result.state)) {
                this.#bootFailure = result.code || 'publication-boot-unavailable';
                throw new Error(this.#bootFailure);
            }
            if (result.state === 'bound' && founding !== null) {
                const installed = GraphService.installIdentityFoundingSource({bootText, target,
                    seed: founding.seed, sourceRevision: founding.sourceRevision});
                if (!['installed', 'idempotent'].includes(installed.state)) {
                    this.#bootFailure = installed.code || 'founding-source-unavailable';
                    throw new Error(this.#bootFailure);
                }
            }
            this.#bootFailure = null;
            return result;
        } catch (cause) {
            const code = epoch === this.#bootEpoch ? this.#bootFailure : 'publication-boot-canceled';
            throw Object.assign(new Error(`Identity publication boot unavailable: ${code}`, {cause}), {code});
        }
    }

    /** @summary Retires this process's pending boot generation before its Server owner is destroyed. */
    cancelBoot() {
        this.#bootEpoch++;
        this.#bootFailure = 'publication-boot-canceled';
    }

    /**
     * @summary Supplies detached public trust and a callback preserving the original signed carrier.
     * AuthService owns HTTP/profile validation; GraphService rechecks durable authority and samples
     * its own clock after acquiring the physical transaction.
     * @returns {Object|null} AuthService's typed boot boundary.
     */
    getBoundary() {
        if (!this.#generation) return null;
        const {compiled, target} = this.#generation;
        return {audience: target.planeId, issuer: compiled.descriptor.issuer,
            publicKeys: new Map(compiled.publicKeys), admit: token => this.publish(token)};
    }

    /**
     * @summary Admits the original compact bytes with source-owned target, boot trust and clock.
     * @param {String} token Signed compact carrier; decoded request fields supply no authority.
     * @returns {{statusCode: Number, body: Object}} A finite HTTP disposition without exception detail.
     */
    publish(token) {
        if (!this.#generation) return {statusCode: 503, body: this.#unprovisioned()};
        if (this.#bootFailure) return {statusCode: 503, body: {state: 'unavailable', code: this.#bootFailure}};
        const body = GraphService.admitIdentityPublication(token, {
            bootText: this.#generation.bootText, target: this.#generation.target
        });
        const statusCode = {accepted: 201, idempotent: 200, conflict: 409, refused: 400, unavailable: 503}[body.state];
        if (!statusCode) throw new Error('Identity publication owner returned an unsupported disposition.');
        return {statusCode, body};
    }

    /**
     * @summary Reads one physical founding/history observation; callers cannot select target or trust.
     * Admission revision and founding digest/provenance retain their distinct meanings.
     * @returns {Object} Complete available snapshot or named unavailability from its owner.
     */
    getIdentityPublicationSnapshot() {
        if (this.#generation && this.#bootFailure) return {state: 'unavailable', code: this.#bootFailure};
        return this.#generation ? GraphService.readIdentityPublicationSnapshot({
            bootText: this.#generation.bootText, target: this.#generation.target
        }) : this.#unprovisioned();
    }

    /**
     * @summary Exposes the current target-bound original-run reservation/trust witness without writing.
     * Remains callable during pending or failed boot for read-only reconciliation; its physical owner
     * still reports unavailable or fenced state explicitly. This read does not certify completed boot.
     * @returns {Object} Physical lineage observation or named unavailability.
     */
    getIdentityPublicationLineage() {
        return this.#generation ? GraphService.readIdentityPublicationLineage(
            this.#generation.bootText, this.#generation.target
        ) : this.#unprovisioned();
    }

    /** @summary Returns an explicit unprovisioned state, never an empty successful population. */
    #unprovisioned() {
        return Object.freeze({state: 'unavailable', code: 'publication-not-provisioned'});
    }
}

export default Neo.setupClass(IdentityPublicationService);
