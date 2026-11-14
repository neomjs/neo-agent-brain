import {execFileSync} from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';

/**
 * @summary Executes a git subcommand safely with bounded timeout and silent stderr.
 * @param {String[]} args Git CLI arguments.
 * @returns {String|null} Trimmed stdout or null on failure.
 */
function defaultExecGit(args) {
    try {
        const out = execFileSync('git', args, {
            encoding: 'utf8',
            stdio   : ['ignore', 'pipe', 'ignore'],
            timeout : 3000
        });
        return typeof out === 'string' ? out.trim() : null;
    } catch {
        return null;
    }
}

/**
 * @summary Resolves realpath when target or an ancestor exists without throwing on missing leaves.
 * @param {String} targetPath Path to normalize.
 * @returns {String} Normalized absolute path.
 */
function safeRealpath(targetPath) {
    let   current = path.resolve(targetPath);
    const tail    = [];

    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...tail);
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
                return path.resolve(targetPath);
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return path.resolve(targetPath);
            }
            tail.unshift(path.basename(current));
            current = parent;
        }
    }
}

/**
 * @summary Expands a leading tilde segment against the user's home directory.
 * @param {String} rawPath Input path string.
 * @param {String} [homedir=os.homedir()] Home directory root.
 * @returns {String} Expanded path string.
 */
function expandHome(rawPath, homedir = os.homedir()) {
    if (rawPath === '~') {
        return homedir;
    }
    if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
        return path.join(homedir, rawPath.slice(2));
    }
    return rawPath;
}

/**
 * @summary Checks whether an explicit workspace value represents a filesystem path rather than an opaque slug.
 * @param {String} value Trimmed workspace argument.
 * @returns {Boolean} True when value should be resolved as a directory path.
 */
function isFilesystemPathInput(value) {
    return (
        value === '.' ||
        value === '..' ||
        value === '~' ||
        value.startsWith('/') ||
        value.startsWith('./') ||
        value.startsWith('../') ||
        value.startsWith('~/') ||
        value.startsWith('.\\') ||
        value.startsWith('..\\') ||
        value.startsWith('~\\') ||
        value.startsWith('\\\\') ||
        /^[A-Za-z]:[\\/]/.test(value)
    );
}

/**
 * @summary Cleans a repository path segment by stripping slashes and trailing `.git`.
 * @param {String} rawRepoPath Raw URL pathname or SCP path segment.
 * @returns {String|null} Lowercased `<owner>/<repo>` path or null when empty.
 */
function cleanRepoPath(rawRepoPath) {
    const cleaned = rawRepoPath
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/i, '')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/+/g, '/')
        .toLowerCase();

    return cleaned.length > 0 ? cleaned : null;
}

/**
 * @summary Normalizes SSH and HTTPS git remote URLs identically to `<lowercase-host>/<owner>/<repo>`.
 * @param {String} rawUrl Raw `git remote get-url origin` string.
 * @returns {String|null} Canonical workspace key or null when unparseable.
 */
export function normalizeGitRemoteOrigin(rawUrl) {
    if (typeof rawUrl !== 'string') {
        return null;
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return null;
    }

    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
        try {
            const normalizedScheme = trimmed.replace(/^git\+/i, '');
            const parsed           = new URL(normalizedScheme);
            const host             = parsed.hostname.toLowerCase();
            if (!host) {
                return null;
            }
            const standardPorts = new Set(['', '22', '80', '443', '9418']);
            const hostWithPort  = standardPorts.has(parsed.port) ? host : `${host}:${parsed.port}`;
            const repoPath      = cleanRepoPath(decodeURIComponent(parsed.pathname));

            return repoPath ? `${hostWithPort}/${repoPath}` : null;
        } catch {
            return null;
        }
    }

    if (!/^[A-Za-z]:[\\/]/.test(trimmed)) {
        const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(.+)$/);
        if (scpMatch) {
            const host     = scpMatch[1].toLowerCase();
            const repoPath = cleanRepoPath(scpMatch[2]);

            if (host && repoPath) {
                return `${host}/${repoPath}`;
            }
        }
    }

    return null;
}

/**
 * @summary Resolves the standalone workspace key via `explicit-slug -> git-remote -> git-toplevel -> cwd`.
 * @param {Object} [options={}] Resolution inputs.
 * @param {String} [options.explicitWorkspace] Explicit `--workspace` or `NEO_MC_WORKSPACE` value.
 * @param {String} [options.cwd=process.cwd()] Working directory fallback.
 * @param {Function} [options.execGit=defaultExecGit] Injectable git runner receiving an args array.
 * @param {String} [options.homedir=os.homedir()] Home directory used when expanding `~` paths.
 * @returns {{workspace: String, workspaceSource: ('explicit-slug'|'git-remote'|'git-toplevel'|'cwd')}}
 */
export function resolveStandaloneWorkspaceKey({
    explicitWorkspace,
    cwd     = process.cwd(),
    execGit = defaultExecGit,
    homedir = os.homedir()
} = {}) {
    let targetDir = path.resolve(cwd);

    if (typeof explicitWorkspace === 'string' && explicitWorkspace.trim().length > 0) {
        const trimmed = explicitWorkspace.trim();
        if (!isFilesystemPathInput(trimmed)) {
            return {
                workspace      : trimmed,
                workspaceSource: 'explicit-slug'
            };
        }
        targetDir = path.resolve(cwd, expandHome(trimmed, homedir));
    }

    const remoteUrl = execGit(['-C', targetDir, 'remote', 'get-url', 'origin']);
    if (typeof remoteUrl === 'string' && remoteUrl.trim().length > 0) {
        const normalizedRemote = normalizeGitRemoteOrigin(remoteUrl);
        if (normalizedRemote) {
            return {
                workspace      : normalizedRemote,
                workspaceSource: 'git-remote'
            };
        }
    }

    const gitTopLevel = execGit(['-C', targetDir, 'rev-parse', '--show-toplevel']);
    if (typeof gitTopLevel === 'string' && gitTopLevel.trim().length > 0) {
        const resolvedTop = path.resolve(targetDir, gitTopLevel.trim());
        return {
            workspace      : safeRealpath(resolvedTop),
            workspaceSource: 'git-toplevel'
        };
    }

    return {
        workspace      : safeRealpath(targetDir),
        workspaceSource: 'cwd'
    };
}
