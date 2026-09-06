import {test, expect}  from '@playwright/test';
import {execFileSync}  from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';

import {
    ARTIFACT_VERBS,
    loadLocalSeats,
    MANAGED_KEYS,
    renderZshFragment,
    resolveSeatEnvFile,
    toAbsoluteRoutes,
    TRACKED_SEATS
} from '../../../../ai/scripts/lifecycle/local-agent-os/seatCredentialRouting.mjs';

/**
 * Guards the tracked seat credential mapping (neomjs/neo-agent-brain#244).
 *
 * The ticket's AC names the trap this file has to avoid: *"a positive-only test passes for a mapping
 * that matches everything"*. So the cross-seat isolation arm is paired with a control that feeds it a
 * deliberately catch-all route and asserts the SAME assertion fails — proving the arm can go red at
 * all. Without that, "no seat resolves to another's" is a sentence, not a test.
 */

const BASE = '/tmp/seat-routing-fixture';

test.describe('seatCredentialRouting', () => {
    const routes = toAbsoluteRoutes(BASE);

    test('every tracked seat resolves to its own env', () => {
        expect(TRACKED_SEATS.length).toBeGreaterThan(1);

        for (const {dir, env} of TRACKED_SEATS) {
            expect(resolveSeatEnvFile(path.join(BASE, dir), routes)).toBe(path.join(BASE, env));
        }
    });

    test('a sibling repo under a seat root resolves — the exact #244 regression', () => {
        // The old mapping matched `<seat>/neomjs/neo` only, so when the Agent OS moved into
        // neo-agent-brain every seat lost GH_TOKEN there and `gh` authored as the operator.
        const seat = TRACKED_SEATS.find(s => s.dir.endsWith('/neomjs') || s.dir === 'claude/neomjs');

        for (const repo of ['neo', 'neo-agent-brain', 'devindex', 'neo-agent-institution']) {
            expect(resolveSeatEnvFile(path.join(BASE, seat.dir, repo), routes))
                .toBe(path.join(BASE, seat.env));
        }
    });

    test('no seat resolves to another seat\'s env', () => {
        for (const {dir, env} of TRACKED_SEATS) {
            const resolved = resolveSeatEnvFile(path.join(BASE, dir, 'neo'), routes),
                  foreign  = TRACKED_SEATS.filter(s => s.env !== env).map(s => path.join(BASE, s.env));

            expect(foreign).not.toContain(resolved);
        }
    });

    test('CONTROL: the isolation arm fails against a catch-all mapping', () => {
        // Non-vacuity. A route claiming the whole base makes every seat resolve to one foreign env;
        // if the assertion above cannot notice that, it was never testing isolation.
        const catchAll = [
            {prefix: BASE, envFile: path.join(BASE, 'somebody-elses/.env')},
            ...routes
        ].map(r => ({...r, prefix: BASE}));

        let isolationHeld = true;

        for (const {env} of TRACKED_SEATS) {
            const resolved = resolveSeatEnvFile(path.join(BASE, 'claude/neomjs', 'neo'), catchAll);

            if (resolved !== path.join(BASE, env)) {
                isolationHeld = false;
            }
        }

        expect(isolationHeld).toBe(false);
    });

    test('a path that merely shares a string prefix does NOT match', () => {
        // `startsWith` passes every positive arm above and still routes one seat's credentials into
        // a neighbouring directory. These two cases are NOT equally load-bearing, and the difference
        // is recorded because a reader would otherwise assume both are:
        //
        //   `claude/neomjs-old/neo`     — DISCRIMINATING. Measured: a startsWith resolver returns
        //                                 `<base>/claude/neomjs/neo/.env` here; this one returns
        //                                 null. This is the arm that forbids that implementation.
        //   `claude-scratch/neomjs/neo` — cannot fail against the CURRENT table, because every
        //                                 tracked prefix ends in `/neomjs`, so the strings diverge
        //                                 before the boundary is reached. Kept deliberately: it
        //                                 becomes load-bearing the moment a route is added whose
        //                                 prefix is a bare seat root.
        expect(resolveSeatEnvFile(`${BASE}/claude/neomjs-old/neo`, routes)).toBe(null);
        expect(resolveSeatEnvFile(`${BASE}/claude-scratch/neomjs/neo`, routes)).toBe(null);

        // The bare-root case, exercised directly so the boundary is proven rather than assumed.
        const bareRoot = [{prefix: `${BASE}/claude`, envFile: `${BASE}/claude/.env`}];

        expect(resolveSeatEnvFile(`${BASE}/claude-scratch/neo`, bareRoot)).toBe(null);
        expect(resolveSeatEnvFile(`${BASE}/claude/neo`, bareRoot)).toBe(`${BASE}/claude/.env`);
    });

    test('an unmapped path resolves to nothing', () => {
        expect(resolveSeatEnvFile('/Users/Shared/agent-os/neo-agent-brain', routes)).toBe(null);
        expect(resolveSeatEnvFile('/', routes)).toBe(null);
        expect(resolveSeatEnvFile('', routes)).toBe(null);
    });

    test('the longest matching prefix wins, so declaration order is not a security control', () => {
        const nested = [
            {prefix: `${BASE}/claude/neomjs`,     envFile: `${BASE}/broad/.env`},
            {prefix: `${BASE}/claude/neomjs/neo`, envFile: `${BASE}/narrow/.env`}
        ];

        expect(resolveSeatEnvFile(`${BASE}/claude/neomjs/neo/src`, nested)).toBe(`${BASE}/narrow/.env`);
        expect(resolveSeatEnvFile(`${BASE}/claude/neomjs/neo/src`, [...nested].reverse()))
            .toBe(`${BASE}/narrow/.env`);
    });

    test.describe('local (untracked) seats', () => {
        test('an absent file is normal, not a misconfiguration', () => {
            expect(loadLocalSeats(path.join(os.tmpdir(), 'seat-routing-absent.json'))).toEqual([]);
        });

        test('a malformed file throws rather than silently routing fewer seats', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-local-'));

            fs.writeFileSync(path.join(dir, 'bad.json'), '{"seats":[{"prefix":"relative/x","envFile":"/abs/.env"}]}');
            expect(() => loadLocalSeats(path.join(dir, 'bad.json'))).toThrow(/absolute/);

            fs.writeFileSync(path.join(dir, 'shape.json'), '{"nope":[]}');
            expect(() => loadLocalSeats(path.join(dir, 'shape.json'))).toThrow(/seats/);
        });

        test('a local seat routes alongside the tracked ones', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-local-ok-'));

            fs.writeFileSync(path.join(dir, 'ok.json'),
                JSON.stringify({seats: [{prefix: '/private/workspace', envFile: '/private/workspace/.env'}]}));

            const merged = [...routes, ...loadLocalSeats(path.join(dir, 'ok.json'))];

            expect(resolveSeatEnvFile('/private/workspace/some-repo', merged)).toBe('/private/workspace/.env');
            expect(resolveSeatEnvFile(path.join(BASE, 'claude/neomjs/neo'), merged))
                .toBe(path.join(BASE, 'claude/neomjs/neo/.env'));
        });
    });

    test.describe('generated fragment', () => {
        const fragment = renderZshFragment(routes);

        test('carries one arm per route and unsets only managed keys', () => {
            for (const {envFile} of routes) {
                expect(fragment).toContain(envFile);
            }

            expect(fragment).toContain(MANAGED_KEYS.join(' '));
            expect(fragment).toContain('unset ${=_neo_env_managed_keys}');
        });

        test('guards artifact-creating gh verbs on the agent shell, not the directory', () => {
            expect(fragment).toContain('CLAUDECODE');
            expect(fragment).toContain('AI_AGENT');
            expect(fragment).toContain('-z "$GH_TOKEN"');

            for (const verb of ['create', 'edit', 'comment', 'merge']) {
                expect(ARTIFACT_VERBS).toContain(verb);
            }

            // Reads stay available so a broken shell is still diagnosable from inside it.
            expect(ARTIFACT_VERBS).not.toContain('view');
            expect(ARTIFACT_VERBS).not.toContain('list');
            expect(ARTIFACT_VERBS).not.toContain('status');
        });

        test('says it is generated, so nobody hand-edits the host copy', () => {
            expect(fragment).toContain('GENERATED by');
            expect(fragment).toContain('do not hand-edit');
        });
    });

    test.describe('the emitted zsh actually behaves like the resolver', () => {
        // Everything above tests the JavaScript. The SHELL is what runs on the host, and a `case`
        // glob is not the same language as `path.resolve` — so these arms execute the emitted
        // fragment under zsh and compare its answer to the resolver's on the same paths. Without
        // them the generator could drift from its own model and every JS arm would stay green.
        //
        // The base is a fixture directory that does not exist, so no real `.env` is ever sourced:
        // the fragment's `-f` test fails and only the resolution is observable.
        // `PWD` is special in zsh — assigning it does not move the shell, so a first version of
        // these arms silently resolved every path as unmapped and only the positive cases failed.
        // They `cd` for real now, which means the fixture directories must exist. The base is
        // realpath'd because macOS maps /tmp -> /private/tmp and the emitted globs are literal.
        const zshBase   = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-zsh-base-'))),
              zshRoutes = toAbsoluteRoutes(zshBase);

        const zshAnswer = cwd => {
            fs.mkdirSync(cwd, {recursive: true});

            const file = path.join(zshBase, 'fragment.zsh');

            fs.writeFileSync(file, renderZshFragment(zshRoutes));

            const script = `cd ${JSON.stringify(cwd)} || exit 9; source ${JSON.stringify(file)}; ` +
                           'print -r -- "${NEO_SEAT_ENV_FILE:-<unmapped>}"';

            // Resolved through PATH, not `/bin/zsh`: that path is macOS's. On the Linux CI runner it
            // is `/usr/bin/zsh`, and hardcoding the macOS location reds every arm here with an
            // ENOENT that says nothing about the routing under test.
            return execFileSync('zsh', ['-c', script], {encoding: 'utf8'}).trim();
        };

        test('zsh is present — a missing shell is a RED here, never a skip', () => {
            // These arms are the only ones that execute the artifact this module actually ships.
            // Skipping them where zsh is absent would restore the exact gap they close: every other
            // arm would stay green while the emitted `case` globs went unverified. So the
            // prerequisite is asserted, and CI installs zsh rather than opting out of the check.
            expect(() => execFileSync('zsh', ['-c', 'exit 0'])).not.toThrow();
        });

        for (const [label, rel] of [
            ['a seat root',                 'claude/neomjs'],
            ['a sibling repo under a seat', 'claude/neomjs/neo-agent-brain'],
            ['the string-prefix trap',      'claude/neomjs-old/neo'],
            ['an unmapped sibling root',    'agent-os/neo-agent-brain']
        ]) {
            test(`zsh agrees with the resolver on ${label}`, () => {
                const cwd      = path.join(zshBase, rel),
                      expected = resolveSeatEnvFile(cwd, zshRoutes) ?? '<unmapped>';

                expect(zshAnswer(cwd)).toBe(expected);
            });
        }

        test('CONTROL: the zsh comparison can fail — a wrong base is detected', () => {
            // Proves these arms are not passing because both sides say "<unmapped>" for everything.
            const cwd = path.join(zshBase, 'claude/neomjs');

            expect(resolveSeatEnvFile(cwd, zshRoutes)).not.toBe(null);
            expect(zshAnswer(cwd)).not.toBe('<unmapped>');
        });
    });
});
