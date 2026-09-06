import fs                       from 'node:fs';
import path                     from 'node:path';
import process                  from 'node:process';

/**
 * Pre-Flight (structural): `ai/scripts/lifecycle/local-agent-os/` is the declared owner of the
 * one-machine local procedure, and neomjs/neo-agent-brain#244 AC-1 names this folder as the home for the
 * tracked mapping. Sibling precedent for the concern is `ai/scripts/lifecycle/harnessRouting.mjs`.
 * No novel directory choice.
 *
 * @summary The tracked source of truth for seat credential routing, and the generator for the shell
 * fragment that applies it.
 *
 * **The failure this replaces** (neomjs/neo-agent-brain#244). Which `.env` a shell loads — and therefore which
 * GitHub identity `gh` writes as — was decided by a `case` block in an untracked, unreviewed,
 * untested host dotfile. Its arms matched `<seat-root>/neomjs/neo/*`, the engine repo only. When the
 * Agent OS moved into this repository, every seat began working in siblings that no arm matched,
 * `GH_TOKEN` was silently absent, and `gh` fell back to the operator's keyring account. Nothing
 * errored. Git authorship stayed correct because it is configured separately, so the only visible
 * symptom was the author on the finished artifact — and GitHub authorship is immutable.
 *
 * **Why the mapping is relative, not absolute.** A host's seat roster is machine-specific, and this
 * repository is deployed by people who are not this machine. So the tracked data describes seats
 * *relative to a base*, and the absolute base is supplied at generate time. That keeps the reviewable
 * artifact portable, and it keeps one host's directory layout out of a public repository.
 *
 * **Private seats stay untracked, deliberately.** A host may route paths that must never appear in a
 * public repo — a client workspace, for instance. Those live in an untracked local file merged at
 * generate time ({@link loadLocalSeats}); the tracked table carries `neomjs` seats only. This is not
 * an oversight to tidy up later: publishing that arm would leak a client relationship.
 *
 * @see ai/scripts/lifecycle/local-agent-os/README.md
 * @see ai/scripts/lifecycle/harnessRouting.mjs
 */

/**
 * @summary Env keys this routing owns, and the only keys it may unset.
 *
 * Unsetting is scoped to this list so leaving a seat tree never clears a variable the operator set
 * by hand. `GH_TOKEN` is the one whose absence is silent — `gh` does not fail without it.
 * @type {String[]}
 */
export const MANAGED_KEYS = [
    'NEO_KB_ASK_API_KEY',
    'GH_TOKEN',
    'NEO_EMBEDDING_PROVIDER',
    'NEO_CHROMA_EMBEDDING_PROVIDER',
    'NEO_AGENT_IDENTITY',
    'ANTHROPIC_API_KEY',
    'NEO_MCP_REMOTE_TOKEN',
    'NEO_SEAT_ENV_FILE'
];

/**
 * @summary Env key naming the seat env file this shell resolved, or absent when unmapped.
 *
 * Two jobs. For an operator or agent it answers "which seat am I authenticated as?", which had no
 * answer before — the old arrangement's only observable was the author on a finished GitHub
 * artifact, i.e. after the damage. For the test suite it is the seam that lets a spec assert the
 * EMITTED SHELL, not just the JavaScript model of it: the `case` globs are what actually run, and an
 * untested generator can drift from its own resolver silently.
 * @type {String}
 */
export const RESOLVED_KEY = 'NEO_SEAT_ENV_FILE';

/**
 * @summary `gh` subcommands that CREATE or MUTATE a GitHub artifact.
 *
 * The guard refuses exactly these when an agent shell has no token, because these are the verbs
 * whose output carries an author. Reads and `gh auth` stay available so the situation is still
 * diagnosable from inside the broken shell.
 * @type {String[]}
 */
export const ARTIFACT_VERBS = [
    'create', 'edit', 'comment', 'close', 'reopen', 'merge', 'review', 'delete', 'ready',
    'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop', 'add', 'remove', 'set',
    'rename', 'sync', 'upload', 'clone'
];

/**
 * @summary Seat roots relative to the deployment base, each owning one `.env`.
 *
 * `dir` is the seat's directory under the base; `env` is the env file relative to the SAME base, so
 * a seat can point at another seat's file only by saying so explicitly here — which a reviewer sees.
 *
 * Every entry routes the whole seat root, not `neomjs/neo` alone. That narrowing is what caused
 * neomjs/neo-agent-brain#244: it silently excluded every sibling repository, and the Agent OS then moved into
 * one.
 * @type {Object[]}
 */
export const TRACKED_SEATS = [
    {dir: 'agents/neo-gpt-emmy/neomjs',   env: 'agents/neo-gpt-emmy/neomjs/neo/.env'},
    {dir: 'agents/neo-kimi-iris/neomjs',  env: 'agents/neo-kimi-iris/neomjs/neo/.env'},
    {dir: 'agents/neo-kimi-phoebe/neomjs', env: 'agents/neo-kimi-phoebe/neomjs/neo/.env'},
    {dir: 'agents/neo-preview/neomjs',    env: 'agents/neo-preview/neomjs/neo/.env'},
    {dir: 'antigravity/neomjs',           env: 'antigravity/neomjs/neo/.env'},
    {dir: 'claude/neomjs',                env: 'claude/neomjs/neo/.env'},
    {dir: 'clio/neomjs',                  env: 'clio/neomjs/neo/.env'},
    {dir: 'codex/neomjs',                 env: 'codex/neomjs/neo/.env'},
    {dir: 'fable/neomjs',                 env: 'fable/neomjs/neo/.env'},
    {dir: 'github/neomjs',                env: 'github/neomjs/neo/.env'},
    {dir: 'opus-vega/neomjs',             env: 'opus-vega/neomjs/neo/.env'}
];

/**
 * @summary Resolves seat routes to absolute form against a deployment base.
 * @param {String} base Absolute directory holding the seat roots.
 * @param {Object[]} [seats=TRACKED_SEATS] Relative seat entries.
 * @returns {Object[]} `{prefix, envFile}` pairs, both absolute.
 */
export function toAbsoluteRoutes(base, seats = TRACKED_SEATS) {
    return seats.map(({dir, env}) => ({
        prefix : path.resolve(base, dir),
        envFile: path.resolve(base, env)
    }));
}

/**
 * @summary Resolves which env file a working directory should load, or null.
 *
 * Matching is on **path boundaries**, never string prefixes: `/x/claude` must not claim
 * `/x/claude-scratch`. A `startsWith` implementation passes every positive test and silently routes
 * one seat's credentials into a neighbouring directory, which is the same class of failure this
 * module exists to end — so the boundary is asserted by a dedicated spec arm.
 *
 * The longest matching prefix wins, so a nested route can override a broader one regardless of the
 * order routes are declared in. Declaration order deciding credentials would make an unrelated
 * reordering a security change.
 *
 * @param {String} cwd Absolute working directory.
 * @param {Object[]} routes `{prefix, envFile}` pairs from {@link toAbsoluteRoutes}.
 * @returns {String|null} Absolute env path, or null when the path is unmapped.
 */
export function resolveSeatEnvFile(cwd, routes) {
    if (typeof cwd !== 'string' || cwd === '') {
        return null;
    }

    const target = path.resolve(cwd);
    let   best   = null;

    for (const {prefix, envFile} of routes) {
        const root = path.resolve(prefix);

        if (target === root || target.startsWith(root + path.sep)) {
            if (!best || root.length > best.prefixLength) {
                best = {envFile, prefixLength: root.length};
            }
        }
    }

    return best ? best.envFile : null
}

/**
 * @summary Loads untracked host-local routes, merged after the tracked ones.
 *
 * Absent file is the normal case and returns `[]` — a deployment with no private seats is not a
 * misconfiguration. A malformed file THROWS rather than degrading to `[]`: silently routing fewer
 * seats than the operator declared is how neomjs/neo-agent-brain#244 happened.
 *
 * @param {String} filePath Absolute path to the untracked JSON.
 * @returns {Object[]} `{prefix, envFile}` pairs, absolute, as authored.
 */
export function loadLocalSeats(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (!Array.isArray(parsed?.seats)) {
        throw new Error(`${filePath}: expected {"seats": [{"prefix": "...", "envFile": "..."}]}`);
    }

    for (const seat of parsed.seats) {
        if (!path.isAbsolute(seat?.prefix ?? '') || !path.isAbsolute(seat?.envFile ?? '')) {
            throw new Error(`${filePath}: every seat needs absolute "prefix" and "envFile"`);
        }
    }

    return parsed.seats.map(({prefix, envFile}) => ({prefix, envFile}))
}

/**
 * @summary Renders the zsh fragment that applies these routes on every directory change.
 *
 * The emitted `gh` guard is keyed on the **agent shell** (`CLAUDECODE` / `AI_AGENT`), not the
 * working directory. A cwd-scoped guard was tried first on this host and missed the common case
 * immediately: agents `cd` to a scratch directory to pass `--body-file`, which is outside every seat
 * tree, so the guard stayed silent for precisely the command that creates the artifact.
 *
 * @param {Object[]} routes `{prefix, envFile}` pairs.
 * @param {Object} [options]
 * @param {String[]} [options.managedKeys=MANAGED_KEYS]
 * @returns {String} zsh source, safe to write to a file and `source`.
 */
export function renderZshFragment(routes, {managedKeys = MANAGED_KEYS} = {}) {
    const arms = routes.map(({prefix, envFile}) =>
        `    ${prefix}/*)\n      _env_file=${JSON.stringify(envFile)}\n      ;;`
    ).join('\n');

    return `# GENERATED by ai/scripts/lifecycle/local-agent-os/seatCredentialRouting.mjs — do not hand-edit.
# Adding a seat is a reviewed change to TRACKED_SEATS in that module, or to the untracked
# local seats file for a private root. Re-run the generator and re-source this file.

_neo_env_managed_keys=(${managedKeys.join(' ')})

_neo_source_seat_env() {
  local _env_file=""
  case "$PWD/" in
${arms}
  esac

  # Set before the -f test, so "which seat does this path route to?" is answerable even when the
  # env file is missing — that is exactly the state an operator needs to see, not hide.
  if [[ -n "$_env_file" ]]; then
    export ${RESOLVED_KEY}="$_env_file"
  fi

  if [[ -n "$_env_file" && -f "$_env_file" ]]; then
    set -a; source "$_env_file"; set +a
    _neo_env_active=1
  elif [[ "$_neo_env_active" == "1" ]]; then
    unset \${=_neo_env_managed_keys}
    _neo_env_active=0
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook chpwd _neo_source_seat_env
_neo_source_seat_env

# Backstop, because a list of seats goes stale: a new seat, a repo cloned outside the mapped roots,
# a renamed root. Without GH_TOKEN, \`gh\` does not fail — it uses the keyring account, and every
# artifact it writes is misattributed to the operator.
gh() {
  if [[ ( -n "$CLAUDECODE" || -n "$AI_AGENT" ) && -z "$GH_TOKEN" ]]; then
    case "$2" in
      ${ARTIFACT_VERBS.join('|')})
        print -u2 "gh: refused — agent shell with no GH_TOKEN; this would author as the operator's keyring account."
        print -u2 "gh: cd into a mapped seat tree, or add this root via seatCredentialRouting.mjs."
        return 1
        ;;
    esac
  fi
  command gh "$@"
}
`;
}

/**
 * @summary CLI: emits the fragment for a deployment base.
 * @returns {void}
 */
function main() {
    const baseFlag  = process.argv.indexOf('--base'),
          localFlag = process.argv.indexOf('--local-seats'),
          base      = baseFlag !== -1 ? process.argv[baseFlag + 1] : null;

    if (!base) {
        console.error('usage: node seatCredentialRouting.mjs --base <dir> [--local-seats <file.json>]');
        console.error('  --base         absolute directory holding the seat roots');
        console.error('  --local-seats  untracked JSON of private roots, merged after the tracked ones');
        process.exit(1);
    }

    const routes = [
        ...toAbsoluteRoutes(base),
        ...(localFlag !== -1 && process.argv[localFlag + 1] ? loadLocalSeats(process.argv[localFlag + 1]) : [])
    ];

    process.stdout.write(renderZshFragment(routes));
}

if (process.argv[1] && import.meta.url === (await import('url')).pathToFileURL(process.argv[1]).href) {
    main();
}
