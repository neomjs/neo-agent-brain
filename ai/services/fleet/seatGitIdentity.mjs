import {execFile}  from 'node:child_process';
import fs          from 'node:fs/promises';
import path        from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The four variables through which an environment names a commit's author and committer. Git reads them before any
 * config file, so a launch env that carries them decides the identity of every commit its processes make.
 * @type {String[]}
 */
export const GIT_IDENTITY_ENV = Object.freeze(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);

/**
 * The config keys beside `user.name` and `user.email` under which the Fleet records what it wrote. A checkout whose
 * values still equal the record holds the Fleet's own write; a value that differs was set or edited by someone else.
 * @type {{name: String, email: String}}
 * @private
 */
const RECORD = Object.freeze({name: 'neo-fleet.writtenName', email: 'neo-fleet.writtenEmail'});

/**
 * What git drops from either end of an identity: whitespace, control characters and `,:;<>"\'`.
 * @type {RegExp}
 * @private
 */
const GIT_CRUD_ENDS = /^[\x00-\x20,:;<>"\\']+|[\x00-\x20,:;<>"\\']+$/g;

/**
 * One address: a local part and a dotted domain, holding nothing git would drop or read as a delimiter.
 * @type {RegExp}
 * @private
 */
const COMMIT_EMAIL = /^[^\x00-\x20\x7f@<>"'\\,:;]+@[^\x00-\x20\x7f@<>"'\\,:;.]+(?:\.[^\x00-\x20\x7f@<>"'\\,:;.]+)+$/;

/**
 * The API origin a GitHub seat's PAT is presented to.
 * @type {String}
 * @private
 */
const GITHUB_API = 'https://api.github.com';

/**
 * @summary A name as git records it: without `<`, `>` or line breaks, and without what git drops at either end.
 * @param {String} name
 * @returns {String}
 * @private
 */
function gitRecordedName(name) {
    return String(name).replace(/[\n<>]/g, '').replace(GIT_CRUD_ENDS, '')
}

/**
 * @summary Whether a value is one address a commit carries unchanged.
 * @param {*} email
 * @returns {Boolean}
 * @private
 */
function isCommitEmail(email) {
    return typeof email === 'string' && email.length <= 254 && COMMIT_EMAIL.test(email)
}

/**
 * @summary Validates the identity an operator declares for a seat's commits, which wins over the one its forge
 * account offers. Both fields are given, or neither is. A provider-issued privacy address, such as GitHub's `noreply`
 * one, is declared like any other address.
 * @param {Object}      [declaration={}]
 * @param {String|null} [declaration.gitName]  The name the seat's commits carry.
 * @param {String|null} [declaration.gitEmail] The email the seat's commits carry.
 * @returns {{gitName: String, gitEmail: String}|null} The declaration, or `null` when neither field is given.
 * @throws {TypeError} On half a pair, a name git would record differently, or a value that is not one address.
 */
export function normalizeGitIdentityDeclaration({gitName = null, gitEmail = null} = {}) {
    if (gitName === null && gitEmail === null) return null;

    if (gitName === null || gitEmail === null) {
        throw new TypeError("'gitName' and 'gitEmail' are declared together, or neither is.")
    }

    if (typeof gitName !== 'string' || !gitName || gitName.length > 256 || gitRecordedName(gitName) !== gitName) {
        throw new TypeError("'gitName' must be a name git records unchanged: no '<', '>' or line break, and no whitespace or any of ,:;\"\\' at either end.")
    }

    if (!isCommitEmail(gitEmail)) {
        throw new TypeError("'gitEmail' must be one address, such as 'name@example.com'.")
    }

    return {gitName, gitEmail}
}

/**
 * @summary The launch env values that make a process commit as the seat, as author and as committer.
 * @param {Object} identity
 * @param {String} identity.name
 * @param {String} identity.email
 * @returns {Object} The four {@link GIT_IDENTITY_ENV} values.
 */
export function gitIdentityEnv({name, email}) {
    return {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email}
}

/**
 * @summary Reads one JSON resource, bounded by a timeout.
 * @param {Function} fetchFn
 * @param {String}   url
 * @param {Object}   headers
 * @param {Number}   timeoutMs
 * @returns {Promise<*>} The parsed body.
 * @throws {Error} Carrying the response's `status` when it is not a success, or the transport's own error.
 * @private
 */
async function readJson(fetchFn, url, headers, timeoutMs) {
    const response = await fetchFn(url, {headers, signal: AbortSignal.timeout(timeoutMs)});

    if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), {status: response.status})
    }

    return response.json()
}

/**
 * @summary A GitHub account's name, login and candidate addresses, best first: the verified primary when the PAT can
 * already list the account's addresses and the account shows that address publicly, then the public one. A primary
 * marked private, or unlabelled, is skipped: a verified address is not consent to publish it in commits. Listing
 * addresses needs a permission the PAT may lack, so a refusal there (403, 404) only drops that candidate and says
 * nothing about the PAT. Any other failure fails the read, so a passing outage cannot switch the seat to its other
 * address.
 * @param {Object}   options
 * @param {String}   options.credential
 * @param {Function} options.fetchFn
 * @param {Number}   options.timeoutMs
 * @param {Boolean}  [options.addresses=true] Whether to list the account's addresses; without them only the public
 *                                            one is a candidate.
 * @returns {Promise<{login: String, name: String|null, candidates: Object[]}>}
 * @private
 */
async function readGithubAccount({credential, fetchFn, timeoutMs, addresses = true}) {
    const
        headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`, 'X-GitHub-Api-Version': '2022-11-28'},
        user    = await readJson(fetchFn, `${GITHUB_API}/user`, headers, timeoutMs);

    let emails = [];

    try {
        if (addresses) emails = await readJson(fetchFn, `${GITHUB_API}/user/emails?per_page=100`, headers, timeoutMs)
    } catch (error) {
        if (error.status !== 403 && error.status !== 404) throw error
    }

    const primary = Array.isArray(emails)
        ? emails.find(entry => entry?.primary === true && entry.verified === true && entry.visibility === 'public')
        : null;

    return {
        login     : user.login,
        name      : user.name,
        candidates: [{email: primary?.email, source: 'verified-primary'}, {email: user.email, source: 'public'}]
    }
}

/**
 * @summary A GitLab account's name, login and candidate addresses, read at the seat's own instance: the address the
 * account chose for commits, which may be the instance's own privacy address, then the public one. The primary is
 * never a candidate, since the account says nothing about publishing it.
 * @param {Object}   options
 * @param {String}   options.forgeHost The instance's origin, as the seat's definition records it.
 * @param {String}   options.credential
 * @param {Function} options.fetchFn
 * @param {Number}   options.timeoutMs
 * @returns {Promise<{login: String, name: String|null, candidates: Object[]}>}
 * @private
 */
async function readGitlabAccount({forgeHost, credential, fetchFn, timeoutMs}) {
    const user = await readJson(fetchFn, `${forgeHost}/api/v4/user`, {Authorization: `Bearer ${credential}`}, timeoutMs);

    return {
        login     : user.username,
        name      : user.name,
        candidates: [{email: user.commit_email, source: 'commit-email'}, {email: user.public_email, source: 'public'}]
    }
}

/**
 * @summary The forge account a PAT answers for, read at the origin that PAT belongs to and held against the seat's own
 * login (`githubUsername`, compared as the forge does, without case).
 * @param {Object}   options
 * @param {Object}   options.agent
 * @param {String}   options.credential
 * @param {Function} options.fetchFn
 * @param {Number}   options.timeoutMs
 * @param {Boolean}  options.addresses Whether the account's addresses are needed.
 * @returns {Promise<Object>} `{state: 'own', account}`, `{state: 'mismatch', found, reason}`, or
 *     `{state: 'unknown', reason}`.
 * @private
 */
async function readSeatAccount({agent, credential, fetchFn, timeoutMs, addresses}) {
    let account;

    try {
        account = agent?.forge === 'gitlab'
            ? await readGitlabAccount({forgeHost: agent.forgeHost, credential, fetchFn, timeoutMs})
            : await readGithubAccount({credential, fetchFn, timeoutMs, addresses})
    } catch (error) {
        return {state: 'unknown', reason: `its forge account could not be read (${error.message})`}
    }

    const
        seatLogin = typeof agent?.githubUsername === 'string' ? agent.githubUsername.trim().replace(/^@/, '') : '',
        readLogin = typeof account.login === 'string' ? account.login : '';

    if (!seatLogin || readLogin.toLowerCase() !== seatLogin.toLowerCase()) {
        return {
            state : 'mismatch',
            found : readLogin || null,
            reason: `its PAT belongs to the forge account '${readLogin || '(unnamed)'}', not to the seat's '${seatLogin || '(none)'}'`
        }
    }

    return {state: 'own', account}
}

/**
 * @summary Proves that a PAT is the seat's own: its forge account is read, whatever Git identity the definition
 * declares, because a declaration names the commits' author and says nothing about whose PAT this is.
 * @param {Object}   options
 * @param {Object}   options.agent                 The seat's definition: `githubUsername`, `forge`, and `forgeHost`
 *                                                 for a GitLab seat.
 * @param {String}   options.credential            The PAT to prove.
 * @param {Function} [options.fetchFn=globalThis.fetch]
 * @param {Number}   [options.timeoutMs=10000]     Per request.
 * @returns {Promise<Object>} `{ok: true}`, or `{ok: false, reason: 'mismatch' | 'unknown'}`: another account's PAT, or
 *     an account that could not be read.
 */
export async function proveSeatForgeAccount({agent, credential, fetchFn = globalThis.fetch, timeoutMs = 10000}) {
    const read = await readSeatAccount({agent, credential, fetchFn, timeoutMs, addresses: false});

    return read.state === 'own' ? {ok: true} : {ok: false, reason: read.state}
}

/**
 * @summary The identity a seat's commits carry, and where it comes from.
 *
 * A declaration on the definition wins and needs no forge read. Otherwise the seat's own forge account is read with
 * the PAT the seat already holds, at the origin that PAT belongs to (GitHub's API, or a GitLab seat's `forgeHost`).
 * The account must be the seat's own: a PAT that answers for another login (`githubUsername`, compared as the forge
 * does, without case) resolves as `mismatch`, because a successful read proves only who holds the PAT.
 * The name is the account's name, else its login, as git records it. The email is the first address the account has
 * published or chosen for commits that a commit can carry. An address is never made up: an account that offers none
 * resolves as `missing`, and one that cannot be read as `unknown`, each with the reason.
 *
 * @param {Object}   options
 * @param {Object}   options.agent                        The seat's definition: `githubUsername` (the seat's forge
 *                                                        login), `gitName` and `gitEmail` when declared, `forge`, and
 *                                                        `forgeHost` for a GitLab seat.
 * @param {String}   options.credential                   The seat's PAT.
 * @param {Function} [options.fetchFn=globalThis.fetch]
 * @param {Number}   [options.timeoutMs=10000]            Per request.
 * @returns {Promise<Object>} `{state: 'declared', source: 'declared', name, email}`,
 *     `{state: 'derived', source: 'verified-primary' | 'commit-email' | 'public', name, email}`,
 *     `{state: 'missing', reason, name?}`, `{state: 'mismatch', found, reason}` for another account's PAT, or
 *     `{state: 'unknown', reason}`.
 */
export async function resolveSeatGitIdentity({agent, credential, fetchFn = globalThis.fetch, timeoutMs = 10000}) {
    if (agent?.gitName && agent?.gitEmail) {
        return {state: 'declared', source: 'declared', name: agent.gitName, email: agent.gitEmail}
    }

    const read = await readSeatAccount({agent, credential, fetchFn, timeoutMs, addresses: true});

    if (read.state !== 'own') return read;

    const
        {account} = read,
        name      = gitRecordedName(account.name ?? '') || gitRecordedName(account.login ?? ''),
        chosen    = account.candidates.find(candidate => isCommitEmail(candidate.email));

    if (!name) {
        return {state: 'missing', reason: 'its forge account names neither a name nor a login'}
    }

    if (!chosen) {
        return {state: 'missing', name, reason: 'its forge account offers no email this PAT can read'}
    }

    return {state: 'derived', source: chosen.source, name, email: chosen.email}
}

/**
 * @summary An environment without any `GIT_*` override, so git answers from the checkout's config files alone.
 * @param {Object} env
 * @returns {Object}
 * @private
 */
function withoutGitOverrides(env) {
    return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')))
}

/**
 * @summary Brings one managed checkout's Git identity to the seat's without overwriting anyone else's, then reads
 * back what git records there.
 *
 * The identity lives in the checkout's own config scope: `local` for a clone, `worktree` for a linked worktree, whose
 * repository config other worktrees share. The global config and other worktrees' configs are never written. In that
 * scope:
 * - no identity: the Fleet writes the seat's and records what it wrote (`written`);
 * - the seat's identity, whoever set it: kept as it is (`kept`);
 * - the Fleet's own write, unchanged since: replaced by the seat's current identity (`updated`);
 * - anything else (an identity the Fleet did not write, half of one, or a Fleet write edited since): left untouched,
 *   `mismatch`.
 *
 * Then `git var` reads the author and the committer twice: with the seat's launch env, and without any `GIT_*`
 * override, because launch variables can mask a wrong config underneath. Both must be the seat's. These probes
 * prepare a start; only a commit from the seat's session proves it commits as itself.
 *
 * @param {Object} options
 * @param {String} options.repoPath          The managed checkout.
 * @param {Object} options.identity          `{name, email}` the seat commits as.
 * @param {Object} [options.env=process.env] The environment the probes start from.
 * @returns {Promise<Object>} `{state: 'converged', scope, action: 'written' | 'kept' | 'updated'}`, or
 *     `{state: 'mismatch', scope, found, reason}`, where `found` is the identity the checkout holds or git records.
 */
export async function convergeSeatGitIdentity({repoPath, identity, env = process.env}) {
    const
        baseEnv = withoutGitOverrides(env),
        git     = async (args, runEnv = baseEnv) => (await execFileAsync('git', args, {cwd: repoPath, env: runEnv, timeout: 10000})).stdout.trim(),
        read    = async args => {
            try {
                return await git(args)
            } catch (error) {
                // `git config --get` exits 1 for a key that is not set
                if (error.code === 1) return null;
                throw error
            }
        };

    const
        dirs     = await Promise.all([git(['rev-parse', '--absolute-git-dir']), git(['rev-parse', '--git-common-dir'])]),
        [gitDir, commonDir] = await Promise.all(dirs.map(dir => fs.realpath(path.resolve(repoPath, dir)))),
        scope    = gitDir === commonDir ? 'local' : 'worktree',
        // a linked worktree has a scope of its own only once the repository enables per-worktree config
        readable = scope === 'local' || await read(['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig']) === 'true',
        own      = async key => readable ? read(['config', `--${scope}`, '--get', key]) : null,
        current  = {name: await own('user.name'), email: await own('user.email')},
        record   = {name: await own(RECORD.name), email: await own(RECORD.email)},
        expected = `${identity.name} <${identity.email}>`,
        held     = `${current.name ?? '(no name)'} <${current.email ?? '(no email)'}>`,
        empty    = current.name === null && current.email === null,
        written  = record.name !== null && record.email !== null,
        // the Fleet's own only while BOTH values still equal its record: a key unset since is an edit, not a write
        // that was cut short, and an edit is never undone
        fleets   = written && current.name === record.name && current.email === record.email;

    let action = 'kept';

    if (current.name !== identity.name || current.email !== identity.email) {
        if (!empty && !fleets) {
            const unset  = current.name === null ? 'user.name' : 'user.email',
                  reason = current.name === null || current.email === null
                ? written
                    ? `has no ${unset} since the Fleet wrote '${record.name} <${record.email}>'`
                    : `sets only ${current.name === null ? 'user.email' : 'user.name'} in its ${scope} config`
                : written
                    ? `holds '${held}', changed after the Fleet wrote '${record.name} <${record.email}>'`
                    : `holds '${held}' in its ${scope} config, which the Fleet did not write`;

            return {state: 'mismatch', scope, found: held, reason}
        }

        action = empty ? 'written' : 'updated';

        if (!readable) await git(['config', '--local', 'extensions.worktreeConfig', 'true']);

        // the record first: a write cut short leaves values the record still claims, never values it disowns
        for (const [key, value] of [[RECORD.name, identity.name], [RECORD.email, identity.email], ['user.name', identity.name], ['user.email', identity.email]]) {
            await git(['config', `--${scope}`, key, value])
        }
    }

    for (const [probeEnv, setting] of [[{...baseEnv, ...gitIdentityEnv(identity)}, 'with the launch env'], [baseEnv, 'without GIT_* overrides']]) {
        for (const [variable, role] of [['GIT_AUTHOR_IDENT', 'author'], ['GIT_COMMITTER_IDENT', 'committer']]) {
            let ident = null;

            try {
                ident = (await git(['var', variable], probeEnv)).replace(/ \d+ [+-]\d{4}$/, '')
            } catch {}

            if (ident !== expected) {
                const reason = ident === null
                    ? `leaves git without an identity for the ${role} ${setting}`
                    : `makes git record '${ident}' as the ${role} ${setting}`;

                return {state: 'mismatch', scope, found: ident, reason}
            }
        }
    }

    return {state: 'converged', scope, action}
}
