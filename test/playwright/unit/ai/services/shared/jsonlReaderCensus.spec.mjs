import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import path           from 'node:path';
import os             from 'node:os';

const allowed = new Set([
    'services/shared/bundlePayload.mjs',
    'scripts/setup/firstRun.mjs'
]);

/**
 * @summary Finds direct readline imports, including aliases, outside the reader and interactive prompt.
 * @param {String} root
 * @returns {String[]}
 */
function directReaders(root) {
    return fs.readdirSync(root, {recursive: true, withFileTypes: true})
        .filter(entry => entry.isFile() && /\.[cm]?js$/.test(entry.name))
        .map(entry => path.join(entry.parentPath, entry.name))
        .filter(file => /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?readline(?:\/promises)?['"]/.test(fs.readFileSync(file, 'utf8')))
        .map(file => path.relative(root, file).split(path.sep).join('/'))
        .filter(file => !allowed.has(file))
        .sort();
}

test('all JSONL readers use the shared reader; only firstRun may prompt directly', () => {
    expect(directReaders(path.resolve('ai'))).toEqual([]);
});

test('the census rejects new direct readers, including aliases, but allows the named prompt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-reader-census-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts/setup'), {recursive: true});
        fs.writeFileSync(path.join(root, 'scripts/setup/firstRun.mjs'), "import readline from 'node:readline/promises';");
        expect(directReaders(root)).toEqual([]);
        fs.writeFileSync(path.join(root, 'new-reader.mjs'), "import {createInterface as readLines} from 'node:readline';");
        expect(directReaders(root)).toEqual(['new-reader.mjs']);
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});
