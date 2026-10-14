import {expect, test}                                                                                            from '@playwright/test';
import fs                                                                                                        from 'fs-extra';
import os                                                                                                        from 'node:os';
import path                                                                                                      from 'node:path';
import {spawn}                                                                                                   from 'node:child_process';
import {once}                                                                                                    from 'node:events';
import {holdLaunchAdmissionHandoff, isAdmissionSnapshot, openLaunchAdmissionJournal, readLaunchAdmissionJournal} from '../../../../../../ai/services/fleet/launchAdmissionJournal.mjs';
import {writeFileAtomicSync}                                                                                     from '../../../../../../ai/services/shared/atomicFileWrite.mjs';
import {acquireFileLease}                                                                                        from '../../../../../../ai/daemons/shared/fileLease.mjs';

let root, journals;
const emptySnapshot = {version: 1, generations: []};
const snapshot      = {version: 1, generations: [{id: 'original-start', state: 'active'}]};
const origin        = 'http://127.0.0.1:47123';

/** @summary A closed fixture schema; production supplies the issuer's non-secret record codec. */
function validateSnapshot(value) {
    return value?.version === 1 && Object.keys(value).sort().join(',') === 'generations,version' &&
        Array.isArray(value.generations) && value.generations.every(row =>
            Object.keys(row).sort().join(',') === 'id,state' && row.id === 'original-start' && ['active', 'revoked'].includes(row.state));
}

/** @summary Opens only this test's journal and tracks it for cleanup. */
function open(options = {}) {
    const journal = openLaunchAdmissionJournal({directory: root, validateSnapshot, emptySnapshot, ...options});
    journals.push(journal);
    return journal;
}

test.beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-admission-journal-')));
    fs.chmodSync(root, 0o700);
    journals = [];
});
test.afterEach(() => {
    journals.forEach(journal => journal.close());
    fs.removeSync(root);
});

test('clean handoff is durably consumed before the successor receives the original snapshot', () => {
    const first = open();
    expect(first.previous).toBeNull();
    first.write(snapshot, origin);
    first.handoff(snapshot, origin);
    const before = fs.readJsonSync(path.join(root, 'fence.json'));
    const second = open();
    expect(second.previous).toEqual({handoffProved: true, reason: null, origin, snapshot});
    const after = fs.readJsonSync(path.join(root, 'fence.json'));
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.issuer).not.toBe(before.issuer);
    expect(fs.readJsonSync(path.join(root, 'issuer.json')).phase).toBe('active');
    expect(fs.readJsonSync(path.join(root, 'issuer.json')).snapshot).toEqual(snapshot);
    expect(() => first.write(snapshot)).toThrow(/issuer-closed/);
    second.close();
    expect(open().previous).toMatchObject({handoffProved: false, reason: 'unclean-issuer-exit', snapshot});
});

test('an active record after an unclean exit carries evidence but no recovery authority', () => {
    const first = open();
    first.write(snapshot, origin);
    first.close();
    expect(open().previous).toEqual({handoffProved: false, reason: 'unclean-issuer-exit', origin, snapshot});
});

test('replaying an earlier clean handoff cannot cross the consumed fence', () => {
    const first = open();
    first.handoff(snapshot, origin);
    const old    = fs.readFileSync(path.join(root, 'issuer.json'));
    const second = open();
    expect(second.previous.handoffProved).toBe(true);
    second.close();
    fs.writeFileSync(path.join(root, 'issuer.json'), old, {mode: 0o600});
    expect(open().previous).toMatchObject({handoffProved: false, reason: 'handoff-replayed'});
});

test('a crash between consuming the fence and publishing the successor state never reuses the handoff', () => {
    open().handoff(snapshot, origin);
    expect(() => open({writeAtomic: (file, text, options) => {
        if (path.basename(file) === 'issuer.json') throw Error('fixture crash');
        return writeFileAtomicSync(file, text, options);
    }})).toThrow(/durability-failed/);
    expect(open().previous).toMatchObject({handoffProved: false, reason: 'handoff-replayed'});
});

test('a failed revocation write makes handoff impossible and old active bytes remain unproved', () => {
    let   fail  = false;
    const first = open({writeAtomic: (file, text, options) => {
        if (fail) throw Error('fixture lost write');
        return writeFileAtomicSync(file, text, options);
    }});
    first.write(snapshot, origin);
    fail = true;
    const revoked = {version: 1, generations: [{id: 'original-start', state: 'revoked'}]};
    expect(() => first.write(revoked)).toThrow(/durability-failed/);
    expect(() => first.handoff(snapshot, origin)).toThrow(/durability-failed/);
    first.close();
    expect(open().previous).toMatchObject({handoffProved: false, reason: 'unclean-issuer-exit'});
});

test('successful revocation survives a later clean handoff', () => {
    const first = open(), revoked = {version: 1, generations: [{id: 'original-start', state: 'revoked'}]};
    first.write(snapshot, origin);
    first.write(revoked);
    first.handoff(revoked, origin);
    expect(open().previous).toMatchObject({handoffProved: true, snapshot: revoked});
});

test('the existing file lease excludes a second live issuer', () => {
    const first = open();
    expect(() => open()).toThrow(/refuses to start a duplicate/);
    first.write(snapshot, origin);
});

test('strict file and directory syncs are requested for every transition', () => {
    const writes = [];
    const first  = open({writeAtomic: (file, text, options) => {
        writes.push({file: path.basename(file), fsync: options.fsync, mode: options.mode});
        return writeFileAtomicSync(file, text, options);
    }});
    first.write(snapshot, origin);
    first.handoff(snapshot, origin);
    expect(writes.map(row => row.file)).toEqual(['fence.json', 'issuer.json', 'issuer.json', 'issuer.json']);
    expect(writes.every(row => row.fsync === true && row.mode === 0o600)).toBe(true);
});

test('first-run custody creation flushes every newly created directory entry before publication', () => {
    const names     = new Map(), flushed = [];
    const directory = path.join(root, 'new-parent', 'admission');
    open({directory, fileSystem: {
        ...fs,
        openSync(file, ...args) {
            const fd = fs.openSync(file, ...args);
            names.set(fd, file);
            return fd;
        },
        fsyncSync(fd) { flushed.push(names.get(fd)); return fs.fsyncSync(fd); }
    }});
    expect(flushed.slice(0, 3)).toEqual([directory, path.dirname(directory), root]);
});

test('unknown versions, malformed records and mismatched file pairs refuse before recovery', () => {
    const first = open();
    first.write(snapshot, origin);
    first.close();
    const file = path.join(root, 'issuer.json'), saved = fs.readJsonSync(file);
    fs.writeJsonSync(file, {...saved, version: 999});
    expect(() => open()).toThrow(/record-invalid/);
    fs.writeFileSync(file, '{broken');
    expect(() => open()).toThrow(/record-unreadable/);
    fs.removeSync(file);
    expect(() => open()).toThrow(/record-invalid/);
});

test('unclassified snapshot fields cannot enter the durable record', () => {
    const first = open();
    expect(() => first.write({...snapshot, env: {GH_TOKEN: 'fixture-secret'}})).toThrow(/snapshot-invalid/);
    expect(fs.readFileSync(path.join(root, 'issuer.json'), 'utf8')).not.toContain('fixture-secret');
});

test('symlinked or widened record custody refuses', () => {
    const first = open();
    first.close();
    const file = path.join(root, 'issuer.json');
    fs.chmodSync(file, 0o644);
    expect(() => open()).toThrow(/record-custody/);
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, file + '.copy');
    fs.symlinkSync(file + '.copy', file);
    expect(() => open()).toThrow(/record-unreadable/);
});

/** @summary Captures durable state and lease identity while excluding ordinary read-access timestamps. */
function custody() {
    return fs.readdirSync(root).sort().map(name => {
        const file = path.join(root, name), stat = fs.statSync(file, {bigint: true});
        return {name, source: fs.readFileSync(file).toString('base64'),
            metadata: ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key]))};
    });
}

test('inspection creates nothing and neither takes the live lease nor consumes a clean handoff', () => {
    const missing = path.join(root, 'never-created');
    expect(readLaunchAdmissionJournal({directory: missing, validateSnapshot})).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);
    expect(readLaunchAdmissionJournal({directory: root, validateSnapshot})).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);

    const first = open();
    first.write(snapshot, origin);
    const activeBytes = custody();
    const active      = readLaunchAdmissionJournal({directory: root, validateSnapshot});
    expect(active).toMatchObject({handoffProved: false, reason: 'handoff-not-completed', state: {phase: 'active', snapshot}});
    expect(custody()).toEqual(activeBytes);
    first.handoff(snapshot, origin);
    const sealedBytes = custody();
    const sealed      = readLaunchAdmissionJournal({directory: root, validateSnapshot});
    expect(sealed).toMatchObject({handoffProved: true, reason: null, state: {issuer: active.state.issuer, epoch: active.state.epoch, snapshot}});
    expect(custody()).toEqual(sealedBytes);
    expect(open().previous).toMatchObject({handoffProved: true, snapshot});
    expect(readLaunchAdmissionJournal({directory: root, validateSnapshot})).toMatchObject({handoffProved: false});
});

test('inspection never promotes replayed, malformed or widened-custody evidence', () => {
    open().handoff(snapshot, origin);
    const file = path.join(root, 'issuer.json'), old = fs.readFileSync(file);
    open().close();
    fs.writeFileSync(file, old);
    expect(readLaunchAdmissionJournal({directory: root, validateSnapshot})).toMatchObject({handoffProved: false, reason: 'handoff-replayed'});
    fs.chmodSync(file, 0o644);
    expect(() => readLaunchAdmissionJournal({directory: root, validateSnapshot})).toThrow(/record-custody/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{broken');
    expect(() => readLaunchAdmissionJournal({directory: root, validateSnapshot})).toThrow(/record-unreadable/);
    fs.removeSync(file);
    expect(() => readLaunchAdmissionJournal({directory: root, validateSnapshot})).toThrow(/record-invalid/);
});

test('the read-only package entry uses the production snapshot codec without an issuer instance', async () => {
    const reader     = await import('neo-agent-brain/launch-admission-journal');
    const production = {version: 6, generations: [], seats: []};
    open({emptySnapshot: production, validateSnapshot: isAdmissionSnapshot}).handoff(production);
    expect(reader.readLaunchAdmissionJournal({directory: root})).toMatchObject({handoffProved: true});
    const file = path.join(root, 'issuer.json'), state = fs.readJsonSync(file);
    fs.writeJsonSync(file, {...state, snapshot: {...production, env: {GH_TOKEN: 'fixture-secret'}}});
    expect(() => reader.readLaunchAdmissionJournal({directory: root})).toThrow(/record-invalid/);
    fs.writeJsonSync(file, {...state, env: {GH_TOKEN: 'fixture-secret'}});
    expect(() => reader.readLaunchAdmissionJournal({directory: root})).toThrow(/record-invalid/);
});

test('inspection refuses a successor fence published between its record reads', () => {
    open().handoff(snapshot, origin);
    const file       = path.join(root, 'fence.json');
    let   fenceReads = 0;
    expect(() => readLaunchAdmissionJournal({directory: root, validateSnapshot, fileSystem: {
        ...fs,
        openSync(name, ...args) {
            if (name === file && ++fenceReads === 2) {
                const fence = fs.readJsonSync(file);
                writeFileAtomicSync(file, JSON.stringify({...fence, epoch: fence.epoch + 1}), {mode: 0o600, fsync: true});
            }
            return fs.openSync(name, ...args);
        }
    }})).toThrow(/record-changed/);
});

test('inspection refuses a replaced custody directory even when its record bytes match', () => {
    open().handoff(snapshot, origin);
    const parked     = root + '.parked', fenceFile = path.join(root, 'fence.json');
    let   fenceReads = 0;
    try {
        expect(() => readLaunchAdmissionJournal({directory: root, validateSnapshot, fileSystem: {
            ...fs,
            openSync(name, ...args) {
                if (name === fenceFile && ++fenceReads === 2) {
                    fs.renameSync(root, parked);
                    fs.mkdirSync(root, {mode: 0o700});
                    for (const file of ['issuer.json', 'fence.json']) fs.copyFileSync(path.join(parked, file), path.join(root, file));
                }
                return fs.openSync(name, ...args);
            }
        }})).toThrow(/record-changed/);
    } finally { fs.removeSync(parked); }
});

test('the update guard excludes a successor without consuming the handoff it must recover', () => {
    const first = open();
    first.write(snapshot, origin);
    const {state} = readLaunchAdmissionJournal({directory: root, validateSnapshot});
    first.handoff(snapshot, origin);
    const before = custody();
    const guard  = holdLaunchAdmissionHandoff({directory: root, validateSnapshot,
        expected: {issuer: state.issuer, epoch: state.epoch}});
    try {
        expect(guard.evidence.handoffProved).toBe(true);
        expect(() => open()).toThrow(/refuses to start a duplicate/);
        guard.assertCurrent();
        expect(custody().filter(row => row.name !== 'issuer.lock')).toEqual(before);
        // A caller may inspect its detached evidence without changing the guard's comparison.
        guard.evidence.state.phase = 'active';
        guard.assertCurrent();
    } finally { guard.release(); }
    expect(() => guard.assertCurrent()).toThrow(/update-guard-closed/);
    guard.release();
    expect(open().previous).toMatchObject({handoffProved: true, snapshot});
});

test('missing, active and changed-issuer records cannot acquire the update guard', () => {
    expect(() => holdLaunchAdmissionHandoff({directory: path.join(root, 'missing'), validateSnapshot})).toThrow(/handoff-incomplete/);
    expect(fs.readdirSync(root)).toEqual([]);
    const first       = open();
    const activeBytes = custody();
    expect(() => holdLaunchAdmissionHandoff({directory: root, validateSnapshot})).toThrow(/handoff-incomplete/);
    expect(custody()).toEqual(activeBytes);
    first.handoff(snapshot, origin);
    const {state} = readLaunchAdmissionJournal({directory: root, validateSnapshot});
    expect(() => holdLaunchAdmissionHandoff({directory: root, validateSnapshot,
        expected: {issuer: state.issuer, epoch: state.epoch + 1}})).toThrow(/issuer-changed/);
    expect(open().previous.handoffProved).toBe(true);
});

test('changed handoff bytes refuse under the update lease and failure cleanup releases exclusion', () => {
    open().handoff(snapshot, origin);
    const guard = holdLaunchAdmissionHandoff({directory: root, validateSnapshot});
    try {
        const file = path.join(root, 'issuer.json'), state = fs.readJsonSync(file);
        fs.writeJsonSync(file, {...state, snapshot: {version: 1, generations: []}});
        expect(() => guard.assertCurrent()).toThrow(/handoff-changed/);
    } finally { guard.release(); }
    expect(open().previous.handoffProved).toBe(true);
});

test('a successor between inspection and lease acquisition invalidates the guard and releases its lease', () => {
    open().handoff(snapshot, origin);
    expect(() => holdLaunchAdmissionHandoff({directory: root, validateSnapshot, acquireLease: options => {
        open().close();
        return acquireFileLease(options);
    }})).toThrow(/handoff-changed/);
    expect(fs.existsSync(path.join(root, 'issuer.lock'))).toBe(false);
    expect(open().previous).toMatchObject({handoffProved: false, reason: 'unclean-issuer-exit'});
});

test('contended update release refuses before open and a later process can recover after the installer exits', async () => {
    const script = `
        const {openLaunchAdmissionJournal,holdLaunchAdmissionHandoff,isAdmissionSnapshot} = await import('neo-agent-brain/launch-admission-journal');
        const directory=process.argv[1], snapshot={version:6,generations:[],seats:[]};
        openLaunchAdmissionJournal({directory,validateSnapshot:isAdmissionSnapshot,emptySnapshot:snapshot}).handoff(snapshot);
        const guard=holdLaunchAdmissionHandoff({directory});
        process.send({state:'held'});
        process.once('message',()=>{
            let result;
            try {guard.release();result={state:'released'};}
            catch(error) {result={state:'refused',reason:error.reason};}
            process.send(result,()=>process.exit(0));
        });
    `;
    const child    = spawn(process.execPath, ['--input-type=module', '-e', script, root], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    const exited   = once(child, 'exit');
    const guardDir = path.join(root, 'issuer.lock.lifecycle-guard');
    try {
        expect((await once(child, 'message'))[0]).toEqual({state: 'held'});
        fs.mkdirSync(guardDir);
        fs.writeFileSync(path.join(guardDir, 'owner-test-transition'), '');
        const reply = once(child, 'message');
        child.send('release');
        expect((await reply)[0]).toEqual({state: 'refused', reason: 'update-release-unproved'});
        expect(await exited).toEqual([0, null]);
        expect(fs.existsSync(path.join(root, 'issuer.lock'))).toBe(true);
        fs.removeSync(guardDir);
        const successor = open({validateSnapshot: isAdmissionSnapshot, emptySnapshot: {version: 6, generations: [], seats: []}});
        expect(successor.previous.handoffProved).toBe(true);
    } finally {
        fs.removeSync(guardDir);
        if (child.exitCode === null) { child.kill(); await exited; }
    }
});

test('update release leaves a different owner untouched and refuses an unreadable lease', () => {
    open().handoff(snapshot, origin);
    const guard = holdLaunchAdmissionHandoff({directory: root, validateSnapshot});
    const file  = path.join(root, 'issuer.lock'), original = fs.readJsonSync(file);
    fs.writeJsonSync(file, {...original, ownerToken: 'different-fixture-owner'});
    expect(guard.release()).toBe(true);
    expect(fs.readJsonSync(file).ownerToken).toBe('different-fixture-owner');
    fs.removeSync(file);
    const next = holdLaunchAdmissionHandoff({directory: root, validateSnapshot});
    fs.writeFileSync(file, '{broken');
    expect(() => next.release()).toThrow(/update-release-unproved/);
    expect(() => next.release()).toThrow(/update-release-unproved/);
    fs.removeSync(file);
    expect(next.release()).toBe(true);
});
