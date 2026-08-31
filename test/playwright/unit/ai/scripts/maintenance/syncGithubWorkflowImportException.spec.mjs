import {test, expect}       from '@playwright/test';
import {readFileSync}       from 'node:fs';
import {dirname, resolve}   from 'node:path';
import {fileURLToPath}      from 'node:url';
import {normalizeSpecifier} from '../../../../../../ai/scripts/lint/scriptPlaneClosure.mjs';

const
    // maintenance -> scripts -> ai -> unit -> playwright -> test -> repo root
    REPO_ROOT      = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    BARREL         = resolve(REPO_ROOT, 'ai/services.mjs'),
    EXCEPTION_SITE = resolve(REPO_ROOT, 'ai/scripts/maintenance/syncGithubWorkflow.mjs'),
    OPENAPI        = resolve(REPO_ROOT, 'ai/mcp/server/github-workflow/openapi.yaml');

/**
 * @summary First-party packages whose sources are OUR code reached through a package specifier.
 *
 * The Agent OS consumes the PUBLISHED Engine, so the Engine's `src/**` is named `neo.mjs/src/**`
 * here; an earlier layout kept those files in this repository, reached by a relative climb. A walker
 * that leaves every bare specifier unfollowed therefore stops dead at a boundary that did not exist
 * when it was written, and under-walks the graph it is measuring. Third-party packages stay
 * unfollowed on purpose — leaving them as leaves is precisely how the `barePackage` under test is
 * detected.
 * @type {Object}
 */
const FIRST_PARTY_PACKAGES = {
    'neo.mjs': resolve(REPO_ROOT, 'node_modules/neo.mjs')
};

/**
 * @summary Walks static `import` specifiers from an entry module and reports whether a bare package
 * is reachable.
 *
 * Static rather than executed: the property under test is what module RESOLUTION pulls in, which is
 * exactly what fails before any code runs. Importing the barrel to find out would fail the suite in
 * the same environments this is protecting.
 *
 * Which specifier forms it follows, stated so the next reader does not have to derive it:
 * - relative (`./`, `../`) — followed, resolved against the importing file;
 * - a subpath of a {@link FIRST_PARTY_PACKAGES} package (`neo.mjs/src/Neo.mjs`) — followed, resolved
 *   into `node_modules`, because that is our own source wearing a package name;
 * - every other bare specifier — a LEAF, deliberately. Following third-party graphs would change the
 *   property under test from "does our code import this package" into "does anything anywhere".
 *
 * A first-party specifier that resolves to a file that cannot be read falls through to the same leaf
 * handling as any other bare specifier, so a bad mapping shows up as a shrunken `walked` count
 * against the callers' non-vacuity floors rather than as a silent pass.
 *
 * @param {String} entry Absolute path.
 * @param {String} barePackage
 * @returns {{reached: Boolean, chain: String[], walked: Number}}
 */
function reachesPackage(entry, barePackage) {
    const seen = new Set();
    let   hit  = null;

    // Deliberately NOT short-circuited on `hit`. Both callers assert a non-vacuity floor on `walked`
    // BEFORE they assert `reached`, so a walk that stopped at the first hit would collapse `walked`
    // to the depth of that one chain — and a genuine `chromadb` regression on the stage entry would
    // fail the FLOOR ("check that the entry still resolves") instead of the property, pointing the
    // next reader at a file-resolution problem that does not exist. `walked` must mean "the graph we
    // measured", independent of the outcome, or the floor cannot coexist with the property it guards.
    const walk = (file, chain) => {
        if (seen.has(file) || seen.size > 5000) {
            return
        }

        seen.add(file);

        let source;

        try {
            source = readFileSync(file, 'utf8')
        } catch {
            return
        }

        for (const match of source.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)) {
            const specifier = match[1];

            let resolved;

            if (specifier.startsWith('.')) {
                resolved = resolve(dirname(file), specifier)
            } else {
                // Collapse subpaths to the package root before comparing. `specifier === barePackage`
                // saw only the bare root, so `import 'chromadb/subpath'` — reach into the forbidden
                // package by any reading — passed as clean. `normalizeSpecifier` is the repository's
                // existing authority for this and already handles the scoped-package case, so the
                // comparison is delegated rather than re-derived here.
                if (normalizeSpecifier(specifier) === normalizeSpecifier(barePackage)) {
                    // First chain wins — it is the one reported — but the walk continues, so
                    // `walked` still measures the whole graph. See the note on `walk` above.
                    hit ??= [...chain, file, specifier];
                    continue
                }

                const
                    packageName = Object.keys(FIRST_PARTY_PACKAGES).find(name => specifier.startsWith(`${name}/`)),
                    subPath     = packageName && specifier.slice(packageName.length + 1);

                // Not first-party, or the package root rather than a subpath: a leaf, as documented.
                if (!subPath) {
                    continue
                }

                resolved = resolve(FIRST_PARTY_PACKAGES[packageName], subPath)
            }

            if (!resolved.endsWith('.mjs') && !resolved.endsWith('.js')) {
                resolved += '.mjs'
            }

            walk(resolved, [...chain, file]);
        }
    };

    walk(entry, []);

    return {
        chain  : (hit ?? []).map(entryPath => entryPath.replace(`${REPO_ROOT}/`, '')),
        reached: hit !== null,
        walked : seen.size
    }
}

/**
 * @summary The mechanical sunset for the SDK-boundary exception in `syncGithubWorkflow.mjs`.
 *
 * A retirement trigger keyed to an event nothing observes can never fire, and it reads as coverage
 * while providing none — `// TODO: remove when #N lands` is observed by nobody. So the exception's
 * expiry is a test that goes RED on its own the moment the exception stops being necessary.
 *
 * Every assertion here is phrased so that FAILURE means "delete the exception" or "the exception no
 * longer holds what it promised" — never "add more exception".
 */
test.describe('syncGithubWorkflow SDK-boundary exception — self-expiring', () => {
    test('SUNSET: the barrel still reaches chromadb; when it stops, DELETE the exception', () => {
        const {reached, chain, walked} = reachesPackage(BARREL, 'chromadb');

        // The walk ran; a zero-walk "not reached" proves nothing. Calibration: the repaired walker
        // reaches 301 modules from the barrel, measured when this floor was last re-derived. 50 leaves
        // room for ordinary graph churn while still firing on a collapse — an entry that moved or
        // cannot be read walks 1. Re-derived rather than moved: 50 was already the right floor, and
        // nudging a working alarm to look re-calibrated is how alarms lose their teeth.
        expect(walked).toBeGreaterThan(50);

        expect(
            reached,
            'ai/services.mjs NO LONGER reaches chromadb, so the Body tier can import the barrel again. ' +
            'The SDK-boundary exception at the top of ai/scripts/maintenance/syncGithubWorkflow.mjs is ' +
            'now unnecessary: restore `import {GH_Config, GH_SyncService} from "../../services.mjs"`, ' +
            'drop the direct Neo/core bootstrap, and delete ' +
            'this spec. This failure is the exception expiring on schedule, not a regression.'
        ).toBe(true);

        // Recorded so the path is legible when it does expire, rather than requiring a re-derivation.
        expect(chain.at(-1)).toBe('chromadb');
    });

    test('THE PRODUCTION PROPERTY: the stage entry does NOT reach chromadb', () => {
        // The assertion this file was missing, found in review by @neo-gpt.
        //
        // Every other test here protects the exception's EXPIRY and its carried invariants. None of
        // them protected the property that actually broke: 20 consecutive Data Sync runs died on
        //
        //   ERR_MODULE_NOT_FOUND: Cannot find package 'chromadb'
        //     imported from ai/services/knowledge-base/ChromaManager.mjs
        //
        // The barrel walk above proves the exception is still NEEDED. It says nothing about whether
        // the exception still WORKS. A future static import from any module this stage already
        // depends on back to `chromadb` would turn the hourly stage red again while every assertion
        // in this file stayed green — a guard covering the retirement path but not the failure it
        // was built for.
        const {reached, chain, walked} = reachesPackage(EXCEPTION_SITE, 'chromadb');

        // Positive control FIRST: an empty walk would make `reached === false` vacuously true, so a
        // moved or unreadable entry file would read as "clean" — the shape this whole file exists to
        // reject. The same guard the barrel test uses, for the same reason.
        //
        // This floor is the reason the package-boundary under-walk was ever noticed: when the walker
        // stopped at `neo.mjs/**`, reach fell from its calibrated range to 45 and this fired.
        // Calibration: the walker reaches 63 modules from the stage entry, measured when this floor
        // was last re-derived. Lowering the floor to accommodate a shrunken walk is the anti-fix —
        // it converts a working alarm into a silent one, which is exactly what it just caught.
        expect(
            walked,
            'the stage-entry walk found almost nothing, so a `false` below would prove nothing — ' +
            'check that ai/scripts/maintenance/syncGithubWorkflow.mjs still resolves'
        ).toBeGreaterThan(50);

        expect(
            reached,
            'ai/scripts/maintenance/syncGithubWorkflow.mjs now reaches chromadb again through ' +
            `${chain.join(' -> ')}. The SDK-boundary exception no longer buys what it exists for: ` +
            'the hourly Data Sync "GitHub Workflow corpus" stage will fail with ERR_MODULE_NOT_FOUND ' +
            'on the next scheduled run. Break the new edge — do NOT widen the exception.'
        ).toBe(false);
    });

    test('the exception retains namespace bootstrap while the retired startup projection fork stays absent', () => {
        // The direct-import exception still owes the namespace bootstrap. The former syncOnStartup
        // override is now forbidden: the leaf and SyncService branch were retired with the one-writer
        // projection cut, so reintroducing either recreates an unleased second entry path.
        const source = readFileSync(EXCEPTION_SITE, 'utf8');

        // Matched on symbol + resolved module rather than exact text. The block-alignment lint owns
        // the spacing, so an assertion pinned to today's padding would fail on a pure realignment —
        // and the SPECIFIER is no more stable than the padding: moving the Agent OS onto the
        // published Engine rewrote this exact bootstrap from a relative climb into `src/**` to
        // `neo.mjs/src/**`, which silently invalidated the literal pattern that used to stand here.
        // What is guarded is that the namespace bootstrap is present, not how it is spelled.
        expect(source, 'Neo namespace bootstrap missing — the barrel supplied it and no longer does')
            .toMatch(/import\s+Neo\s+from\s+'[^']*src\/Neo\.mjs'/);

        expect(source, 'core/_export augmentation missing — Neo globals will be absent at setupClass time')
            .toMatch(/import\s+\*\s+as\s+core\s+from\s+'[^']*src\/core\/_export\.mjs'/);

        expect(source).not.toContain('syncOnStartup');

        // The exception must stay narrow: it exists for this one barrel-avoidance, not as licence.
        expect(source).not.toContain("from '../../services.mjs'");
    });

    test('makeSafe is still a no-op for the two methods this script calls', () => {
        // The barrel wraps services in `makeSafe`, which validates and marshals against the OpenAPI
        // spec. That is currently harmless to lose here because neither called method is an operation
        // in the spec. If someone ADDS one, the direct import silently drops validation — so this
        // fails and says so rather than letting the exception quietly widen its cost.
        const spec = readFileSync(OPENAPI, 'utf8');

        for (const method of ['emitGeneratedContentAndDerive', 'runFullSync', 'emit_generated_content', 'run_full_sync']) {
            expect(
                spec.includes(method),
                `${method} is now in the github-workflow OpenAPI spec, so makeSafe would validate or ` +
                'marshal it. The direct import in syncGithubWorkflow.mjs bypasses that wrapper — the ' +
                'exception now costs real validation and must be revisited.'
            ).toBe(false);
        }
    });
});
