import {test, expect}  from '@playwright/test'
import {isAdrRedirect} from '../../../../../../ai/services/shared/adrRedirect.mjs'

const pointer = `---
type: redirect
target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0034
---

# Moved

This decision lives in neomjs/neo-agent-institution.
`;

/**
 * @summary Contract suite for the shared ADR redirect reader: only a frontmatter `type` of exactly
 * `redirect` makes a document a pointer; everything else stays a record for its caller.
 */
test.describe('adrRedirect — the redirect reader', () => {
    test('a §2.9 pointer is a redirect, quoted or not', () => {
        expect(isAdrRedirect(pointer)).toBe(true);
        expect(isAdrRedirect(pointer.replace('type: redirect', 'type: "redirect"'))).toBe(true);
        expect(isAdrRedirect(pointer.replace(/\n/g, '\r\n'))).toBe(true)
    });

    test('a record stays a record: no frontmatter, another type, or a body that only mentions one', () => {
        expect(isAdrRedirect('# ADR 0034: Electron shell\n\n| **Status** | Accepted |\n')).toBe(false);
        expect(isAdrRedirect(pointer.replace('type: redirect', 'type: adr'))).toBe(false);
        expect(isAdrRedirect('# ADR 0006\n\n```yaml\n---\ntype: redirect\n---\n```\n')).toBe(false);
        expect(isAdrRedirect(pointer.replace('type: redirect', 'type: redirects'))).toBe(false)
    });

    test('unparsable frontmatter or no text reads as a record, never as a pointer', () => {
        expect(isAdrRedirect('---\ntype: [redirect\n---\n# Broken\n')).toBe(false);
        expect(isAdrRedirect('---\n---\n# Empty frontmatter\n')).toBe(false);
        expect(isAdrRedirect('')).toBe(false);
        expect(isAdrRedirect(undefined)).toBe(false)
    })
});
