import {test, expect}          from '@playwright/test';
import fs                      from 'node:fs';
import os                      from 'node:os';
import path                    from 'node:path';
import {readSeatSessionFolder} from '../../../../../../ai/services/fleet/seatSessionFolder.mjs';

/**
 * @summary Where a Claude Desktop seat's session opened, on real temp profiles: only the seat's own
 * session records answer, the record most recently active since the launch decides, and a record set
 * that cannot be read is `unknown`, never `ok`.
 */
test.describe('seatSessionFolder — the folder a desktop seat\'s session opened in', () => {
    const
        since    = '2026-10-03T19:00:00.000Z',
        before   = Date.parse('2026-10-03T18:00:00.000Z'),
        after    = minutes => Date.parse(since) + minutes * 60_000;

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
