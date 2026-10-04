import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    ensureSeatEnvFile,
    FLEET_BLOCK_END,
    FLEET_BLOCK_START,
    readSeatEnvOperatorKeys,
    seatEnvFilePath,
    seatEnvKeys
} from '../../../../../../ai/services/fleet/seatEnvFile.mjs';

/**
 * @summary A seat's own `.env`, on real temp folders: it sits in the seat folder and is owner-only, the
 * Fleet converges only its block, and the operator's lines survive every Start byte for byte.
 */
test.describe('seatEnvFile — a Fleet block plus the operator\'s keys', () => {
    let root, seatHome;

    test.beforeEach(() => {
        root     = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-env-'));
        seatHome = path.join(root, 'agents', 'neo-fable')
    });

    test.afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('the file sits in the seat folder, owner-only, and holds the Fleet block alone at first', async () => {
        const file = await ensureSeatEnvFile({seatHome});

        expect(file).toBe(path.join(seatHome, '.env'));
        expect(seatEnvFilePath(seatHome)).toBe(file);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(file, 'utf8')).toBe(`${FLEET_BLOCK_START}\n${FLEET_BLOCK_END}\n`)
    });

    test('the Fleet converges only its block; the operator\'s lines, comments and order survive byte for byte', async () => {
        const file     = await ensureSeatEnvFile({seatHome}),
              operator = '# the second forge\nNEO_GITLAB_HOST=gitlab.example.com\n\nexport CLIENT_TOKEN="a b"\nZED=1\n';

        fs.appendFileSync(file, operator);
        await ensureSeatEnvFile({seatHome, fleetKeys: {NEO_SEAT_SKIN: 'dark'}});
        await ensureSeatEnvFile({seatHome, fleetKeys: {NEO_SEAT_SKIN: 'light'}});

        expect(fs.readFileSync(file, 'utf8')).toBe(`${FLEET_BLOCK_START}\nNEO_SEAT_SKIN=light\n${FLEET_BLOCK_END}\n${operator}`);

        // a file the operator wrote before the Fleet ever did keeps every byte, below the block
        fs.writeFileSync(file, operator);
        await ensureSeatEnvFile({seatHome});

        expect(fs.readFileSync(file, 'utf8')).toBe(`${FLEET_BLOCK_START}\n${FLEET_BLOCK_END}\n${operator}`)
    });

    test('an unchanged file is not rewritten, and a mode the operator widened is narrowed again', async () => {
        const file = await ensureSeatEnvFile({seatHome});

        fs.chmodSync(file, 0o644);

        const before = fs.statSync(file).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 15));
        await ensureSeatEnvFile({seatHome});

        expect(fs.statSync(file).mtimeMs, 'same content, no write').toBe(before);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    });

    test('the operator\'s keys are read from outside the block, comments and exports included; an absent file sets none', async () => {
        expect(readSeatEnvOperatorKeys(seatHome)).toEqual([]);

        const file = await ensureSeatEnvFile({seatHome, fleetKeys: {NEO_SEAT_SKIN: 'dark'}});

        fs.appendFileSync(file, '# GH_TOKEN=commented out\nexport GH_TOKEN=ghp_x\nOTHER = 1\n');

        expect(readSeatEnvOperatorKeys(seatHome), 'the Fleet block is not the operator\'s').toEqual(['GH_TOKEN', 'OTHER']);
        expect(seatEnvKeys('A=1\n#B=2\n  export C=3\nnot a line\n')).toEqual(['A', 'C'])
    });

    test('a Fleet key that is not a one-line key and value is refused before anything is written', async () => {
        await expect(ensureSeatEnvFile({seatHome, fleetKeys: {'BAD KEY': 'x'}})).rejects.toThrow(TypeError);
        await expect(ensureSeatEnvFile({seatHome, fleetKeys: {GOOD: 'two\nlines'}})).rejects.toThrow(TypeError);
        expect(fs.existsSync(seatEnvFilePath(seatHome))).toBe(false)
    });
});
