import {test, expect}     from '@playwright/test';
import fs                 from 'node:fs';
import path               from 'node:path';
import {load as loadYaml} from 'js-yaml';

const
    repoRoot     = path.resolve(process.cwd()),
    workflowPath = path.join(repoRoot, '.github/workflows/claim-responder.yml');

/**
 * @summary Loads and parses `.github/workflows/claim-responder.yml` alongside its raw YAML source.
 * @returns {{doc: Object, raw: String}}
 */
function readCallerWorkflow() {
    const raw = fs.readFileSync(workflowPath, 'utf8');
    return {doc: loadYaml(raw), raw}
}

test.describe('claim-responder workflow caller contract', () => {
    test('declares dual triggers, exact token permissions, and pre-runner event filters', () => {
        const {doc} = readCallerWorkflow();

        expect(doc.name).toBe('Claim responder');
        expect(doc.on.issue_comment).toEqual({types: ['created']});
        expect(doc.on.pull_request_target).toEqual({types: ['opened', 'reopened', 'edited', 'closed']});
        expect(doc.permissions).toEqual({
            contents       : 'read',
            issues         : 'write',
            'pull-requests': 'write'
        });

        const condition = String(doc.jobs?.respond?.if ?? '');
        expect(condition).toContain("github.event_name == 'issue_comment'");
        expect(condition).toContain('!github.event.issue.pull_request');
        expect(condition).toContain("github.event.issue.state == 'open'");
        expect(condition).toContain("github.event.comment.user.type != 'Bot'");
        expect(condition).toContain('["COLLABORATOR","MEMBER","OWNER"]');
        expect(condition).toContain("contains(github.event.issue.labels.*.name, 'good first issue')");
        expect(condition).toContain("contains(github.event.issue.labels.*.name, 'help wanted')");
        expect(condition).toContain("github.event_name == 'pull_request_target'");
        expect(condition).toContain("github.event.pull_request.user.type != 'Bot'");
    });

    test('delegates via full 40-hex Engine SHA with zero local concurrency group, inputs, or steps', () => {
        const
            {doc, raw} = readCallerWorkflow(),
            jobEntries = Object.entries(doc.jobs ?? {});

        expect(doc.concurrency).toBeUndefined();
        expect(jobEntries).toHaveLength(1);
        expect(jobEntries[0][0]).toBe('respond');

        const respond = jobEntries[0][1];
        expect(respond.concurrency).toBeUndefined();
        expect(respond.uses).toMatch(/^neomjs\/neo\/\.github\/workflows\/claim-responder\.yml@[0-9a-f]{40}$/);
        expect(respond.with).toBeUndefined();
        expect(respond.steps).toBeUndefined();
        expect(respond['runs-on']).toBeUndefined();
        expect(raw).not.toContain('actions/checkout');
        expect(raw).not.toContain('pull_request.head');
    });
});
