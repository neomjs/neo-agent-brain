import {setup} from '../../../../setup.mjs';

const appName = 'IssueServiceStateTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * @summary Contract coverage for `IssueService.manageIssueState`, the server's issue close.
 *
 * Every arm records the GraphQL calls, because half of the contract is what must not be sent: a
 * refused, already-closed or malformed close reaches no mutation.
 */
test.describe('Neo.ai.services.github-workflow.IssueService — manageIssueState (#1616)', () => {
    const ISSUE_NODE_ID    = 'I_kwDOUBzDFM8AAAABOXFAbA',
          ISSUE_URL        = 'https://github.com/neomjs/neo/issues/1616',
          SURVIVOR_NODE_ID = 'I_kwDOUBzDFM8AAAABOXFAbB',
          CLOSED           = {issueId: ISSUE_NODE_ID, number: 1616, url: ISSUE_URL, closed: true};

    let IssueService,
        GraphqlService,
        originalQuery;

    test.beforeAll(async () => {
        GraphqlService = (await import('../../../../../../ai/services/github-workflow/GraphqlService.mjs')).default;
        IssueService   = (await import('../../../../../../ai/services/github-workflow/IssueService.mjs')).default;

        originalQuery = GraphqlService.query.bind(GraphqlService);
    });

    test.afterEach(() => {
        GraphqlService.query = originalQuery;
    });

    /**
     * Stubs `GraphqlService.query` by operation name and records every call.
     * @param {Object} [issue] The issue the close-target lookup answers; `survivor: null` makes the
     *     surviving issue of a DUPLICATE close unknown.
     * @returns {Object[]} The recorded `{query, variables}` calls.
     */
    function stubClose({author = 'neo-opus-vega', assignees = [], viewer = 'neo-opus-vega', closed = false, stateReason = null, survivor = SURVIVOR_NODE_ID} = {}) {
        const calls = [];

        GraphqlService.query = async (query, variables) => {
            calls.push({query, variables});

            if (query.includes('GetIssueCloseTarget')) {
                return {
                    viewer    : {login: viewer},
                    repository: {
                        issue: {
                            id       : ISSUE_NODE_ID,
                            url      : ISSUE_URL,
                            closed,
                            stateReason,
                            author   : {login: author},
                            assignees: {nodes: assignees.map(login => ({login}))}
                        }
                    }
                };
            }

            if (query.includes('GetIssueId')) {
                return {repository: {issue: survivor ? {id: survivor} : null}};
            }

            if (query.includes('CloseIssue')) {
                return {closeIssue: {issue: {id: ISSUE_NODE_ID, url: ISSUE_URL, closed: true, stateReason: variables.stateReason}}};
            }

            throw new Error(`Unexpected GraphqlService.query call: ${query.slice(0, 60)}`);
        };

        return calls;
    }

    const close   = options => IssueService.manageIssueState({action: 'close', issue_number: 1616, ...options}),
          mutated = calls => calls.some(call => call.query.includes('CloseIssue'));

    for (const reason of ['COMPLETED', 'NOT_PLANNED']) {
        test(`the author closes an own issue as ${reason}`, async () => {
            const calls  = stubClose(),
                  result = await close({reason});

            expect(result).toEqual({...CLOSED, stateReason: reason});
            expect(calls.map(call => call.variables)).toEqual([
                {owner: 'neomjs', repo: 'neo', number: 1616},
                {issueId: ISSUE_NODE_ID, stateReason: reason}
            ]);
        });
    }

    test('a DUPLICATE close resolves the surviving issue and passes its node id', async () => {
        const calls  = stubClose(),
              result = await close({reason: 'DUPLICATE', duplicate_of: 132});

        expect(result).toEqual({...CLOSED, stateReason: 'DUPLICATE', duplicateOf: 132});
        expect(calls.map(call => call.variables)).toEqual([
            {owner: 'neomjs', repo: 'neo', number: 1616},
            {owner: 'neomjs', repo: 'neo', number: 132},
            {issueId: ISSUE_NODE_ID, stateReason: 'DUPLICATE', duplicateIssueId: SURVIVOR_NODE_ID}
        ]);
    });

    test('a DUPLICATE close whose surviving issue is unknown closes nothing', async () => {
        const calls  = stubClose({survivor: null}),
              result = await close({reason: 'DUPLICATE', duplicate_of: 999999});

        expect(result.code).toBe('NOT_FOUND');
        expect(mutated(calls)).toBe(false);
    });

    test('an assignee who is not the author closes it, and the login check ignores case', async () => {
        const calls  = stubClose({author: 'neo-opus-ada', assignees: ['neo-gpt-emmy', 'Neo-Opus-Vega']}),
              result = await close({reason: 'COMPLETED'});

        expect(result).toEqual({...CLOSED, stateReason: 'COMPLETED'});
        expect(mutated(calls)).toBe(true);
    });

    test('a caller who is neither author nor assignee is refused, and nothing is closed', async () => {
        const calls  = stubClose({author: 'neo-opus-ada', assignees: ['neo-gpt-emmy']}),
              result = await close({reason: 'COMPLETED'});

        expect(result).toMatchObject({
            code       : 'FOREIGN_CLOSE_FORBIDDEN',
            number     : 1616,
            author     : 'neo-opus-ada',
            assignees  : ['neo-gpt-emmy'],
            viewerLogin: 'neo-opus-vega'
        });
        expect(calls).toHaveLength(1);
    });

    test('a blank acknowledgedForeignClose does not lift the refusal', async () => {
        const calls  = stubClose({author: 'neo-opus-ada'}),
              result = await close({reason: 'COMPLETED', acknowledgedForeignClose: '   '});

        expect(result.code).toBe('FOREIGN_CLOSE_FORBIDDEN');
        expect(calls).toHaveLength(1);
    });

    test('a stated acknowledgedForeignClose closes a foreign issue and echoes the reason', async () => {
        const calls  = stubClose({author: 'neo-opus-ada'}),
              result = await close({reason: 'NOT_PLANNED', acknowledgedForeignClose: '  author agreed on the thread  '});

        expect(result).toEqual({...CLOSED, stateReason: 'NOT_PLANNED', acknowledgedForeignClose: 'author agreed on the thread'});
        expect(mutated(calls)).toBe(true);
    });

    test('an already-closed issue returns its state without mutating, whoever asks', async () => {
        const calls  = stubClose({author: 'neo-opus-ada', closed: true, stateReason: 'NOT_PLANNED'}),
              result = await close({reason: 'COMPLETED'});

        expect(result).toEqual({...CLOSED, stateReason: 'NOT_PLANNED', alreadyClosed: true});
        expect(calls).toHaveLength(1);
    });

    for (const [label, options, code] of [
        ['a missing reason',                        {},                                             'MISSING_ARGUMENTS'],
        ['a missing issue number',                  {issue_number: undefined, reason: 'COMPLETED'}, 'MISSING_ARGUMENTS'],
        ['an unknown reason',                       {reason: 'completed'},                          'INVALID_ARGUMENTS'],
        ['an unknown action',                       {action: 'reopen', reason: 'COMPLETED'},        'INVALID_ARGUMENTS'],
        ['a DUPLICATE without its surviving issue', {reason: 'DUPLICATE'},                          'INVALID_ARGUMENTS'],
        ['a DUPLICATE of itself',                   {reason: 'DUPLICATE', duplicate_of: 1616},      'INVALID_ARGUMENTS'],
        ['a duplicate_of with another reason',      {reason: 'COMPLETED', duplicate_of: 132},       'INVALID_ARGUMENTS']
    ]) {
        test(`${label} is refused before any GraphQL call`, async () => {
            const calls  = stubClose(),
                  result = await close(options);

            expect(result.code).toBe(code);
            expect(calls).toHaveLength(0);
        });
    }

    test('a number that is no issue of the repository returns NOT_FOUND', async () => {
        GraphqlService.query = async () => ({viewer: {login: 'neo-opus-vega'}, repository: {issue: null}});

        expect((await close({reason: 'COMPLETED'})).code).toBe('NOT_FOUND');
    });

    test('a mutation that throws is reported as GRAPHQL_API_ERROR', async () => {
        stubClose();

        const answer = GraphqlService.query;

        GraphqlService.query = async (query, variables) => {
            if (query.includes('CloseIssue')) {
                throw new Error('Resource not accessible by integration');
            }

            return answer(query, variables);
        };

        const result = await close({reason: 'COMPLETED'});

        expect(result.code).toBe('GRAPHQL_API_ERROR');
        expect(result.message).toContain('not accessible');
    });
});
