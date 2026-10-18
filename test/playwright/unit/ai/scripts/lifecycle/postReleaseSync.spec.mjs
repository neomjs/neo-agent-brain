import {test, expect} from '@playwright/test';
import fs             from 'fs';
import path           from 'path';

/**
 * The post-release lifecycle uploads the Knowledge Base and writes nothing into the Engine checkout.
 *
 * The Engine no longer carries a content mirror: its conversations publish from
 * `neomjs/github-content-sync`, and its release notes stay where they were authored. A sync, a
 * broad stage or a push from this script would recreate the retired tree on the Engine's `dev`,
 * and every one of its commits would bypass the hooks by design. A source assertion is the only
 * instrument short of cutting a release.
 */

const
    root       = process.cwd(),
    sourcePath = 'ai/scripts/lifecycle/postReleaseSync.mjs';

test.describe('postReleaseSync — the Brain half of the release writes nothing into the Engine', () => {
    const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');

    test('the script is a live entrypoint, not an orphan this spec would assert over', () => {
        const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
            .scripts['ai:post-release-sync'];

        expect(script, 'package.json must carry ai:post-release-sync').toBeTruthy();
        expect(script.replace(/^node\s+/, '').replace(/^\.\//, '')).toBe(sourcePath)
    });

    test('it neither syncs nor stages, commits or pushes', () => {
        expect(source).not.toMatch(/emitConversationCorpus\(|sync-github-workflow|syncGithubWorkflow/);
        expect(source).not.toMatch(/['"`]git (add|commit|push)\b/);
        expect(source).not.toMatch(/check-content-logical-identity/)
    });

    test('the Knowledge Base upload runs after the fail-closed preflight', () => {
        const
            preflightIdx = source.indexOf('assertAdmissibleStartingState({'),
            uploadIdx    = source.indexOf("'ai/scripts/maintenance/uploadKnowledgeBase.mjs'");

        expect(preflightIdx).toBeGreaterThan(-1);
        expect(uploadIdx).toBeGreaterThan(preflightIdx)
    })
});
