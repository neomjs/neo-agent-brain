import {test, expect}                                     from '@playwright/test';
import fs                                                 from 'node:fs';
import os                                                 from 'node:os';
import path                                               from 'node:path';
import {convergeSeatSessionPreset, readSeatSessionFolder} from '../../../../../../ai/services/fleet/seatSessionFolder.mjs';

/**
 * @summary Converging a Claude Desktop seat's session preset to its provisioned checkout before spawn,
 * and reading where the running seat's session opened from the seat's own profile.
 */
test.describe('convergeSeatSessionPreset — preset convergence before claude-desktop spawn (#1223)', () => {
    const accountId = 'd6da8ba9-b0ba-403e-bb82-53fc76bc6a08';

    let root, instanceHome, checkout, staleFolder, presetPath;

    test.beforeEach(() => {
        root         = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-session-preset-'));
        instanceHome = path.join(root, 'profile');
        checkout     = path.join(root, 'agents', 'neo-fable-mnemosyne', 'neomjs', 'neo');
        staleFolder  = path.join(root, 'agents', 'neo-fable', 'neomjs', 'neo');
        presetPath   = path.join(instanceHome, 'ccd-session-presets.json');
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('AC-1: rewrites a stale preset folder to the provisioned checkout and leaves an already-matching file byte-identical', () => {
        fs.mkdirSync(instanceHome, {recursive: true});

        const initial = `${JSON.stringify({
            byAccount: {
                [accountId]: {
                    presets: [{
                        id        : '78c5d999-a73b-4239-994f-70d2332da522',
                        name      : 'neo',
                        createdAt : 1789984863649,
                        lastUsedAt: 1789984863649,
                        target    : {
                            kind: 'local',
                            cwd : staleFolder
                        }
                    }],
                    builtIns       : {},
                    seededFromDraft: true
                }
            }
        }, null, '\t')}\n`;

        fs.writeFileSync(presetPath, initial, {mode: 0o600});

        const updated = convergeSeatSessionPreset({instanceHome, cwd: checkout});

        expect(updated).toEqual({path: presetPath, status: 'updated', cwd: checkout});

        const afterUpdateBytes = fs.readFileSync(presetPath, 'utf8');
        const parsed           = JSON.parse(afterUpdateBytes);

        expect(parsed.byAccount[accountId].presets).toEqual([{
            id        : '78c5d999-a73b-4239-994f-70d2332da522',
            name      : 'neo',
            createdAt : 1789984863649,
            lastUsedAt: 1789984863649,
            target    : {
                kind: 'local',
                cwd : checkout
            }
        }]);

        const statBeforeSecondCall = fs.statSync(presetPath);
        const unchanged            = convergeSeatSessionPreset({instanceHome, cwd: checkout});
        const statAfterSecondCall  = fs.statSync(presetPath);

        expect(unchanged).toEqual({path: presetPath, status: 'unchanged', cwd: checkout});
        expect(fs.readFileSync(presetPath, 'utf8')).toBe(afterUpdateBytes);
        expect(statAfterSecondCall.ino).toBe(statBeforeSecondCall.ino);
        expect(statAfterSecondCall.mtimeMs).toBe(statBeforeSecondCall.mtimeMs)
    });

    test('AC-2: seeds one preset pointing at the checkout when the profile has no preset file', () => {
        fs.mkdirSync(instanceHome, {recursive: true});
        fs.writeFileSync(path.join(instanceHome, 'config.json'), JSON.stringify({lastKnownAccountUuid: accountId}));

        const created = convergeSeatSessionPreset({instanceHome, cwd: checkout});

        expect(created).toEqual({path: presetPath, status: 'created', cwd: checkout});

        const parsed  = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
        const bucket  = parsed.byAccount?.[accountId];
        const presets = bucket?.presets;

        expect(Array.isArray(presets)).toBe(true);
        expect(presets).toHaveLength(1);
        expect(presets[0]).toMatchObject({
            name  : 'neo',
            target: {
                kind: 'local',
                cwd : checkout
            }
        });
        expect(bucket.seededFromDraft).toBe(true)
    });

    test('AC-3: refuses a missing or relative checkout before touching the profile', () => {
        for (const badCwd of [undefined, null, '', 'relative/checkout', './neo']) {
            expect(() => convergeSeatSessionPreset({instanceHome, cwd: badCwd}))
                .toThrow(/must be an absolute provisioned checkout for claude-desktop/)
        }
        expect(fs.existsSync(presetPath)).toBe(false)
    });
});

/**
 * @summary Where a Claude Desktop seat's session opened, on real temp profiles: only the seat's own
 * session records answer, the record most recently active since the launch decides, and a record set
 * that cannot be read is `unknown`, never `ok`.
 */
test.describe('seatSessionFolder — the folder a desktop seat\'s session opened in', () => {
    const
        since  = '2026-10-03T19:00:00.000Z',
        before = Date.parse('2026-10-03T18:00:00.000Z'),
        after  = minutes => Date.parse(since) + minutes * 60_000;

    let root, instanceHome, expected, store;

    // one Code-tab session record, its file touched at `touched` (ms)
    const record = (name, fields, touched = after(30)) => {
        const file = path.join(store, `local_${name}.json`);

        fs.writeFileSync(file, typeof fields === 'string' ? fields : JSON.stringify(fields));
        fs.utimesSync(file, new Date(touched), new Date(touched));

        return file
    };

    const read = () => readSeatSessionFolder({instanceHome, expected, since});

    test.beforeEach(() => {
        root         = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-session-folder-'));
        instanceHome = path.join(root, 'profile');
        expected     = path.join(root, 'agents', 'neo-fable', 'neomjs', 'neo');
        store        = path.join(instanceHome, 'claude-code-sessions', 'account', 'org');
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('a profile with no session since the launch is pending', () => {
        expect(read(), 'no session store yet').toEqual({state: 'pending', expected});

        fs.mkdirSync(store, {recursive: true});
        record('old', {originCwd: expected, createdAt: before, lastActivityAt: before}, before);

        expect(read(), 'only a session untouched since the launch').toEqual({state: 'pending', expected})
    });

    test('the session opened in the checkout is ok, also when a worktree moved its cwd', () => {
        fs.mkdirSync(store, {recursive: true});
        record('a', {originCwd: expected, cwd: path.join(expected, '.claude', 'worktrees', 'x'), createdAt: after(5)});

        expect(read()).toEqual({state: 'ok', expected})
    });

    test('a session opened anywhere else is wrong and names the folder', () => {
        fs.mkdirSync(store, {recursive: true});
        record('a', {originCwd: '/Users/Shared/fable/neomjs/neo', cwd: '/Users/Shared/fable/neomjs/neo', createdAt: after(5)});

        expect(read()).toEqual({state: 'wrong', expected, observed: '/Users/Shared/fable/neomjs/neo'})
    });

    test('the session most recently active since the launch decides, a reopened one included, an archived one never', () => {
        fs.mkdirSync(store, {recursive: true});
        // reopened at relaunch: created before the launch, focused after it
        record('reopened', {originCwd: '/old/checkout', createdAt: before, lastFocusedAt: after(10)});
        record('current',  {originCwd: expected, createdAt: after(15), lastActivityAt: after(20)});
        record('archived', {originCwd: '/elsewhere', createdAt: after(25), isArchived: true});

        expect(read(), 'the most recent active session is in the checkout').toEqual({state: 'ok', expected});

        record('reopened', {originCwd: '/old/checkout', createdAt: before, lastFocusedAt: after(40)});

        expect(read(), 'the operator went back to the old one').toEqual({state: 'wrong', expected, observed: '/old/checkout'})
    });

    test('records this reader cannot read are unknown with the reason, never ok', () => {
        fs.mkdirSync(store, {recursive: true});
        record('broken', '{not json');
        record('shapeless', {title: 'no folder, no times'});

        expect(read()).toEqual({state: 'unknown', expected, reason: '2 of the seat\'s session records could not be read'});

        record('good', {originCwd: expected, createdAt: after(5)});

        expect(read(), 'a readable record answers beside the unreadable ones').toEqual({state: 'ok', expected})
    });

    // the store churns under the reader: a record listed a moment ago is gone, or its metadata refuses
    for (const code of ['ENOENT', 'EACCES']) {
        test(`a record whose metadata read fails with ${code} after the listing is unreadable, never a throw`, () => {
            fs.mkdirSync(store, {recursive: true});

            const
                churned    = record('churned', {originCwd: expected, createdAt: after(5)}),
                fileSystem = {...fs, statSync: (file, ...rest) => {
                    if (file === churned) throw Object.assign(new Error(`${code}: ${file}`), {code});

                    return fs.statSync(file, ...rest)
                }},
                readWith   = () => readSeatSessionFolder({instanceHome, expected, since, fileSystem});

            expect(readWith()).toEqual({state: 'unknown', expected, reason: '1 of the seat\'s session records could not be read'});

            record('good', {originCwd: expected, createdAt: after(6)});

            expect(readWith(), 'the readable record still answers').toEqual({state: 'ok', expected})
        })
    }

    test('a linked folder in the store is not followed', () => {
        const outside = path.join(root, 'outside', 'org');

        fs.mkdirSync(outside, {recursive: true});
        fs.writeFileSync(path.join(outside, 'local_x.json'), JSON.stringify({originCwd: expected, createdAt: after(5)}));
        fs.mkdirSync(path.join(instanceHome, 'claude-code-sessions'), {recursive: true});
        fs.symlinkSync(path.join(root, 'outside'), path.join(instanceHome, 'claude-code-sessions', 'account'));

        expect(read()).toEqual({state: 'pending', expected})
    });
});
