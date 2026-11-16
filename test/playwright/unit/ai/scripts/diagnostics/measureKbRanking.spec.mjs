import {expect, test} from '@playwright/test';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import os   from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    DEFAULT_FIXTURE_PATH,
    buildRipgrepPattern,
    evaluateArmQuestion,
    extractGrepWords,
    findUnderperformingClasses,
    foldChunksToSources,
    formatMarkdownReport,
    isolatedUnder,
    isolationEnv,
    main,
    measureKbRanking,
    normalizeCorpusSourcePath,
    parseRipgrepCountOutput,
    rankRipgrepHits,
    selectQuestions,
    summarizeArmMetrics
} from '../../../../../../ai/scripts/diagnostics/measureKbRanking.mjs';

const
    here      = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot = path.resolve(here, '../../../../../..');

test.describe('measureKbRanking', () => {
    test('committed fixture satisfies #1800 provenance, balance, class, and Brain path invariants', async () => {
        const fixture = JSON.parse(await readFile(DEFAULT_FIXTURE_PATH, 'utf8'));

        expect(fixture.schemaVersion).toBe(1);
        expect(fixture.picker).toBe('@neo-fable-clio');
        expect(fixture.verifier).toBe('@neo-gemini-maryam');
        expect(fixture.source?.table).toBe('kb_query_log');
        expect(fixture.verifiedCommits?.neo).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.verifiedCommits?.brain).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.questions).toHaveLength(49);

        const balanced = selectQuestions(fixture, {all49: false});
        expect(balanced).toHaveLength(40);
        expect(balanced.filter(q => q.repo === 'neomjs/neo')).toHaveLength(20);
        expect(balanced.filter(q => q.repo === 'neomjs/neo-agent-brain')).toHaveLength(20);
        expect(selectQuestions(fixture, {all49: true})).toHaveLength(49);

        const parentClass = balanced.filter(q => q.class === 'parent-class');
        expect(parentClass).toHaveLength(5);
        expect(parentClass.filter(q => q.strictParentOnly === true)).toHaveLength(3);
        expect(parentClass.filter(q => q.strictParentOnly === false)).toHaveLength(2);

        const sourceOnly = balanced.filter(q => q.class === 'source-only');
        expect(sourceOnly).toHaveLength(11);
        expect(sourceOnly.filter(q => q.repo === 'neomjs/neo')).toHaveLength(4);
        expect(sourceOnly.filter(q => q.repo === 'neomjs/neo-agent-brain')).toHaveLength(7);

        const judged = fixture.questions.filter(q => q.judged === true);
        expect(judged).toHaveLength(10);
        for (const row of judged) {
            expect(typeof row.referenceAnswer).toBe('string');
            expect(row.referenceAnswer.trim().length).toBeGreaterThan(20);
        }

        for (const row of fixture.questions.filter(q => q.repo === 'neomjs/neo-agent-brain')) {
            for (const af of row.answerFiles) {
                await access(path.join(brainRoot, af.path));
            }
        }
    });

    test('extracts ripgrep content words, builds regex, and ranks count output deterministically', () => {
        const words = extractGrepWords('What contracts govern Neo.data.Store, node.get+set, and Store order?');
        expect(words).toEqual(['contracts', 'govern', 'neo', 'data', 'store', 'node', 'get', 'set', 'order']);

        const pattern = buildRipgrepPattern(['foo.bar', 'baz']);
        expect(pattern).toBe('\\b(?:foo\\.bar|baz)\\b');
        expect(buildRipgrepPattern([])).toBeNull();

        const hits = parseRipgrepCountOutput([
            './src/B.mjs:2',
            'src/A.mjs:5',
            './src/C.mjs:2',
            'ignored-no-count',
            './zero.mjs:0'
        ].join('\n'), 'neomjs/neo');

        expect(rankRipgrepHits(hits)).toEqual([
            {repo: 'neomjs/neo', source: 'src/A.mjs', count: 5},
            {repo: 'neomjs/neo', source: 'src/B.mjs', count: 2},
            {repo: 'neomjs/neo', source: 'src/C.mjs', count: 2}
        ]);
    });

    test('folds nearest Chroma chunks into unique normalized source paths without losing chunk order', () => {
        expect(normalizeCorpusSourcePath('./node_modules/neo.mjs/src/grid/Row.mjs')).toBe('src/grid/Row.mjs');

        const folded = foldChunksToSources([
            {source: 'node_modules/neo.mjs/src/grid/Row.mjs'},
            {source: 'unknown'},
            {source: 'src/grid/Row.mjs'},
            {source: null},
            {source: 'ai/services/memory-core/MemoryService.mjs'},
            {source: 'node_modules/neo.mjs/src/table/Body.mjs'}
        ]);

        expect(folded).toEqual([
            'src/grid/Row.mjs',
            'ai/services/memory-core/MemoryService.mjs',
            'src/table/Body.mjs'
        ]);
    });

    test('scores ranks, aggregates metrics, and detects underperforming canonical classes', () => {
        const q = {
            id         : 'E001',
            repo       : 'neomjs/neo',
            answerFiles: [{path: 'src/component/Base.mjs'}]
        };

        const missWrongRepo = evaluateArmQuestion([
            {repo: 'neomjs/neo-agent-brain', source: 'src/component/Base.mjs'},
            {repo: 'neomjs/neo', source: 'src/Other.mjs'},
            {repo: 'neomjs/neo', source: 'src/component/Base.mjs'}
        ], q);

        expect(missWrongRepo).toEqual({
            hitAt5          : true,
            firstRank       : 3,
            firstMatchedPath: 'src/component/Base.mjs',
            top5            : [
                'neomjs/neo-agent-brain:src/component/Base.mjs',
                'neomjs/neo:src/Other.mjs',
                'neomjs/neo:src/component/Base.mjs'
            ]
        });

        const missed = evaluateArmQuestion(['src/A.mjs', 'src/B.mjs'], q);
        expect(missed.hitAt5).toBe(false);
        expect(missed.firstRank).toBeNull();

        const summary = summarizeArmMetrics([
            {hitAt5: true, firstRank: 1},
            {hitAt5: true, firstRank: 4},
            {hitAt5: false, firstRank: 8},
            {hitAt5: false, firstRank: null}
        ]);

        expect(summary).toEqual({
            n                 : 4,
            hitsAt5           : 2,
            recallAt5         : 0.5,
            foundCount        : 3,
            missCount         : 1,
            medianFirstRank   : 4,
            medianFirstRankAll: 6,
            meanReciprocalRank: 0.3438
        });

        const under = findUnderperformingClasses({
            'parent-class': {
                shipped      : {n: 2, hitsAt5: 1, meanReciprocalRank: 0.5},
                nearestChunks: {n: 2, hitsAt5: 2, meanReciprocalRank: 0.75},
                ripgrep      : {n: 2, hitsAt5: 1, meanReciprocalRank: 0.5}
            },
            'source-only': {
                shipped      : {n: 2, hitsAt5: 2, meanReciprocalRank: 0.5},
                nearestChunks: {n: 2, hitsAt5: 1, meanReciprocalRank: 0.5},
                ripgrep      : {n: 2, hitsAt5: 2, meanReciprocalRank: 0.8}
            },
            'source-with-guide-mention': {
                shipped      : {n: 2, hitsAt5: 2, meanReciprocalRank: 0.9},
                nearestChunks: {n: 2, hitsAt5: 2, meanReciprocalRank: 0.6},
                ripgrep      : {n: 2, hitsAt5: 1, meanReciprocalRank: 0.5}
            },
            'guide-covered': {
                shipped      : {n: 2, hitsAt5: 2, meanReciprocalRank: 1.0},
                nearestChunks: {n: 2, hitsAt5: 2, meanReciprocalRank: 0.8},
                ripgrep      : {n: 2, hitsAt5: 1, meanReciprocalRank: 0.5}
            }
        });

        expect(under).toEqual([
            {
                class         : 'parent-class',
                reason        : 'recallAt5',
                bestArm       : 'nearestChunks',
                shippedHitsAt5: 1,
                bestHitsAt5   : 2,
                shippedMrr    : 0.5,
                bestMrr       : 0.75
            },
            {
                class         : 'source-only',
                reason        : 'meanReciprocalRank',
                bestArm       : 'ripgrep',
                shippedHitsAt5: 2,
                bestHitsAt5   : 2,
                shippedMrr    : 0.5,
                bestMrr       : 0.8
            }
        ]);
    });

    test('enforces child isolation while permitting read-only access to default_database', () => {
        const scratch = '/tmp/scratch-root';
        const env     = isolationEnv(scratch);

        expect(env.UNIT_TEST_MODE).toBe('false');
        expect(env.NEO_TEST_CONFIG_TEMPLATES).toBe('false');
        expect(env.NEO_MEMORY_DB_PATH).toBe(path.join(scratch, 'kb-ranking-telemetry.sqlite'));

        const validIsolation = {
            dataRoot               : scratch,
            mcGraphPath            : path.join(scratch, 'kb-ranking-telemetry.sqlite'),
            memoryCoreDbPath       : path.join(scratch, 'kb-ranking-telemetry.sqlite'),
            logPath                : path.join(scratch, 'logs'),
            embeddingResumeStateDir: path.join(scratch, 'kb-sync'),
            chromaDatabase         : 'default_database'
        };

        expect(isolatedUnder(validIsolation, scratch)).toBeNull();
        expect(isolatedUnder({...validIsolation, chromaDatabase: 'neo-kb-unit-test-1'}, scratch)).toContain('chromaDatabase=default_database');
        expect(isolatedUnder({...validIsolation, memoryCoreDbPath: '/var/live/memory-core-graph.sqlite'}, scratch)).toContain('outside scratch root');
    });

    test('runs end-to-end CLI over injected Chroma child and real ripgrep checkouts', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kb-ranking-spec-'));

        try {
            const neoDir     = path.join(root, 'neo');
            const brainDir   = path.join(root, 'brain');
            const fixtPath   = path.join(root, 'fixture.json');
            const outJson    = path.join(root, 'out', 'report.json');

            await mkdir(path.join(neoDir, 'src/component'), {recursive: true});
            await mkdir(path.join(brainDir, 'ai/services'), {recursive: true});

            await writeFile(
                path.join(neoDir, 'src/component/Base.mjs'),
                'export class Base { startMountFlight() {} }\n',
                'utf8'
            );
            await writeFile(
                path.join(brainDir, 'ai/services/QueryService.mjs'),
                'export class QueryService { queryDocuments() {} }\n',
                'utf8'
            );

            await writeFile(fixtPath, JSON.stringify({
                questions: [
                    {
                        id             : 'Q1',
                        repo           : 'neomjs/neo',
                        question       : 'startMountFlight component Base',
                        style          : 'keywords',
                        class          : 'parent-class',
                        strictParentOnly: true,
                        inBalanced40   : true,
                        judged         : true,
                        referenceAnswer: 'startMountFlight lives in src/component/Base.mjs.',
                        answerFiles    : [{path: 'src/component/Base.mjs'}]
                    },
                    {
                        id          : 'Q2',
                        repo        : 'neomjs/neo-agent-brain',
                        question    : 'Where does queryDocuments live?',
                        style       : 'question',
                        class       : 'source-only',
                        inBalanced40: true,
                        answerFiles : [{path: 'ai/services/QueryService.mjs'}]
                    }
                ]
            }), 'utf8');

            const fakeExec = async (file, args, options) => {
                if (file === 'git') {
                    return {stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: ''};
                }
                if (file === 'rg') {
                    const targetRepo = options.cwd === neoDir ? 'neomjs/neo' : 'neomjs/neo-agent-brain';
                    const stdout     = targetRepo === 'neomjs/neo'
                        ? (args.some(a => a.includes('startmountflight')) ? 'src/component/Base.mjs:1\n' : '')
                        : (args.some(a => a.includes('querydocuments')) ? 'ai/services/QueryService.mjs:1\n' : '');

                    if (!stdout) {
                        const err = new Error('no match');
                        err.code = 1;
                        err.stdout = '';
                        throw err;
                    }
                    return {stdout, stderr: ''};
                }

                const scratch = options.env.NEO_KB_RANKING_SCRATCH_ROOT;
                return {
                    stdout: JSON.stringify({
                        isolation: {
                            dataRoot               : options.env.NEO_PLANE_DATA_ROOT,
                            mcGraphPath            : options.env.NEO_MEMORY_DB_PATH,
                            memoryCoreDbPath       : options.env.NEO_MEMORY_DB_PATH,
                            logPath                : options.env.NEO_KB_LOG_PATH,
                            embeddingResumeStateDir: options.env.NEO_KB_EMBEDDING_RESUME_STATE_DIR,
                            chromaDatabase         : 'default_database'
                        },
                        indexCount       : 90000,
                        embeddingProvider: 'openAiCompatible',
                        embeddingModel   : 'qwen3-embedding',
                        askProvider      : 'openAiCompatible',
                        askModel         : 'gemma-4',
                        indexedSources   : {
                            'src/component/Base.mjs'      : true,
                            'ai/services/QueryService.mjs': false
                        },
                        perQuestion: {
                            Q1: {
                                shippedSources: ['src/tooltip/Base.mjs', 'src/component/Base.mjs'],
                                nearestSources: ['src/component/Base.mjs']
                            },
                            Q2: {
                                shippedSources: ['learn/agentos/KnowledgeBase.md'],
                                nearestSources: ['learn/agentos/KnowledgeBase.md']
                            }
                        },
                        askResults: [
                            {
                                id             : 'Q1',
                                repo           : 'neomjs/neo',
                                class          : 'parent-class',
                                style          : 'keywords',
                                question       : 'startMountFlight component Base',
                                referenceAnswer: 'startMountFlight lives in src/component/Base.mjs.',
                                answer         : 'Defined in src/component/Base.mjs.',
                                references     : [{source: 'src/component/Base.mjs', score: 120}],
                                degraded       : false,
                                durationMs     : 420
                            }
                        ]
                    }) + '\n',
                    stderr: ''
                };
            };

            let captured = '';
            const exitCode = await main([
                'node',
                'measureKbRanking.mjs',
                '--fixture', fixtPath,
                '--neo-root', neoDir,
                '--brain-root', brainDir,
                '--with-ask',
                '--json-out', outJson
            ], {
                stdout: {write: chunk => { captured += chunk; }},
                exec  : fakeExec
            });

            expect(exitCode).toBe(0);
            expect(captured).toContain('Knowledge Base 3-Arm Ranking Measurement');
            expect(captured).toContain('Judged `SearchService.ask` Runs');

            const written = JSON.parse(await readFile(outJson, 'utf8'));
            expect(written.questionCount).toBe(2);
            expect(written.indexCoverage.questionsAnyIndexed).toBe(1);
            expect(written.indexCoverage.questionsNoneIndexed).toBe(1);
            expect(written.summary.overall.shipped.hitsAt5).toBe(1);
            expect(written.summary.overall.ripgrep.hitsAt5).toBe(2);
            expect(written.underperformingClasses.map(row => row.class)).toEqual([
                'parent-class',
                'source-only'
            ]);
            expect(formatMarkdownReport({unmeasured: 'chroma down'})).toContain('UNMEASURED');
            expect(await measureKbRanking({
                fixturePath  : fixtPath,
                neoRoot      : neoDir,
                brainCheckout: brainDir,
                exec         : async (file, ...rest) => {
                    if (file === 'git') return {stdout: 'abc\n', stderr: ''};
                    return {stdout: JSON.stringify({isolation: null, unmeasured: 'chroma down'}) + '\n', stderr: ''};
                }
            })).toMatchObject({unmeasured: expect.stringContaining('isolation')});
        } finally {
            await rm(root, {recursive: true, force: true});
        }
    });
});
