import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'OperatorPresenceRecordTest', isMounted: () => true, vnodeInitialising: false}
});

import {test, expect} from '@playwright/test';
import fs             from 'fs';
import os             from 'os';
import path           from 'path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    operatorPresenceRecordPath,
    sameOperatorPresence,
    writeOperatorPresenceRecord
} from '../../../../../../ai/services/fleet/operatorPresenceRecord.mjs';

/**
 * @summary The Fleet's host record of the operator's presence: what it writes, what a failed write leaves, and
 * when two readings count as the same state.
 */
test.describe('ai/services/fleet/operatorPresenceRecord', () => {
    const away = {mode: 'away', since: '2026-11-12T22:00:00.000Z', until: '2026-11-13T08:00:00.000Z', setBy: '@tobiu'};
    let dir;

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-operator-presence-record-'))
    });

    test.afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    });

    test('writes mode, since, until and writtenAt, never the setter, and leaves no temp file', () => {
        const filePath = path.join(dir, 'fleet', 'operator-presence.json');

        expect(writeOperatorPresenceRecord(away, {filePath, now: Date.parse('2026-11-12T22:00:01Z')})).toBe(true);
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
            mode: 'away', since: away.since, until: away.until, writtenAt: '2026-11-12T22:00:01.000Z'
        });
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(['operator-presence.json']);
    });

    test('a failed write returns false and leaves the previous record', () => {
        const filePath = path.join(dir, 'operator-presence.json');

        writeOperatorPresenceRecord(away, {filePath});

        // the temp file's name taken by a directory: the write fails before the rename, whoever runs it
        fs.mkdirSync(`${filePath}.${process.pid}.tmp`);
        expect(writeOperatorPresenceRecord({mode: 'present', since: away.until, until: null}, {filePath})).toBe(false);
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).mode).toBe('away');

        // a parent that is a file is no directory to write into
        expect(writeOperatorPresenceRecord(away, {filePath: path.join(filePath, 'nested.json')})).toBe(false);
    });

    test('the record lives beneath the Fleet\'s data directory', () => {
        expect(path.basename(operatorPresenceRecordPath())).toBe('operator-presence.json');
        expect(path.isAbsolute(operatorPresenceRecordPath())).toBe(true);
    });

    test('two readings are the same state when mode, since and until agree', () => {
        expect(sameOperatorPresence(away, {mode: 'away', since: away.since, until: away.until})).toBe(true);
        expect(sameOperatorPresence(away, {...away, until: null})).toBe(false);
        expect(sameOperatorPresence(away, {...away, mode: 'present'})).toBe(false);
        expect(sameOperatorPresence({mode: 'present', since: null}, {mode: 'present', since: null, until: null})).toBe(true);
        expect(sameOperatorPresence(away, null)).toBe(false);
        expect(sameOperatorPresence(null, null)).toBe(false);
    });
});
