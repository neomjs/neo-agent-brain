import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
    censusDefectNoteCaptures,
    defectNoteFingerprint,
    foldDefectObservations,
    inspectDefectNoteCapture,
    isDefectNoteSubject,
    parseDefectNote
} from '../../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';

// The production helper is pure; fixture reads and CLI subprocesses stay local.

const NOTE = 'defect-note: query_summaries broke returns zero-content rows for populated sessions';

test.describe('defectObservationFold — the defect-channel read model', () => {
    test('the fingerprint is deterministic from the note alone, prefix- and marker-insensitive', () => {
        const base = defectNoteFingerprint(NOTE);

        expect(defectNoteFingerprint(NOTE)).toBe(base);
        // The prefix and a recovery marker carry no identity.
        expect(defectNoteFingerprint(NOTE.replace('defect-note:', ''))).toBe(base);
        expect(defectNoteFingerprint(NOTE.replace('defect-note:', 'defect-note: [recovered]'))).toBe(base);
        expect(base).toMatch(/^[0-9a-f]{16}$/);
    });

    test('normalization merges casing, whitespace, and volatile tokens — never distinct defects', () => {
        const a = defectNoteFingerprint('defect-note: KB Ingestion broke  404 on repo 12345'),
              b = defectNoteFingerprint('defect-note: kb ingestion broke 404 on repo 678');

        expect(a).toBe(b); // volatile digit runs collapse

        const c = defectNoteFingerprint('defect-note: KB Ingestion broke 500 on repo 12345');

        expect(c).not.toBe(a); // a different symptom is a different observation
    });

    test('parseDefectNote: quoted delimiters stay literal, while broke and is wrong split the note', () => {
        expect(parseDefectNote(NOTE)).toEqual({
            parseable: true,
            recovered: false,
            surface  : 'query_summaries',
            symptom  : 'returns zero-content rows for populated sessions'
        });
        expect(parseDefectNote('defect-note: parser is wrong emits malformed envelopes')).toMatchObject({
            parseable: true,
            surface  : 'parser',
            symptom  : 'emits malformed envelopes'
        });
        expect(parseDefectNote("defect-note: `parseDefectNote` splits on the literal ' broke ', so notes fail")).toMatchObject({
            parseable: false,
            surface  : "`parseDefectNote` splits on the literal ' broke ', so notes fail"
        });
        expect(parseDefectNote("defect-note: 'query_summaries broke helper' broke returns empty rows")).toMatchObject({
            parseable: true,
            surface  : "'query_summaries broke helper'",
            symptom  : 'returns empty rows'
        });
        expect(parseDefectNote("defect-note: parser's output broke returns empty rows")).toMatchObject({
            parseable: true,
            surface  : "parser's output",
            symptom  : 'returns empty rows'
        });
        expect(parseDefectNote('defect-note: [recovered] kb broke embed stall').recovered).toBe(true);

        const malformed = parseDefectNote('defect-note: something vague happened');

        expect(malformed.parseable).toBe(false);
        expect(malformed.surface).toBe('something vague happened');
        expect(parseDefectNote('defect-note:  broke symptom').parseable).toBe(false);
        expect(parseDefectNote('defect-note: surface broke ').parseable).toBe(false);
    });

    test('inspectDefectNoteCapture admits only canonical broadcast captures and preserves raw notes', () => {
        const subject = '  DeFeCt-NoTe: query_summaries broke returns zero-content rows';

        expect(isDefectNoteSubject(subject)).toBe(true);
        expect(isDefectNoteSubject('[defect-note] query_summaries broke rows')).toBe(false);
        expect(inspectDefectNoteCapture({subject, to: 'AGENT:*'})).toEqual({
            admitted   : true,
            parseable  : true,
            fingerprint: defectNoteFingerprint(subject)
        });
        expect(inspectDefectNoteCapture({
            subject       : 'defect-note: something vague happened',
            to            : 'AGENT:*',
            taggedConcepts: ['defect-note']
        })).toEqual({
            admitted   : true,
            parseable  : false,
            fingerprint: defectNoteFingerprint('defect-note: something vague happened'),
            reason     : 'No unambiguous surface/symptom split; raw note retained.'
        });
        expect(inspectDefectNoteCapture({
            subject       : '[lane-claim] defect-note: query broke rows',
            to            : 'AGENT:*',
            taggedConcepts: ['defect-note']
        })).toMatchObject({admitted: false, reason: expect.stringMatching(/complete subject prefix/i)});
        const quotedPrefix = 'defect-note: parser broke reports `defect-note:` literally';

        expect(isDefectNoteSubject(quotedPrefix)).toBe(true);
        expect(inspectDefectNoteCapture({subject: quotedPrefix, to: 'AGENT:*'})).toEqual({
            admitted   : true,
            parseable  : true,
            fingerprint: defectNoteFingerprint(quotedPrefix)
        });
        expect(inspectDefectNoteCapture({subject: 'defect-note: query broke rows', to: '@neo-gpt-emmy'}))
            .toMatchObject({admitted: false, reason: expect.stringMatching(/AGENT:\*/)});
        expect(inspectDefectNoteCapture({subject: 'ordinary project update', to: 'AGENT:*'})).toBeUndefined();
    });

    test('the historical nine-note cohort retains six observations and no quoted-separator false positive', () => {
        const {messages} = JSON.parse(readFileSync(new URL('./defect-note-census.json', import.meta.url), 'utf8'));
        expect(censusDefectNoteCaptures(messages)).toEqual({rows: 9, candidates: 9, admitted: 6, dropped: 3, parseable: 0, raw: 6});
        expect(inspectDefectNoteCapture({subject: 'Review: the defect-note channel needs a fix', to: 'AGENT:*'})).toBeUndefined();
        expect(inspectDefectNoteCapture({subject: 'defect-note ×3: notes in body', to: 'AGENT:*'}))
            .toMatchObject({admitted: false, reason: expect.stringMatching(/batches.*one defect-note subject/i)});

        const row = {subject: 'defect-note: the grid is wrong after resize'};
        Object.defineProperty(row, 'body', {enumerable: true, get() { throw new Error('body must not be read'); }});
        expect(censusDefectNoteCaptures([row])).toMatchObject({admitted: 1, parseable: 1});
        expect(censusDefectNoteCaptures([{subject: row.subject, to: '@someone'}])).toMatchObject({admitted: 0, dropped: 1});
    });

    test('the census CLI replays a file without a plane and refuses digest or missing-file arguments', () => {
        const script = fileURLToPath(new URL('../../../../../../../ai/scripts/diagnostics/defectObservations.mjs', import.meta.url)),
              fixture = fileURLToPath(new URL('./defect-note-census.json', import.meta.url)),
              run = args => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', timeout: 10000});
        const census = run(['--census', '--input-file', fixture]);

        expect(census.status, census.stderr).toBe(0);
        expect(JSON.parse(census.stdout)).toEqual({rows: 9, candidates: 9, admitted: 6, dropped: 3, parseable: 0, raw: 6});
        const digest = run(['--digest', '--census', '--input-file', fixture]);
        expect(digest.status).toBe(1);
        expect(digest.stderr).toContain('read-only and cannot send a digest');
        const missing = run(['--census', '--input-file']);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('requires a JSON file path');
    });

    test('the fold aggregates one record per fingerprint with count, reporters, and sighting bounds', () => {
        const records = foldDefectObservations([
            {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: NOTE},
            {from: '@b', sentAt: '2026-08-15T09:00:00Z', subject: NOTE},
            {from: '@a', sentAt: '2026-08-15T08:30:00Z', subject: 'defect-note: kbSync broke wedge on one slow file'}
        ], {now: Date.parse('2026-08-15T10:00:00Z')});

        expect(records).toHaveLength(2);

        const top = records[0]; // most-recently-active first

        expect(top.fingerprint).toBe(defectNoteFingerprint(NOTE));
        expect(top).toMatchObject({
            count      : 2,
            reporters  : ['@a', '@b'],
            firstSeenAt: '2026-08-15T08:00:00.000Z',
            lastSeenAt : '2026-08-15T09:00:00.000Z',
            state      : 'red'
        });
    });

    test('the fold records the distinct threads a fingerprint was sighted in; a threadless row records none', () => {
        const records = foldDefectObservations([
            {from: '@ci', sentAt: '2026-08-15T08:00:00Z', subject: NOTE, partOfThread: 'ci:.github/workflows/test.yml:components:1'},
            {from: '@ci', sentAt: '2026-08-15T09:00:00Z', subject: NOTE, partOfThread: 'ci:.github/workflows/test.yml:components:2'},
            {from: '@ci', sentAt: '2026-08-15T09:30:00Z', subject: NOTE, partOfThread: 'ci:.github/workflows/test.yml:components:2'},
            {from: '@a',  sentAt: '2026-08-15T10:00:00Z', subject: NOTE}
        ], {now: Date.parse('2026-08-15T11:00:00Z')});

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            count    : 4,
            reporters: ['@ci', '@a'],
            // Two runs are two threads; the same run twice is one; a hand-filed note adds none.
            threads  : ['ci:.github/workflows/test.yml:components:1', 'ci:.github/workflows/test.yml:components:2']
        });
    });

    test('recovery is idempotent and a fresh sighting re-opens — newest transition wins', () => {
        const recovered = NOTE.replace('defect-note:', 'defect-note: [recovered]'),
              records   = foldDefectObservations([
                  {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: NOTE},
                  {from: '@b', sentAt: '2026-08-15T09:00:00Z', subject: recovered},
                  // A duplicate recovery note changes nothing — the fold recomputes state.
                  {from: '@b', sentAt: '2026-08-15T09:01:00Z', subject: recovered}
              ], {now: Date.parse('2026-08-15T10:00:00Z')});

        expect(records).toHaveLength(1);
        expect(records[0].state).toBe('recovered');
        expect(records[0].count).toBe(3);

        const reopened = foldDefectObservations([
            {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: recovered},
            {from: '@a', sentAt: '2026-08-15T09:00:00Z', subject: NOTE}
        ], {now: Date.parse('2026-08-15T10:00:00Z')});

        expect(reopened[0].state).toBe('red');
    });

    test('aging is a fold parameter: a stale record reads quiet, and quiet never mutates the trail', () => {
        const rows    = [{from: '@a', sentAt: '2026-08-01T08:00:00Z', subject: NOTE}],
              records = foldDefectObservations(rows, {now: Date.parse('2026-08-15T10:00:00Z'), quietAfterMs: 7 * 24 * 60 * 60 * 1000});

        expect(records[0].state).toBe('quiet');
        // The record keeps its last transition under the aging overlay.
        expect(records[0].count).toBe(1);

        const fresh = foldDefectObservations(rows, {now: Date.parse('2026-08-01T09:00:00Z')});

        expect(fresh[0].state).toBe('red');
    });

    test('the fold guards its coordinates and skips unaddressable rows', () => {
        expect(() => foldDefectObservations([], {now: Number.NaN})).toThrow(/now and a positive finite quietAfterMs/);
        expect(() => foldDefectObservations([], {quietAfterMs: 0})).toThrow(/now and a positive finite quietAfterMs/);

        const records = foldDefectObservations([
            {from: '@a', sentAt: 'not-a-date', subject: NOTE},
            {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: '   '},
            {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: NOTE}
        ], {now: Date.parse('2026-08-15T10:00:00Z')});

        expect(records).toHaveLength(1);
        expect(records[0].count).toBe(1);
    });

    test('the fold reads the subject deliberately — a body never re-identifies a note', () => {
        // Production callers filter on `subject.startsWith('defect-note:')` and the list
        // projection carries no body at all, so identity comes from the subject by construction.
        const records = foldDefectObservations([
            {from: '@a', sentAt: '2026-08-15T08:00:00Z', subject: NOTE, body: 'defect-note: unrelated text entirely'},
            {from: '@b', sentAt: '2026-08-15T09:00:00Z', subject: NOTE}
        ], {now: Date.parse('2026-08-15T10:00:00Z')});

        expect(records).toHaveLength(1);
        expect(records[0].fingerprint).toBe(defectNoteFingerprint(NOTE));
        expect(records[0].count).toBe(2);
    });
});
