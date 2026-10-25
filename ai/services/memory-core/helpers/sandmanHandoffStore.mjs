import fs from 'fs-extra';
import {
    DEFAULT_HANDOFF_SECTIONS,
    normalizeRequestedSections,
    splitSandmanHandoffSections
} from './sandmanHandoffSections.mjs';

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000; // nightly cadence + slack
const DEFAULT_MAX_BYTES      = 256 * 1024;

/**
 * @summary Reads the Sandman handoff (`sandman_handoff.md`) with freshness metadata and section filtering.
 *
 * The handoff is the Dream Pipeline's morning surface (typed gaps, consolidation gaps, and
 * Golden Path recommendations), written nightly by the DreamService at the resolved
 * `handoffFilePath` config leaf. Local agents read it as a repo file; remote/container
 * agents have no filesystem access to it — this reader is the file-contract half of the
 * `get_sandman_handoff` MCP tool that serves them.
 *
 * By default (`sections = ['goldenPath']`), only the `## Computed Golden Path` section is
 * returned inside `sections.goldenPath` (`{content, bytes}`) with `content: null` and
 * `availableSections` listing all slugs present in the file so boot reads do not pay for
 * the gap audit sections unless requested. Passing `sections: 'all'` or `['*']` populates
 * `content` with the full file byte-identically to the whole-file read.
 *
 * Missing or unreadable files are an explicit payload, never a throw and never a silent
 * empty string: a cloud deployment whose writer persistence is not wired yet must get a
 * machine-readable reason its agents can react to.
 *
 * @param {Object} options
 * @param {String} options.filePath Resolved handoff path (`AiConfig.handoffFilePath`).
 * @param {Number} [options.now=Date.now()] Current time in epoch ms.
 * @param {Number} [options.staleAfterMs=129600000] Freshness window; <=0 disables stale classification.
 * @param {Number} [options.maxBytes=262144] Hard read-size cap.
 * @param {String|String[]} [options.sections=['goldenPath']] Section slugs to return (`'gaps'`, `'consolidation'`, `'goldenPath'`, `'focus'`), or `'all'` / `['*']` for the full file.
 * @returns {Promise<Object>} Sectioned (`{content: null, sections, availableSections, missingSections, ...}`)
 *          or whole-file (`{content, availableSections, ...}`) freshness envelope, or a `content: null`
 *          error envelope carrying a stable `reason` code.
 */
export async function readSandmanHandoff({
    filePath,
    now          = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    maxBytes     = DEFAULT_MAX_BYTES,
    sections     = DEFAULT_HANDOFF_SECTIONS
} = {}) {
    if (!filePath) {
        return unavailable({reason: 'handoff-path-unconfigured', staleAfterMs});
    }

    try {
        const stat = await fs.stat(filePath);

        if (stat.size > maxBytes) {
            return unavailable({filePath, reason: 'handoff-too-large', details: {size: stat.size, maxBytes}, staleAfterMs});
        }

        const content                             = await fs.readFile(filePath, 'utf8'),
              mtimeMs                             = stat.mtimeMs,
              ageMs                               = Math.max(0, now - mtimeMs),
              stale                               = staleAfterMs > 0 && ageMs > staleAfterMs,
              {sectionsBySlug, availableSections} = splitSandmanHandoffSections(content),
              {mode, requestedSlugs}              = normalizeRequestedSections(sections);

        if (mode === 'all') {
            return {
                content,
                path  : filePath,
                mtimeMs,
                ageMs,
                staleAfterMs,
                stale,
                reason: null,
                availableSections
            };
        }

        const selectedSections = {};
        const missingSections  = [];

        for (const slug of requestedSlugs) {
            if (Object.hasOwn(sectionsBySlug, slug)) {
                selectedSections[slug] = sectionsBySlug[slug];
            } else {
                selectedSections[slug] = null;
                missingSections.push(slug);
            }
        }

        return {
            content : null,
            path    : filePath,
            mtimeMs,
            ageMs,
            staleAfterMs,
            stale,
            reason  : null,
            sections: selectedSections,
            availableSections,
            missingSections
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return unavailable({filePath, reason: 'handoff-not-found', staleAfterMs});
        }

        return unavailable({filePath, reason: 'handoff-read-failed', details: {message: error.message}, staleAfterMs});
    }
}

function unavailable({filePath = null, reason, details = null, staleAfterMs}) {
    return {
        content: null,
        path   : filePath,
        mtimeMs: null,
        ageMs  : null,
        staleAfterMs,
        stale  : true,
        reason,
        details
    };
}
