import {execFileSync}             from 'node:child_process';
import {createHash}               from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fs                         from 'node:fs/promises';
import path                       from 'node:path';

import createRepositoryRevisionReader, {normalizeRevisionSourcePath}
    from './repositoryRevisionReader.mjs';

const SHA_PATTERN        = /^[a-f0-9]{40}$/u;
const ENGINE_PIN_PATTERN = /^https:\/\/github\.com\/neomjs\/neo\/archive\/([a-f0-9]{40})\.tar\.gz$/u;

/**
 * @summary Creates a stable, non-secret error for image revision admission failures.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function readerError(code, message) {
    const error = new Error(message);

    error.code = code;

    return error;
}

/**
 * @summary Attests one unstamped Brain checkout before its files can carry a Git revision.
 * @param {Object} options
 * @param {String} options.root Explicit checkout root.
 * @param {Function} [options.runGit=execFileSync] Injectable command for the CLI boundary spec.
 * @returns {String} The clean checkout HEAD.
 */
export function resolveCleanBrainCheckoutRevision({root, runGit = execFileSync} = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw readerError('KB_CORE_CORPUS_CHECKOUT_REVISION_INVALID', 'Shared core sync requires an explicit Brain checkout root');
    }

    let status;
    let revision;

    try {
        status = String(runGit('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        })).trim();
    } catch {
        throw readerError('KB_CORE_CORPUS_CHECKOUT_REVISION_INVALID', 'Shared core sync could not verify the Brain checkout');
    }

    if (status) {
        throw readerError('KB_CORE_CORPUS_CHECKOUT_DIRTY', 'Shared core sync requires a clean, exact Brain checkout or an image revision stamp');
    }

    try {
        revision = String(runGit('git', ['-C', root, 'rev-parse', 'HEAD'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        })).trim();
    } catch {
        throw readerError('KB_CORE_CORPUS_CHECKOUT_REVISION_INVALID', 'Shared core sync could not resolve an exact Brain checkout revision');
    }

    if (!SHA_PATTERN.test(revision)) {
        throw readerError('KB_CORE_CORPUS_CHECKOUT_REVISION_INVALID', 'Shared core sync could not resolve an exact Brain checkout revision');
    }

    return revision;
}

/**
 * @summary Returns true when a resolved path stays at or below its declared root.
 * @param {String} root
 * @param {String} candidate
 * @returns {Boolean}
 */
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);

    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * @summary Computes the same content object identity that Git assigns to a blob.
 * @param {Buffer} content
 * @returns {String}
 */
function blobOid(content) {
    return createHash('sha1')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
}

/**
 * @summary Reads a regular file without following its final component and refuses a moving file.
 * @param {Object} options
 * @returns {Promise<Buffer>}
 */
async function readStableFile({fileSystem, root, absolutePath}) {
    const before = await fileSystem.lstat(absolutePath);

    if (!before.isFile() || before.isSymbolicLink()) {
        throw readerError('KB_IMAGE_READER_ENTRY_UNSUPPORTED', 'Image revision entry is not a regular file');
    }

    const handle = await fileSystem.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

    try {
        const
            opened   = await handle.stat(),
            realPath = await fileSystem.realpath(absolutePath);

        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || !isWithin(root, realPath)) {
            throw readerError('KB_IMAGE_READER_PATH_OUTSIDE_ROOT', 'Image revision path escaped or changed below its root');
        }

        const
            bytes     = await handle.readFile(),
            after     = await handle.stat(),
            pathAfter = await fileSystem.lstat(absolutePath);

        if (
            !pathAfter.isFile()
            || after.ino !== opened.ino || after.dev !== opened.dev
            || pathAfter.ino !== opened.ino || pathAfter.dev !== opened.dev
            || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        ) {
            throw readerError('KB_IMAGE_READER_ENTRY_CHANGED', 'Image revision entry changed while being read');
        }

        return bytes;
    } finally {
        await handle.close();
    }
}

/**
 * @summary Reads an image-carried identity file only from an explicit physical source root.
 * @param {Object} options
 * @returns {Promise<Buffer>}
 */
async function readIdentityFile({fileSystem, root, sourcePath}) {
    const absolutePath = path.join(root, sourcePath);

    return await readStableFile({fileSystem, root, absolutePath});
}

/**
 * @summary Validates an explicit absolute directory and returns its canonical physical path.
 * @param {Object} options
 * @returns {Promise<String>}
 */
async function physicalRoot({fileSystem, root}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw readerError('KB_IMAGE_READER_ROOT_INVALID', 'Image revision root must be an explicit absolute path');
    }

    const stats = await fileSystem.lstat(root);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw readerError('KB_IMAGE_READER_ROOT_INVALID', 'Image revision root must be a physical directory');
    }

    return await fileSystem.realpath(root);
}

/**
 * @summary Normalizes caller-declared scan roots; no filesystem root is inferred from cwd.
 * @param {String[]} roots
 * @returns {String[]}
 */
function normalizeRoots(roots) {
    if (!Array.isArray(roots) || roots.length === 0) {
        throw readerError('KB_IMAGE_READER_ROOTS_INVALID', 'Image revision reader requires explicit scan roots');
    }

    const ordered = [...new Set(roots.map(root => {
        if (typeof root !== 'string' || root.includes('\0')) {
            throw readerError('KB_IMAGE_READER_ROOTS_INVALID', 'Image revision scan roots require safe POSIX paths');
        }

        return root === '.' ? '.' : normalizeRevisionSourcePath(root);
    }))].sort();

    return ordered.filter((root, index) => !ordered.slice(0, index)
        .some(parent => parent === '.' || root.startsWith(`${parent}/`)));
}

/**
 * @summary Adapts one image-carried filesystem tree to the exact-revision reader contract.
 *
 * The caller supplies the source root, revision proof, and territory roots explicitly. Listing hashes
 * ordinary files into Git blob identities; later reads recheck the same identity. Symlinks are listed
 * with mode 120000, never traversed, and the existing revision reader refuses their content. This
 * guards read/list consistency without treating a mutable local checkout as an immutable image.
 *
 * @param {Object} options
 * @param {Object} [options.fileSystem=fs] Injectable filesystem for isolated tests.
 * @param {String} options.sourceRoot Absolute package or Brain image root.
 * @param {String[]} options.roots Explicit repo-relative territories to enumerate.
 * @param {String} options.tenantId
 * @param {String} options.repoSlug
 * @param {String} options.revision Exact image/package revision.
 * @param {Function} [options.verifyRevision] Re-attest a checkout after its initial file listing.
 * @returns {Promise<Object>}
 */
export async function createImageRevisionReader({
    fileSystem = fs,
    sourceRoot,
    roots,
    tenantId,
    repoSlug,
    revision,
    verifyRevision
} = {}) {
    const
        root          = await physicalRoot({fileSystem, root: sourceRoot}),
        scanRoots     = normalizeRoots(roots),
        entriesByPath = new Map();

    let listingPromise;

    /**
     * @summary Walks a declared territory without following symlinks.
     * @param {String} sourcePath
     * @returns {Promise<void>}
     */
    const walk = async sourcePath => {
        const
            absolutePath = sourcePath === '.' ? root : path.join(root, sourcePath),
            stats        = await fileSystem.lstat(absolutePath);

        if (stats.isDirectory()) {
            const realPath = await fileSystem.realpath(absolutePath);

            if (!isWithin(root, realPath)) {
                throw readerError('KB_IMAGE_READER_PATH_OUTSIDE_ROOT', 'Image revision directory escaped its root');
            }

            const children = (await fileSystem.readdir(absolutePath)).sort();

            for (const name of children) {
                const child = sourcePath === '.' ? name : `${sourcePath}/${name}`;

                await walk(normalizeRevisionSourcePath(child));
            }

            return;
        }

        const normalized = normalizeRevisionSourcePath(sourcePath);
        let content;
        let mode;

        if (stats.isSymbolicLink()) {
            content = Buffer.from(await fileSystem.readlink(absolutePath, {encoding: 'buffer'}));
            mode = '120000';
        } else if (stats.isFile()) {
            content = await readStableFile({fileSystem, root, absolutePath});
            mode = (await fileSystem.lstat(absolutePath)).mode & 0o111 ? '100755' : '100644';
        } else {
            throw readerError('KB_IMAGE_READER_ENTRY_UNSUPPORTED', 'Image revision has a non-file entry');
        }

        entriesByPath.set(normalized, Object.freeze({
            sourcePath: normalized,
            mode,
            type      : 'blob',
            oid       : blobOid(content)
        }));
    };

    /**
     * @summary Captures one lexical, mode-bearing entry universe for subsequent reads.
     * @returns {Promise<Object[]>}
     */
    const list = async () => {
        listingPromise ??= (async () => {
            for (const scanRoot of scanRoots) {
                await walk(scanRoot);
            }

            await verifyRevision?.();

            return [...entriesByPath.values()].sort((left, right) => left.sourcePath === right.sourcePath
                ? 0
                : left.sourcePath < right.sourcePath ? -1 : 1);
        })();

        return await listingPromise;
    };

    const adapter = {
        /**
         * @summary Lists only entries physically captured from the declared image territories.
         * @returns {Promise<Object[]>}
         */
        async listRevisionEntries() {
            return await list();
        },

        /**
         * @summary Reads a listed regular file and rejects byte or mode drift since listing.
         * @param {Object} options
         * @returns {Promise<Buffer>}
         */
        async readRevisionBlob({sourcePath} = {}) {
            if (typeof sourcePath !== 'string' || sourcePath.includes('\0')) {
                throw readerError('KB_IMAGE_READER_PATH_INVALID', 'Image revision path requires a safe POSIX name');
            }

            const
                normalized = normalizeRevisionSourcePath(sourcePath),
                entry      = (await list(), entriesByPath.get(normalized));

            if (!entry || !/^(?:100644|100755)$/u.test(entry.mode)) {
                throw readerError('KB_IMAGE_READER_ENTRY_UNSUPPORTED', 'Image revision path is absent or not regular');
            }

            const
                absolutePath = path.join(root, normalized),
                bytes        = await readStableFile({fileSystem, root, absolutePath}),
                stats        = await fileSystem.lstat(absolutePath),
                currentMode  = stats.mode & 0o111 ? '100755' : '100644';

            if (currentMode !== entry.mode || blobOid(bytes) !== entry.oid) {
                throw readerError('KB_IMAGE_READER_ENTRY_CHANGED', 'Image revision entry differs from its listed identity');
            }

            return bytes;
        },

        /**
         * @summary Confirms that requested blobs are already local to the bound image.
         * @param {Object} options
         * @returns {Promise<Object>}
         */
        async prefetchRevisionBlobs({sourcePaths = []} = {}) {
            return {status: 'already-local', requested: sourcePaths.length};
        }
    };

    return createRepositoryRevisionReader({
        gitMirror : adapter,
        mirrorRoot: root,
        tenantId,
        repoSlug,
        revision
    });
}

/**
 * @summary Binds the installed Engine package to all three Brain manifest/lock SHA carriers.
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function createInstalledEngineRevisionReader({
    fileSystem = fs,
    brainRoot,
    engineRoot,
    roots,
    tenantId,
    repoSlug = 'neo'
} = {}) {
    const
        brain          = await physicalRoot({fileSystem, root: brainRoot}),
        expectedEngine = path.join(brain, 'node_modules', 'neo.mjs'),
        engine         = await physicalRoot({fileSystem, root: engineRoot || expectedEngine});

    if (engine !== expectedEngine) {
        throw readerError('KB_IMAGE_READER_ENGINE_ROOT_INVALID', 'Engine package must be Brain image node_modules/neo.mjs');
    }

    const
        manifest        = JSON.parse((await readIdentityFile({fileSystem, root: brain, sourcePath: 'package.json'})).toString('utf8')),
        lock            = JSON.parse((await readIdentityFile({fileSystem, root: brain, sourcePath: 'package-lock.json'})).toString('utf8')),
        packageManifest = JSON.parse((await readIdentityFile({fileSystem, root: engine, sourcePath: 'package.json'})).toString('utf8')),
        manifestPin     = manifest.dependencies?.['neo.mjs'] || manifest.devDependencies?.['neo.mjs'],
        lockRootPin     = lock.packages?.['']?.dependencies?.['neo.mjs']
            || lock.packages?.['']?.devDependencies?.['neo.mjs'],
        lockedPackage = lock.packages?.['node_modules/neo.mjs'],
        lockedPin = lockedPackage?.resolved,
        match = typeof manifestPin === 'string' && manifestPin.match(ENGINE_PIN_PATTERN);

    if (
        manifest.name !== 'neo-agent-brain'
        || !match || lockRootPin !== manifestPin || lockedPin !== manifestPin
        || typeof lockedPackage?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockedPackage.integrity)
        || packageManifest.name !== 'neo.mjs' || packageManifest.version !== lockedPackage.version
    ) {
        throw readerError('KB_IMAGE_READER_ENGINE_IDENTITY_INVALID', 'Installed Engine package is not bound to one manifest/lock SHA pin');
    }

    return await createImageRevisionReader({
        fileSystem,
        sourceRoot: engine,
        roots,
        tenantId,
        repoSlug,
        revision  : match[1]
    });
}

/**
 * @summary Binds the Brain tree to its image stamp or an attested clean checkout revision.
 *
 * An unstamped checkout resolves HEAD from its explicit root and checks cleanliness before and
 * after listing. A supplied revision is an additional assertion, never the source of truth.
 * A stamped image uses the revision written when the image source was built.
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function createBrainImageRevisionReader({
    fileSystem = fs,
    brainRoot,
    roots,
    tenantId,
    repoSlug = 'neo-agent-brain',
    revision
} = {}) {
    const brain = await physicalRoot({fileSystem, root: brainRoot});
    let stampedRevision;

    try {
        stampedRevision = (await readIdentityFile({fileSystem, root: brain, sourcePath: '.neo-revision'}))
            .toString('utf8').trim();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    const checkoutRevision = stampedRevision ? null : resolveCleanBrainCheckoutRevision({root: brain});
    const resolvedRevision = stampedRevision || checkoutRevision;

    if (
        !SHA_PATTERN.test(resolvedRevision || '')
        || (revision && revision !== resolvedRevision)
    ) {
        throw readerError('KB_IMAGE_READER_BRAIN_IDENTITY_INVALID', 'Brain tree requires one exact image or checkout revision');
    }

    const packageManifest = JSON.parse((await readIdentityFile({
        fileSystem,
        root      : brain,
        sourcePath: 'package.json'
    })).toString('utf8'));

    if (packageManifest.name !== 'neo-agent-brain') {
        throw readerError('KB_IMAGE_READER_BRAIN_IDENTITY_INVALID', 'Brain root is not the neo-agent-brain package');
    }

    /** @summary Re-attests a checkout after the reader captures its file universe. */
    const verifyCheckout = stampedRevision ? null : () => {
        if (resolveCleanBrainCheckoutRevision({root: brain}) !== checkoutRevision) {
            throw readerError('KB_IMAGE_READER_BRAIN_IDENTITY_INVALID', 'Brain checkout revision differs from its declared revision');
        }
    };

    verifyCheckout?.();

    return await createImageRevisionReader({
        fileSystem,
        sourceRoot    : brain,
        roots,
        tenantId,
        repoSlug,
        revision      : resolvedRevision,
        verifyRevision: verifyCheckout
    });
}

export default createImageRevisionReader;
