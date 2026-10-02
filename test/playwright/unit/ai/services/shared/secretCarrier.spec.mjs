import {expect, test}     from '@playwright/test';
import {readSecretCarrier} from '../../../../../../ai/services/shared/secretCarrier.mjs';

// Pure over an injected file reader: no file is touched by any arm.

const
    names    = {valueName: 'openAiCompatible.apiKey', fileName: 'openAiCompatible.apiKeyFile'},
    SENTINEL = 'sk-SENTINEL-0123456789',
    reader   = files => (filePath, encoding) => {
        expect(encoding).toBe('utf8');

        if (!(filePath in files)) {
            throw new Error(`ENOENT ${filePath}`);
        }

        return files[filePath];
    };

test.describe('secretCarrier', () => {
    test('AC-1: exactly one carrier — the value wins when set alone, the file is read at the call, both set fails naming both leaves', () => {
        expect(readSecretCarrier({value: ` ${SENTINEL} `, file: '', ...names})).toBe(SENTINEL);
        expect(readSecretCarrier({value: '', file: '/run/secrets/key', ...names, readFile: reader({'/run/secrets/key': `${SENTINEL}\n`})})).toBe(SENTINEL);
        expect(() => readSecretCarrier({value: SENTINEL, file: '/run/secrets/key', ...names})).toThrow(/exactly one of openAiCompatible\.apiKey or openAiCompatible\.apiKeyFile may be set; both are\./);
    });

    test('neither carrier: empty unless required, and the required error names both leaves', () => {
        expect(readSecretCarrier({value: '', file: '', ...names})).toBe('');
        expect(readSecretCarrier({value: undefined, file: null, ...names})).toBe('');
        expect(() => readSecretCarrier({value: '', file: '', ...names, required: true})).toThrow(/a credential is required; set openAiCompatible\.apiKey or openAiCompatible\.apiKeyFile\./);
    });

    test('an unreadable or empty file fails naming the file leaf and never the path or the contents', () => {
        const unreadable = () => readSecretCarrier({value: '', file: '/run/secrets/missing', ...names, readFile: reader({})});

        expect(unreadable).toThrow(/cannot read the file named by openAiCompatible\.apiKeyFile\./);
        expect(unreadable).not.toThrow(/missing/);

        const empty = () => readSecretCarrier({value: '', file: '/run/secrets/key', ...names, readFile: reader({'/run/secrets/key': '  \n'})});

        expect(empty).toThrow(/contains no credential\./);
        expect(() => readSecretCarrier({value: '', file: '/run/secrets/key', ...names, readFile: reader({'/run/secrets/key': `${SENTINEL}`})})).not.toThrow();
    });

    test('the file is read only when the file carrier decides: a value never triggers a read', () => {
        let reads = 0;

        expect(readSecretCarrier({value: SENTINEL, file: '', ...names, readFile: () => { reads++; return 'other' }})).toBe(SENTINEL);
        expect(reads).toBe(0);
        expect(readSecretCarrier({value: '', file: '/k', ...names, readFile: () => { reads++; return 'other' }})).toBe('other');
        expect(reads).toBe(1);
    });
});
