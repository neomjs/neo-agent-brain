import fs              from 'fs';
import {createRequire} from 'node:module';
import {
    FULL_NAMESPACE_REGEX,
    KNOWN_CUT_REPOSITORIES,
    createCodedError,
     parseCanonicalAdrKey,
    validateAdrIdentityFields
} from '../shared/adrIdentityCodec.mjs';
import {
    extractCitationSurfaceContext,
    parseHumanOrNumericAdrReference
} from '../shared/adrDocumentParser.mjs';

/**
 * @module ai/services/ingestion/adrAdmissionCatalog
 * @summary Owns the admitted ADR catalog, per-repository reservation buckets, forge namespace
 * directory, cross-process SQLite/graph admission-evidence rehydration, reader authorization,
 * alias binding, and reference resolution shared between `AdrIngestor` and `AdrSource`.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §§2.6–2.10
 */

/**
 * Shared in-memory admitted ADR catalog, per-repository reservation buckets, and forge directory.
 */
export const SHARED_ADR_CATALOG_STATE = Object.freeze({
    admissionCatalog      : new Map(),
    repositoryReservations: new Map(),
    forgeDirectory        : new Map()
});

/**
 * @summary Ensures and returns the reservation bucket for `(forge, repositoryId)` in the shared catalog state.
 * @param {String} forge
 * @param {String} repositoryId
 * @returns {{forge: String, repositoryId: String, numbers: Set<String>, aliases: Map<String, Object>}}
 */
export function ensureSharedReservationBucket(forge, repositoryId) {
    const key = `${forge}:${repositoryId}`;
    if (!SHARED_ADR_CATALOG_STATE.repositoryReservations.has(key)) {
        SHARED_ADR_CATALOG_STATE.repositoryReservations.set(key, {
            forge,
            repositoryId,
            numbers: new Set(),
            aliases: new Map()
        });
    }
    return SHARED_ADR_CATALOG_STATE.repositoryReservations.get(key);
}

/**
 * @summary Registers a repository's current namespace occupancy in the shared forge provider directory.
 * @param {Object} repo
 */
export function registerSharedForgeRepository({forge = 'github.com', repositoryId, namespace, aliases = []} = {}) {
    validateAdrIdentityFields({forge, repositoryId, namespace, number: '0001'});
    if (!SHARED_ADR_CATALOG_STATE.forgeDirectory.has(forge)) {
        SHARED_ADR_CATALOG_STATE.forgeDirectory.set(forge, new Map());
    }

    const dir = SHARED_ADR_CATALOG_STATE.forgeDirectory.get(forge);
    dir.set(namespace.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});

    for (const aliasNs of aliases) {
        if (typeof aliasNs === 'string' && FULL_NAMESPACE_REGEX.test(aliasNs)) {
            const existing = dir.get(aliasNs.toLowerCase());
            if (!existing || existing.repositoryId === repositoryId) {
                dir.set(aliasNs.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});
            }
        }
    }

    ensureSharedReservationBucket(forge, repositoryId);
}

/**
 * @summary Resets the shared admitted ADR catalog and seeds the default cut repositories.
 */
export function resetSharedAdrCatalog() {
    SHARED_ADR_CATALOG_STATE.admissionCatalog.clear();
    SHARED_ADR_CATALOG_STATE.repositoryReservations.clear();
    SHARED_ADR_CATALOG_STATE.forgeDirectory.clear();
    for (const repo of KNOWN_CUT_REPOSITORIES) {
        registerSharedForgeRepository(repo);
    }
}

/**
 * @summary Hydrates admitted `adrAdmissionRecord` payloads into `SHARED_ADR_CATALOG_STATE`.
 * When `replaceExisting` is true (default), refreshes existing catalog records with live
 * cross-process updates (such as custody moves, newly bound aliases, or status updates)
 * while preserving any already-recorded in-memory renames and alias bindings.
 * @param {Object[]} [records=[]]
 * @param {Object} [options={}]
 * @param {Boolean} [options.replaceExisting=true]
 * @returns {Number} Number of hydrated or refreshed records.
 */
export function hydrateAdrAdmissionRecords(records = [], {replaceExisting = true} = {}) {
    let hydratedCount = 0;

    for (const rawRecord of records) {
        if (!rawRecord?.canonicalKey) continue;
        const existing = SHARED_ADR_CATALOG_STATE.admissionCatalog.get(rawRecord.canonicalKey) || null;
        if (existing && !replaceExisting) continue;

        const
            mergedAliasBindings = (rawRecord.aliasBindings || []).map(b => ({...b})),
            mergedReservations  = (rawRecord.reservations || []).map(r => ({...r})),
            mergedTransitions   = [...(rawRecord.provenance?.custodyTransitions || [])],
            mergedRenames       = [...(rawRecord.provenance?.repositoryRenames || [])],
            mergedLineage       = [...(rawRecord.provenance?.sourceLineage || [])];

        if (existing) {
            for (const prevBinding of existing.aliasBindings || []) {
                const alreadyInRaw = mergedAliasBindings.some(
                    b => b.kind === prevBinding.kind &&
                         b.value === prevBinding.value &&
                         b.forge === prevBinding.forge &&
                         b.repositoryId === prevBinding.repositoryId &&
                         String(b.namespace || '').toLowerCase() === String(prevBinding.namespace || '').toLowerCase()
                );
                if (!alreadyInRaw) {
                    mergedAliasBindings.push({...prevBinding});
                }
            }

            for (const prevRes of existing.reservations || []) {
                const alreadyInRaw = mergedReservations.some(
                    r => r.kind === prevRes.kind &&
                         r.value === prevRes.value &&
                         r.forge === prevRes.forge &&
                         r.repositoryId === prevRes.repositoryId &&
                         String(r.namespace || '').toLowerCase() === String(prevRes.namespace || '').toLowerCase()
                );
                if (!alreadyInRaw) {
                    mergedReservations.push({...prevRes});
                }
            }

            for (const prevRename of existing.provenance?.repositoryRenames || []) {
                const alreadyInRaw = mergedRenames.some(
                    r => r.repositoryId === prevRename.repositoryId &&
                         r.previousNamespace === prevRename.previousNamespace &&
                         r.currentNamespace === prevRename.currentNamespace
                );
                if (!alreadyInRaw) {
                    mergedRenames.push({...prevRename});
                }
            }

            for (const prevTrans of existing.provenance?.custodyTransitions || []) {
                const alreadyInRaw = mergedTransitions.some(
                    t => t.canonicalKey === prevTrans.canonicalKey &&
                         t.fromRepositoryId === prevTrans.fromRepositoryId &&
                         t.toRepositoryId === prevTrans.toRepositoryId
                );
                if (!alreadyInRaw) {
                    mergedTransitions.push({...prevTrans});
                }
            }
        }

        const record = {
            ...(existing || {}),
            ...rawRecord,
            historicalAliases: [...(rawRecord.historicalAliases || existing?.historicalAliases || [])],
            aliasBindings    : mergedAliasBindings,
            reservations     : mergedReservations,
            provenance       : {
                ...(existing?.provenance || {}),
                ...(rawRecord.provenance || {}),
                custodyTransitions: mergedTransitions,
                repositoryRenames : mergedRenames,
                sourceLineage     : mergedLineage
            }
        };

        for (const tuple of [record.sourceTuple, record.assignmentEvidence]) {
            if (tuple?.repositoryId && tuple?.namespace) {
                const forge = tuple.forge || 'github.com';
                registerSharedForgeRepository({forge, repositoryId: tuple.repositoryId, namespace: tuple.namespace});
                ensureSharedReservationBucket(forge, tuple.repositoryId).numbers.add(record.adrNumber);
            }
        }

        for (const rename of record.provenance.repositoryRenames) {
            if (rename?.repositoryId && rename?.currentNamespace && rename?.previousNamespace) {
                registerSharedForgeRepository({
                    forge       : rename.forge || 'github.com',
                    repositoryId: rename.repositoryId,
                    namespace   : rename.currentNamespace,
                    aliases     : [rename.previousNamespace]
                });
            }
        }

        for (const binding of record.aliasBindings) {
            const bucket = binding.repositoryId
                ? ensureSharedReservationBucket(binding.forge || 'github.com', binding.repositoryId)
                : null;
            if (bucket && binding.kind === 'legacy-number') bucket.numbers.add(binding.value);
            if (bucket && binding.namespace) {
                bucket.aliases.set(`${binding.kind}:${binding.namespace.toLowerCase()}:${binding.value}`, {
                    ...binding,
                    targetKey: record.canonicalKey
                });
            }
        }

        SHARED_ADR_CATALOG_STATE.admissionCatalog.set(record.canonicalKey, record);
        hydratedCount++;
    }

    return hydratedCount;
}

/**
 * @summary Collects deduplicated custody transitions across a list of `adrAdmissionRecord` entries.
 * @param {Iterable<Object>} records
 * @param {Object[]} [seedTransitions=[]]
 * @returns {Object[]}
 * @private
 */
function collectCustodyTransitionsFromRecords(records, seedTransitions = []) {
    const
        transitions = [],
        seen        = new Set();

    const addTransition = (t) => {
        if (!t || (!t.canonicalKey && !t.adrNumber)) return;
        const key = `${t.canonicalKey || t.adrNumber}|${t.fromRepositoryId || ''}|${t.toRepositoryId || ''}|${t.toNamespace || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            transitions.push({...t});
        }
    };

    for (const t of seedTransitions || []) {
        addTransition(t);
    }

    for (const rec of records || []) {
        for (const t of rec?.provenance?.custodyTransitions || []) {
            addTransition({
                adrNumber   : rec.adrNumber,
                canonicalKey: rec.canonicalKey,
                ...t
            });
        }
    }

    return transitions;
}

/**
 * @summary Reads the live admitted ADR projection from Memory Core (`graphDb`, `sqlitePath`,
 * and/or the in-memory `SHARED_ADR_CATALOG_STATE`) into a serializable cross-process snapshot.
 * @param {Object} [options={}]
 * @param {Object|null} [options.graphDb=null]
 * @param {String|null} [options.sqlitePath=null]
 * @param {Boolean} [options.includeInMemory=true]
 * @returns {{version: Number, admissionAvailable: Boolean, records: Object[], custodyTransitions: Object[], repositoryRenames: Object[]}}
 */
export function buildAdrAdmissionProjectionSnapshot({
    graphDb         = null,
    sqlitePath      = null,
    includeInMemory = true
} = {}) {
    const
        byKey   = new Map(),
        renames = [];
    let evidenceReadable = false;

    const collectRecord = (candidate) => {
        if (candidate?.canonicalKey) {
            byKey.set(candidate.canonicalKey, candidate);
        }
    };

    if (includeInMemory && SHARED_ADR_CATALOG_STATE.admissionCatalog.size > 0) {
        evidenceReadable = true;
        for (const rec of SHARED_ADR_CATALOG_STATE.admissionCatalog.values()) {
            collectRecord(rec);
        }
    }

    if (graphDb?.nodes?.items) {
        evidenceReadable = true;
        for (const node of graphDb.nodes.items) {
            const
                label = node.isRecord ? node.get('label') : node.label,
                props = (node.isRecord ? node.get('properties') : node.properties) || {};
            if (label === 'ADR' && props.adrAuthority?.admitted === true && props.adrAdmissionRecord) {
                collectRecord(props.adrAdmissionRecord);
            }
        }
    }

    const openSqlite = graphDb?.storage?.db || null;
    if (openSqlite) {
        try {
            const rows = openSqlite.prepare(`
                SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'ADR'
            `).all();
            evidenceReadable = true;
            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.data);
                    if (parsed?.properties?.adrAuthority?.admitted === true && parsed.properties.adrAdmissionRecord) {
                        collectRecord(parsed.properties.adrAdmissionRecord);
                    }
                } catch {}
            }
        } catch {}
    } else if (typeof sqlitePath === 'string' && sqlitePath.trim() && sqlitePath !== ':memory:' && fs.existsSync(sqlitePath)) {
        let readonlyDb = null;
        try {
            const Database = createRequire(import.meta.url)('better-sqlite3');
            readonlyDb = new Database(sqlitePath, {readonly: true, fileMustExist: true});
            const hasNodesTable = readonlyDb.prepare(`
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Nodes'
            `).get();

            if (hasNodesTable) {
                evidenceReadable = true;
                const rows = readonlyDb.prepare(`
                    SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'ADR'
                `).all();
                for (const row of rows) {
                    try {
                        const parsed = JSON.parse(row.data);
                        if (parsed?.properties?.adrAuthority?.admitted === true && parsed.properties.adrAdmissionRecord) {
                            collectRecord(parsed.properties.adrAdmissionRecord);
                        }
                    } catch {}
                }
            }
        } catch {} finally {
            try { readonlyDb?.close(); } catch {}
        }
    }

    const
        records            = Array.from(byKey.values()),
        custodyTransitions = collectCustodyTransitionsFromRecords(records);

    for (const rec of records) {
        for (const rename of rec?.provenance?.repositoryRenames || []) {
            if (!renames.some(r => r.repositoryId === rename.repositoryId && r.previousNamespace === rename.previousNamespace && r.currentNamespace === rename.currentNamespace)) {
                renames.push({...rename});
            }
        }
    }

    return {
        version           : 1,
        admissionAvailable: records.length > 0 || evidenceReadable,
        records,
        custodyTransitions,
        repositoryRenames : renames
    };
}

export const ADR_ADMISSION_PROJECTION_PATH = '/adr-admission-projection';

/**
 * @summary Creates an HTTP request listener that serves Memory Core's live admitted ADR projection
 * (`GET /adr-admission-projection`) to a separate Knowledge Base process.
 * @param {Object} [options={}]
 * @param {Object|Function|null} [options.graphDb=null]
 * @param {String|Function|null} [options.sqlitePath=null]
 * @param {Boolean} [options.includeInMemory=true]
 * @param {Function|null} [options.getAvailable=null]
 * @returns {Function} Node `http` request listener `(req, res) => void`.
 */
export function createAdrAdmissionProjectionHandler({
    graphDb         = null,
    sqlitePath      = null,
    includeInMemory = true,
    getAvailable    = null
} = {}) {
    return (req, res) => {
        if (req.method && req.method !== 'GET') {
            res.writeHead(405, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Method Not Allowed'}));
            return;
        }

        if (typeof getAvailable === 'function' && !getAvailable(req)) {
            res.writeHead(503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                version           : 1,
                admissionAvailable: false,
                code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
                records           : [],
                custodyTransitions: [],
                repositoryRenames : []
            }));
            return;
        }

        try {
            const
                resolvedGraphDb    = typeof graphDb === 'function' ? graphDb() : graphDb,
                resolvedSqlitePath = typeof sqlitePath === 'function' ? sqlitePath() : sqlitePath,
                snapshot           = buildAdrAdmissionProjectionSnapshot({
                    graphDb   : resolvedGraphDb,
                    sqlitePath: resolvedSqlitePath,
                    includeInMemory
                });
            res.writeHead(snapshot.admissionAvailable ? 200 : 503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(snapshot));
        } catch (error) {
            res.writeHead(503, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({
                version           : 1,
                admissionAvailable: false,
                code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
                message           : error.message,
                records           : [],
                custodyTransitions: [],
                repositoryRenames : []
            }));
        }
    };
}

/**
 * @summary Fetches the live admitted ADR projection across process boundaries via an async reader
 * callback (`admissionProjectionReader`) or an HTTP projection endpoint (`admissionProjectionUrl`).
 * Never throws on transport/HTTP errors; returns `available: false` and `source: 'projection-unavailable'`.
 * @param {Object} [options={}]
 * @param {String|null} [options.admissionProjectionUrl=null]
 * @param {Function|null} [options.admissionProjectionReader=null]
 * @param {Number} [options.timeoutMs=5000]
 * @param {Object} [options.headers={}]
 * @returns {Promise<{available: Boolean, records: Object[], custodyTransitions: Object[], repositoryRenames: Object[], source: String, code?: String}>}
 */
export async function fetchAdrAdmissionProjection({
    admissionProjectionUrl    = null,
    admissionProjectionReader = null,
    timeoutMs                 = 5000,
    headers                   = {}
} = {}) {
    const unavailable = (reason) => ({
        available         : false,
        records           : [],
        custodyTransitions: [],
        repositoryRenames : [],
        source            : 'projection-unavailable',
        code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
        reason
    });

    if (typeof admissionProjectionReader === 'function') {
        try {
            const payload = await admissionProjectionReader({timeoutMs, headers});
            if (!payload || payload.admissionAvailable === false || !Array.isArray(payload.records)) {
                return unavailable(payload?.code || 'READER_REPORTED_UNAVAILABLE');
            }
            const records = payload.records.map(r => r?.adrAdmissionRecord || r).filter(r => r?.canonicalKey);
            return {
                available         : records.length > 0 || payload.admissionAvailable === true,
                records,
                custodyTransitions: collectCustodyTransitionsFromRecords(records, payload.custodyTransitions || []),
                repositoryRenames : Array.isArray(payload.repositoryRenames) ? payload.repositoryRenames : [],
                source            : 'projection-reader'
            };
        } catch (error) {
            return unavailable(error?.message || 'READER_ERROR');
        }
    }

    if (typeof admissionProjectionUrl === 'string' && admissionProjectionUrl.trim()) {
        try {
            const response = await fetch(admissionProjectionUrl.trim(), {
                method : 'GET',
                headers: {Accept: 'application/json', ...headers},
                signal : AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000)
            });

            if (!response.ok) {
                return unavailable(`HTTP_${response.status}`);
            }

            const payload = await response.json();
            if (!payload || payload.admissionAvailable === false || !Array.isArray(payload.records)) {
                return unavailable(payload?.code || 'INVALID_PROJECTION_PAYLOAD');
            }

            const records = payload.records.map(r => r?.adrAdmissionRecord || r).filter(r => r?.canonicalKey);
            return {
                available         : records.length > 0 || payload.admissionAvailable === true,
                records,
                custodyTransitions: collectCustodyTransitionsFromRecords(records, payload.custodyTransitions || []),
                repositoryRenames : Array.isArray(payload.repositoryRenames) ? payload.repositoryRenames : [],
                source            : 'http-projection'
            };
        } catch (error) {
            return unavailable(error?.message || 'FETCH_ERROR');
        }
    }

    return unavailable('NO_PROJECTION_CHANNEL');
}

/**
 * @summary Rehydrates `SHARED_ADR_CATALOG_STATE` from retained admission evidence:
 * explicit `retainedAdmissionRecords`, an open `graphDb` (`GraphService.db`), or the
 * persisted Memory Core SQLite `Nodes` table at `sqlitePath`.
 * @param {Object} [options={}]
 * @param {Object|null} [options.graphDb=null]
 * @param {String|null} [options.sqlitePath=null]
 * @param {Boolean} [options.sqlitePathExplicit=false]
 * @param {Object[]|null} [options.retainedAdmissionRecords=null]
 * @returns {{available: Boolean, recordCount: Number, hydratedCount: Number, source: String, custodyTransitions: Object[], code?: String}}
 */
export function rehydrateAdrCatalogFromEvidence({
    graphDb                  = null,
    sqlitePath               = null,
    sqlitePathExplicit       = false,
    retainedAdmissionRecords = null
} = {}) {
    const
        records  = [],
        seenKeys = new Set();
    let
        evidenceReadable = false,
        evidenceSource   = 'none';

    const collectRecord = (candidate) => {
        if (candidate?.canonicalKey && !seenKeys.has(candidate.canonicalKey)) {
            seenKeys.add(candidate.canonicalKey);
            records.push(candidate);
        }
    };

    if (Array.isArray(retainedAdmissionRecords)) {
        evidenceReadable = true;
        evidenceSource   = 'retained-records';
        for (const rec of retainedAdmissionRecords) {
            collectRecord(rec?.adrAdmissionRecord || rec);
        }
    }

    if (graphDb?.nodes?.items) {
        evidenceReadable = true;
        if (evidenceSource === 'none') evidenceSource = 'graph-db';
        for (const node of graphDb.nodes.items) {
            const
                label = node.isRecord ? node.get('label') : node.label,
                props = (node.isRecord ? node.get('properties') : node.properties) || {};
            if (label === 'ADR' && props.adrAuthority?.admitted === true && props.adrAdmissionRecord) {
                collectRecord(props.adrAdmissionRecord);
            }
        }
    }

    const openSqlite = graphDb?.storage?.db || null;
    if (openSqlite) {
        try {
            const rows = openSqlite.prepare(`
                SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'ADR'
            `).all();
            evidenceReadable = true;
            if (evidenceSource === 'none') evidenceSource = 'graph-sqlite';
            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.data);
                    if (parsed?.properties?.adrAuthority?.admitted === true && parsed.properties.adrAdmissionRecord) {
                        collectRecord(parsed.properties.adrAdmissionRecord);
                    }
                } catch {}
            }
        } catch {}
    } else if (typeof sqlitePath === 'string' && sqlitePath.trim() && sqlitePath !== ':memory:' && fs.existsSync(sqlitePath)) {
        let readonlyDb = null;
        try {
            const Database = createRequire(import.meta.url)('better-sqlite3');
            readonlyDb = new Database(sqlitePath, {readonly: true, fileMustExist: true});
            const hasNodesTable = readonlyDb.prepare(`
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Nodes'
            `).get();

            if (hasNodesTable) {
                evidenceReadable = true;
                if (evidenceSource === 'none') evidenceSource = 'sqlite-file';
                const rows = readonlyDb.prepare(`
                    SELECT id, data FROM Nodes WHERE json_extract(data, '$.label') = 'ADR'
                `).all();
                for (const row of rows) {
                    try {
                        const parsed = JSON.parse(row.data);
                        if (parsed?.properties?.adrAuthority?.admitted === true && parsed.properties.adrAdmissionRecord) {
                            collectRecord(parsed.properties.adrAdmissionRecord);
                        }
                    } catch {}
                }
            }
        } catch {
            // SQLite file unreadable or uninitialized; admission evidence remains unavailable unless already in catalog.
        } finally {
            try { readonlyDb?.close(); } catch {}
        }
    }

    if (sqlitePathExplicit && !evidenceReadable && !Array.isArray(retainedAdmissionRecords) && !graphDb) {
        return {
            available         : false,
            recordCount       : 0,
            hydratedCount     : 0,
            source            : 'projection-unavailable',
            code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
            custodyTransitions: []
        };
    }

    const
        hydratedCount      = hydrateAdrAdmissionRecords(records, {replaceExisting: true}),
        recordCount        = SHARED_ADR_CATALOG_STATE.admissionCatalog.size,
        available          = recordCount > 0 || (evidenceReadable && Array.isArray(retainedAdmissionRecords)),
        custodyTransitions = collectCustodyTransitionsFromRecords(SHARED_ADR_CATALOG_STATE.admissionCatalog.values());

    return {
        available,
        recordCount,
        hydratedCount,
        source: recordCount > 0 && evidenceSource === 'none' ? 'in-memory-catalog' : evidenceSource,
        custodyTransitions
    };
}

/**
 * @summary Asynchronously rehydrates `SHARED_ADR_CATALOG_STATE` from a live cross-process admission
 * projection (`admissionProjectionUrl` or `admissionProjectionReader`) or falls back to
 * `rehydrateAdrCatalogFromEvidence` (`retainedAdmissionRecords`, `graphDb`, `sqlitePath`).
 * When a configured live admission projection channel fails, returns `available: false` and
 * `source: 'projection-unavailable'` (`code: 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE'`) without
 * admitting from markdown files or falling back to stale unverified state.
 * @param {Object} [options={}]
 * @returns {Promise<{available: Boolean, recordCount: Number, hydratedCount: Number, source: String, custodyTransitions: Object[], code?: String}>}
 */
export async function rehydrateAdrCatalogFromEvidenceAsync(options = {}) {
    const hasAsyncChannel = typeof options.admissionProjectionReader === 'function' ||
        (typeof options.admissionProjectionUrl === 'string' && Boolean(options.admissionProjectionUrl.trim()));

    if (hasAsyncChannel) {
        const proj = await fetchAdrAdmissionProjection(options);
        if (!proj.available) {
            return {
                available         : false,
                recordCount       : 0,
                hydratedCount     : 0,
                source            : 'projection-unavailable',
                code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
                custodyTransitions: []
            };
        }

        const
            hydratedCount      = hydrateAdrAdmissionRecords(proj.records, {replaceExisting: true}),
            recordCount        = SHARED_ADR_CATALOG_STATE.admissionCatalog.size,
            custodyTransitions = collectCustodyTransitionsFromRecords(
                SHARED_ADR_CATALOG_STATE.admissionCatalog.values(),
                proj.custodyTransitions || []
            );

        return {
            available: recordCount > 0 || proj.available,
            recordCount,
            hydratedCount,
            source   : proj.source,
            custodyTransitions
        };
    }

    return rehydrateAdrCatalogFromEvidence(options);
}

/**
 * @summary Evaluates whether a reader context is authorized for an admitted ADR record,
 * including private-repository (`neomjs/neo-stage`) tenant/reader policy controls.
 * @param {Object} record
 * @param {Object} [context={}]
 * @returns {Boolean}
 */
export function isAdrReaderAuthorized(record, context = {}) {
    if (!record) return false;
    if (typeof context.isAuthorized === 'function' && !context.isAuthorized(record)) return false;

    const
        repoId     = record.sourceTuple?.repositoryId || record.assignmentEvidence?.repositoryId,
        namespace  = (record.sourceTuple?.namespace || record.assignmentEvidence?.namespace || '').toLowerCase(),
        visibility = record.visibility || 'public',
        tenantId   = record.tenantId || null;

    if (Array.isArray(context.authorizedRepositoryIds)) {
        const allowedIds = new Set(context.authorizedRepositoryIds.map(String));
        if (!allowedIds.has(String(repoId))) return false;
    }

    if (Array.isArray(context.authorizedNamespaces)) {
        const allowedNs = new Set(context.authorizedNamespaces.map(ns => String(ns).toLowerCase()));
        if (!allowedNs.has(namespace)) return false;
    }

    if (Array.isArray(context.authorizedTenants) && tenantId) {
        const allowedTenants = new Set(context.authorizedTenants.map(String));
        if (!allowedTenants.has(String(tenantId))) return false;
    }

    if (visibility === 'private') {
        const
            hasRepoAuth   = Array.isArray(context.authorizedRepositoryIds) &&
                            context.authorizedRepositoryIds.map(String).includes(String(repoId)),
            hasNsAuth     = Array.isArray(context.authorizedNamespaces) &&
                            context.authorizedNamespaces.map(ns => String(ns).toLowerCase()).includes(namespace),
            hasTenantAuth = (Boolean(tenantId) && context.tenantId === tenantId) ||
                            (Boolean(tenantId) && Array.isArray(context.authorizedTenants) && context.authorizedTenants.includes(tenantId)),
            hasCustomAuth = typeof context.isAuthorized === 'function' && Boolean(context.isAuthorized(record));

        if (!hasRepoAuth && !hasNsAuth && !hasTenantAuth && !hasCustomAuth) {
            return false;
        }
    }

    return true;
}

/**
 * @summary Binds current slug, historical aliases, and legacy-number reservations on an admitted record
 * and in the shared repository reservation buckets. Fails with `ADR_MISSING_SOURCE_NAMESPACE` if a
 * record arrives without an explicit `<organization>/<repository>` source namespace.
 * @param {Object} record
 * @param {Object|null} specRepo
 * @param {Object} adr
 * @param {Boolean} [isCustodyMove=false]
 */
export function bindSharedAdrRecordAliases(record, specRepo, adr, isCustodyMove = false) {
    const
        forge        = specRepo?.forge || record?.sourceTuple?.forge || record?.assignmentEvidence?.forge || 'github.com',
        sourceRepoId = specRepo?.repositoryId || record?.sourceTuple?.repositoryId || record?.assignmentEvidence?.repositoryId || null,
        sourceNs     = specRepo?.namespace || record?.sourceTuple?.namespace || record?.assignmentEvidence?.namespace || null;

    if (typeof sourceNs !== 'string' || !FULL_NAMESPACE_REGEX.test(sourceNs.trim())) {
        throw createCodedError(
            'ADR_MISSING_SOURCE_NAMESPACE',
            `Cannot bind aliases for ADR '${adr?.canonicalKey || record?.canonicalKey || 'unknown'}' without an explicit source namespace (<organization>/<repository>).`
        );
    }

    const addBinding = (bucket, binding) => {
        const
            normalizedNs = binding.namespace.toLowerCase(),
            matches      = item => item.kind === binding.kind && item.value === binding.value &&
                                   item.forge === binding.forge && item.repositoryId === binding.repositoryId &&
                                   item.namespace.toLowerCase() === normalizedNs,
            existing     = record.aliasBindings.find(matches);

        if (existing) {
            existing.current = Boolean(binding.current);
        } else {
            record.aliasBindings.push({...binding});
        }

        if (!record.reservations.some(matches)) {
            record.reservations.push({
                kind        : binding.kind,
                value       : binding.value,
                forge       : binding.forge,
                repositoryId: binding.repositoryId,
                namespace   : binding.namespace,
                targetKey   : record.canonicalKey
            });
        }

        if (bucket) {
            bucket.aliases.set(`${binding.kind}:${normalizedNs}:${binding.value}`, {...binding, targetKey: record.canonicalKey});
        }
    };

    const bucket = sourceRepoId ? ensureSharedReservationBucket(forge, sourceRepoId) : null;
    if (bucket) {
        bucket.numbers.add(adr.adrNumber);
    }

    for (const b of record.aliasBindings) {
        if (b.kind === 'slug' && b.forge === forge && b.repositoryId === sourceRepoId) {
            b.current = (b.value === adr.currentSlug && b.namespace.toLowerCase() === sourceNs.toLowerCase());
        }
    }

    addBinding(bucket, {kind: 'slug', value: adr.currentSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});
    addBinding(bucket, {kind: 'legacy-number', value: adr.adrNumber, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: true});

    for (const histSlug of adr.historicalAliases || []) {
        const alreadyAdmitted = record.aliasBindings.some(b => b.kind === 'slug' && b.value === histSlug);
        if (!alreadyAdmitted && !isCustodyMove) {
            addBinding(bucket, {kind: 'slug', value: histSlug, forge, repositoryId: sourceRepoId, namespace: sourceNs, targetKey: adr.canonicalKey, current: false});
        }
    }

    if (record.assignmentEvidence?.repositoryId && record.assignmentEvidence.repositoryId !== sourceRepoId) {
        const
            originForge  = record.assignmentEvidence.forge || forge,
            originRepoId = record.assignmentEvidence.repositoryId,
            originBucket = ensureSharedReservationBucket(originForge, originRepoId);
        originBucket.numbers.add(adr.adrNumber);
        if (record.assignmentEvidence.namespace) {
            const originNs = record.assignmentEvidence.namespace;
            addBinding(originBucket, {kind: 'slug', value: adr.currentSlug, forge: originForge, repositoryId: originRepoId, namespace: originNs, targetKey: adr.canonicalKey, current: false});
            addBinding(originBucket, {kind: 'legacy-number', value: adr.adrNumber, forge: originForge, repositoryId: originRepoId, namespace: originNs, targetKey: adr.canonicalKey, current: false});
        }
    }
}

function unresolvedRefResult(reasonCode, candidates = []) {
    return {
        status           : candidates.length > 1 ? 'ambiguous' : 'unresolved',
        resolved         : false,
        canonicalKey     : null,
        identityResolved : false,
        documentAvailable: false,
        candidates,
        reasonCode
    };
}

function resolvedRefResult(record) {
    return {
        status           : 'resolved',
        resolved         : true,
        canonicalKey     : record.canonicalKey,
        identityResolved : true,
        documentAvailable: Boolean(record.documentAvailable),
        kbAvailable      : Boolean(record.kbAvailable),
        stale            : Boolean(record.stale),
        record,
        candidates       : [record.canonicalKey]
    };
}

/**
 * @summary Resolves a human or machine ADR citation against the shared admitted catalog using
 * evidenced citation context, forge-adapter repository identity lookup, rename/reuse conflict rules,
 * and reader authorization.
 * @param {String} reference
 * @param {Object} [context={}]
 * @returns {Object}
 */
export function resolveSharedAdrReference(reference, context = {}) {
    const
        catalog = SHARED_ADR_CATALOG_STATE.admissionCatalog,
        raw     = typeof reference === 'string' ? reference.trim() : '';

    if (!raw) return unresolvedRefResult('EMPTY_REFERENCE');

    if (raw.startsWith('adr:') && raw.split(':').length === 5) {
        let parsedKey;
        try {
            parsedKey = parseCanonicalAdrKey(raw);
        } catch (e) {
            return unresolvedRefResult(e.code || 'ADR_INVALID_CANONICAL_KEY');
        }
        const record = catalog.get(parsedKey.canonicalKey);
        if (!record || !isAdrReaderAuthorized(record, context)) {
            return unresolvedRefResult('NOT_FOUND');
        }
        return resolvedRefResult(record);
    }

    const parsedRef = parseHumanOrNumericAdrReference(raw);
    if (!parsedRef.ok) return unresolvedRefResult(parsedRef.reasonCode);

    const
        {explicitForge, explicitNamespace, targetKind, targetValue} = parsedRef,
        surfaceContext                                              = extractCitationSurfaceContext(context),
        effectiveForge                                              = explicitForge || surfaceContext.forge,
        hasRepositoryContext                                        = Boolean(explicitNamespace || surfaceContext.repositoryId || surfaceContext.namespace);

    if (!hasRepositoryContext) {
        const matchingAuthorized = [];
        for (const record of catalog.values()) {
            if (!isAdrReaderAuthorized(record, context)) continue;
            const matches = record.aliasBindings?.some(
                b => b.kind === targetKind && b.value === targetValue && (!effectiveForge || b.forge === effectiveForge)
            ) || (targetKind === 'legacy-number' && record.adrNumber === targetValue && !record.assignmentEvidence?.repositoryId);
            if (matches) matchingAuthorized.push(record.canonicalKey);
        }

        if (matchingAuthorized.length === 1 &&
            matchingAuthorized[0] === `adr-${targetValue}` &&
            !context.surface &&
            !context.requireRepositoryContext) {
            return resolvedRefResult(catalog.get(matchingAuthorized[0]));
        }
        return unresolvedRefResult('MISSING_REPOSITORY_CONTEXT', matchingAuthorized);
    }

    if (!effectiveForge) return unresolvedRefResult('MISSING_FORGE_CONTEXT');

    const
        targetNamespace   = explicitNamespace || surfaceContext.namespace,
        lowerTargetNs     = targetNamespace ? targetNamespace.toLowerCase() : null,
        forgeMap          = SHARED_ADR_CATALOG_STATE.forgeDirectory.get(effectiveForge),
        adapterResolution = lowerTargetNs && forgeMap ? forgeMap.get(lowerTargetNs) : null,
        currentOccupantId = (!explicitNamespace && surfaceContext.repositoryId)
            ? surfaceContext.repositoryId
            : (adapterResolution?.repositoryId || null),
        namespaceBindings = [],
        repoIdBindings    = [];

    for (const record of catalog.values()) {
        for (const binding of record.aliasBindings || []) {
            if (binding.forge !== effectiveForge || binding.kind !== targetKind || binding.value !== targetValue) continue;
            if (lowerTargetNs && binding.namespace.toLowerCase() === lowerTargetNs) namespaceBindings.push({binding, record});
            if (currentOccupantId && binding.repositoryId === currentOccupantId) repoIdBindings.push({binding, record});
        }
    }

    if (lowerTargetNs && currentOccupantId) {
        const conflictingHistorical = namespaceBindings.filter(entry => entry.binding.repositoryId !== currentOccupantId);
        if (conflictingHistorical.length > 0) {
            const candidateSet = new Set();
            for (const entry of [...conflictingHistorical, ...namespaceBindings.filter(e => e.binding.repositoryId === currentOccupantId)]) {
                if (isAdrReaderAuthorized(entry.record, context)) candidateSet.add(entry.record.canonicalKey);
            }
            const authorizedCandidates = Array.from(candidateSet);
            if (authorizedCandidates.length === 0) return unresolvedRefResult('NOT_FOUND');

            return {
                status              : 'conflict',
                resolved            : false,
                canonicalKey        : null,
                identityResolved    : false,
                documentAvailable   : false,
                requiresCanonicalKey: true,
                candidates          : authorizedCandidates,
                reasonCode          : 'RESERVED_NAMESPACE_OCCUPANCY_CONFLICT'
            };
        }
    }

    let matchedEntries = [];
    if (lowerTargetNs) {
        matchedEntries = namespaceBindings;
        if (matchedEntries.length === 0 && currentOccupantId && adapterResolution) {
            matchedEntries = repoIdBindings.filter(entry =>
                entry.record.provenance?.repositoryRenames?.some(
                    r => r.forge === effectiveForge &&
                         r.repositoryId === currentOccupantId &&
                         (r.currentNamespace.toLowerCase() === lowerTargetNs || r.previousNamespace.toLowerCase() === lowerTargetNs)
                )
            );
        }
    } else if (currentOccupantId) {
        matchedEntries = repoIdBindings;
    }

    const
        authorizedRecords = [],
        seenKeys          = new Set();

    for (const entry of matchedEntries) {
        if (!seenKeys.has(entry.record.canonicalKey) && isAdrReaderAuthorized(entry.record, context)) {
            seenKeys.add(entry.record.canonicalKey);
            authorizedRecords.push(entry.record);
        }
    }

    if (authorizedRecords.length === 0) return unresolvedRefResult('NOT_FOUND');
    if (authorizedRecords.length > 1)   return unresolvedRefResult('AMBIGUOUS_REFERENCE', authorizedRecords.map(r => r.canonicalKey));

    return resolvedRefResult(authorizedRecords[0]);
}

resetSharedAdrCatalog();
