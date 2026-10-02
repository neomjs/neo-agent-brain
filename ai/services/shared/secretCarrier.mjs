/**
 * @module ai/services/shared/secretCarrier
 * @summary The one sanctioned adapter between a secret's two carriers: the value leaf (`X`) and its
 * file sibling (`X_FILE`). A use site reads both resolved leaves from `AiConfig` and hands them here;
 * this module decides which carrier holds the credential and reads the file at that moment — never at
 * module load, never from `process.env`, never by exporting the value. Exactly one carrier may be set:
 * both is a configuration error named by both leaf names, neither is an error only when the caller
 * requires a credential. Errors name the carrier, never its contents.
 *
 * Mirrors the bootstrap-PAT shape the auth service already keeps (`providerBootstrapPat` /
 * `providerBootstrapPatFile`), generalized so the provider keys get the same custody without a
 * fourth shape.
 */

import {readFileSync} from 'node:fs';

const text = value => typeof value === 'string' ? value.trim() : '';

/**
 * @summary Reads a credential from exactly one of its two carriers.
 * @param {Object} options
 * @param {String}   options.value           The resolved value leaf.
 * @param {String}   options.file            The resolved file-sibling leaf (a path).
 * @param {String}   options.valueName       The value leaf's name, for the error text.
 * @param {String}   options.fileName        The file leaf's name, for the error text.
 * @param {Boolean}  [options.required=false] Whether an unset credential is an error.
 * @param {Function} [options.readFile=readFileSync] `(path, 'utf8') → String`; injected by specs.
 * @returns {String} The credential, or `''` when neither carrier is set and none is required.
 */
export function readSecretCarrier({value, file, valueName, fileName, required = false, readFile = readFileSync}) {
    const
        direct   = text(value),
        filePath = text(file);

    if (direct && filePath) {
        throw new Error(`secretCarrier: exactly one of ${valueName} or ${fileName} may be set; both are.`);
    }

    if (direct) {
        return direct;
    }

    if (!filePath) {
        if (required) {
            throw new Error(`secretCarrier: a credential is required; set ${valueName} or ${fileName}.`);
        }

        return '';
    }

    let content;

    try {
        content = readFile(filePath, 'utf8');
    } catch {
        throw new Error(`secretCarrier: cannot read the file named by ${fileName}.`);
    }

    const credential = text(content);

    if (!credential) {
        throw new Error(`secretCarrier: the file named by ${fileName} contains no credential.`);
    }

    return credential;
}
