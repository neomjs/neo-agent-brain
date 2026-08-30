import {test, expect} from '@playwright/test';

import {
    createRepositoryRevisionReader,
    isBinaryRevisionBlob,
    isRegularRevisionBlob
} from '../../../../../../ai/services/knowledge-base/helpers/repositoryRevisionReader.mjs';

test.describe('repository revision reader (#261)', () => {
    function entry(sourcePath, mode, type, oidCharacter = 'a') {
        return {sourcePath, mode, type, oid: oidCharacter.repeat(40)};
    }

    function createReader(contents = {}) {
        const entries = [
            entry('src/executable.mjs', '100755', 'blob', 'a'),
            entry('src/plain.mjs',      '100644', 'blob', 'b'),
            entry('src/symlink.mjs',    '120000', 'blob', 'c'),
            entry('vendor/package',     '160000', 'commit', 'd')
        ];
        const gitMirror = {
            async listRevisionEntries() {
                return entries;
            },
            async readRevisionBlob({sourcePath}) {
                return contents[sourcePath] ?? Buffer.from(sourcePath);
            },
            async prefetchRevisionBlobs({sourcePaths}) {
                return {sourcePaths};
            }
        };

        return createRepositoryRevisionReader({
            gitMirror,
            mirrorRoot: '/fixture',
            tenantId  : 'tenant-a',
            repoSlug  : 'org/repo',
            revision  : 'f'.repeat(40)
        });
    }

    test('uses Git mode—not object type—to select regular blobs', async () => {
        const reader = createReader();

        expect((await reader.listRegularEntries()).map(entry => entry.sourcePath))
            .toEqual(['src/executable.mjs', 'src/plain.mjs']);
        expect(isRegularRevisionBlob(entry('x', '100644', 'blob'))).toBe(true);
        expect(isRegularRevisionBlob(entry('x', '120000', 'blob'))).toBe(false);
        expect(isRegularRevisionBlob(entry('x', '160000', 'commit'))).toBe(false);
        await expect(reader.readBlob('src/symlink.mjs'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_ENTRY_UNSUPPORTED'});
        await expect(reader.readBlob('vendor/package'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_ENTRY_UNSUPPORTED'});
    });

    test('preserves raw bytes and refuses invalid UTF-8 or NUL content before decoding', async () => {
        const reader = createReader({
            'src/executable.mjs': Buffer.from([0xff, 0xfe]),
            'src/plain.mjs'     : Buffer.from('ok\0bad', 'utf8')
        });

        expect(await reader.readBlob('src/executable.mjs')).toEqual(Buffer.from([0xff, 0xfe]));
        await expect(reader.readText('src/executable.mjs'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_BINARY_BLOB'});
        await expect(reader.readText('src/plain.mjs'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_BINARY_BLOB'});
        expect(isBinaryRevisionBlob(Buffer.from('valid utf8'))).toBe(false);
    });

    test('scopes reads and prefetches to the route-assigned entry set', async () => {
        const reader  = createReader();
        const [plain] = (await reader.listRegularEntries())
            .filter(entry => entry.sourcePath === 'src/plain.mjs');
        const scoped = await reader.scope([plain]);

        await expect(scoped.readText('src/plain.mjs')).resolves.toBe('src/plain.mjs');
        await expect(scoped.readText('src/executable.mjs'))
            .rejects.toMatchObject({code: 'KB_REVISION_READER_PATH_OUTSIDE_SCOPE'});
        await expect(scoped.scope([
            entry('src/executable.mjs', '100755', 'blob')
        ])).rejects.toMatchObject({code: 'KB_REVISION_READER_SCOPE_INVALID'});
        await expect(scoped.prefetch(['src/plain.mjs'])).resolves.toEqual({
            sourcePaths: ['src/plain.mjs']
        });
    });

    test('rejects malformed adapter entry identity instead of classifying it as a skip', async () => {
        const reader = createRepositoryRevisionReader({
            gitMirror: {
                async listRevisionEntries() {
                    return [{sourcePath: 'src/a.mjs', mode: '100644', type: 'blob', oid: 'bad'}];
                },
                async readRevisionBlob() {
                    return Buffer.from('content');
                }
            },
            mirrorRoot: '/fixture',
            tenantId  : 'tenant-a',
            repoSlug  : 'org/repo',
            revision  : 'f'.repeat(40)
        });

        await expect(reader.listEntries())
            .rejects.toMatchObject({code: 'KB_REVISION_READER_ENTRY_INVALID'});
    });

    test('requires an immutable Git OID and a raw-byte adapter', () => {
        const base = {
            mirrorRoot: '/fixture',
            tenantId  : 'tenant-a',
            repoSlug  : 'org/repo'
        };

        expect(() => createRepositoryRevisionReader({
            ...base,
            revision : 'dev',
            gitMirror: {
                async listRevisionEntries() { return [] },
                async readRevisionBlob() { return Buffer.alloc(0) }
            }
        })).toThrow(/exact Git object id/u);

        expect(() => createRepositoryRevisionReader({
            ...base,
            revision : 'f'.repeat(40),
            gitMirror: {
                async listRevisionEntries() { return [] },
                async readRevisionFile() { return 'text only' }
            }
        })).toThrow(/blob-read GitMirror primitives/u);
    });
});
