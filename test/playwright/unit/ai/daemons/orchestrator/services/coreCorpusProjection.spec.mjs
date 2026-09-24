import {setup} from '../../../../../setup.mjs';

setup({appConfig: {name: 'CoreCorpusProjectionServiceTest'}});

import {test, expect} from '@playwright/test';
import fs             from 'fs-extra';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import IssueIngestor  from '../../../../../../../ai/services/ingestion/IssueIngestor.mjs';
import {
    Memory_GraphService as GraphService,
    Memory_StorageRouter as StorageRouter
} from '../../../../../../../ai/services.mjs';
import {
    getChangedCorpusIndexFacets,
    getChangedCorpusProjectionFacets,
    isCoreCorpusProjectionPath,
    runCoreCorpusProjectionCycle
} from '../../../../../../../ai/daemons/orchestrator/services/coreCorpusProjection.mjs';
import {
    CORPUS_PROJECTION_CONSUMER,
    evaluateCorpusProjectionAdmission
} from '../../../../../../../ai/services/graph/corpusProjectionContract.mjs';
import {readCorpusProjectionReceipt} from '../../../../../../../ai/services/graph/corpusProjectionReceiptStore.mjs';
import {
    classifyCoreCorpusProjectionOutcome,
    runProjectCoreCorpus
} from '../../../../../../../ai/scripts/maintenance/projectCoreCorpus.mjs';
import logger from '../../../../../../../ai/mcp/server/memory-core/logger.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function createConfig(root) {
    return {
        enabled                    : true,
        sourceRepository           : 'https://github.com/neomjs/github-content-sync.git',
        sourceRef                  : 'refs/heads/dev',
        mirrorRoot                 : path.join(root, 'mirror'),
        materializedRoot           : path.join(root, 'materialized'),
        receiptPath                : path.join(root, 'projection.json'),
        freshnessSlaMs             : 4 * 60 * 60 * 1000,
        readConcurrency            : 2,
        fullRematerializeIntervalMs: Number.MAX_SAFE_INTEGER
    }
}

function createGitMirror({
    head            = HEAD_A,
    pathsByRevision = {},
    filesByRevision = {},
    diff            = {addedOrChanged: [], deleted: []},
    events          = [],
    prefetchStatus  = 'already-local'
} = {}) {
    let cloned = false;

    return {
        setHead(value) {
            head = value
        },
        setDiff(value) {
            diff = value
        },
        async cloneIfMissing() {
            const first = !cloned;
            cloned = true;
            return {cloned: first, mirrorPath: '/fixture/mirror.git'}
        },
        async fetch() {
            return {newRevisions: []}
        },
        async resolveHead() {
            return head
        },
        async isAncestor() {
            return true
        },
        async listRevisionPaths({revision}) {
            return [...(pathsByRevision[revision] || [])]
        },
        async diffRevisions() {
            return {...diff}
        },
        async prefetchRevisionBlobs({revision, sourcePaths}) {
            events.push({op: 'prefetch', revision, sourcePaths: [...sourcePaths]});
            return {status: prefetchStatus, requested: sourcePaths.length, missing: 0, chunks: 0, reason: null}
        },
        async readRevisionFile({revision, sourcePath}) {
            events.push({op: 'read', revision, sourcePath});
            const content = filesByRevision[revision]?.[sourcePath];
            if (content === undefined) throw new Error(`missing fixture ${revision}:${sourcePath}`);
            return content
        }
    }
}

function createIngestor(calls, failures = {}) {
    const run = facet => async options => {
        calls.push({facet, options});
        if (failures[facet]) throw failures[facet]
    };

    return {
        ingestIssueStates        : run('issues'),
        ingestPullRequestFeedback: run('pulls'),
        ingestDiscussionStates   : run('discussions')
    }
}

test.describe('coreCorpusProjection — core-origin corpus writer (#401)', () => {
    test('recognizes only neo facets and the shared root index', () => {
        for (const sourcePath of [
            '_index.json',
            'neo/issues/chunk-1/issue-1.md',
            'neo/archive/pulls/v13/pr-1.md',
            'neo/discussions/discussion-1.md'
        ]) {
            expect(isCoreCorpusProjectionPath(sourcePath), sourcePath).toBe(true)
        }

        for (const sourcePath of [
            'neo/release-notes/v13.2.0.md',
            'neo-agent-brain/issues/issue-1.md',
            'neo-agent-brain/archive/pulls/v13/pr-1.md',
            'resources/content/issues/issue-1.md'
        ]) {
            expect(isCoreCorpusProjectionPath(sourcePath), sourcePath).toBe(false)
        }
        expect(isCoreCorpusProjectionPath('ai/configBase.mjs')).toBe(false);
        expect(getChangedCorpusProjectionFacets([
            'neo/archive/issues/v13/issue-1.md',
            'neo/pulls/pr-2.md',
            'neo-agent-brain/discussions/discussion-1.md'
        ])).toEqual(['issues', 'pulls']);
        expect(getChangedCorpusProjectionFacets(['_index.json'])).toEqual([]);
        expect(getChangedCorpusIndexFacets(
            JSON.stringify([
                {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'},
                {repoSlug: 'neo', type: 'pulls', id: 2, path: 'neo/pulls/pr-2.md'}
            ]),
            JSON.stringify([
                {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'},
                {repoSlug: 'neo', type: 'pulls', id: 3, path: 'neo/pulls/pr-3.md'}
            ])
        )).toEqual(['pulls'])
    });

    test('#11735 non-interference: the writer closure reuses GitMirror without entering tenant sync or kb-config', () => {
        const source = [
            'ai/daemons/orchestrator/services/coreCorpusProjection.mjs',
            'ai/scripts/maintenance/projectCoreCorpus.mjs'
        ].map(file => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');

        expect(source).not.toMatch(/TenantRepoSyncService|syncTenantRepos|tenant-repo-sync|kb-config\.yaml/)
    });

    test('same-id origins materialize only neo and the real ingestor resolves its normalized index into graph writes', async () => {
        const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-origin-')),
              config    = createConfig(root),
              neoPath   = 'neo/issues/issue-999.md',
              brainPath = 'neo-agent-brain/issues/issue-999.md',
              neoRow    = {repoSlug: 'neo', type: 'issues', id: 42, path: neoPath},
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json', neoPath, brainPath]},
                  filesByRevision: {[HEAD_A]: {
                      '_index.json': JSON.stringify([
                          neoRow,
                          {repoSlug: 'neo-agent-brain', type: 'issues', id: 42, path: brainPath}
                      ]),
                      [neoPath]  : '---\ntitle: Core selected issue\nstate: OPEN\n---\nCore body',
                      [brainPath]: '---\ntitle: Foreign colliding issue\nstate: OPEN\n---\nForeign body'
                  }}
              }),
              graphWrites  = [],
              vectorWrites = [],
              originals    = {
                  db                           : GraphService.db,
                  upsertNode                   : GraphService.upsertNode,
                  listSharedNodeRecordsByLabels: GraphService.listSharedNodeRecordsByLabels,
                  removeNodes                  : GraphService.removeNodes,
                  getGraphCollection           : StorageRouter.getGraphCollection
              };

        GraphService.db = {
            nodes           : {get: () => null},
            edges           : {items: []},
            getAdjacentNodes: () => {}
        };
        GraphService.upsertNode = node => graphWrites.push(node);
        GraphService.listSharedNodeRecordsByLabels = () => [];
        GraphService.removeNodes = () => {};
        StorageRouter.getGraphCollection = async () => ({
            get   : async () => ({ids: [], metadatas: []}),
            upsert: async payload => vectorWrites.push(payload)
        });

        try {
            const outcome = await runCoreCorpusProjectionCycle({config, gitMirror, issueIngestor: IssueIngestor});

            expect(outcome.status).toBe('completed');
            expect(await fs.readJson(path.join(config.materializedRoot, '_index.json'))).toEqual([
                {...neoRow, path: 'issues/issue-999.md'}
            ]);
            expect(fs.readdirSync(config.materializedRoot).sort()).toEqual(['_index.json', 'issues']);
            expect(graphWrites).toHaveLength(1);
            expect(graphWrites[0]).toMatchObject({
                id        : 'issue-42',
                name      : 'Core selected issue',
                properties: {
                    corpusProjectionSourceRepository: config.sourceRepository,
                    corpusProjectionSourceRevision  : HEAD_A
                }
            });
            expect(vectorWrites).toHaveLength(1);
            expect(vectorWrites[0]).toMatchObject({ids: ['issue-42'], documents: ['Core selected issue\n\nCore body']})
        } finally {
            GraphService.db = originals.db;
            GraphService.upsertNode = originals.upsertNode;
            GraphService.listSharedNodeRecordsByLabels = originals.listSharedNodeRecordsByLabels;
            GraphService.removeNodes = originals.removeNodes;
            StorageRouter.getGraphCollection = originals.getGraphCollection;
            fs.removeSync(root)
        }
    });

    for (const [name, invalidIndex, errorCode] of [
        ['malformed JSON', '{', 'CORE_CORPUS_INDEX_INVALID'],
        ['non-array JSON', '{}', 'CORE_CORPUS_INDEX_INVALID'],
        ['missing repoSlug', JSON.stringify([
            {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'},
            {type: 'issues', id: 2, path: 'neo-agent-brain/issues/issue-2.md'}
        ]), 'CORE_CORPUS_INDEX_INVALID'],
        ['empty repoSlug', JSON.stringify([
            {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'},
            {repoSlug: ' ', type: 'issues', id: 2, path: 'neo-agent-brain/issues/issue-2.md'}
        ]), 'CORE_CORPUS_INDEX_INVALID'],
        ['absent neo origin', JSON.stringify([
            {repoSlug: 'neo-agent-brain', type: 'issues', id: 1, path: 'neo-agent-brain/issues/issue-1.md'}
        ]), 'CORE_CORPUS_ORIGIN_MISSING'],
        ['foreign selected path', JSON.stringify([
            {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo-agent-brain/issues/issue-1.md'}
        ]), 'CORE_CORPUS_INDEX_INVALID'],
        ['traversing selected path', JSON.stringify([
            {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/../../issue-1.md'}
        ]), 'CORE_CORPUS_INDEX_INVALID']
    ]) {
        for (const incremental of [false, true]) {
            test(`${name} refuses ${incremental ? 'incremental' : 'full'} materialization before staging, ingestion, or receipt mutation`, async () => {
                const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-invalid-')),
                      config    = createConfig(root),
                      issuePath = 'neo/issues/issue-1.md',
                      gitMirror = createGitMirror({
                          head           : incremental ? HEAD_A : HEAD_B,
                          pathsByRevision: {
                              [HEAD_A]: ['_index.json', issuePath],
                              [HEAD_B]: ['_index.json', issuePath]
                          },
                          filesByRevision: {
                              [HEAD_A]: {
                                  '_index.json': JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 1, path: issuePath}]),
                                  [issuePath]  : 'retained issue content'
                              },
                              [HEAD_B]: {'_index.json': invalidIndex, [issuePath]: 'must not replace retained content'}
                          },
                          diff: {addedOrChanged: ['_index.json', issuePath], deleted: []}
                      }),
                      calls     = [],
                      mutations = [],
                      fileSystem = {...fs};

                for (const method of ['ensureDir', 'outputFile', 'move', 'remove']) {
                    fileSystem[method] = async (...args) => {
                        mutations.push({method, path: args[0]});
                        return fs[method](...args)
                    }
                }

                try {
                    if (incremental) {
                        await runCoreCorpusProjectionCycle({config, gitMirror, issueIngestor: createIngestor(calls)})
                    } else {
                        await fs.outputFile(path.join(config.materializedRoot, 'retained.txt'), 'existing staging')
                    }
                    const beforeEntries = fs.readdirSync(root, {recursive: true}).sort(),
                          beforeReceipt = await readCorpusProjectionReceipt(config.receiptPath),
                          retainedPath  = path.join(config.materializedRoot, incremental ? 'issues/issue-1.md' : 'retained.txt'),
                          retainedValue = fs.readFileSync(retainedPath, 'utf8'),
                          beforeIndex   = incremental ? fs.readFileSync(path.join(config.materializedRoot, '_index.json'), 'utf8') : null;

                    calls.length = 0;
                    gitMirror.setHead(HEAD_B);

                    await expect(runCoreCorpusProjectionCycle({
                        config, gitMirror, fileSystem, issueIngestor: createIngestor(calls)
                    })).rejects.toMatchObject({code: errorCode});

                    expect(mutations).toEqual([]);
                    expect(calls).toEqual([]);
                    expect(fs.readdirSync(root, {recursive: true}).sort()).toEqual(beforeEntries);
                    expect(fs.readFileSync(retainedPath, 'utf8')).toBe(retainedValue);
                    expect(await readCorpusProjectionReceipt(config.receiptPath)).toEqual(beforeReceipt);
                    if (incremental) {
                        expect(fs.readFileSync(path.join(config.materializedRoot, '_index.json'), 'utf8')).toBe(beforeIndex)
                    }
                } finally {
                    fs.removeSync(root)
                }
            })
        }
    }

    for (const changeIndex of [false, true]) {
        test(`other-origin-only ${changeIndex ? 'index and path' : 'path'} changes advance every receipt with zero ingestor calls`, async () => {
            const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-other-origin-')),
                  config    = createConfig(root),
                  neoPath   = 'neo/issues/issue-1.md',
                  brainPath = 'neo-agent-brain/issues/issue-1.md',
                  neoRow    = {repoSlug: 'neo', type: 'issues', id: 1, path: neoPath},
                  brainRow  = {repoSlug: 'neo-agent-brain', type: 'issues', id: 1, path: brainPath},
                  indexA    = JSON.stringify([neoRow, brainRow]),
                  indexB    = JSON.stringify([neoRow, changeIndex ? {...brainRow, version: 'v1'} : brainRow]),
                  gitMirror = createGitMirror({
                      pathsByRevision: {[HEAD_A]: ['_index.json', neoPath, brainPath]},
                      filesByRevision: {
                          [HEAD_A]: {'_index.json': indexA, [neoPath]: 'core issue', [brainPath]: 'foreign issue A'},
                          [HEAD_B]: {'_index.json': indexB, [brainPath]: 'foreign issue B'}
                      },
                      diff: {addedOrChanged: changeIndex ? ['_index.json', brainPath] : [brainPath], deleted: []}
                  }),
                  calls = [];

            try {
                await runCoreCorpusProjectionCycle({config, gitMirror, issueIngestor: createIngestor(calls)});
                calls.length = 0;
                gitMirror.setHead(HEAD_B);

                const outcome = await runCoreCorpusProjectionCycle({config, gitMirror, issueIngestor: createIngestor(calls)});

                expect(getChangedCorpusIndexFacets(indexA, indexB)).toEqual([]);
                expect(outcome.materialization).toMatchObject({full: false, changedFacets: []});
                expect(outcome.receipt.materializedCorpusRevision).toBe(HEAD_B);
                expect(outcome.receipt.projectedRevisionByFacet).toEqual({issues: HEAD_B, pulls: HEAD_B, discussions: HEAD_B});
                expect(calls).toEqual([]);
                expect(await fs.readJson(path.join(config.materializedRoot, '_index.json'))).toEqual([
                    {...neoRow, path: 'issues/issue-1.md'}
                ]);
                expect(fs.readFileSync(path.join(config.materializedRoot, 'issues/issue-1.md'), 'utf8')).toBe('core issue');
                expect(fs.readdirSync(config.materializedRoot).sort()).toEqual(['_index.json', 'issues'])
            } finally {
                fs.removeSync(root)
            }
        })
    }

    test('cold start fully materializes one exact source revision before committing every facet', async () => {
        const root   = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-cold-')),
              config = createConfig(root),
              paths  = [
                  '_index.json',
                  'neo/issues/issue-1.md',
                  'neo/pulls/pr-2.md',
                  'neo/discussions/discussion-3.md',
                  'README.md'
              ],
              files = {
                  '_index.json': JSON.stringify([
                      {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'},
                      {repoSlug: 'neo', type: 'pulls', id: 2, path: 'neo/pulls/pr-2.md'},
                      {repoSlug: 'neo', type: 'discussions', id: 3, path: 'neo/discussions/discussion-3.md'}
                  ]),
                  'neo/issues/issue-1.md'          : 'issue A',
                  'neo/pulls/pr-2.md'              : 'pull A',
                  'neo/discussions/discussion-3.md': 'discussion A'
              },
              events    = [],
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: paths},
                  filesByRevision: {[HEAD_A]: files},
                  events
              }),
              calls = [];

        try {
            const outcome = await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            });

            expect(outcome).toMatchObject({
                status         : 'completed',
                headRevision   : HEAD_A,
                materialization: {full: true, deleted: [], prefetch: {status: 'already-local', requested: 4}}
            });
            expect(events[0], 'one bulk prefetch before the first blob read').toEqual({
                op         : 'prefetch',
                revision   : HEAD_A,
                sourcePaths: ['_index.json', 'neo/issues/issue-1.md', 'neo/pulls/pr-2.md', 'neo/discussions/discussion-3.md']
            });
            expect(events.filter(event => event.op === 'prefetch')).toHaveLength(1);
            expect(calls.map(call => call.facet)).toEqual(['issues', 'pulls', 'discussions']);
            expect(calls.every(call =>
                call.options.strict === true &&
                call.options.reconcile === true &&
                call.options.contentRoot === config.materializedRoot
            )).toBe(true);
            expect(fs.readFileSync(path.join(config.materializedRoot, 'issues/issue-1.md'), 'utf8'))
                .toBe('issue A');

            const receipt = await readCorpusProjectionReceipt(config.receiptPath);
            expect(receipt.materializedCorpusRevision).toBe(HEAD_A);
            expect(receipt.lastFullMaterializationAt).toBe('2026-08-24T00:00:00.000Z');
            expect(receipt.projectedRevisionByFacet).toEqual({
                issues     : HEAD_A,
                pulls      : HEAD_A,
                discussions: HEAD_A
            })
        } finally {
            fs.removeSync(root)
        }
    });

    test('a later linear head applies exact add/delete/archive-move reconciliation without a full rebuild', async () => {
        const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-incremental-')),
              config    = createConfig(root),
              active    = 'neo/issues/issue-4.md',
              archived  = 'neo/archive/issues/v13/issue-4.md',
              events    = [],
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json', active]},
                  filesByRevision: {
                      [HEAD_A]: {
                          '_index.json': JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 4, path: active}]),
                          [active]     : 'state: OPEN'
                      },
                      [HEAD_B]: {
                          '_index.json': JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 4, path: archived}]),
                          [archived]   : 'state: CLOSED'
                      }
                  },
                  events
              }),
              calls = [];

        try {
            await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            });

            gitMirror.setHead(HEAD_B);
            gitMirror.setDiff({addedOrChanged: ['_index.json', archived], deleted: [active]});
            events.length = 0;

            const outcome = await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:01:00.000Z')
            });

            expect(outcome.materialization).toEqual({
                full          : false,
                addedOrChanged: ['_index.json', archived],
                deleted       : [active],
                changedFacets : ['issues'],
                prefetch      : {status: 'already-local', requested: 2, missing: 0, chunks: 0, reason: null}
            });
            expect(events[0], 'an incremental cycle prefetches its changed paths, never the tree').toEqual({
                op         : 'prefetch',
                revision   : HEAD_B,
                sourcePaths: ['_index.json', archived]
            });
            expect(fs.pathExistsSync(path.join(config.materializedRoot, 'issues/issue-4.md'))).toBe(false);
            expect(fs.readFileSync(path.join(config.materializedRoot, 'archive/issues/v13/issue-4.md'), 'utf8')).toBe('state: CLOSED');
            expect(outcome.receipt.projectedRevisionByFacet).toEqual({
                issues     : HEAD_B,
                pulls      : HEAD_B,
                discussions: HEAD_B
            })
        } finally {
            fs.removeSync(root)
        }
    });

    test('an unavailable prefetch leaves the per-file reads as the fallback and reports itself (#449)', async () => {
        const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-prefetch-unavailable-')),
              config    = createConfig(root),
              issuePath = 'neo/issues/issue-1.md',
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json', issuePath]},
                  filesByRevision: {
                      [HEAD_A]: {
                          '_index.json': JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 1, path: issuePath}]),
                          [issuePath]  : 'issue A'
                      }
                  },
                  prefetchStatus: 'unavailable'
              });

        try {
            const outcome = await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor([]),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            });

            expect(outcome.status).toBe('completed');
            expect(outcome.materialization.prefetch.status).toBe('unavailable');
            expect(fs.readFileSync(path.join(config.materializedRoot, 'issues/issue-1.md'), 'utf8')).toBe('issue A')
        } finally {
            fs.removeSync(root)
        }
    });

    test('a failed read settles its in-flight siblings before the staging directory is removed (#449)', async () => {
        const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-failed-read-')),
              config    = createConfig(root),
              slowPath  = 'neo/issues/issue-1.md',
              badPath   = 'neo/pulls/pr-2.md',
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json', slowPath, badPath]},
                  filesByRevision: {
                      [HEAD_A]: {
                          '_index.json': JSON.stringify([
                              {repoSlug: 'neo', type: 'issues', id: 1, path: slowPath},
                              {repoSlug: 'neo', type: 'pulls', id: 2, path: badPath}
                          ]),
                          [slowPath]: 'issue A'
                      }
                  }
              }),
              readFixture = gitMirror.readRevisionFile;

        // `readConcurrency` 2: the slow read is still in flight when its sibling fails.
        gitMirror.readRevisionFile = async options => {
            if (options.sourcePath === slowPath) await new Promise(resolve => setTimeout(resolve, 50));
            return readFixture(options)
        };

        try {
            await expect(runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor([]),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            })).rejects.toThrow(`missing fixture ${HEAD_A}:${badPath}`);

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(fs.readdirSync(root).filter(entry => entry.startsWith('materialized.next-')), 'no orphaned staging directory').toEqual([])
        } finally {
            fs.removeSync(root)
        }
    });

    test('the named periodic cadence forces a same-head full rematerialization and all-facet reconciliation', async () => {
        const root      = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-periodic-full-')),
              config    = {...createConfig(root), fullRematerializeIntervalMs: 60_000},
              issuePath = 'neo/issues/issue-7.md',
              gitMirror = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json', issuePath]},
                  filesByRevision: {[HEAD_A]: {
                      '_index.json': JSON.stringify([{repoSlug: 'neo', type: 'issues', id: 7, path: issuePath}]),
                      [issuePath]  : 'state: OPEN'
                  }}
              }),
              calls = [];

        try {
            await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            });
            calls.length = 0;

            const outcome = await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:01:01.000Z')
            });

            expect(outcome.materialization.full).toBe(true);
            expect(outcome.materialization.changedFacets).toEqual(['issues', 'pulls', 'discussions']);
            expect(calls.map(call => call.facet)).toEqual(['issues', 'pulls', 'discussions']);
            expect(outcome.receipt.lastFullMaterializationAt).toBe('2026-08-24T00:01:01.000Z')
        } finally {
            fs.removeSync(root)
        }
    });

    test('a pull-only failure carries unrelated facet coverage forward instead of all-cursors starvation', async () => {
        const root          = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-pulls-only-')),
              config        = createConfig(root),
              issuePath     = 'neo/issues/issue-1.md',
              pullPath      = 'neo/pulls/pr-2.md',
              discussPath   = 'neo/discussions/discussion-3.md',
              rootIndexPath = '_index.json',
              indexA        = JSON.stringify([
                  {repoSlug: 'neo', type: 'issues', id: 1, version: null, path: issuePath},
                  {repoSlug: 'neo', type: 'pulls', id: 2, version: null, path: pullPath},
                  {repoSlug: 'neo', type: 'discussions', id: 3, version: null, path: discussPath}
              ]),
              indexB = JSON.stringify([
                  {repoSlug: 'neo', type: 'issues', id: 1, version: null, path: issuePath},
                  {repoSlug: 'neo', type: 'pulls', id: 2, version: 'v13.2.0', path: pullPath},
                  {repoSlug: 'neo', type: 'discussions', id: 3, version: null, path: discussPath}
              ]),
              gitMirror  = createGitMirror({
                  pathsByRevision: {[HEAD_A]: [rootIndexPath, issuePath, pullPath, discussPath]},
                  filesByRevision: {
                      [HEAD_A]: {
                          [rootIndexPath]: indexA,
                          [issuePath]    : 'issue A',
                          [pullPath]     : 'pull A',
                          [discussPath]  : 'discussion A'
                      },
                      [HEAD_B]: {
                          [rootIndexPath]: indexB,
                          [pullPath]     : 'pull B'
                      }
                  }
              }),
              calls = [];

        try {
            await runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls),
                now          : Date.parse('2026-08-24T00:00:00.000Z')
            });

            gitMirror.setHead(HEAD_B);
            gitMirror.setDiff({addedOrChanged: [rootIndexPath, pullPath], deleted: []});

            await expect(runCoreCorpusProjectionCycle({
                config,
                gitMirror,
                issueIngestor: createIngestor(calls, {
                    pulls: Object.assign(new Error('injected pull failure'), {code: 'PULL_PROJECTION_FAILED'})
                }),
                now: Date.parse('2026-08-24T00:01:00.000Z')
            })).rejects.toMatchObject({code: 'CORE_CORPUS_PROJECTION_INCOMPLETE'});

            expect(calls.slice(3).map(call => call.facet)).toEqual(['pulls']);

            const receipt = await readCorpusProjectionReceipt(config.receiptPath);
            expect(receipt.projectedRevisionByFacet).toEqual({
                issues     : HEAD_B,
                pulls      : HEAD_A,
                discussions: HEAD_B
            });
            expect(evaluateCorpusProjectionAdmission({
                consumer: CORPUS_PROJECTION_CONSUMER.computedGoldenPath,
                now     : Date.parse('2026-08-24T00:01:00.000Z'),
                receipt
            })).toMatchObject({admitted: true, staleFacets: []});
            expect(evaluateCorpusProjectionAdmission({
                consumer: CORPUS_PROJECTION_CONSUMER.contextFrontier,
                now     : Date.parse('2026-08-24T00:01:00.000Z'),
                receipt
            })).toMatchObject({admitted: false, staleFacets: ['pulls']})
        } finally {
            fs.removeSync(root)
        }
    });

    test('one failed facet holds its cursor while independent siblings still commit', async () => {
        const root         = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-failure-')),
              config       = createConfig(root),
              issueFailure = Object.assign(new Error('injected issue failure'), {code: 'ISSUE_PROJECTION_FAILED'}),
              calls        = [],
              gitMirror    = createGitMirror({
                  pathsByRevision: {[HEAD_A]: ['_index.json']},
                  filesByRevision: {[HEAD_A]: {'_index.json': JSON.stringify([
                      {repoSlug: 'neo', type: 'issues', id: 1, path: 'neo/issues/issue-1.md'}
                  ])}}
              });

        try {
            let failure;
            try {
                await runCoreCorpusProjectionCycle({
                    config,
                    gitMirror,
                    issueIngestor: createIngestor(calls, {issues: issueFailure}),
                    now          : Date.parse('2026-08-24T00:00:00.000Z')
                })
            } catch (error) {
                failure = error
            }

            expect(failure).toMatchObject({
                code    : 'CORE_CORPUS_PROJECTION_INCOMPLETE',
                failures: [{facet: 'issues', errorCode: 'ISSUE_PROJECTION_FAILED'}]
            });
            expect(calls.map(call => call.facet)).toEqual(['issues', 'pulls', 'discussions']);

            const receipt = await readCorpusProjectionReceipt(config.receiptPath);
            expect(receipt.projectedRevisionByFacet).toEqual({
                issues     : null,
                pulls      : HEAD_A,
                discussions: HEAD_A
            });
            expect(receipt.projectionStateByFacet.issues).toMatchObject({
                status   : 'failed',
                errorCode: 'ISSUE_PROJECTION_FAILED'
            })
        } finally {
            fs.removeSync(root)
        }
    });

    test('missing source identity refuses before the mirror can run', async () => {
        const root   = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-identity-')),
              config = {...createConfig(root), sourceRepository: ''};

        try {
            await expect(runCoreCorpusProjectionCycle({
                config,
                gitMirror: {cloneIfMissing: async () => { throw new Error('mirror must stay untouched') }}
            })).rejects.toMatchObject({code: 'CORE_CORPUS_SOURCE_IDENTITY_MISSING'})
        } finally {
            fs.removeSync(root)
        }
    })

    test('a direct second writer defers at the heavy-maintenance lease before graph boot or projection (#17627)', async () => {
        const root   = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-lease-')),
              config = createConfig(root),
              lines  = [];
        let graphReadyCalls = 0;
        let projectionCalls = 0;

        try {
            const exitCode = await runProjectCoreCorpus({
                config,
                configProvider: {
                    orchestrator: {
                        corpusProjection     : config,
                        dataDir              : root,
                        heavyMaintenanceLease: {staleAfterMs: 60_000}
                    },
                    validateRequiredEnv: () => ({findings: []})
                },
                assertFresh : async () => {},
                graphService: {ready: async () => { graphReadyCalls++ }},
                runCycle    : async () => { projectionCalls++ },
                withLease   : async () => ({
                    status  : 'held',
                    acquired: false,
                    lease   : {
                        owner     : 'backup',
                        reason    : 'periodic-backup',
                        pid       : 123,
                        acquiredAt: '2026-08-24T00:00:00.000Z'
                    }
                }),
                output: {log: value => lines.push(value)},
                exit  : code => code
            });

            expect(exitCode).toBe(0);
            expect(graphReadyCalls).toBe(0);
            expect(projectionCalls).toBe(0);
            expect(JSON.parse(lines[0])).toEqual({
                deferred: true,
                reason  : 'heavy-maintenance-lease-held',
                holder  : {
                    owner     : 'backup',
                    reason    : 'periodic-backup',
                    pid       : 123,
                    acquiredAt: '2026-08-24T00:00:00.000Z'
                }
            });
            expect(classifyCoreCorpusProjectionOutcome({
                status: 'completed',
                result: {status: 'up-to-date'}
            })).toEqual({deferred: false, status: 'up-to-date'});
            expect(classifyCoreCorpusProjectionOutcome({status: 'unreadable'})).toEqual({
                deferred   : true,
                reason     : 'heavy-maintenance-lease-unavailable',
                leaseStatus: 'unreadable'
            })
        } finally {
            fs.removeSync(root)
        }
    });

    test('a failed cycle names its code, message and git stderr on stderr, keeps the file-sink line and exits 1 (#448)', async () => {
        const root        = fs.mkdtempSync(path.join(os.tmpdir(), 'core-corpus-failure-line-')),
              config      = createConfig(root),
              errors      = [],
              fileLines   = [],
              loggerError = logger.error,
              failure     = Object.assign(new Error('GitMirror failed to read a revision file'), {
                  code  : 'KB_GITMIRROR_FILE_READ_FAILED',
                  stderr: "fatal: path '_index.json' does not exist in 'abc123'\n"
              });

        logger.error = (...args) => fileLines.push(args);

        try {
            const exitCode = await runProjectCoreCorpus({
                config,
                configProvider: {
                    orchestrator: {
                        corpusProjection     : config,
                        dataDir              : root,
                        heavyMaintenanceLease: {staleAfterMs: 60_000}
                    },
                    validateRequiredEnv: () => ({findings: []})
                },
                assertFresh : async () => {},
                graphService: {ready: async () => {}},
                runCycle    : async () => { throw failure },
                withLease   : async work => ({status: 'completed', result: await work()}),
                output      : {log: () => {}, error: value => errors.push(value)},
                exit        : code => code
            });

            expect(exitCode).toBe(1);
            expect(errors).toEqual([
                "[core-corpus-projection] Projection cycle failed: KB_GITMIRROR_FILE_READ_FAILED — GitMirror failed to read a revision file — git: fatal: path '_index.json' does not exist in 'abc123'"
            ]);
            expect(fileLines).toHaveLength(1);
            expect(fileLines[0][1]).toBe(failure)
        } finally {
            logger.error = loggerError;
            fs.removeSync(root)
        }
    })
});
