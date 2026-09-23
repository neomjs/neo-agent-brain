import aiConfig           from '../../../mcp/server/knowledge-base/config.mjs';
import SourceRegistry     from './SourceRegistry.mjs';
import AdrSource          from './AdrSource.mjs';
import ApiSource          from './ApiSource.mjs';
import ConceptSource      from './ConceptSource.mjs';
import LearningSource     from './LearningSource.mjs';
import RawRepoSource      from './RawRepoSource.mjs';
import ReleaseNotesSource from './ReleaseNotesSource.mjs';
import SkillSource        from './SkillSource.mjs';
import TestSource         from './TestSource.mjs';

/**
 * @module Neo.ai.services.knowledge-base.source._export
 * @summary Auto-registers Neo's default Source classes + tenant-supplied custom Source/Parser
 * classes into {@link SourceRegistry} at import time.
 *
 * **Auto-registration contract:**
 *
 * - When `aiConfig.useDefaultSources !== false`, the seven surviving default Source classes
 *   register in deterministic insertion order for legacy registry consumers. The shared
 *   Engine/Brain `kbSync` no longer reads this registry; it uses revision-bound repository
 *   profiles, so the old single-JSONL byte-equivalence claim no longer applies. GitHub
 *   conversations are not a default Source: the Knowledge Base ingests the org corpus published by
 *   `github-content-sync` as its own tenant through the `ConversationCorpusSource` extractor
 *   (neo-agent-brain#402), so the three per-facet Sources that walked the Engine's tracked
 *   conversation mirror retired.
 * - When `aiConfig.useDefaultSources === false` (cloud deployments opting out of Neo's
 *   curated content), no default registration occurs. The registry only contains whatever
 *   tenant-supplied sources register via `aiConfig.customSources`, explicit `rawRepoSource`,
 *   or programmatically via `SourceRegistry.registerSource(...)`.
 * - When `aiConfig.rawRepoSource === true`, {@link RawRepoSource} registers as an
 *   explicit opt-in fallback for tenants whose repo shape is unknown. It is intentionally
 *   NOT part of {@link DEFAULT_SOURCES}; the shared core profiles do not consult the registry.
 *
 * **Declarative custom-source/parser registration shape:**
 *
 * Tenants pre-import their Source/Parser class modules and reference the class via the
 * `SourceClass` / `ParserClass` property in the config array entry:
 *
 * ```js
 * import MyProtoParser    from './my-tenant/MyProtoParser.mjs';
 * import MyEs5SourceClass from './my-tenant/MyEs5Source.mjs';
 *
 * aiConfig.customSources = [
 *     {SourceClass: MyEs5SourceClass, sourceName: 'tenant-X-es5'}  // sourceName optional
 * ];
 * aiConfig.customParsers = [
 *     {ParserClass: MyProtoParser,    parserId: 'proto-v1'}        // parserId  optional
 * ];
 * ```
 *
 * The actual class object (not a className string) is passed via `SourceClass` / `ParserClass`
 * — this preserves Neo's class-extension semantics and allows the registry to call
 * `Neo.setupClass(...)` if needed. `sourceName` / `parserId` are optional overrides; when
 * omitted, the registry derives a name from the class's `className` final segment.
 *
 * **Order discipline:**
 *
 * The default sources MUST appear in the registry in the same relative order as the original
 * hardcoded array — `AdrSource`, `ApiSource`, `ConceptSource`, `LearningSource`,
 * `ReleaseNotesSource`, `SkillSource`, `TestSource`.
 *
 * **Testability:**
 *
 * Auto-registration logic is extracted into the exported {@link applyConfigToRegistry}
 * function so tests can exercise the config-driven path against a fresh registry instance
 * with mocked config shapes (e.g., `useDefaultSources: false` skip-default behavior,
 * declarative `customSources` / `customParsers` round-trip). The import-time side effect
 * at the bottom of this module invokes `applyConfigToRegistry(SourceRegistry, aiConfig)`
 * with the production config — preserving the zero-config default-register-on-import shape.
 *
 * @see https://github.com/neomjs/neo/issues/11658
 * @see https://github.com/neomjs/neo/issues/11625
 */

const DEFAULT_SOURCES = [
    AdrSource,
    ApiSource,
    ConceptSource,
    LearningSource,
    ReleaseNotesSource,
    SkillSource,
    TestSource
];

/**
 * Applies legacy config-driven registration to a {@link SourceRegistry}
 * instance: registers default Neo Source classes when `config.useDefaultSources !== false`,
 * then walks `config.customSources` / `config.customParsers` declarative arrays. Exported as
 * a pure function so tests can verify the config-driven path against a fresh registry
 * without depending on module-import singleton state.
 *
 * @param {Object}   registry          A `SourceRegistry`-shaped object exposing `registerSource(class, {sourceName?})` and `registerParser(class, {parserId?})`.
 * @param {Object}   config            A config object exposing `useDefaultSources` (boolean), `rawRepoSource` (boolean), `useDefaultParsers` (boolean), `customSources` (array), `customParsers` (array).
 * @param {Object}   [options]
 * @param {Array}   [options.defaults] Override the default Source class set (testing-only override; production omits to use {@link DEFAULT_SOURCES}).
 * @returns {{defaultSourcesRegistered: Number, rawRepoSourceRegistered: Number, customSourcesRegistered: Number, customParsersRegistered: Number}}
 */
export function applyConfigToRegistry(registry, config, {defaults = DEFAULT_SOURCES} = {}) {
    const stats = {
        defaultSourcesRegistered: 0,
        rawRepoSourceRegistered : 0,
        customSourcesRegistered : 0,
        customParsersRegistered : 0
    };

    if (config?.useDefaultSources !== false) {
        for (const SourceClass of defaults) {
            registry.registerSource(SourceClass);
            stats.defaultSourcesRegistered++;
        }
    }

    if (config?.rawRepoSource === true) {
        registry.registerSource(RawRepoSource);
        stats.rawRepoSourceRegistered++;
    }

    // Declarative custom-source registration via aiConfig.customSources (Phase 0/1B contract).
    // Each entry is a {SourceClass, sourceName?} pair; consumers pre-import their classes and
    // reference them in the config array. Programmatic post-import registration via
    // `SourceRegistry.registerSource(...)` remains supported for hot-reload scenarios.
    if (Array.isArray(config?.customSources)) {
        for (const entry of config.customSources) {
            if (entry?.SourceClass) {
                registry.registerSource(entry.SourceClass, {sourceName: entry.sourceName});
                stats.customSourcesRegistered++;
            }
        }
    }

    if (Array.isArray(config?.customParsers)) {
        for (const entry of config.customParsers) {
            if (entry?.ParserClass) {
                registry.registerParser(entry.ParserClass, {parserId: entry.parserId});
                stats.customParsersRegistered++;
            }
        }
    }

    return stats;
}

// Import-time side effect: register defaults + apply customSources/customParsers against the
// production aiConfig. The function form above lets tests skip this default invocation by
// calling `SourceRegistry.clear()` then `applyConfigToRegistry(SourceRegistry, mockConfig)`
// with a different config shape.
applyConfigToRegistry(SourceRegistry, aiConfig);

export default SourceRegistry;
export {
    AdrSource,
    ApiSource,
    ConceptSource,
    DEFAULT_SOURCES,
    LearningSource,
    RawRepoSource,
    ReleaseNotesSource,
    SkillSource,
    TestSource
};
