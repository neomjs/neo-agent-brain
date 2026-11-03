import {test, expect}  from '@playwright/test';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    assertFleetPlaneAdmissionBearerClass,
    assertFleetPlaneBearerClass,
    assertFleetViewerMcAuthorizationClass,
    resolveFleetPlaneAdmissionBearer,
    resolveFleetPlaneBearer
} from '../../../../../../ai/services/fleet/fleetServer.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * The two-home plane-bearer contract the dev fleet entry consumes: direct value wins, the
 * declared secret file materializes otherwise, and every empty/unreadable path resolves `''` so
 * the caller's own fail-closed admission owns the refusal. Plus the consuming-site ratchet: the
 * dev entry arms its plane client through the ASSERT variant — never by reading the direct leaf,
 * never by the bare resolver — so the file indirection and the credential-class teeth are both
 * pinned against regressions at the consuming site (source-form pins, not a behavior proof).
 */
test.describe('resolveFleetPlaneBearer — the two-home plane credential contract', () => {
    const config = ({direct = '', file = ''} = {}) => ({fleet: {planeBearer: direct, planeBearerFile: file}});

    test('the direct value wins over a pinned file', () => {
        const resolved = resolveFleetPlaneBearer({
            aiConfig: config({direct: 'direct-token', file: '/also/pinned'}),
            readFile: () => { throw new Error('the file seam must not be consulted when the direct value is set') }
        });

        expect(resolved).toBe('direct-token')
    });

    test('the secret file materializes when the direct value is empty', () => {
        const resolved = resolveFleetPlaneBearer({
            aiConfig: config({file: '/deploy/secrets/plane-bearer'}),
            readFile: target => {
                expect(target).toBe('/deploy/secrets/plane-bearer');
                return '  file-token\n'
            }
        });

        expect(resolved).toBe('file-token')
    });

    test('a pinned-but-unreadable file resolves empty — the caller owns the loud refusal, never a silent fall-through', () => {
        const resolved = resolveFleetPlaneBearer({
            aiConfig: config({file: '/deploy/secrets/gone'}),
            readFile: () => { throw new Error('ENOENT') }
        });

        expect(resolved).toBe('')
    });

    test('neither home set resolves empty — the tokenless-plane path is preserved', () => {
        expect(resolveFleetPlaneBearer({aiConfig: config()})).toBe('')
    });

    test('the default readFileSync seam materializes the file the leaf documents — no injected reader', () => {
        // Proves the DEFAULT file seam (readFile: null → the real readFileSync), not just the
        // injection path: a minimal tree carrying the REAL leaf names, a real file on disk.
        const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'plane-bearer-')),
              file = path.join(dir, 'token');

        fs.writeFileSync(file, 'real-tree-file-token\n');

        const resolved = resolveFleetPlaneBearer({
            aiConfig: {fleet: {planeBearer: '', planeBearerFile: file}},
            readFile: null
        });

        expect(resolved).toBe('real-tree-file-token')
    });
});

/**
 * The credential-class ledger's teeth at the arming site: the assert variant resolves through the
 * same two-home read, then refuses a bearer that aliases the deployment's bootstrap/healthcheck
 * admission token — the refusal production has and the dev journey must match. `''` early when
 * nothing resolves, so the tokenless path is preserved byte-for-byte; a missing or unreadable
 * admission file disables the comparison, never the resolution.
 */
test.describe('assertFleetPlaneBearerClass — the credential-class non-alias teeth', () => {
    const config = ({direct = '', file = '', admissionFile = ''} = {}) => ({
        fleet: {planeBearer: direct, planeBearerFile: file, admissionTokenFile: admissionFile}
    });

    test('a bearer aliasing the admission token throws the named ledger refusal', () => {
        expect(() => assertFleetPlaneBearerClass({
            aiConfig: config({direct: 'shared-token', admissionFile: '/deploy/secrets/admission'}),
            readFile: target => {
                expect(target).toBe('/deploy/secrets/admission');
                return 'shared-token\n'
            }
        })).toThrow(/credential-class ledger forbids that aliasing/)
    });

    test('distinct bearer + admission token passes through the resolved bearer', () => {
        const resolved = assertFleetPlaneBearerClass({
            aiConfig: config({direct: 'plane-token', admissionFile: '/deploy/secrets/admission'}),
            readFile: () => 'admission-token\n'
        });

        expect(resolved).toBe('plane-token')
    });

    test('an unreadable admission file disables the COMPARISON, never the resolution', () => {
        const resolved = assertFleetPlaneBearerClass({
            aiConfig: config({direct: 'plane-token', admissionFile: '/deploy/secrets/gone'}),
            readFile: () => { throw new Error('ENOENT') }
        });

        expect(resolved).toBe('plane-token')
    });

    test('no admission file declared disables the comparison', () => {
        const resolved = assertFleetPlaneBearerClass({
            aiConfig: config({direct: 'plane-token'}),
            readFile: () => { throw new Error('must not be consulted without an admission file') }
        });

        expect(resolved).toBe('plane-token')
    });

    test('nothing resolves returns empty EARLY — the tokenless path never touches the comparison', () => {
        const resolved = assertFleetPlaneBearerClass({
            aiConfig: config({admissionFile: '/deploy/secrets/admission'}),
            readFile: () => { throw new Error('must not be consulted when nothing resolved') }
        });

        expect(resolved).toBe('')
    });

    test('ratchet: the dev fleet entry arms its plane client through the ASSERT variant — never the direct leaf, never the bare resolver', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'ai/services/fleet/devFleetServer.mjs'), 'utf8');

        expect(source).toContain('assertFleetPlaneBearerClass');
        // the gaps this ticket line closes, pinned as source forms: the direct-leaf credential
        // read, and the teeth-free bare-resolver arm
        expect(source).not.toMatch(/credential:\s*AiConfig\.fleet\.planeBearer\b/);
        expect(source).not.toMatch(/credential:\s*resolveFleetPlaneBearer\(/)
    });
});

test.describe('a piped plane credential meets the teeth a configured bearer meets (#1462)', () => {
    const
        ADMISSION_FILE = '/deploy/secrets/admission',
        config         = (fleet = {}) => ({fleet: {
            admissionTokenFile       : ADMISSION_FILE,
            planeAdmissionBearer     : '',
            planeAdmissionBearerFile : '',
            planeBearer              : '',
            planeBearerClass         : '',
            planeBearerFile          : '',
            viewerMcAuthorization    : '',
            viewerMcAuthorizationFile: '',
            ...fleet
        }}),
        admissionToken = token => target => {
            expect(target).toBe(ADMISSION_FILE);
            return `${token}\n`
        };

    test('a piped bearer that IS the admission token is refused exactly like a configured one, and named as piped', () => {
        const aiConfig = config();

        expect(() => assertFleetPlaneBearerClass({aiConfig, readFile: admissionToken('shared-token'), planeCredential: {bearer: 'shared-token', bearerClass: ''}}))
            .toThrow(/^\[FleetServer\] the piped plane bearer resolves to the deployment's bootstrap\/healthcheck admission token — the credential-class ledger forbids that aliasing/);
        expect(() => assertFleetPlaneBearerClass({aiConfig: config({planeBearer: 'shared-token'}), readFile: admissionToken('shared-token')}))
            .toThrow(/^\[FleetServer\] fleet\.planeBearer resolves to the deployment's bootstrap\/healthcheck admission token/)
    });

    test('the piped bearer is judged in place of the configured one', () => {
        expect(assertFleetPlaneBearerClass({
            aiConfig       : config({planeBearer: 'shared-token'}),
            readFile       : admissionToken('shared-token'),
            planeCredential: {bearer: 'ghp_distinct', bearerClass: 'github-pat'}
        })).toBe('ghp_distinct')
    });

    test('a forge-PAT class on the frame presents the piped bearer at the fleet surface; any other class arms nothing, and a declared admission bearer still wins', () => {
        const readFile = admissionToken('bootstrap-token');

        expect(assertFleetPlaneAdmissionBearerClass({aiConfig: config(), readFile, planeCredential: {bearer: 'ghp_rotated', bearerClass: 'github-pat'}})).toBe('ghp_rotated');
        expect(assertFleetPlaneAdmissionBearerClass({aiConfig: config(), readFile, planeCredential: {bearer: 'plane-mint', bearerClass: ''}})).toBe('');
        // the configured class describes the configured bearer, never the piped one
        expect(resolveFleetPlaneAdmissionBearer({aiConfig: config({planeBearerClass: 'github-pat'}), planeCredential: {bearer: 'plane-mint', bearerClass: ''}})).toBe('');
        expect(resolveFleetPlaneAdmissionBearer({aiConfig: config({planeAdmissionBearer: 'fleet-mint'}), planeCredential: {bearer: 'ghp_rotated', bearerClass: 'github-pat'}})).toBe('fleet-mint')
    });

    test('a declared fleet-surface bearer equal to a piped plane mint is refused, as with a configured one', () => {
        expect(() => assertFleetPlaneAdmissionBearerClass({
            aiConfig       : config({planeAdmissionBearer: 'same-mint'}),
            readFile       : admissionToken('bootstrap-token'),
            planeCredential: {bearer: 'same-mint', bearerClass: ''}
        })).toThrow(/same bytes as the plane-MCP bearer/)
    });

    test('the viewer mint refuses a piped bearer it aliases', () => {
        expect(() => assertFleetViewerMcAuthorizationClass({
            aiConfig       : config({viewerMcAuthorization: 'viewer-mint'}),
            readFile       : admissionToken('bootstrap-token'),
            planeCredential: {bearer: 'viewer-mint', bearerClass: ''}
        })).toThrow(/viewerMcAuthorization resolves to the same bytes as the plane-MCP bearer/)
    });
});
