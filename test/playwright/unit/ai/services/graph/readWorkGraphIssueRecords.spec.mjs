import {setup}                     from '../../../../setup.mjs';
import {test, expect}              from '@playwright/test';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import {readWorkGraphIssueRecords} from '../../../../../../ai/services/graph/issueFocusSections.mjs';
import fs                          from 'node:fs';
import os                          from 'node:os';
import path                        from 'node:path';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name: 'ReadWorkGraphIssueRecordsTest'
    }
});

/**
 * @summary The issue reader's origin contract: with an `origin` the record identity is qualified and
 * the record carries `repoSlug`, so the same number from two repositories stays two records; without
 * one — the Golden Path and stall-inference callers — ids stay the bare `issue-N` the Graph keys.
 */
test.describe('Neo.ai.services.graph.readWorkGraphIssueRecords — origin identity', () => {
    let root;

    const writeIssue = (origin, number) => {
        const dir = path.join(root, origin, 'issues', 'chunk-1');

        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, `issue-${number}.md`), [
            '---', `id: ${number}`, `title: ${origin} ${number}`, 'state: OPEN', 'labels: []', 'assignees: []',
            "createdAt: '2026-09-22T10:00:00Z'", "updatedAt: '2026-09-22T10:00:00Z'",
            `githubUrl: 'https://github.com/neomjs/${origin}/issues/${number}'`, '---', 'body'
        ].join('\n'));

        return path.join(root, origin, 'issues')
    };

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'synced-issues-'));
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('two origins sharing an issue number answer two records with distinct, origin-qualified ids', () => {
        const [home]    = readWorkGraphIssueRecords(writeIssue('neo', 7), {origin: 'neo'}),
              [foreign] = readWorkGraphIssueRecords(writeIssue('neo-agent-brain', 7), {origin: 'neo-agent-brain'});

        expect(home).toMatchObject({issueId: 'issue-7', number: 7, repoSlug: 'neo', title: 'neo 7'});
        expect(foreign).toMatchObject({issueId: 'neo-agent-brain#issue-7', number: 7, repoSlug: 'neo-agent-brain', title: 'neo-agent-brain 7'});
        expect(home.issueId).not.toBe(foreign.issueId)
    });

    test('without an origin the ids stay the bare issue-N the Graph keys, and repoSlug is null', () => {
        const [record] = readWorkGraphIssueRecords(writeIssue('neo', 19058));

        expect(record).toMatchObject({issueId: 'issue-19058', number: 19058, repoSlug: null})
    })
});
