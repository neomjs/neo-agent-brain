import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    convergeSeatGitIdentity,
    gitIdentityEnv,
    normalizeGitIdentityDeclaration,
    proveSeatForgeAccount,
    resolveSeatGitIdentity
} from '../../../../../../ai/services/fleet/seatGitIdentity.mjs';

// Real git in temp directories, offline. Every git call runs under a temp HOME whose global config names an
// operator: the identity a seat's clone answers with until the Fleet gives it its own.

const
    SEAT     = {name: 'Seat Agent', email: 'seat@example.test'},
    RENAMED  = {name: 'Seat Agent Two', email: 'seat-two@example.test'},
    OPERATOR = 'Operator <operator@example.test>',
    SEAT_ID  = 'Seat Agent <seat@example.test>';

/**
 * A temp root holding the operator's HOME and one fresh repository.
 * @returns {{root: String, env: Object, repo: String}}
 */
function fixture() {
    const
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-seat-git-identity-')),
        home = path.join(root, 'home'),
        repo = path.join(root, 'repo'),
        env  = {PATH: process.env.PATH, HOME: home};

    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Operator\n\temail = operator@example.test\n');
    git(root, env, '-c', 'init.defaultBranch=main', 'init', '-q', repo);

    return {root, env, repo}
}

function git(cwd, env, ...args) {
    return execFileSync('git', args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
}

/** The checkout's own value for a key, or `null` when unset. */
function configOf(cwd, env, scope, key) {
    try {
        return git(cwd, env, 'config', `--${scope}`, '--get', key)
    } catch {
        return null
    }
}

/** Commits from `cwd` under `env` and answers `author|committer` as git recorded them. */
function commitAs(cwd, env) {
    git(cwd, env, 'commit', '-q', '--allow-empty', '-m', 'probe');

    return git(cwd, env, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')
}

/**
 * A fixture forge: answers the routes it names, 404 elsewhere, and records every request's URL and credential.
 * @param {Object} routes `{[url]: {status?, body}}`
 */
function forge(routes) {
    const calls = [];

    return {
        calls,
        fetchFn: async (url, init) => {
            calls.push({url, authorization: init?.headers?.Authorization});

            const route = routes[url];

            return route
                ? {ok: (route.status ?? 200) < 300, status: route.status ?? 200, json: async () => route.body}
                : {ok: false, status: 404, json: async () => ({message: 'Not Found'})}
        }
    }
}

const
    GITHUB_USER   = 'https://api.github.com/user',
    GITHUB_EMAILS = 'https://api.github.com/user/emails?per_page=100',
    GITHUB_SEAT   = {id: 'seat', githubUsername: 'seat-agent'};

test.describe('normalizeGitIdentityDeclaration', () => {
    test('takes both fields or neither', () => {
        expect(normalizeGitIdentityDeclaration({gitName: 'Seat Agent', gitEmail: 'seat@example.test'}))
            .toEqual({gitName: 'Seat Agent', gitEmail: 'seat@example.test'});
        expect(normalizeGitIdentityDeclaration({})).toBeNull();
        expect(normalizeGitIdentityDeclaration({gitName: null, gitEmail: null})).toBeNull();
    });

    test('refuses half a pair', () => {
        expect(() => normalizeGitIdentityDeclaration({gitName: 'Seat Agent'})).toThrow(/declared together/);
        expect(() => normalizeGitIdentityDeclaration({gitEmail: 'seat@example.test'})).toThrow(/declared together/);
    });

    test('refuses a name git would record differently', () => {
        for (const gitName of ['Seat <Agent>', ' Seat', 'Seat,', 'Seat\nAgent', '']) {
            expect(() => normalizeGitIdentityDeclaration({gitName, gitEmail: 'seat@example.test'}), gitName).toThrow(/'gitName'/)
        }
    });

    test('refuses what is not one address', () => {
        for (const gitEmail of ['seat', 'seat@', '@example.test', 'seat agent@example.test', 'seat@example', 'Seat <seat@example.test>', 42]) {
            expect(() => normalizeGitIdentityDeclaration({gitName: 'Seat Agent', gitEmail}), String(gitEmail)).toThrow(/'gitEmail'/)
        }
    });

    test('takes a provider-issued privacy address as declared', () => {
        expect(normalizeGitIdentityDeclaration({gitName: 'Seat Agent', gitEmail: '12345+seat-agent@users.noreply.github.com'}).gitEmail)
            .toBe('12345+seat-agent@users.noreply.github.com');
    });
});

test.describe('resolveSeatGitIdentity', () => {
    test('a declaration wins and reads no forge', async () => {
        const {calls, fetchFn} = forge({});

        expect(await resolveSeatGitIdentity({agent: {...GITHUB_SEAT, gitName: 'Declared', gitEmail: 'declared@example.test'}, credential: 'ghp_seat', fetchFn}))
            .toEqual({state: 'declared', source: 'declared', name: 'Declared', email: 'declared@example.test'});
        expect(calls).toEqual([]);
    });

    test('GitHub: the verified primary, read with the seat\'s PAT from GitHub\'s API only', async () => {
        const {calls, fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: 'public@example.test'}},
            [GITHUB_EMAILS]: {body: [
                {email: 'unverified@example.test', primary: false, verified: false},
                {email: 'primary@example.test', primary: true, verified: true, visibility: 'public'}
            ]}
        });

        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn}))
            .toEqual({state: 'derived', source: 'verified-primary', name: 'Seat Agent', email: 'primary@example.test'});
        expect(calls).toEqual([
            {url: GITHUB_USER, authorization: 'Bearer ghp_seat'},
            {url: GITHUB_EMAILS, authorization: 'Bearer ghp_seat'}
        ]);
    });

    test('the name falls back to the login, as git records it', async () => {
        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'seat-agent', name: null, email: null}},
            [GITHUB_EMAILS]: {body: [{email: 'primary@example.test', primary: true, verified: true, visibility: 'public'}]}
        });

        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn}))
            .toEqual({state: 'derived', source: 'verified-primary', name: 'seat-agent', email: 'primary@example.test'});
    });

    test('a GitHub primary marked private, or unlabelled, is skipped: a verified address is not consent to publish it', async () => {
        for (const visibility of ['private', undefined, null]) {
            const {fetchFn} = forge({
                [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: 'public@example.test'}},
                [GITHUB_EMAILS]: {body: [{email: 'primary@example.test', primary: true, verified: true, visibility}]}
            });

            expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn}), String(visibility))
                .toEqual({state: 'derived', source: 'public', name: 'Seat Agent', email: 'public@example.test'});
        }

        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: null}},
            [GITHUB_EMAILS]: {body: [{email: 'primary@example.test', primary: true, verified: true, visibility: 'private'}]}
        });

        expect((await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn})).state).toBe('missing');
    });

    test('a PAT that may not list addresses (403 or 404) falls back to the public email and still resolves', async () => {
        for (const status of [403, 404]) {
            const {fetchFn} = forge({
                [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: 'public@example.test'}},
                [GITHUB_EMAILS]: {status, body: {message: 'Resource not accessible'}}
            });

            expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn}), String(status))
                .toEqual({state: 'derived', source: 'public', name: 'Seat Agent', email: 'public@example.test'});
        }
    });

    test('another failure of the address list fails the read, so an outage never switches the address', async () => {
        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: 'public@example.test'}},
            [GITHUB_EMAILS]: {status: 502, body: {}}
        });

        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn}))
            .toEqual({state: 'unknown', reason: 'its forge account could not be read (HTTP 502)'});
    });

    test('an account that offers no email resolves missing, and no address is made up', async () => {
        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'seat-agent', name: 'Seat Agent', email: null}},
            [GITHUB_EMAILS]: {body: [{email: 'unverified@example.test', primary: true, verified: false}]}
        });

        const identity = await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn});

        expect(identity).toEqual({state: 'missing', name: 'Seat Agent', reason: 'its forge account offers no email this PAT can read'});
    });

    test('an account that cannot be read is unknown with the reason, never missing or derived', async () => {
        const {fetchFn} = forge({[GITHUB_USER]: {status: 401, body: {message: 'Bad credentials'}}});

        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_revoked', fetchFn}))
            .toEqual({state: 'unknown', reason: 'its forge account could not be read (HTTP 401)'});
        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_seat', fetchFn: async () => { throw new Error('fetch failed') }}))
            .toEqual({state: 'unknown', reason: 'its forge account could not be read (fetch failed)'});
    });

    test('GitLab: the commit address the account chose, read at the seat\'s own instance', async () => {
        const
            agent            = {id: 'seat', githubUsername: 'seat-agent', forge: 'gitlab', forgeHost: 'https://gitlab.example.test'},
            {calls, fetchFn} = forge({
                'https://gitlab.example.test/api/v4/user': {body: {
                    username    : 'seat-agent', name: 'Seat Agent', email: 'primary@example.test', confirmed_at: '2026-01-01T00:00:00Z',
                    commit_email: 'commits@example.test', public_email: 'public@example.test'
                }}
            });

        expect(await resolveSeatGitIdentity({agent, credential: 'glpat_seat', fetchFn}))
            .toEqual({state: 'derived', source: 'commit-email', name: 'Seat Agent', email: 'commits@example.test'});
        expect(calls).toEqual([{url: 'https://gitlab.example.test/api/v4/user', authorization: 'Bearer glpat_seat'}]);
    });

    test('GitLab: a provider-issued privacy address chosen for commits is taken as the provider returns it', async () => {
        const {fetchFn} = forge({
            'https://gitlab.example.test/api/v4/user': {body: {
                username: 'seat-agent', name: 'Seat Agent', commit_email: '4242-seat-agent@users.noreply.gitlab.example.test'
            }}
        });

        expect((await resolveSeatGitIdentity({agent: {githubUsername: 'seat-agent', forge: 'gitlab', forgeHost: 'https://gitlab.example.test'}, credential: 'glpat_seat', fetchFn})).email)
            .toBe('4242-seat-agent@users.noreply.gitlab.example.test');
    });

    test('GitLab: without a chosen commit address, the public email; the primary is never used', async () => {
        const
            agent = {githubUsername: 'seat-agent', forge: 'gitlab', forgeHost: 'https://gitlab.example.test'},
            user  = {username: 'seat-agent', name: 'Seat Agent', email: 'primary@example.test', confirmed_at: '2026-01-01T00:00:00Z', commit_email: null};

        let {fetchFn} = forge({'https://gitlab.example.test/api/v4/user': {body: {...user, public_email: 'public@example.test'}}});

        expect(await resolveSeatGitIdentity({agent, credential: 'glpat_seat', fetchFn}))
            .toEqual({state: 'derived', source: 'public', name: 'Seat Agent', email: 'public@example.test'});

        ({fetchFn} = forge({'https://gitlab.example.test/api/v4/user': {body: {...user, public_email: ''}}}));

        expect((await resolveSeatGitIdentity({agent, credential: 'glpat_seat', fetchFn})).state).toBe('missing');
    });

    test('a PAT that answers for another account is a mismatch naming that account, never derived', async () => {
        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'different-account', name: 'Different Account', email: 'different@example.test'}},
            [GITHUB_EMAILS]: {body: [{email: 'different@example.test', primary: true, verified: true, visibility: 'public'}]}
        });

        expect(await resolveSeatGitIdentity({agent: GITHUB_SEAT, credential: 'ghp_other', fetchFn})).toEqual({
            state : 'mismatch',
            found : 'different-account',
            reason: "its PAT belongs to the forge account 'different-account', not to the seat's 'seat-agent'"
        });
    });

    test('the seat\'s own account matches as the forge compares logins: without case, and without a leading @', async () => {
        const {fetchFn} = forge({
            [GITHUB_USER]  : {body: {login: 'Seat-Agent', name: 'Seat Agent', email: 'public@example.test'}},
            [GITHUB_EMAILS]: {body: []}
        });

        expect(await resolveSeatGitIdentity({agent: {...GITHUB_SEAT, githubUsername: '@seat-agent'}, credential: 'ghp_seat', fetchFn}))
            .toEqual({state: 'derived', source: 'public', name: 'Seat Agent', email: 'public@example.test'});
    });

    test('GitLab: a PAT for another account at the seat\'s instance is a mismatch too', async () => {
        const
            agent     = {id: 'seat', githubUsername: 'seat-agent', forge: 'gitlab', forgeHost: 'https://gitlab.example.test'},
            {fetchFn} = forge({'https://gitlab.example.test/api/v4/user': {body: {username: 'other-agent', name: 'Other Agent', commit_email: 'other@example.test'}}});

        expect(await resolveSeatGitIdentity({agent, credential: 'glpat_other', fetchFn})).toMatchObject({state: 'mismatch', found: 'other-agent'});
    });
});

test.describe('proveSeatForgeAccount', () => {
    test('#964 a forge outage is unanswered, an authentication refusal is terminal, and cancellation reaches fetch', async () => {
        for (const [status, verdict] of [[503, 'unanswered'], [429, 'unanswered'], [401, 'refused'], [403, 'refused']]) {
            const fetchFn = async () => ({ok: false, status});
            expect(await proveSeatForgeAccount({agent: GITHUB_SEAT, credential: 'fixture', fetchFn})).toEqual({ok: false, verdict, reason: 'unknown'})
        }
        const controller = new AbortController();
        let observed;
        const proof = proveSeatForgeAccount({agent: GITHUB_SEAT, credential: 'fixture', signal: controller.signal,
            fetchFn: (url, {signal}) => new Promise((resolve, reject) => {
                observed = signal;
                signal.addEventListener('abort', () => reject(signal.reason), {once: true})
            })});
        controller.abort();
        expect(await proof).toMatchObject({ok: false, verdict: 'unanswered'});
        expect(observed.aborted).toBe(true)
    });

    test('a declared Git identity proves nothing about the PAT: the account is read, and only the seat\'s own proves', async () => {
        const
            declared         = {...GITHUB_SEAT, gitName: 'Declared', gitEmail: 'declared@example.test'},
            {calls, fetchFn} = forge({[GITHUB_USER]: {body: {login: 'Seat-Agent', name: 'Seat Agent'}}});

        expect(await proveSeatForgeAccount({agent: declared, credential: 'ghp_seat', fetchFn})).toEqual({ok: true, verdict: 'proved'});
        expect(calls, 'one read, and no addresses').toEqual([{url: GITHUB_USER, authorization: 'Bearer ghp_seat'}]);

        const other = forge({[GITHUB_USER]: {body: {login: 'different-account'}}});

        expect(await proveSeatForgeAccount({agent: declared, credential: 'ghp_other', fetchFn: other.fetchFn})).toEqual({ok: false, verdict: 'refused', reason: 'mismatch'})
    });

    test('an account that cannot be read proves nothing, at GitHub or at a GitLab seat\'s instance', async () => {
        const
            gitlab = {id: 'seat', githubUsername: 'seat-agent', forge: 'gitlab', forgeHost: 'https://gitlab.example.test'},
            mine   = forge({'https://gitlab.example.test/api/v4/user': {body: {username: 'seat-agent'}}});

        expect(await proveSeatForgeAccount({agent: GITHUB_SEAT, credential: 'ghp_revoked', fetchFn: forge({}).fetchFn})).toEqual({ok: false, verdict: 'refused', reason: 'unknown'});
        expect(await proveSeatForgeAccount({agent: gitlab, credential: 'glpat_seat', fetchFn: mine.fetchFn})).toEqual({ok: true, verdict: 'proved'});
        expect(mine.calls).toEqual([{url: 'https://gitlab.example.test/api/v4/user', authorization: 'Bearer glpat_seat'}])
    });
});

test.describe('convergeSeatGitIdentity (real git)', () => {
    let fx;

    test.beforeEach(() => {
        fx = fixture()
    });

    test.afterEach(() => {
        fs.rmSync(fx.root, {recursive: true, force: true})
    });

    test('a clone with no identity of its own commits as the seat afterwards, with the launch env and without it', async () => {
        const {env, repo} = fx;

        // the operator fallback the Fleet closes: the clone answers with the host's global identity
        expect(commitAs(repo, env)).toBe(`${OPERATOR}|${OPERATOR}`);

        expect(await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env}))
            .toEqual({state: 'converged', scope: 'local', action: 'written'});

        expect(commitAs(repo, env)).toBe(`${SEAT_ID}|${SEAT_ID}`);
        expect(commitAs(repo, {...env, ...gitIdentityEnv(SEAT)})).toBe(`${SEAT_ID}|${SEAT_ID}`);
        expect(configOf(repo, env, 'global', 'user.email')).toBe('operator@example.test');
    });

    test('the seat\'s identity already in the checkout is kept, and nothing is recorded', async () => {
        const {env, repo} = fx;

        git(repo, env, 'config', '--local', 'user.name', SEAT.name);
        git(repo, env, 'config', '--local', 'user.email', SEAT.email);

        expect(await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env}))
            .toEqual({state: 'converged', scope: 'local', action: 'kept'});
        expect(configOf(repo, env, 'local', 'neo-fleet.writtenName')).toBeNull();
    });

    test('an identity the Fleet did not write is left untouched: mismatch', async () => {
        const {env, repo} = fx;

        git(repo, env, 'config', '--local', 'user.name', 'Someone Else');
        git(repo, env, 'config', '--local', 'user.email', 'else@example.test');

        const outcome = await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});

        expect(outcome).toEqual({
            state : 'mismatch',
            scope : 'local',
            found : 'Someone Else <else@example.test>',
            reason: "holds 'Someone Else <else@example.test>' in its local config, which the Fleet did not write"
        });
        expect(configOf(repo, env, 'local', 'user.email')).toBe('else@example.test');
        expect(configOf(repo, env, 'local', 'neo-fleet.writtenEmail')).toBeNull();
    });

    test('half an identity is left untouched: mismatch', async () => {
        const {env, repo} = fx;

        git(repo, env, 'config', '--local', 'user.email', 'else@example.test');

        const outcome = await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});

        expect(outcome.state).toBe('mismatch');
        expect(outcome.reason).toBe('sets only user.email in its local config');
        expect(configOf(repo, env, 'local', 'user.name')).toBeNull();
        expect(configOf(repo, env, 'local', 'user.email')).toBe('else@example.test');
    });

    test('the Fleet replaces its own write, unchanged since, when the seat\'s identity changes', async () => {
        const {env, repo} = fx;

        await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});

        expect(await convergeSeatGitIdentity({repoPath: repo, identity: RENAMED, env}))
            .toEqual({state: 'converged', scope: 'local', action: 'updated'});
        expect(commitAs(repo, env)).toBe('Seat Agent Two <seat-two@example.test>|Seat Agent Two <seat-two@example.test>');
    });

    test('a value edited after the Fleet\'s write is foreign: mismatch, and the edit stays', async () => {
        const {env, repo} = fx;

        await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});
        git(repo, env, 'config', '--local', 'user.email', 'edited@example.test');

        const outcome = await convergeSeatGitIdentity({repoPath: repo, identity: RENAMED, env});

        expect(outcome.state).toBe('mismatch');
        expect(outcome.reason).toBe("holds 'Seat Agent <edited@example.test>', changed after the Fleet wrote 'Seat Agent <seat@example.test>'");
        expect(configOf(repo, env, 'local', 'user.email')).toBe('edited@example.test');
    });

    test('a name unset after the Fleet\'s write is an edit, not a write cut short: mismatch, and it stays unset', async () => {
        const {env, repo} = fx;

        await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});
        git(repo, env, 'config', '--local', '--unset', 'user.name');

        expect(await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env}))
            .toMatchObject({state: 'mismatch', reason: "has no user.name since the Fleet wrote 'Seat Agent <seat@example.test>'"});
        expect(configOf(repo, env, 'local', 'user.name')).toBeNull();
        expect(configOf(repo, env, 'local', 'user.email')).toBe(SEAT.email);
    });

    test('an email unset after the Fleet\'s write stays unset the same way', async () => {
        const {env, repo} = fx;

        await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});
        git(repo, env, 'config', '--local', '--unset', 'user.email');

        expect(await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env}))
            .toMatchObject({state: 'mismatch', reason: "has no user.email since the Fleet wrote 'Seat Agent <seat@example.test>'"});
        expect(configOf(repo, env, 'local', 'user.email')).toBeNull();
    });

    test('a linked worktree gets the identity in its own scope; the repository config it shares stays as it was', async () => {
        const
            {env, repo, root} = fx,
            worktree          = path.join(root, 'worktree');

        git(repo, env, 'commit', '-q', '--allow-empty', '-m', 'root');
        git(repo, env, 'worktree', 'add', '-q', worktree, '-b', 'seat');

        expect(await convergeSeatGitIdentity({repoPath: worktree, identity: SEAT, env}))
            .toEqual({state: 'converged', scope: 'worktree', action: 'written'});

        expect(commitAs(worktree, env)).toBe(`${SEAT_ID}|${SEAT_ID}`);
        expect(configOf(repo, env, 'local', 'user.email')).toBeNull();
        expect(commitAs(repo, env)).toBe(`${OPERATOR}|${OPERATOR}`);
    });

    test('config that still resolves to another identity after the write is a mismatch: git var reads it', async () => {
        const
            {env, repo, root} = fx,
            override          = path.join(root, 'override.gitconfig');

        // the checkout's own `user` section comes first and an include after it, so whatever lands in that section
        // is overridden for every git process, while the checkout's own scope reads only its file
        fs.writeFileSync(override, '[user]\n\temail = override@example.test\n');
        fs.appendFileSync(path.join(repo, '.git', 'config'), `[user]\n[include]\n\tpath = ${override}\n`);

        const outcome = await convergeSeatGitIdentity({repoPath: repo, identity: SEAT, env});

        expect(outcome).toEqual({
            state : 'mismatch',
            scope : 'local',
            found : 'Seat Agent <override@example.test>',
            reason: "makes git record 'Seat Agent <override@example.test>' as the author without GIT_* overrides"
        });
    });
});
