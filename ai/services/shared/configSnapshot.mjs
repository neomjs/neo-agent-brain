import {types as utilTypes} from 'node:util';
import Base                 from 'neo.mjs/src/core/Base.mjs';

/**
 * @module ai/services/shared/configSnapshot
 * @summary Shared test-isolation helpers for building and validating plain-object `configSnapshot`
 * trees from hierarchical `Neo.ai.ConfigProvider` instances.
 *
 * Services that expose a `configSnapshot` test seam (`TextEmbeddingService`, `VectorService`, etc.)
 * share one implementation of plain-object validation and ancestor-aware subtree cloning here so
 * neither the proxy-guard rules nor the `ConfigProvider` parent-chain walk are duplicated across
 * consumers.
 */

/**
 * @summary Verifies that an array and all of its elements (recursively) are isolated plain values
 * rather than `ConfigProvider` instances or `Proxy` objects.
 * @param {Array} candidate Candidate array.
 * @returns {Boolean}
 */
function isPlainSnapshotArray(candidate) {
    if (!Array.isArray(candidate) || utilTypes.isProxy(candidate)) {
        return false;
    }

    for (const item of candidate) {
        if (item && typeof item === 'object') {
            if (Array.isArray(item)) {
                if (!isPlainSnapshotArray(item)) {
                    return false;
                }
            } else if (!isPlainSnapshotObject(item)) {
                return false;
            }
        }
    }

    return true;
}

/**
 * @summary Verifies that a candidate config snapshot node and all nested object or array values
 * are isolated plain objects/arrays rather than `ConfigProvider` instances or hierarchical data proxies.
 * @param {*} candidate Candidate object node.
 * @returns {Boolean}
 */
export function isPlainSnapshotObject(candidate) {
    if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        utilTypes.isProxy(candidate) ||
        candidate instanceof Base
    ) {
        return false;
    }

    for (const value of Object.values(candidate)) {
        if (value && typeof value === 'object') {
            if (Array.isArray(value)) {
                if (!isPlainSnapshotArray(value)) {
                    return false;
                }
            } else if (!isPlainSnapshotObject(value)) {
                return false;
            }
        }
    }

    return true;
}

/**
 * @summary Deep-clones an array value inside a config snapshot so nested arrays and plain objects
 * are detached from the source config tree.
 * @param {Array} items Source array.
 * @returns {Array}
 */
function cloneSnapshotArray(items) {
    return items.map(item => {
        if (Array.isArray(item)) {
            return cloneSnapshotArray(item);
        }

        if (item && typeof item === 'object') {
            const copy = {};

            for (const [key, val] of Object.entries(item)) {
                if (Array.isArray(val)) {
                    copy[key] = cloneSnapshotArray(val);
                } else if (val && typeof val === 'object') {
                    copy[key] = {...val};
                } else {
                    copy[key] = val;
                }
            }

            return copy;
        }

        return item;
    });
}

/**
 * @summary Resolves and deep-clones a hierarchical `ConfigProvider` subtree into an isolated plain
 * object across the provider parent chain.
 *
 * **Pin-scoped premise and retirement trigger:**
 * Upstream `Neo.state.Provider` commit `a87a89e2` (2026-09-26) fixed `getTopLevelDataKeys` to walk
 * the parent chain so `Object.keys()` / object spread on a child hierarchical data proxy enumerates
 * inherited Tier-1 keys. The Brain repository's current `neo.mjs` dependency pin (`7f16355a`,
 * 2026-09-25) predates `a87a89e2` by one day, so on this pin `{...aiConfig.ollama}` only enumerates
 * Tier-2 child overrides and drops Tier-1 `Neo.ai.Config` leaves. Walking `current.getParent()`
 * here compensates for the pre-`a87a89e2` pin while reading each resolved value through `liveNode`.
 *
 * **Retirement trigger:** Once `neo-agent-brain` advances its `neo.mjs` dependency pin past
 * `a87a89e2`, retire the `current.getParent()` key-collection loop and reduce `cloneConfigSubtree`
 * to a direct recursive plain-object copy of `liveNode`.
 *
 * @param {Neo.ai.ConfigProvider} provider Root config provider (`aiConfig`).
 * @param {String[]} pathParts Path segments from the provider root to the target subtree.
 * @returns {Object}
 */
export function cloneConfigSubtree(provider, pathParts) {
    const keys = new Set();

    for (let current = provider; current; current = typeof current.getParent === 'function' ? current.getParent() : null) {
        let node = current.data;

        for (const key of pathParts) {
            if (!node || typeof node !== 'object') {
                node = null;
                break;
            }
            node = node[key];
        }

        if (node && typeof node === 'object' && !Array.isArray(node)) {
            for (const key of Object.keys(node)) {
                keys.add(key);
            }
        }
    }

    let liveNode = provider;

    for (const key of pathParts) {
        liveNode = liveNode[key];
    }

    const snapshot = {};

    for (const key of keys) {
        const value = liveNode[key];

        if (Array.isArray(value)) {
            snapshot[key] = cloneSnapshotArray(value);
        } else if (value && typeof value === 'object') {
            snapshot[key] = cloneConfigSubtree(provider, [...pathParts, key]);
        } else {
            snapshot[key] = value;
        }
    }

    return snapshot;
}

/**
 * @summary Validates a candidate `configSnapshot` value for a service's `beforeSetConfigSnapshot` hook.
 *
 * Returns `null` when `value` is `null` or `undefined` (restoring canonical `aiConfig`), and throws
 * a `TypeError` when the root or any required subtree is missing or is not an isolated plain object.
 *
 * @param {Object|null|undefined} value Candidate snapshot or `null` to restore canonical `aiConfig`.
 * @param {Object} options
 * @param {String} options.serviceName Service name used in the thrown `TypeError` prefix.
 * @param {Array<String|String[]>} [options.requiredSubtrees=[]] Dot-separated paths or key arrays
 *     that must resolve to plain-object subtrees on the snapshot.
 * @returns {Object|null}
 */
export function validateConfigSnapshot(value, {serviceName, requiredSubtrees = []}) {
    if (value === null || value === undefined) {
        return null;
    }

    const fail = () => {
        throw new TypeError(`${serviceName}: configSnapshot must be an isolated snapshot, never the shared aiConfig singleton or a live subtree`);
    };

    if (!isPlainSnapshotObject(value)) {
        fail();
    }

    for (const entry of requiredSubtrees) {
        const parts   = Array.isArray(entry) ? entry : String(entry).split('.');
        const subtree = parts.reduce((acc, key) => acc?.[key], value);

        if (!isPlainSnapshotObject(subtree)) {
            fail();
        }
    }

    return value;
}
