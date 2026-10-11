import {test, expect}            from '@playwright/test';
import fs                        from 'node:fs';
import os                        from 'node:os';
import path                      from 'node:path';
import {deriveAgentInstanceHome} from '../../../../../../ai/services/fleet/deriveAgentInstanceHome.mjs';
import {deriveCodexHome}         from '../../../../../../ai/services/fleet/deriveHarnessLaunchSpec.mjs';
import {
    detectMemoryCandidates,
    importSeatMemory,
    memoryDestination,
    MEMORY_IMPORT_RECEIPT,
    normalizeMemoryImport,
    seatHoldsMemory
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

    test('every memory-capable family uses its seat-owned memory folder', () => {
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'claude-desktop'})).toBe(path.join(agents, 'a', 'memory'));
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'claude-code'})).toBe(path.join(agents, 'a', 'memory'));
        for (const harnessType of ['codex', 'codex-desktop', 'opencode', 'kimi-code']) {
            expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType})).toBe(path.join(agents, 'a', 'memory'))
        }
        expect(memoryDestination({instanceRoot: agents, agentId: 'a', harnessType: 'antigravity'})).toBeNull()
    });

    for (const harnessType of ['codex', 'codex-desktop']) {
        test(`${harnessType}: a scoped source belongs only to the selected, placed seat`, async () => {
            const agent  = {...seat(null, harnessType), seatHome: path.join(agents, 'neo-fable')},
                  source = path.join(deriveCodexHome({harnessType,
                      instanceHome: deriveAgentInstanceHome({instanceRoot: agents, agentId: agent.id, harnessType})}), 'memories'),
                  other = source.replace(`${path.sep}neo-fable${path.sep}`, `${path.sep}other-seat${path.sep}`),
                  options = {homeDir: home, instanceRoot: agents, agent};

            write(source, {'MEMORY.md': 'retained native notes'});
            write(other, {'MEMORY.md': 'another seat'});
            write(path.join(home, '.codex', 'memories'), {'MEMORY.md': 'classic notes'});

            expect(normalizeMemoryImport(source, options)).toBe(source);
            expect(() => normalizeMemoryImport(other, options)).toThrow();
            expect(() => normalizeMemoryImport(source, {homeDir: home})).toThrow();
            expect(() => normalizeMemoryImport(source, {...options, agent: {...agent, seatHome: path.join(root, 'old-seat')}})).toThrow();

            const metadataOnly = {...fs.promises, readFile: async () => {throw new Error('discovery read document contents')}};
            const candidates   = await detectMemoryCandidates({...options, fileSystem: metadataOnly});
            expect(candidates.map(candidate => candidate.source).sort()).toEqual([source, path.join(home, '.codex', 'memories')].sort());
            expect(candidates.find(candidate => candidate.source === source)).toMatchObject({family: 'codex', notes: 1});
            expect(await detectMemoryCandidates({homeDir: home})).toHaveLength(1);
            await expect(detectMemoryCandidates({...options, agent: {...agent, seatHome: path.join(root, 'old-seat')}})).rejects.toThrow();

            const result = await importFor({...agent, memoryImport: source});
            expect(result.state).toBe('copied');
            expect(fs.readFileSync(path.join(agents, agent.id, 'memory', 'MEMORY.md'), 'utf8')).toBe('retained native notes');
            expect(fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8')).toBe('retained native notes');
        });
    }

    test('managed source links and unreadable discovery fail instead of reporting an empty seat', async () => {
        const agent   = {...seat(null, 'codex'), seatHome: path.join(agents, 'neo-fable')},
              source  = path.join(agent.seatHome, 'harness', 'codex', 'memories'),
              options = {agent, instanceRoot: agents, homeDir: home};
        write(source, {'MEMORY.md': 'own'});
        write(path.join(root, 'outside'), {'private.md': 'never'});
        fs.symlinkSync(path.join(root, 'outside'), path.join(source, 'escape'), 'dir');
        await expect(detectMemoryCandidates(options)).rejects.toThrow(/link/);
        await expect(importFor({...agent, memoryImport: source})).rejects.toThrow(/link/);
        expect(fs.existsSync(path.join(agent.seatHome, 'memory'))).toBe(false);

        fs.unlinkSync(path.join(source, 'escape'));
        const unreadable = {...fs.promises, readdir: async (dir, opts) => {
            if (dir === source) throw Object.assign(new Error('unreadable'), {code: 'EACCES'});
            return fs.promises.readdir(dir, opts)
        }};
        await expect(detectMemoryCandidates({...options, fileSystem: unreadable})).rejects.toThrow('unreadable');
        fs.rmSync(source, {recursive: true});
        fs.symlinkSync(path.join(root, 'outside'), source, 'dir');
        await expect(detectMemoryCandidates(options)).rejects.toThrow(/link/);
        await expect(importFor({...agent, memoryImport: source})).rejects.toThrow(/link/);
    });

    test('managed consent must be renewed after a move; a completed import retains its receipt', async () => {
        const agent      = {...seat(null, 'codex'), seatHome: path.join(agents, 'neo-fable')},
              source     = path.join(agent.seatHome, 'harness', 'codex', 'memories'),
              movedRoot  = path.join(root, 'moved-agents'),
              movedAgent = {...agent, seatHome: path.join(movedRoot, agent.id), memoryImport: source};
        write(source, {'MEMORY.md': 'original'});
        await fs.promises.cp(agents, movedRoot, {recursive: true});
        await expect(importSeatMemory({agent: movedAgent, instanceRoot: movedRoot, homeDir: home})).rejects.toThrow(/no agent memory folder/);
        expect(fs.existsSync(path.join(movedAgent.seatHome, 'memory'))).toBe(false);

        await importFor({...agent, memoryImport: source});
        write(path.join(agent.seatHome, 'memory'), {'MEMORY.md': 'authored after import'});
        await fs.promises.rm(movedRoot, {recursive: true});
        await fs.promises.rename(agents, movedRoot);
        expect((await importSeatMemory({agent: movedAgent, instanceRoot: movedRoot, homeDir: home})).state).toBe('present');
        expect(fs.readFileSync(path.join(movedAgent.seatHome, 'memory', 'MEMORY.md'), 'utf8')).toBe('authored after import');
    });

    test('native notes require a choice before birth, while none, fresh and held memory keep their meanings', async () => {
        const agent       = {...seat(null, 'codex-desktop'), seatHome: path.join(agents, 'neo-fable')},
              source      = path.join(agent.seatHome, 'harness', 'codex-desktop', 'codex-home', 'memories'),
              destination = path.join(agent.seatHome, 'memory');

        expect(await importFor(agent)).toEqual({state: 'none'});
        write(source, {'MEMORY.md': 'native notes to choose'});
        await expect(importFor(agent)).rejects.toThrow(/explicit|choice|consent/i);
        expect(fs.existsSync(destination)).toBe(false);
        expect(await importFor({...agent, memoryImport: 'none'})).toEqual({state: 'none'});
        write(destination, {'MEMORY.md': 'seat-owned notes'});
        expect(await importFor(agent)).toEqual({state: 'none'});
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('seat-owned notes');
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

    test('a seat holds its memory once a receipt or any file exists at its destination; a never-started seat holds none', async () => {
        const holds = agent => seatHoldsMemory({agent, instanceRoot: agents});

        expect(await holds(seat()), 'never started').toBe(false);
        expect(await holds(seat(null, 'codex')), 'a Codex seat, never started').toBe(false);
        expect(await holds(seat(null, 'opencode')), 'a family that keeps no markdown memory').toBe(false);

        write(memoryDestination({instanceRoot: agents, agentId: 'neo-vega', harnessType: 'claude-desktop'}), {'MEMORY.md': 'the seat wrote this'});

        expect(await holds({id: 'neo-vega', harnessType: 'claude-desktop'}), 'memory the seat wrote itself, with no import').toBe(true);

        write(claudeSource(), {'MEMORY.md': 'index'});
        await importFor(seat(claudeSource()));

        expect(await holds(seat()), 'a late consent converges like one born with the seat, and then it holds its memory').toBe(true);

        fs.rmSync(path.join(agents, 'neo-fable', 'memory'), {recursive: true});

        expect(await holds(seat()), 'the receipt alone: imported once, the folder emptied since').toBe(true)
    });

    test('a consented import copies identical files owner-only, receipts the copy, and leaves the source', async () => {
        write(claudeSource(), {'MEMORY.md': 'index', 'feedback_x.md': 'lesson'});

        const result      = await importFor(seat(claudeSource())),
              destination = path.join(agents, 'neo-fable', 'memory');

        expect(result).toEqual({state: 'copied', source: claudeSource(), destination, files: 2});
        expect(fs.readFileSync(path.join(destination, 'feedback_x.md'), 'utf8')).toBe('lesson');
        expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
        expect(fs.readdirSync(claudeSource()).sort(), 'copied, never moved').toEqual(['MEMORY.md', 'feedback_x.md']);

        const receipt = JSON.parse(fs.readFileSync(path.join(agents, 'neo-fable', MEMORY_IMPORT_RECEIPT), 'utf8'));

        expect(receipt).toEqual({source: claudeSource(), destination: 'memory', files: 2, copiedAt: '2026-10-03T11:00:00.000Z'})
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

    test('the canonical seat receipt survives a harness switch and protects authored memory', async () => {
        const
            source      = claudeSource(),
            destination = path.join(agents, 'neo-fable', 'memory');

        write(source, {'MEMORY.md': 'source index'});
        await importFor(seat(source, 'codex'));
        fs.writeFileSync(path.join(destination, 'MEMORY.md'), 'seat-authored after import');

        const result = await importFor(seat(source, 'codex-desktop'));

        expect(result).toEqual({state: 'present', source, destination, files: 1});
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('seat-authored after import')
    });

    test('a receipt survives a seat-root and home move when its destination is still the seat memory folder', async () => {
        const
            source            = claudeSource(),
            oldSeatRoot       = path.join(agents, 'neo-fable'),
            oldDestination    = path.join(oldSeatRoot, 'memory'),
            canonicalPath     = path.join(oldSeatRoot, MEMORY_IMPORT_RECEIPT),
            legacyReceiptPath = path.join(oldSeatRoot, 'harness', 'claude-desktop', MEMORY_IMPORT_RECEIPT),
            movedAgents       = path.join(root, 'moved-agents'),
            movedHome         = path.join(root, 'moved-home'),
            movedSeatRoot     = path.join(movedAgents, 'neo-fable'),
            movedDestination  = path.join(movedSeatRoot, 'memory');

        write(source, {'MEMORY.md': 'source before import'});
        await importFor(seat(source));
        fs.writeFileSync(path.join(oldDestination, 'MEMORY.md'), 'seat-authored bytes');
        const legacyReceipt = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

        legacyReceipt.destination = oldDestination;
        fs.mkdirSync(path.dirname(legacyReceiptPath), {recursive: true});
        fs.writeFileSync(legacyReceiptPath, JSON.stringify(legacyReceipt));
        fs.rmSync(canonicalPath);
        fs.mkdirSync(movedAgents);
        fs.mkdirSync(movedHome);
        fs.cpSync(oldSeatRoot, movedSeatRoot, {recursive: true});

        const movedSeat = seat(source, 'codex-desktop'),
              result    = await importSeatMemory({agent: movedSeat, instanceRoot: movedAgents, homeDir: movedHome});

        expect(result).toEqual({state: 'present', source, destination: movedDestination, files: 1});
        expect(await seatHoldsMemory({agent: movedSeat, instanceRoot: movedAgents})).toBe(true);
        expect(fs.readFileSync(path.join(movedDestination, 'MEMORY.md'), 'utf8')).toBe('seat-authored bytes');
        expect(fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8')).toBe('source before import');
        expect(JSON.parse(fs.readFileSync(path.join(movedSeatRoot, MEMORY_IMPORT_RECEIPT), 'utf8')).destination).toBe('memory');
        expect(fs.readFileSync(path.join(movedSeatRoot, 'harness', 'claude-desktop', MEMORY_IMPORT_RECEIPT), 'utf8'))
            .toBe(JSON.stringify(legacyReceipt))
    });

    test('a legacy Codex vendor receipt does not block importing into the seat memory folder', async () => {
        const
            harnessType    = 'codex-desktop',
            source         = path.join(home, '.codex', 'memories'),
            instanceHome   = path.join(agents, 'neo-fable', 'harness', harnessType, 'codex-home'),
            oldDestination = path.join(instanceHome, 'memories'),
            destination    = path.join(agents, 'neo-fable', 'memory'),
            receiptPath    = path.join(agents, 'neo-fable', 'harness', harnessType, MEMORY_IMPORT_RECEIPT),
            agent          = seat(source, harnessType);

        write(source, {'MEMORY.md': 'consented source'});
        write(oldDestination, {'MEMORY.md': 'native vendor bytes'});
        fs.writeFileSync(receiptPath, JSON.stringify({source, destination: oldDestination, files: 1, copiedAt: '2026-10-03T11:00:00.000Z'}));
        const legacyContents = fs.readFileSync(receiptPath, 'utf8');
        expect(await seatHoldsMemory({agent, instanceRoot: agents}), 'the old vendor receipt does not claim the empty seat destination').toBe(false);

        const result = await importFor(agent);

        expect(result).toEqual({state: 'copied', source, destination, files: 1});
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('consented source');
        expect(fs.readFileSync(path.join(oldDestination, 'MEMORY.md'), 'utf8')).toBe('native vendor bytes');
        expect(fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8')).toBe('consented source');
        expect(JSON.parse(fs.readFileSync(path.join(agents, 'neo-fable', MEMORY_IMPORT_RECEIPT), 'utf8')).destination).toBe('memory');
        expect(fs.readFileSync(receiptPath, 'utf8')).toBe(legacyContents)
    });

    test('a mismatched legacy receipt cannot overwrite authored bytes at the new destination', async () => {
        const
            harnessType    = 'codex-desktop',
            source         = path.join(home, '.codex', 'memories'),
            instanceHome   = path.join(agents, 'neo-fable', 'harness', harnessType, 'codex-home'),
            oldDestination = path.join(instanceHome, 'memories'),
            destination    = path.join(agents, 'neo-fable', 'memory'),
            receiptPath    = path.join(agents, 'neo-fable', 'harness', harnessType, MEMORY_IMPORT_RECEIPT),
            agent          = seat(source, harnessType);

        write(source, {'MEMORY.md': 'consented source'});
        write(oldDestination, {'MEMORY.md': 'vendor bytes'});
        write(destination, {'MEMORY.md': 'authored destination bytes'});
        fs.writeFileSync(receiptPath, JSON.stringify({source, destination: oldDestination, files: 1, copiedAt: '2026-10-03T11:00:00.000Z'}));

        const refusal = await importFor(agent).catch(error => error);

        expect(refusal).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, destination, step: 'memory import'});
        expect(refusal.message).toContain('the seat already holds a different MEMORY.md');
        expect(await seatHoldsMemory({agent, instanceRoot: agents})).toBe(true);
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('authored destination bytes');
        expect(fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8')).toBe('consented source');
        expect(fs.readFileSync(path.join(oldDestination, 'MEMORY.md'), 'utf8')).toBe('vendor bytes')
    });

    test('a valid mismatching canonical receipt blocks a matching legacy receipt and permits fresh import', async () => {
        const
            source        = claudeSource(),
            seatRoot      = path.join(agents, 'neo-fable'),
            destination   = path.join(seatRoot, 'memory'),
            canonicalPath = path.join(seatRoot, MEMORY_IMPORT_RECEIPT),
            legacyPath    = path.join(seatRoot, 'harness', 'codex', MEMORY_IMPORT_RECEIPT),
            legacy        = {source, destination: path.join(seatRoot, 'memory'), files: 1, copiedAt: '2026-10-03T11:00:00.000Z'};

        write(source, {'MEMORY.md': 'consented source'});
        fs.mkdirSync(path.dirname(legacyPath), {recursive: true});
        fs.writeFileSync(canonicalPath, JSON.stringify({source, destination: 'harness/codex/memories', files: 1, copiedAt: '2026-10-03T11:00:00.000Z'}));
        fs.writeFileSync(legacyPath, JSON.stringify(legacy));

        expect(await importFor(seat(source))).toEqual({state: 'copied', source, destination, files: 1});
        expect(fs.readFileSync(path.join(destination, 'MEMORY.md'), 'utf8')).toBe('consented source');
        expect(JSON.parse(fs.readFileSync(canonicalPath, 'utf8')).destination).toBe('memory');
        expect(fs.readFileSync(legacyPath, 'utf8')).toBe(JSON.stringify(legacy))
    });

    test('a corrupt canonical receipt refuses without falling back to a matching legacy receipt', async () => {
        const
            source        = claudeSource(),
            seatRoot      = path.join(agents, 'neo-fable'),
            destination   = path.join(seatRoot, 'memory'),
            canonicalPath = path.join(seatRoot, MEMORY_IMPORT_RECEIPT),
            legacyPath    = path.join(seatRoot, 'harness', 'codex', MEMORY_IMPORT_RECEIPT),
            legacy        = {source, destination: path.join(seatRoot, 'memory'), files: 1, copiedAt: '2026-10-03T11:00:00.000Z'};

        write(source, {'MEMORY.md': 'consented source'});
        fs.mkdirSync(path.dirname(legacyPath), {recursive: true});
        fs.writeFileSync(canonicalPath, '{broken');
        fs.writeFileSync(legacyPath, JSON.stringify(legacy));

        const refusal = await importFor(seat(source)).catch(error => error);

        expect(refusal).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, destination, step: 'memory import'});
        expect(refusal.message).toContain('the seat memory receipt is invalid');
        expect(fs.existsSync(destination)).toBe(false);
        expect(fs.readFileSync(legacyPath, 'utf8')).toBe(JSON.stringify(legacy))
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

    test('an import refuses symlinked seat, destination, nested directory, or destination file paths', async () => {
        const
            source       = claudeSource(),
            outside      = path.join(root, 'outside'),
            outsideFile  = path.join(outside, 'MEMORY.md'),
            seatRoot     = path.join(agents, 'neo-fable'),
            destination  = path.join(seatRoot, 'memory'),
            receiptPath  = path.join(seatRoot, MEMORY_IMPORT_RECEIPT),
            nestedSource = path.join(source, 'nested', 'MEMORY.md'),
            cases        = [
                ['seat', () => fs.symlinkSync(outside, seatRoot)],
                ['destination', () => {fs.mkdirSync(seatRoot, {recursive: true}); fs.symlinkSync(outside, destination)}],
                ['nested directory', () => {fs.mkdirSync(destination, {recursive: true}); fs.symlinkSync(outside, path.join(destination, 'nested'))}],
                ['nested file', () => {fs.mkdirSync(path.join(destination, 'nested'), {recursive: true}); fs.symlinkSync(outsideFile, path.join(destination, 'nested', 'MEMORY.md'))}],
                ['receipt file', () => {fs.mkdirSync(seatRoot, {recursive: true}); fs.symlinkSync(outsideFile, receiptPath)}]
            ];

        for (const [label, prepare] of cases) {
            fs.rmSync(seatRoot, {recursive: true, force: true});
            fs.rmSync(outside, {recursive: true, force: true});
            fs.mkdirSync(outside, {recursive: true});
            fs.writeFileSync(outsideFile, 'outside bytes');
            write(path.dirname(nestedSource), {'MEMORY.md': 'consented source'});
            prepare();

            const refusal = await importFor(seat(source)).catch(error => error);

            expect(refusal, label).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, step: 'memory import'});
            expect(fs.readFileSync(outsideFile, 'utf8'), label).toBe('outside bytes');
            expect(fs.existsSync(path.join(outside, 'nested', 'MEMORY.md')), label).toBe(false)
        }
    });

    test('a root may sit below a symlinked ancestor, but the root itself must be a real directory', async () => {
        const
            physical          = path.join(root, 'physical'),
            linked            = path.join(root, 'linked'),
            linkedAgents      = path.join(linked, 'agents'),
            linkedHome        = path.join(linked, 'home'),
            source            = path.join(linkedHome, '.claude', 'projects', 'fixture', 'memory'),
            linkedAgent       = {...seat(source), id: 'linked-root'},
            linkedDestination = path.join(physical, 'agents', 'linked-root', 'memory'),
            realAgents        = path.join(root, 'real-agents'),
            rootLink          = path.join(root, 'agents-root-link'),
            linkedRootAgent   = {...seat(source), id: 'linked-root-refused'};

        fs.mkdirSync(physical, {recursive: true});
        fs.symlinkSync(physical, linked);
        fs.mkdirSync(linkedAgents, {recursive: true});
        fs.mkdirSync(linkedHome, {recursive: true});
        write(source, {'MEMORY.md': 'consented source'});

        expect(await importSeatMemory({agent: linkedAgent, instanceRoot: linkedAgents, homeDir: linkedHome}))
            .toMatchObject({state: 'copied', destination: path.join(linkedAgents, 'linked-root', 'memory')});
        expect(fs.readFileSync(path.join(linkedDestination, 'MEMORY.md'), 'utf8')).toBe('consented source');

        fs.mkdirSync(realAgents);
        fs.symlinkSync(realAgents, rootLink);

        const refusal = await importSeatMemory({agent: linkedRootAgent, instanceRoot: rootLink, homeDir: linkedHome}).catch(error => error);

        expect(refusal).toMatchObject({code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source, step: 'memory import'});
        expect(fs.existsSync(path.join(realAgents, 'linked-root-refused', 'memory'))).toBe(false);
        expect(fs.readFileSync(path.join(source, 'MEMORY.md'), 'utf8')).toBe('consented source')
    });

    test('a first import the seat contradicts is refused and changes nothing, until it is reconciled', async () => {
        write(claudeSource(), {'MEMORY.md': 'index', 'note.md': 'source note'});

        const destination = path.join(agents, 'neo-fable', 'memory'),
              receipt     = path.join(agents, 'neo-fable', MEMORY_IMPORT_RECEIPT);

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

    test('a Codex seat imports into its seat-owned memory folder and it ends owner-only', async () => {
        const source      = path.join(home, '.codex', 'memories'),
              destination = path.join(agents, 'neo-fable', 'memory');

        write(source, {'MEMORY.md': 'codex index', 'raw_memories.md': 'raw'});

        // as the Codex preparer leaves it under umask 022, before Start imports
        fs.mkdirSync(destination, {recursive: true});
        fs.chmodSync(destination, 0o755);

        expect(await importFor(seat(source, 'codex-desktop'))).toEqual({state: 'copied', source, destination, files: 2});
        expect(fs.statSync(destination).mode & 0o777).toBe(0o700)
    });
});
