import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    detectMemoryCandidates,
    importSeatMemory,
    memoryDestination,
    MEMORY_IMPORT_RECEIPT,
    normalizeMemoryImport
} from '../../../../../../ai/services/fleet/seatMemoryImport.mjs';

/**
 * @summary An adopted seat's memory import, on real temp folders: the consent names only agent memory,
 * the destination follows the seat's family, the copy never moves and never repeats, and Start refuses
 * a consented import that reads empty.
 */
test.describe('seatMemoryImport — an adopted seat keeps its memory', () => {
    let root, home, agents;

    const
        write = (dir, files) => {
            fs.mkdirSync(dir, {recursive: true});
            Object.entries(files).forEach(([name, text]) => fs.writeFileSync(path.join(dir, name), text))
        },
        claudeSource = () => path.join(home, '.claude', 'projects', '-Users-x-neo', 'memory'),
        seat         = (memoryImport, harnessType = 'claude-desktop') => ({id: 'neo-fable', harnessType, ...(memoryImport ? {memoryImport} : {})}),
        importFor    = agent => importSeatMemory({agent, instanceRoot: agents, homeDir: home, now: () => '2026-10-03T11:00:00.000Z'});

    test.beforeEach(() => {
        root   = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-memory-'));
        home   = path.join(root, 'home');
        agents = path.join(root, 'agents');
        fs.mkdirSync(agents, {recursive: true})
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('the consent names an agent memory folder or none, and nothing else', () => {
        const h = '/Users/x';

        expect(normalizeMemoryImport('none', {homeDir: h})).toBe('none');
        expect(normalizeMemoryImport(`${h}/.claude/projects/-Users-x-neo/memory`, {homeDir: h})).toBe(`${h}/.claude/projects/-Users-x-neo/memory`);
        expect(normalizeMemoryImport(`${h}/.codex/memories`, {homeDir: h})).toBe(`${h}/.codex/memories`);
        expect(normalizeMemoryImport(`${h}/.codex-instances/emmy/memories/`, {homeDir: h})).toBe(`${h}/.codex-instances/emmy/memories`);

        for (const value of [`${h}/.ssh`, `${h}/.claude/projects/a/memory/inner`, `${h}/.claude/projects/../memory`, '/etc', 'relative/memory', '', null, 42]) {
            expect(() => normalizeMemoryImport(value, {homeDir: h}), String(value)).toThrow(TypeError)
        }
    });

    test('the destination is a function of the seat\'s family', () => {
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'claude-desktop'})).toBe(path.join(agents, 'a', 'memory'));
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'claude-code'})).toBe(path.join(agents, 'a', 'memory'));
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'codex'})).toBe(path.join(agents, 'a', 'harness', 'codex', 'memories'));
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'codex-desktop'})).toBe(path.join(agents, 'a', 'harness', 'codex-desktop', 'codex-home', 'memories'));
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'opencode'})).toBeNull()
    });

    test('detection lists the memory folders that hold files, most first, by name, notes and newest change, and reads nothing else', async () => {
        const
            homeSlug = home.replace(/[^A-Za-z0-9]/g, '-'),
            inHome   = path.join(home, '.claude', 'projects', `${homeSlug}-code-neo`, 'memory'),
            at       = (dir, file, iso) => fs.utimesSync(path.join(dir, file), new Date(iso), new Date(iso));

        write(claudeSource(), {'MEMORY.md': 'CONTENT-1', 'a.md': 'CONTENT-2', 'b.md': 'CONTENT-3', 'c.md': 'CONTENT-4'});
        write(inHome, {'MEMORY.md': 'CONTENT-5', 'a.md': 'CONTENT-6', 'b.md': 'CONTENT-7'});
        write(path.join(home, '.claude', 'projects', '-Users-x-empty', 'memory'), {});
        write(path.join(home, '.codex', 'memories'), {'MEMORY.md': 'CONTENT-8'});
        write(path.join(home, '.codex-instances', 'emmy', 'memories'), {'MEMORY.md': 'CONTENT-9', 'x.md': 'CONTENT-10'});
        write(path.join(home, '.ssh'), {'id_rsa': 'never'});

        at(claudeSource(), 'MEMORY.md', '2026-10-01T09:00:00.000Z');
        at(claudeSource(), 'a.md',      '2026-10-02T18:30:00.000Z');
        at(claudeSource(), 'b.md',      '2026-09-30T07:00:00.000Z');
        at(claudeSource(), 'c.md',      '2026-09-29T07:00:00.000Z');
        ['MEMORY.md', 'a.md', 'b.md'].forEach(file => at(inHome, file, '2026-10-03T08:00:00.000Z'));
        at(path.join(home, '.codex', 'memories'), 'MEMORY.md', '2026-08-01T00:00:00.000Z');
        at(path.join(home, '.codex-instances', 'emmy', 'memories'), 'MEMORY.md', '2026-10-03T11:15:00.000Z');
        at(path.join(home, '.codex-instances', 'emmy', 'memories'), 'x.md',      '2026-10-03T10:00:00.000Z');

        const candidates = await detectMemoryCandidates({homeDir: home});

        expect(candidates).toEqual([
            {family: 'claude', source: claudeSource(), name: 'Users-x-neo', notes: 4, lastChanged: '2026-10-02T18:30:00.000Z'},
            {family: 'claude', source: inHome,         name: 'code-neo',    notes: 3, lastChanged: '2026-10-03T08:00:00.000Z'},
            {family: 'codex',  source: path.join(home, '.codex-instances', 'emmy', 'memories'), name: 'emmy', notes: 2, lastChanged: '2026-10-03T11:15:00.000Z'},
            {family: 'codex',  source: path.join(home, '.codex', 'memories'), name: 'codex', notes: 1, lastChanged: '2026-08-01T00:00:00.000Z'}
        ]);
        expect(JSON.stringify(candidates), 'names, counts and dates, never a file\'s contents').not.toMatch(/CONTENT-|never/);
        expect(await detectMemoryCandidates({homeDir: path.join(root, 'nobody')}), 'a home without agents').toEqual([])
    });

    test('a candidate\'s source is the consent defineAgent accepts, and its name is never its path', async () => {
        const homeSlug = home.replace(/[^A-Za-z0-9]/g, '-');

        write(claudeSource(), {'MEMORY.md': 'index'});
        write(path.join(home, '.claude', 'projects', homeSlug, 'memory'), {'MEMORY.md': 'a project at home'});
        write(path.join(home, '.codex-instances', 'neo-gpt-emmy', 'memories'), {'MEMORY.md': 'e'});

        const candidates = await detectMemoryCandidates({homeDir: home});

        expect(candidates.map(({name}) => name).sort()).toEqual(['Users-x-neo', 'neo-gpt-emmy', '~']);

        for (const {name, source} of candidates) {
            expect(normalizeMemoryImport(source, {homeDir: home}), name).toBe(source);
            expect(name, source).not.toContain(path.sep);
            expect(source, name).not.toBe(name)
        }
    });

    test('a fresh seat, or one that declined, imports nothing and is never checked', async () => {
        expect(await importFor(seat())).toEqual({state: 'none'});
        expect(await importFor(seat('none'))).toEqual({state: 'none'});
        expect(fs.readdirSync(agents)).toEqual([])
    });

    test('a consented import copies identical files owner-only, receipts the copy, and leaves the source', async () => {
        write(claudeSource(), {'MEMORY.md': 'index', 'feedback_x.md': 'lesson'});

        const result      = await importFor(seat(claudeSource())),
              destination = path.join(agents, 'neo-fable', 'memory');

        expect(result).toEqual({state: 'copied', source: claudeSource(), destination, files: 2});
        expect(fs.readFileSync(path.join(destination, 'feedback_x.md'), 'utf8')).toBe('lesson');
        expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
        expect(fs.readdirSync(claudeSource()).sort(), 'copied, never moved').toEqual(['MEMORY.md', 'feedback_x.md']);

        const receipt = JSON.parse(fs.readFileSync(path.join(agents, 'neo-fable', 'harness', 'claude-desktop', MEMORY_IMPORT_RECEIPT), 'utf8'));

        expect(receipt).toEqual({source: claudeSource(), destination, files: 2, copiedAt: '2026-10-03T11:00:00.000Z'})
    });

    test('the receipt only guards a second copy; the seat\'s own later memory is never overwritten', async () => {
        write(claudeSource(), {'MEMORY.md': 'index v1'});
        await importFor(seat(claudeSource()));

        const destination = path.join(agents, 'neo-fable', 'memory');

        fs.writeFileSync(path.join(destination, 'MEMORY.md'), 'the seat wrote this');
        fs.writeFileSync(path.join(claudeSource(), 'MEMORY.md'), 'index v2');

        expect(await importFor(seat(claudeSource()))).toEqual({state: 'present', source: claudeSource(), destination, files: 1});
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('the seat wrote this')
    });

    test('Start refuses a consented import that reads empty, naming the source, the destination and the step', async () => {
        const destination = path.join(agents, 'neo-fable', 'memory');

        // the source holds nothing
        await expect(importFor(seat(claudeSource()))).rejects.toMatchObject({
            code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: claudeSource(), destination, step: 'memory import'
        });

        // imported once, emptied since: the receipt is provenance, the status is the fresh read
        write(claudeSource(), {'MEMORY.md': 'index'});
        await importFor(seat(claudeSource()));
        fs.rmSync(path.join(destination, 'MEMORY.md'));

        const refusal = await importFor(seat(claudeSource())).catch(error => error);

        expect(refusal.code).toBe('FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED');
        expect(refusal.message).toBe("startAgentProvisioned: the memory import did not converge: the seat's memory folder holds none (it was imported once and is empty now). The seat does not start.")
    });

    test('every refusal leads with the step and its reason, and names neither the seat nor a host path', async () => {
        const
            reasons = [],
            refuse  = async (agent, fileSystem) => {
                const error = await importSeatMemory({agent, instanceRoot: agents, homeDir: home, ...(fileSystem ? {fileSystem} : {}), now: () => '2026-10-03T11:00:00.000Z'}).catch(error => error);

                expect(error, agent.memoryImport).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: agent.memoryImport, step: 'memory import'});
                reasons.push(error.message)
            };

        // a family that keeps no markdown memory, then a consent that names no memory folder
        await refuse(seat(claudeSource(), 'opencode'));
        write(path.join(home, '.ssh'), {'id_rsa': 'never'});
        await refuse(seat(path.join(home, '.ssh')));

        // a source that holds nothing, then a seat that already holds a different copy
        await refuse(seat(claudeSource()));
        write(claudeSource(), {'MEMORY.md': 'index'});
        write(path.join(agents, 'neo-fable', 'memory'), {'MEMORY.md': 'the seat wrote this'});
        await refuse(seat(claudeSource()));
        fs.rmSync(path.join(agents, 'neo-fable'), {recursive: true});

        // a copy that does not arrive identical
        await refuse(seat(claudeSource()), {...fs.promises, cp: async (from, to, options) => {
            await fs.promises.cp(from, to, options);
            fs.writeFileSync(path.join(to, 'MEMORY.md'), 'tampered')
        }});

        expect(reasons).toHaveLength(5);

        for (const reason of reasons) {
            expect(reason).toMatch(/^startAgentProvisioned: the memory import did not converge: .+\. The seat does not start\.$/);
            expect(reason, 'the card is the seat').not.toContain('neo-fable');
            expect(reason, 'source and destination travel as fields').not.toContain(root)
        }
    });

    test('a consent that names no memory folder, or a link in its place, imports nothing', async () => {
        write(path.join(home, '.ssh'), {'id_rsa': 'never'});
        await expect(importFor(seat(path.join(home, '.ssh')))).rejects.toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED'});

        // the memory folder is a link to a secret: refused, and nothing is copied
        fs.mkdirSync(path.dirname(claudeSource()), {recursive: true});
        fs.symlinkSync(path.join(home, '.ssh'), claudeSource());

        await expect(importFor(seat(claudeSource()))).rejects.toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED'});
        expect(fs.existsSync(path.join(agents, 'neo-fable', 'memory', 'id_rsa'))).toBe(false)
    });

    test('a link on any segment above the memory folder refuses the import and hides it from detection', async () => {
        const outside = path.join(root, 'outside', 'projects'),
              linked  = path.join(home, '.claude', 'projects');

        write(path.join(outside, '-Users-x-neo', 'memory'), {'MEMORY.md': 'not agent memory'});
        fs.mkdirSync(path.dirname(linked), {recursive: true});
        fs.symlinkSync(outside, linked);

        const refusal = await importFor(seat(claudeSource())).catch(error => error);

        expect(refusal).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: claudeSource(), step: 'memory import'});
        expect(refusal.message).toContain('a part of the source path is a link or a file, not a real folder');
        expect(refusal.message, 'the link travels in no reason').not.toContain(linked);
        expect(fs.existsSync(path.join(agents, 'neo-fable')), 'nothing read, nothing written').toBe(false);
        expect(await detectMemoryCandidates({homeDir: home})).toEqual([])
    });

    test('links inside the source, to a file or to a folder, are neither copied nor counted', async () => {
        write(claudeSource(), {'MEMORY.md': 'index'});
        write(path.join(home, '.ssh'), {'id_rsa': 'never'});
        fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(claudeSource(), 'leak.md'));
        fs.symlinkSync(path.join(home, '.ssh'), path.join(claudeSource(), 'keys'));

        const destination = path.join(agents, 'neo-fable', 'memory');

        expect(await importFor(seat(claudeSource()))).toEqual({state: 'copied', source: claudeSource(), destination, files: 1});
        expect(fs.readdirSync(destination)).toEqual(['MEMORY.md']);
        expect(await detectMemoryCandidates({homeDir: home})).toMatchObject([{family: 'claude', source: claudeSource(), notes: 1}])
    });

    test('a first import the seat contradicts is refused and changes nothing, until it is reconciled', async () => {
        write(claudeSource(), {'MEMORY.md': 'index', 'note.md': 'source note'});

        const destination = path.join(agents, 'neo-fable', 'memory'),
              receipt     = path.join(agents, 'neo-fable', 'harness', 'claude-desktop', MEMORY_IMPORT_RECEIPT);

        write(destination, {'note.md': 'the seat already wrote this'});

        const refusal = await importFor(seat(claudeSource())).catch(error => error);

        expect(refusal).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: claudeSource(), destination, step: 'memory import'});
        expect(refusal.message).toContain('the seat already holds a different note.md');
        expect(fs.readdirSync(destination), 'nothing copied').toEqual(['note.md']);
        expect(fs.readFileSync(path.join(destination, 'note.md'), 'utf8')).toBe('the seat already wrote this');
        expect(fs.existsSync(receipt)).toBe(false);

        // a source that holds nothing is a consent left unhonored too, whatever the seat holds
        await expect(importFor(seat(path.join(home, '.claude', 'projects', '-Users-x-empty', 'memory')))).rejects.toMatchObject({
            code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', message: expect.stringContaining('the source holds no memory to copy')
        });

        // reconciled: the seat now holds the source's words, and the next Start completes the import
        fs.writeFileSync(path.join(destination, 'note.md'), 'source note');

        expect(await importFor(seat(claudeSource()))).toEqual({state: 'copied', source: claudeSource(), destination, files: 2});
        expect(fs.existsSync(receipt)).toBe(true)
    });

    test('a Codex seat imports into its own CODEX_HOME, and a folder its preparation made ends owner-only', async () => {
        const source      = path.join(home, '.codex', 'memories'),
              destination = path.join(agents, 'neo-fable', 'harness', 'codex-desktop', 'codex-home', 'memories');

        write(source, {'MEMORY.md': 'codex index', 'raw_memories.md': 'raw'});

        // as the Codex preparer leaves it under umask 022, before Start imports
        fs.mkdirSync(destination, {recursive: true});
        fs.chmodSync(destination, 0o755);

        expect(await importFor(seat(source, 'codex-desktop'))).toEqual({state: 'copied', source, destination, files: 2});
        expect(fs.statSync(destination).mode & 0o777).toBe(0o700)
    });
});
