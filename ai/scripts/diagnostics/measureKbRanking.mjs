#!/usr/bin/env node
import 'dotenv/config';

import {Command}                      from 'commander';
import {execFile}                     from 'node:child_process';
import fs                             from 'node:fs/promises';
import os                             from 'node:os';
import path                           from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify}                    from 'node:util';
import {isEntryModule}                from '../../services/shared/isEntryModule.mjs';

/**
 * Pre-Flight (structural fast-path): `ai/scripts/diagnostics/measureKbRanking.mjs` lifts the
 * sibling pattern of `presetQualityFloor.mjs` — a read-only diagnostics CLI with an isolated child
 * process, exported pure helpers, and unit coverage; no novel directory.
 *
 * @module ai/scripts/diagnostics/measureKbRanking
 * @summary Three-arm ranking benchmark for the Knowledge Base against plain nearest-chunk Chroma
 * retrieval and checkout ripgrep over a verified query-log fixture (`kbRankingQuestions.json`).
 *
 * Each live Chroma run executes in a child process whose telemetry SQLite, log directory, REM state
 * directory, and resume-state directory resolve under an ephemeral scratch root verified by
 * {@link isolatedUnder} before `ChromaManager`, `QueryService`, or `SearchService` load, while
 * `chromaDatabase` resolves to `default_database` so the live `neo-knowledge-base` collection is
 * queried read-only without mutating live Agent OS telemetry.
 */

const
    execFileAsync = promisify(execFile),
    here          = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot     = path.resolve(here, '../../..');

/** Default path to the verified query-log benchmark fixture. */
export const DEFAULT_FIXTURE_PATH = path.join(here, 'fixtures', 'kbRankingQuestions.json');

/** Default candidate horizon shared across all three arms. */
export const DEFAULT_HORIZON = 100;

/** Timeout for the child process running Chroma queries and optional `SearchService.ask` calls. */
export const CHILD_TIMEOUT_MS = 25 * 60 * 1000;

/** Timeout per ripgrep invocation against one repository checkout. */
export const RIPGREP_TIMEOUT_MS = 30 * 1000;

/** Standard English closed-class question words excluded from the ripgrep arm. */
export const STOPWORDS = Object.freeze(new Set([
    'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before',
    'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'each', 'either', 'for',
    'from', 'had', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'more',
    'most', 'must', 'no', 'nor', 'not', 'of', 'on', 'one', 'only', 'or', 'other', 'our', 'out',
    'over', 'same', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then',
    'there', 'these', 'they', 'this', 'those', 'through', 'to', 'under', 'up', 'use', 'used',
    'using', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
    'with', 'within', 'without', 'would'
]));

const CANONICAL_CLASSES = [
    'parent-class',
    'source-only',
    'source-with-guide-mention',
    'guide-covered'
];

const RIPGREP_EXCLUDE_GLOBS = [
    '!package-lock.json',
    '!docs/output/**',
    '!dist/**',
    '!coverage/**',
    '!node_modules/**',
    '!.neo-ai-data/**',
    '!.git/**',
    '!*.{svg,png,jpg,jpeg,webp,woff,woff2,ttf,ico}'
];

/**
 * @summary Escapes regex metacharacters in a literal query token.
 * @param {String} token Input token.
 * @returns {String} Regex-safe literal token.
 */
function escapeRegex(token) {
    return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @summary Extracts unique lowercase content words (`length >= 3`, non-stopword) for the ripgrep arm.
 * @param {String} question Question text or keyword query.
 * @returns {String[]} Deduplicated ordered content tokens.
 */
export function extractGrepWords(question) {
    const tokens = String(question || '').toLowerCase().split(/[^A-Za-z0-9_]+/);
    const seen   = new Set();
    const out    = [];

    for (const token of tokens) {
        if (token.length >= 3 && !STOPWORDS.has(token) && !seen.has(token)) {
            seen.add(token);
            out.push(token);
        }
    }

    return out;
}

/**
 * @summary Builds a single word-bounded regex alternation from content words.
 * @param {String[]} words Extracted content tokens.
 * @returns {String|null} Alternation pattern or null when empty.
 */
export function buildRipgrepPattern(words) {
    if (!Array.isArray(words) || words.length === 0) {
        return null;
    }

    const escaped = words.filter(Boolean).map(word => escapeRegex(String(word)));

    return escaped.length > 0 ? `\\b(?:${escaped.join('|')})\\b` : null;
}

/**
 * @summary Parses `rg --count-matches -i` stdout lines (`<relPath>:<count>`) into structured hits.
 * @param {String} stdout Raw ripgrep stdout.
 * @param {String} repo Repository slug owning the scanned checkout.
 * @returns {Array<{repo: String, source: String, count: Number}>} Parsed positive-count hits.
 */
export function parseRipgrepCountOutput(stdout, repo) {
    const hits  = [];
    const lines = String(stdout || '').split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const sep = line.lastIndexOf(':');
        if (sep <= 0) {
            continue;
        }

        const source = line.slice(0, sep).replaceAll('\\', '/').replace(/^\.\//, '');
        const count  = Number(line.slice(sep + 1));

        if (source && Number.isFinite(count) && count > 0) {
            hits.push({repo, source, count});
        }
    }

    return hits;
}

/**
 * @summary Orders ripgrep hits descending by match count, tie-breaking ascending by `repo/source`.
 * @param {Array<{repo: String, source: String, count: Number}>} hits Combined hits across checkouts.
 * @returns {Array<{repo: String, source: String, count: Number}>} Sorted hits.
 */
export function rankRipgrepHits(hits) {
    return [...(hits || [])].sort((a, b) => {
        if (b.count !== a.count) {
            return b.count - a.count;
        }

        const keyA = `${a.repo || ''}/${a.source || ''}`;
        const keyB = `${b.repo || ''}/${b.source || ''}`;

        return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
}

/**
 * @summary Normalizes corpus source paths across OS separators and Engine package prefixes.
 * @param {String} source Raw source path.
 * @returns {String} Repo-relative POSIX path.
 */
export function normalizeCorpusSourcePath(source) {
    return String(source || '')
        .replaceAll('\\', '/')
        .replace(/^\.?\//, '')
        .replace(/^node_modules\/neo\.mjs\//, '');
}

/**
 * @summary Folds Chroma chunk metadata in nearest-chunk order into distinct normalized source files.
 * @param {Array<Object>} metadatas Chroma `metadatas[0]` array ordered closest-first.
 * @returns {String[]} Unique normalized source paths in first-seen chunk order.
 */
export function foldChunksToSources(metadatas) {
    const seen    = new Set();
    const sources = [];

    for (const metadata of metadatas || []) {
        const rawSource = metadata?.source;
        if (!rawSource || rawSource === 'unknown') {
            continue;
        }

        const normalized = normalizeCorpusSourcePath(rawSource);
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        sources.push(normalized);
    }

    return sources;
}

/**
 * @summary Selects either the pre-registered balanced-40 subset or all fixture questions.
 * @param {Object} fixture Loaded `kbRankingQuestions.json` fixture.
 * @param {Object} [options]
 * @param {Boolean} [options.all49=false] Return all verified questions instead of `inBalanced40`.
 * @returns {Array<Object>} Selected question rows.
 */
export function selectQuestions(fixture, {all49 = false} = {}) {
    const questions = Array.isArray(fixture?.questions) ? fixture.questions : [];

    return all49 ? [...questions] : questions.filter(row => row.inBalanced40 === true);
}

/**
 * @summary Scores one arm's ranked result list against a question's verified `answerFiles`.
 * @param {Array<String|Object>} rankedEntries Ordered results (`source` strings or `{repo, source}`).
 * @param {Object} question Fixture question row.
 * @param {Object} [options]
 * @param {Number} [options.topK=5] Top-k cutoff for `hitAt5`.
 * @returns {{hitAt5: Boolean, firstRank: Number|null, firstMatchedPath: String|null, top5: Array<String>}}
 */
export function evaluateArmQuestion(rankedEntries, question, {topK = 5} = {}) {
    const entries       = Array.isArray(rankedEntries) ? rankedEntries : [];
    const expectedPaths = new Set((question?.answerFiles || []).map(item => normalizeCorpusSourcePath(item.path)));

    let firstRank        = null;
    let firstMatchedPath = null;

    for (let index = 0; index < entries.length; index++) {
        const entry      = entries[index];
        const entryRepo  = entry && typeof entry === 'object' ? entry.repo : null;
        const entryRaw   = entry && typeof entry === 'object' ? entry.source : entry;
        const normalized = normalizeCorpusSourcePath(entryRaw);

        if (entryRepo && question?.repo && entryRepo !== question.repo) {
            continue;
        }

        if (expectedPaths.has(normalized)) {
            firstRank        = index + 1;
            firstMatchedPath = normalized;
            break;
        }
    }

    const top5 = entries.slice(0, topK).map(entry => {
        if (entry && typeof entry === 'object') {
            return entry.repo ? `${entry.repo}:${normalizeCorpusSourcePath(entry.source)}` : normalizeCorpusSourcePath(entry.source);
        }

        return normalizeCorpusSourcePath(entry);
    });

    return {
        hitAt5: firstRank !== null && firstRank <= topK,
        firstRank,
        firstMatchedPath,
        top5
    };
}

/**
 * @summary Computes median of a sorted or unsorted array of numbers (`null` if empty).
 * @param {Number[]} values Numeric values.
 * @returns {Number|null} Median rounded cleanly.
 */
function computeMedian(values) {
    if (!values || values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid    = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1
        ? sorted[mid]
        : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
}

/**
 * @summary Aggregates Recall@5, rank distribution, and MRR over a slice of single-arm evaluations.
 * @param {Array<{hitAt5: Boolean, firstRank: Number|null}>} questionEvaluations Evaluated rows for one arm.
 * @returns {Object} Summary statistics.
 */
export function summarizeArmMetrics(questionEvaluations) {
    const rows        = Array.isArray(questionEvaluations) ? questionEvaluations : [];
    const n           = rows.length;
    const hitsAt5     = rows.filter(row => row.hitAt5).length;
    const foundRanks  = rows.map(row => row.firstRank).filter(rank => Number.isFinite(rank));
    const foundCount  = foundRanks.length;
    const missCount   = n - foundCount;
    const totalRr     = rows.reduce((sum, row) => sum + (row.firstRank ? 1 / row.firstRank : 0), 0);
    const sortedAll   = rows.map(row => row.firstRank ?? Infinity).sort((a, b) => a - b);
    let   medianAll   = null;

    if (n > 0) {
        const mid = Math.floor(n / 2);
        if (n % 2 === 1) {
            medianAll = Number.isFinite(sortedAll[mid]) ? sortedAll[mid] : 'miss';
        } else {
            const left = sortedAll[mid - 1], right = sortedAll[mid];
            medianAll = Number.isFinite(left) && Number.isFinite(right)
                ? Number(((left + right) / 2).toFixed(2))
                : 'miss';
        }
    }

    return {
        n,
        hitsAt5,
        recallAt5         : n > 0 ? Number((hitsAt5 / n).toFixed(4)) : 0,
        foundCount,
        missCount,
        medianFirstRank   : computeMedian(foundRanks),
        medianFirstRankAll: medianAll,
        meanReciprocalRank: n > 0 ? Number((totalRr / n).toFixed(4)) : 0
    };
}

/**
 * @summary Summarizes all three arms across a subset of per-question evaluation records.
 * @param {Array<Object>} questionResults Combined per-question records.
 * @returns {{shipped: Object, nearestChunks: Object, ripgrep: Object}} Three-arm summaries.
 */
function summarizeSlice(questionResults) {
    return {
        shipped      : summarizeArmMetrics(questionResults.map(row => row.arms.shipped)),
        nearestChunks: summarizeArmMetrics(questionResults.map(row => row.arms.nearestChunks)),
        ripgrep      : summarizeArmMetrics(questionResults.map(row => row.arms.ripgrep))
    };
}

/**
 * @summary Identifies canonical question classes where the shipped ranking is not the best arm.
 * @param {Object<String, {shipped: Object, nearestChunks: Object, ripgrep: Object}>} byClassSummary Slice summaries keyed by class.
 * @returns {Array<Object>} Underperforming class records for AC-4 ticket filing.
 */
export function findUnderperformingClasses(byClassSummary) {
    const underperforming = [];

    for (const className of CANONICAL_CLASSES) {
        const entry = byClassSummary?.[className];
        if (!entry || !entry.shipped || entry.shipped.n === 0) {
            continue;
        }

        const shipped        = entry.shipped;
        const candidates     = [
            {arm: 'nearestChunks', metrics: entry.nearestChunks},
            {arm: 'ripgrep', metrics: entry.ripgrep}
        ].filter(item => item.metrics && item.metrics.n > 0);

        const bestCompetitor = candidates.sort((a, b) => {
            if (b.metrics.hitsAt5 !== a.metrics.hitsAt5) {
                return b.metrics.hitsAt5 - a.metrics.hitsAt5;
            }
            return b.metrics.meanReciprocalRank - a.metrics.meanReciprocalRank;
        })[0];

        if (!bestCompetitor) {
            continue;
        }

        const losesOnHits = shipped.hitsAt5 < bestCompetitor.metrics.hitsAt5;
        const losesOnMrr  = shipped.hitsAt5 === bestCompetitor.metrics.hitsAt5
            && shipped.meanReciprocalRank < bestCompetitor.metrics.meanReciprocalRank;

        if (losesOnHits || losesOnMrr) {
            underperforming.push({
                class          : className,
                reason         : losesOnHits ? 'recallAt5' : 'meanReciprocalRank',
                bestArm        : bestCompetitor.arm,
                shippedHitsAt5 : shipped.hitsAt5,
                bestHitsAt5    : bestCompetitor.metrics.hitsAt5,
                shippedMrr     : shipped.meanReciprocalRank,
                bestMrr        : bestCompetitor.metrics.meanReciprocalRank
            });
        }
    }

    return underperforming;
}

/**
 * @summary Builds the isolated environment variables for the live Chroma child process.
 * @param {String} scratchRoot Absolute directory created by the parent and removed on exit.
 * @returns {Object} Environment overrides isolating SQLite/logs/sync state while targeting `default_database`.
 */
export function isolationEnv(scratchRoot) {
    return {
        UNIT_TEST_MODE                  : 'false',
        NEO_TEST_CONFIG_TEMPLATES       : 'false',
        NEO_KB_RANKING_SCRATCH_ROOT     : scratchRoot,
        NEO_PLANE_DATA_ROOT             : scratchRoot,
        NEO_MEMORY_DB_PATH              : path.join(scratchRoot, 'kb-ranking-telemetry.sqlite'),
        NEO_KB_LOG_PATH                 : path.join(scratchRoot, 'logs'),
        NEO_KB_EMBEDDING_RESUME_STATE_DIR: path.join(scratchRoot, 'kb-sync'),
        NEO_REM_RUN_STATE_DIR           : path.join(scratchRoot, 'rem-runs')
    };
}

/**
 * @summary Verifies that every mutable store/log coordinate resolves under `scratchRoot` while Chroma reads `default_database`.
 * @param {Object|undefined} isolation Reported config paths from the child process.
 * @param {String} scratchRoot Expected ephemeral root directory.
 * @returns {String|null} Refusal reason, or `null` when properly isolated.
 */
export function isolatedUnder(isolation, scratchRoot) {
    if (!isolation || typeof isolation !== 'object') {
        return 'the child reported no isolation envelope';
    }

    const root  = path.resolve(String(scratchRoot || ''));
    const under = value => {
        if (typeof value !== 'string' || !value) {
            return false;
        }
        const resolved = path.resolve(value);
        return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    };

    if (isolation.chromaDatabase !== 'default_database') {
        return `expected chromaDatabase=default_database, got ${isolation.chromaDatabase}`;
    }

    for (const key of ['dataRoot', 'mcGraphPath', 'memoryCoreDbPath', 'logPath', 'embeddingResumeStateDir']) {
        if (!under(isolation[key])) {
            return `resolved ${key}=${isolation[key]} outside scratch root ${root}`;
        }
    }

    return null;
}

/**
 * @summary Emits the child program run under Node to execute Arm A (`shipped`), Arm B (`nearestChunks`),
 * Chroma index coverage probes, and optional `SearchService.ask` evaluations.
 * @param {String} root Brain repository root.
 * @returns {String} ES module source string for `node --input-type=module -e`.
 */
export function childSource(root) {
    const file = relative => pathToFileURL(path.join(root, relative)).href;

    return `
        const fs    = await import('node:fs/promises');
        const path  = await import('node:path');
        const log   = msg => process.stderr.write('[measureKbRanking:child] ' + msg + '\\n');
        const print = async value => {
            const outFile = process.env.NEO_KB_RANKING_OUTPUT;
            if (outFile) {
                await fs.writeFile(outFile, JSON.stringify(value), 'utf8');
                process.stdout.write(JSON.stringify({outputFile: outFile}) + '\\n');
            } else {
                process.stdout.write(JSON.stringify(value) + '\\n');
            }
        };

        globalThis.Neo = {config: {environment: 'development', unitTestMode: false}};
        await import(${JSON.stringify(file('node_modules/neo.mjs/src/Neo.mjs'))});
        await import(${JSON.stringify(file('node_modules/neo.mjs/src/core/_export.mjs'))});

        const {default: kbConfig} = await import(${JSON.stringify(file('ai/mcp/server/knowledge-base/config.mjs'))});
        const {default: mcConfig} = await import(${JSON.stringify(file('ai/mcp/server/memory-core/config.mjs'))});
        const {isolatedUnder}     = await import(${JSON.stringify(file('ai/scripts/diagnostics/measureKbRanking.mjs'))});

        const isolation = {
            dataRoot               : mcConfig.plane?.dataRoot ?? null,
            mcGraphPath            : mcConfig.storagePaths?.graph ?? null,
            memoryCoreDbPath       : kbConfig.memoryCoreDbPath ?? null,
            logPath                : kbConfig.logPath ?? null,
            embeddingResumeStateDir: kbConfig.embeddingResumeStateDir ?? null,
            chromaDatabase         : kbConfig.chromaDatabase ?? null
        };

        const refusal = isolatedUnder(isolation, process.env.NEO_KB_RANKING_SCRATCH_ROOT);
        if (refusal) {
            await print({isolation, unmeasured: 'child isolation failed: ' + refusal});
            process.exit(0);
        }

        const payload = JSON.parse(await fs.readFile(process.env.NEO_KB_RANKING_INPUT, 'utf8'));
        const horizon = Number(payload.horizon) || 100;

        const {default: ChromaManager}        = await import(${JSON.stringify(file('ai/services/knowledge-base/ChromaManager.mjs'))});
        const {default: QueryService}         = await import(${JSON.stringify(file('ai/services/knowledge-base/QueryService.mjs'))});
        const {default: SearchService}        = await import(${JSON.stringify(file('ai/services/knowledge-base/SearchService.mjs'))});
        const {default: TextEmbeddingService} = await import(${JSON.stringify(file('ai/services/memory-core/TextEmbeddingService.mjs'))});

        await ChromaManager.ready();
        await QueryService.ready();
        await SearchService.ready();

        const collection = await ChromaManager.getKnowledgeBaseCollection();
        const indexCount = await collection.count();
        const embeddingModel = mcConfig.embeddingProvider === 'ollama'
            ? mcConfig.ollama?.embeddingModel
            : mcConfig.embeddingProvider === 'openAiCompatible'
                ? mcConfig.openAiCompatible?.embeddingModel
                : mcConfig.gemini?.embeddingModel;

        const indexedSources = {};
        for (const item of payload.uniqueAnswerPaths || []) {
            const variants = item.repo === 'neomjs/neo'
                ? [item.path, 'node_modules/neo.mjs/' + item.path]
                : [item.path];
            const found = await collection.get({
                where  : variants.length === 1 ? {source: variants[0]} : {source: {$in: variants}},
                limit  : 1,
                include: ['metadatas']
            }).catch(() => null);
            indexedSources[item.path] = Boolean(found?.metadatas?.length);
        }

        const {foldChunksToSources, normalizeCorpusSourcePath} = await import(${JSON.stringify(file('ai/scripts/diagnostics/measureKbRanking.mjs'))});

        const perQuestion = {};
        let idx = 0;
        for (const q of payload.selectedQuestions || []) {
            idx++;
            log('Query ' + idx + '/' + payload.selectedQuestions.length + ' ' + q.id);
            const shippedRes = await QueryService.queryDocuments({
                query: q.question,
                type : 'all',
                limit: horizon
            });
            const shippedSources = Array.isArray(shippedRes?.results)
                ? shippedRes.results.map(r => normalizeCorpusSourcePath(r.source))
                : [];

            const vec = await TextEmbeddingService.embedText(q.question, mcConfig.embeddingProvider, {
                operationLabel: 'kb-ranking-nearest-chunks',
                operationStage: 'kb-query-embedding',
                service       : 'knowledge-base'
            });
            const raw = await collection.query({
                queryEmbeddings: [vec],
                nResults       : horizon,
                include        : ['metadatas', 'distances']
            });
            const nearestSources = foldChunksToSources(raw?.metadatas?.[0] || []);

            perQuestion[q.id] = {
                shippedSources,
                shippedRetrieval: shippedRes?.retrieval || null,
                nearestSources
            };
        }

        const askResults = [];
        if (payload.withAsk) {
            let aIdx = 0;
            const askQueue = payload.judgedQuestions || [];
            for (const q of askQueue) {
                aIdx++;
                log('Ask ' + aIdx + '/' + askQueue.length + ' ' + q.id);
                const t0  = Date.now();
                const res = await SearchService.ask({
                    query: q.question,
                    type : 'all',
                    limit: 5
                });
                askResults.push({
                    id             : q.id,
                    repo           : q.repo,
                    class          : q.class,
                    style          : q.style,
                    question       : q.question,
                    referenceAnswer: q.referenceAnswer || null,
                    answer         : res?.answer || '',
                    references     : (res?.references || []).map(r => ({
                        source: normalizeCorpusSourcePath(r.source),
                        score : r.score ?? null
                    })),
                    degraded       : Boolean(res?.degraded),
                    degradedCode   : res?.degradedCode || null,
                    reason         : res?.reason || null,
                    durationMs     : Date.now() - t0
                });
            }
        }

        await print({
            isolation,
            indexCount,
            embeddingProvider: mcConfig.embeddingProvider,
            embeddingModel   : embeddingModel || null,
            askProvider      : kbConfig.askSynthesis?.provider ?? null,
            askModel         : kbConfig.askSynthesis?.model ?? null,
            indexedSources,
            perQuestion,
            askResults
        });
        process.exit(0);
    `;
}

/**
 * @summary Runs the live Chroma child process for Arm A, Arm B, index probes, and optional `ask`.
 * @param {Object} options
 * @returns {Promise<Object>} Parsed child output read from the scratch output file or final stdout line.
 */
export async function runChildChromaArms({
    selectedQuestions,
    judgedQuestions,
    uniqueAnswerPaths,
    withAsk = false,
    horizon = DEFAULT_HORIZON,
    scratchRoot,
    root = brainRoot,
    baseEnv = process.env,
    exec = execFileAsync
}) {
    const inputPath  = path.join(scratchRoot, 'kb-ranking-input.json');
    const outputPath = path.join(scratchRoot, 'kb-ranking-output.json');
    await fs.writeFile(inputPath, JSON.stringify({
        selectedQuestions: selectedQuestions.map(q => ({id: q.id, question: q.question})),
        judgedQuestions  : judgedQuestions.map(q => ({
            id             : q.id,
            repo           : q.repo,
            class          : q.class,
            style          : q.style,
            question       : q.question,
            referenceAnswer: q.referenceAnswer || null
        })),
        uniqueAnswerPaths,
        withAsk,
        horizon
    }), 'utf8');

    const childEnv = {
        ...baseEnv,
        ...isolationEnv(scratchRoot),
        NEO_KB_RANKING_INPUT : inputPath,
        NEO_KB_RANKING_OUTPUT: outputPath
    };

    const {stdout} = await exec(process.execPath, ['--input-type=module', '-e', childSource(root)], {
        cwd      : root,
        env      : childEnv,
        maxBuffer: 64 * 1024 * 1024,
        timeout  : CHILD_TIMEOUT_MS
    });

    try {
        const raw = await fs.readFile(outputPath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
        throw new Error('Child process produced no JSON output');
    }

    return JSON.parse(lines.at(-1));
}

/**
 * @summary Runs `ripgrep` for one question across both repository checkouts and returns ranked hits.
 * @param {Object} options
 * @param {String} options.question Question text.
 * @param {String} options.neoRoot Absolute path to `neomjs/neo` checkout.
 * @param {String} options.brainRoot Absolute path to `neomjs/neo-agent-brain` checkout.
 * @param {Number} [options.horizon=100] Max ranked entries retained.
 * @param {Function} [options.exec=execFileAsync] Spawn seam for unit tests.
 * @returns {Promise<{words: String[], pattern: String|null, hits: Array<{repo: String, source: String, count: Number}>}>}
 */
export async function runRipgrepArm({
    question,
    neoRoot,
    brainRoot: brainCheckout = brainRoot,
    horizon = DEFAULT_HORIZON,
    exec = execFileAsync
}) {
    const words   = extractGrepWords(question);
    const pattern = buildRipgrepPattern(words);

    if (!pattern) {
        return {words, pattern: null, hits: []};
    }

    const globArgs = RIPGREP_EXCLUDE_GLOBS.flatMap(glob => ['-g', glob]);
    const rgArgs   = ['--count-matches', '-i', '--no-messages', ...globArgs, '-e', pattern, '.'];

    const scanRepo = async (cwd, repo) => {
        try {
            const {stdout} = await exec('rg', rgArgs, {
                cwd,
                maxBuffer: 16 * 1024 * 1024,
                timeout  : RIPGREP_TIMEOUT_MS
            });
            return parseRipgrepCountOutput(stdout, repo);
        } catch (error) {
            if (error?.code === 1) {
                return parseRipgrepCountOutput(error.stdout || '', repo);
            }
            throw error;
        }
    };

    const [neoHits, brainHits] = await Promise.all([
        scanRepo(neoRoot, 'neomjs/neo'),
        scanRepo(brainCheckout, 'neomjs/neo-agent-brain')
    ]);

    const ranked = rankRipgrepHits([...neoHits, ...brainHits]).slice(0, horizon);

    return {words, pattern, hits: ranked};
}

/**
 * @summary Reads the current git HEAD SHA for a repository checkout (`unknown` if unavailable).
 * @param {String} repoDir Checkout path.
 * @param {Function} [exec=execFileAsync] Spawn seam.
 * @returns {Promise<String>} Commit SHA or `'unknown'`.
 */
async function readGitHead(repoDir, exec = execFileAsync) {
    try {
        const {stdout} = await exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {timeout: 5000});
        return String(stdout || '').trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * @summary Formats one numeric table row across all three arms.
 * @param {String} label Row label.
 * @param {{shipped: Object, nearestChunks: Object, ripgrep: Object}} slice Summary triple.
 * @returns {String} Markdown table line.
 */
function formatSliceRow(label, slice) {
    const fmt = m => {
        const pct = m.n > 0 ? Math.round((m.hitsAt5 / m.n) * 100) : 0;
        const med = m.medianFirstRank ?? 'miss';
        return `${m.hitsAt5}/${m.n} (${pct}%) · med ${med} · MRR ${m.meanReciprocalRank.toFixed(3)}`;
    };

    return `| ${label} | ${slice.shipped.n} | ${fmt(slice.shipped)} | ${fmt(slice.nearestChunks)} | ${fmt(slice.ripgrep)} |`;
}

/**
 * @summary Renders the complete 3-arm measurement report as Markdown tables.
 * @param {Object} report Output object from {@link measureKbRanking}.
 * @returns {String} Formatted Markdown report.
 */
export function formatMarkdownReport(report) {
    if (report?.unmeasured) {
        return `# Knowledge Base 3-Arm Ranking Measurement (UNMEASURED)\n\nReason: ${report.unmeasured}\n`;
    }

    const lines = [
        '# Knowledge Base 3-Arm Ranking Measurement',
        '',
        `- **Date:** ${report.measuredAt}`,
        `- **Subset:** ${report.subset} (${report.questionCount} questions)`,
        `- **Index size:** ${report.indexCount} chunks (\`${report.embeddingProvider}\` / \`${report.embeddingModel}\`)`,
        `- **Ask synthesis:** \`${report.askProvider}\` / \`${report.askModel}\``,
        `- **Commits:** \`neomjs/neo\` @ \`${report.commits?.neo?.slice(0, 10)}\`, \`neomjs/neo-agent-brain\` @ \`${report.commits?.brain?.slice(0, 10)}\``,
        `- **Indexed answer files:** ${report.indexCoverage?.questionsAnyIndexed ?? 0}/${report.questionCount} questions have >=1 answer file in Chroma (${report.indexCoverage?.questionsNoneIndexed ?? 0} have 0 indexed answer files)`,
        '',
        '## Summary (Hit@5 · Median Found Rank · MRR @ Top-100)',
        '',
        '| Slice | n | Arm A: Shipped (`QueryService`) | Arm B: Nearest Chunks (unweighted) | Arm C: `ripgrep` (content words) |',
        '|---|---:|---|---|---|',
        formatSliceRow('Overall', report.summary.overall),
        formatSliceRow('Overall (excl. B076)', report.summary.overallExcludingB076),
        formatSliceRow('Style: question', report.summary.byStyle.question),
        formatSliceRow('Style: keywords', report.summary.byStyle.keywords),
        formatSliceRow('Repo: `neomjs/neo`', report.summary.byRepo['neomjs/neo']),
        formatSliceRow('Repo: `neomjs/neo-agent-brain`', report.summary.byRepo['neomjs/neo-agent-brain']),
        formatSliceRow('Class: `parent-class` (all 5)', report.summary.byClass['parent-class']),
        formatSliceRow('Class: `parent-class` (strict 3)', report.summary.byClass['parent-class-strict']),
        formatSliceRow('Class: `source-only`', report.summary.byClass['source-only']),
        formatSliceRow('Class: `source-with-guide-mention`', report.summary.byClass['source-with-guide-mention']),
        formatSliceRow('Class: `guide-covered`', report.summary.byClass['guide-covered']),
        formatSliceRow('Index: >=1 answer file in Chroma', report.summary.byIndexCoverage.anyAnswerFileIndexed),
        formatSliceRow('Index: 0 answer files in Chroma', report.summary.byIndexCoverage.noAnswerFilesIndexed),
        '',
        '## Canonical Classes Where Shipped Ranking Loses (AC-4)',
        ''
    ];

    if (report.underperformingClasses.length === 0) {
        lines.push('None — `shipped` matched or led both baseline arms in every canonical class.');
    } else {
        lines.push('| Class | Loss Axis | Best Arm | Shipped | Best Baseline |');
        lines.push('|---|---|---|---|---|');
        for (const row of report.underperformingClasses) {
            lines.push(`| \`${row.class}\` | ${row.reason} | \`${row.bestArm}\` | ${row.shippedHitsAt5} hit@5 (MRR ${row.shippedMrr.toFixed(3)}) | ${row.bestHitsAt5} hit@5 (MRR ${row.bestMrr.toFixed(3)}) |`);
        }
    }

    if (Array.isArray(report.askResults) && report.askResults.length > 0) {
        lines.push('', '## Judged `SearchService.ask` Runs (10 Questions)', '');
        lines.push('| ID | Class | Top Reference | Degraded | Latency (ms) |');
        lines.push('|---|---|---|---|---:|');
        for (const ask of report.askResults) {
            const topRef = ask.references?.[0]?.source ? `\`${ask.references[0].source}\`` : 'none';
            lines.push(`| ${ask.id} | \`${ask.class}\` | ${topRef} | ${ask.degraded ? ask.degradedCode : 'no'} | ${ask.durationMs} |`);
        }
    }

    return `${lines.join('\n')}\n`;
}

/**
 * @summary Executes the complete 3-arm measurement over the verified fixture.
 * @param {Object} [options]
 * @returns {Promise<Object>} Structured measurement report (or `{unmeasured}`).
 */
export async function measureKbRanking({
    fixturePath = DEFAULT_FIXTURE_PATH,
    all49 = false,
    withAsk = false,
    horizon = DEFAULT_HORIZON,
    neoRoot = path.resolve(brainRoot, '../neo'),
    brainCheckout = brainRoot,
    baseEnv = process.env,
    exec = execFileAsync
} = {}) {
    const fixture           = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    const selectedQuestions = selectQuestions(fixture, {all49});
    const judgedQuestions   = fixture.questions.filter(q => q.judged === true);
    const uniquePathMap     = new Map();

    for (const q of selectedQuestions) {
        for (const af of q.answerFiles || []) {
            const key = `${q.repo}:${af.path}`;
            if (!uniquePathMap.has(key)) {
                uniquePathMap.set(key, {repo: q.repo, path: af.path});
            }
        }
    }

    const [neoCommit, brainCommit] = await Promise.all([
        readGitHead(neoRoot, exec),
        readGitHead(brainCheckout, exec)
    ]);

    const scratchRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kb-ranking-measure-')));
    let childData;

    try {
        childData = await runChildChromaArms({
            selectedQuestions,
            judgedQuestions,
            uniqueAnswerPaths: [...uniquePathMap.values()],
            withAsk,
            horizon,
            scratchRoot,
            root: brainCheckout,
            baseEnv,
            exec
        });
    } finally {
        await fs.rm(scratchRoot, {recursive: true, force: true});
    }

    const refusal = isolatedUnder(childData.isolation, scratchRoot);
    if (refusal) {
        return {measuredAt: new Date().toISOString(), unmeasured: `child isolation refused: ${refusal}`};
    }

    if (childData.unmeasured) {
        return {measuredAt: new Date().toISOString(), unmeasured: childData.unmeasured};
    }

    const indexedSources  = childData.indexedSources || {};
    const questionResults = [];

    for (const q of selectedQuestions) {
        const chromaEntry = childData.perQuestion?.[q.id] || {shippedSources: [], nearestSources: []};
        const rgEntry     = await runRipgrepArm({
            question : q.question,
            neoRoot,
            brainRoot: brainCheckout,
            horizon,
            exec
        });

        const indexedAnswerFileCount = (q.answerFiles || []).filter(af => Boolean(indexedSources[af.path])).length;

        questionResults.push({
            id                    : q.id,
            repo                  : q.repo,
            style                 : q.style,
            class                 : q.class,
            strictParentOnly      : q.strictParentOnly ?? null,
            junePostAnecdote      : Boolean(q.junePostAnecdote),
            namesAnswerFileInText : Boolean(q.namesAnswerFileInText),
            inBalanced40          : Boolean(q.inBalanced40),
            answerFiles           : (q.answerFiles || []).map(af => ({
                path   : af.path,
                indexed: Boolean(indexedSources[af.path])
            })),
            indexedAnswerFileCount,
            grepWords             : rgEntry.words,
            arms                  : {
                shipped      : evaluateArmQuestion(chromaEntry.shippedSources, q),
                nearestChunks: evaluateArmQuestion(chromaEntry.nearestSources, q),
                ripgrep      : evaluateArmQuestion(rgEntry.hits, q)
            }
        });
    }

    const byClass = {
        'parent-class'             : summarizeSlice(questionResults.filter(r => r.class === 'parent-class')),
        'parent-class-strict'      : summarizeSlice(questionResults.filter(r => r.class === 'parent-class' && r.strictParentOnly === true)),
        'source-only'              : summarizeSlice(questionResults.filter(r => r.class === 'source-only')),
        'source-with-guide-mention': summarizeSlice(questionResults.filter(r => r.class === 'source-with-guide-mention')),
        'guide-covered'            : summarizeSlice(questionResults.filter(r => r.class === 'guide-covered'))
    };

    const summary = {
        overall             : summarizeSlice(questionResults),
        overallExcludingB076: summarizeSlice(questionResults.filter(r => r.id !== 'B076')),
        byStyle             : {
            question: summarizeSlice(questionResults.filter(r => r.style === 'question')),
            keywords: summarizeSlice(questionResults.filter(r => r.style === 'keywords'))
        },
        byRepo              : {
            'neomjs/neo'            : summarizeSlice(questionResults.filter(r => r.repo === 'neomjs/neo')),
            'neomjs/neo-agent-brain': summarizeSlice(questionResults.filter(r => r.repo === 'neomjs/neo-agent-brain'))
        },
        byClass,
        byIndexCoverage     : {
            allAnswerFilesIndexed: summarizeSlice(questionResults.filter(r => r.indexedAnswerFileCount === r.answerFiles.length)),
            anyAnswerFileIndexed : summarizeSlice(questionResults.filter(r => r.indexedAnswerFileCount > 0)),
            noAnswerFilesIndexed : summarizeSlice(questionResults.filter(r => r.indexedAnswerFileCount === 0))
        }
    };

    return {
        measuredAt            : new Date().toISOString(),
        fixturePath           : path.relative(brainCheckout, fixturePath),
        subset                : all49 ? 'all-49' : 'balanced-40',
        questionCount         : questionResults.length,
        horizon,
        indexCount            : childData.indexCount ?? null,
        embeddingProvider     : childData.embeddingProvider ?? null,
        embeddingModel        : childData.embeddingModel ?? null,
        askProvider           : childData.askProvider ?? null,
        askModel              : childData.askModel ?? null,
        commits               : {neo: neoCommit, brain: brainCommit},
        isolation             : childData.isolation,
        indexCoverage         : {
            uniqueAnswerFiles   : uniquePathMap.size,
            indexedCount        : Object.values(indexedSources).filter(Boolean).length,
            questionsAllIndexed : questionResults.filter(r => r.indexedAnswerFileCount === r.answerFiles.length).length,
            questionsAnyIndexed : questionResults.filter(r => r.indexedAnswerFileCount > 0).length,
            questionsNoneIndexed: questionResults.filter(r => r.indexedAnswerFileCount === 0).length
        },
        summary,
        underperformingClasses: findUnderperformingClasses(byClass),
        questions             : questionResults,
        askResults            : childData.askResults || []
    };
}

/**
 * @summary CLI entrypoint: runs the 3-arm benchmark and prints the Markdown summary table.
 * @param {String[]} [argv=process.argv] Command-line arguments.
 * @param {Object} [io] Stream & spawn injection for tests.
 * @returns {Promise<Number>} Exit code (`0` measured, `2` unmeasured).
 */
export async function main(argv = process.argv, {stdout = process.stdout, exec = execFileAsync} = {}) {
    const program = new Command()
        .name('measureKbRanking')
        .description('Measures QueryService ranking against nearest-chunk Chroma retrieval and ripgrep over real query-log questions.')
        .option('--fixture <path>', 'path to verified question fixture JSON', DEFAULT_FIXTURE_PATH)
        .option('--all-49', 'evaluate all 49 verified questions instead of the pre-registered balanced 40', false)
        .option('--with-ask', 'also run SearchService.ask across the 10 judged questions', false)
        .option('--horizon <n>', 'candidate horizon across all arms', value => Number(value), DEFAULT_HORIZON)
        .option('--neo-root <dir>', 'path to neomjs/neo checkout', path.resolve(brainRoot, '../neo'))
        .option('--brain-root <dir>', 'path to neomjs/neo-agent-brain checkout', brainRoot)
        .option('--json-out <path>', 'write structured JSON results to this file')
        .exitOverride()
        .configureOutput({writeOut: text => stdout.write(text), writeErr: text => stdout.write(text)});

    program.parse(argv);

    const options = program.opts();
    const report  = await measureKbRanking({
        fixturePath  : path.resolve(options.fixture),
        all49        : Boolean(options.all49),
        withAsk      : Boolean(options.withAsk),
        horizon      : Number(options.horizon) || DEFAULT_HORIZON,
        neoRoot      : path.resolve(options.neoRoot),
        brainCheckout: path.resolve(options.brainRoot),
        exec
    });

    if (options.jsonOut) {
        const outPath = path.resolve(options.jsonOut);
        await fs.mkdir(path.dirname(outPath), {recursive: true});
        await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    stdout.write(formatMarkdownReport(report));

    return report.unmeasured ? 2 : 0;
}

if (isEntryModule(import.meta.url)) {
    main().then(
        code => {
            process.exitCode = code;
        },
        error => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }
    );
}
