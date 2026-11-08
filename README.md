# Quod for vitest

Quod can accelerate supported Vitest CI jobs with one line after `actions/setup-node`.
Your install and test commands stay exactly as they are.

This experimental branch adds whole-job and configuration-proof work. Its
results do not change the published `v2` release. Quod is a GitHub Action
inside your existing runner; acceleration depends on the workload and replay
eligibility. Cold recording and confirmation can make a job slower.

Production readiness is still being validated. This branch is preparing a
fresh-runner acceptance gate for the committed Action bundles: native results,
two recording witnesses, replay, dependency-cache reuse, signed Cloud ledger
readback and native fallback. Passing a finite fixture does not establish
support for every repository or configuration, and does not establish net
CI cost savings. Coverage remains outside this initial acceptance gate.

The bundled experimental engine now includes the
[metadata-only replay correction](https://github.com/pango07/quod/blob/exp/boolean-exports-codex/docs/bench/stat-metadata-regression.md).
Its performance must be remeasured; earlier benchmark savings used an older engine.

- **Tests:** Quod replays the vitest test files whose inputs did not change
  since they last passed, and runs the rest, inside your existing test
  command. The summary, the JSON/JUnit reports and the exit code are what a
  full `vitest run` gives.
- **Dependencies:** Quod restores what your install puts down before your
  install step runs. For npm that is `node_modules` itself, so `npm ci`
  finds it in place. For pnpm, yarn and bun it is the package store.
- **turbo and Nx:** when you have no remote cache of your own, Quod points
  turbo's and Nx's remote cache at Quod Cloud.

The job records as it runs. There is no second job.

## Quickstart

Give the test job an OIDC token, and add one line right after
`actions/setup-node`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write          # Quod Cloud knows your job by its OIDC token
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: pango07/quod-action@<sha> # v2   ← this line
      - run: npm ci
      - run: npm test                    # unchanged: vitest goes through Quod
```

**Pin the full commit SHA, with `# v2` as a comment**, as GitHub recommends for
third-party actions. Replace `<sha>` with the commit the `v2` tag points to:

```sh
git ls-remote https://github.com/pango07/quod-action refs/tags/v2 'refs/tags/v2^{}'
```

For an annotated tag, use the peeled `^{}` entry's commit SHA. For a
lightweight tag, use the tag entry's SHA.

The [v2 release](https://github.com/pango07/quod-action/releases/tag/v2) and
the [quickstart](https://www.quodci.com/docs/quickstart) show it too.
Dependabot and Renovate keep a SHA pin with a version comment up to date.
`@v2` also works if your policy allows tags.

Your repository must be in a Quod team, with the Quod GitHub App installed on
it. Without `id-token: write`, or when Quod Cloud doesn't answer, the
GitHub Actions cache carries the ledger. The turbo/Nx remote cache stays off.

Requirements for test replay on this branch: Vitest 3.2–3.x, 4.x or 5.x, Node 22.15 or later
(`module.registerHooks`), and a Linux x64 runner. The dependency cache and
the task cache also run on macOS runners.

The latest complete benchmark tests Node 24.18.0 with Vitest 5.0.0 on
GitHub-hosted Linux x64, including nine monorepo projects. Compatibility paths
for other versions are not a promise that every version/configuration has
been benchmarked. Future Vitest majors and prereleases stay plain until explicitly admitted.
Watch/browser/UI mode, snapshot updates, sharding, changed-file selection and
Yarn Plug'n'Play stay plain. Coverage has separate provider/configuration
guards. This is not a replay promise for Jest, Playwright, Python, Go,
deployment steps, other CI providers or arbitrary shell commands.
See the [support and evidence boundary](https://github.com/pango07/quod/blob/exp/boolean-exports-codex/docs/bench/support-boundaries.md).

## What happens

- **The first run** executes the test files and records eligible work.
  Recording overhead depends on the workload; traced first witnesses can
  cost substantially more than a plain run.
- **A record replays only after a second run agrees with it** (the second
  witness). A record is provisional until another run of the same inputs
  produces the same per-test results: the same file contents, packages,
  environment and vitest arguments. A run that disagrees quarantines the
  file until it proves itself again. So a file runs twice after it changes:
  on the commit that changed it, and once more on the next run.
- **Recording failures are checked without instrumentation.** Recording instruments the tests,
  which can slow a timing-sensitive test into a failure. When a file fails
  while recording, Quod runs the failed files again without recording, and
  that run's result, output and exit code are the job's. A file that failed
  is never recorded.
- **Always runs:** failed or quarantined files and work the recorder marks
  unobservable. Network, child processes and filesystem effects have separate
  recording restrictions; their presence is not a blanket replay guarantee.
  Files using `fs.fstat`, `fs.fstatSync` or `fs.promises.open` also run each
  time: descriptor metadata and `FileHandle` operations are not yet fully
  tracked. Ordinary pathname content reads can still replay.
  Resolved paths include parent symlinks in their input key. Unsupported
  `realpath` arguments, accessor/proxy options and resolution errors prevent
  replay. See the [parent-symlink regression](https://github.com/pango07/quod/blob/probe/worker-arguments-codex/docs/bench/realpath-contract.md).
- **Coverage** (`--coverage`, or `coverage.enabled` in the config, v8 or
  istanbul): each recorded file keeps its coverage; a replayed file's joins
  the files that ran, and vitest's own provider writes every report and
  checks the thresholds, as in a full run. Another provider, or
  `thresholds.autoUpdate`, runs every file.
- **Stays plain vitest:** watch mode, `-u`, `--ui`, `--browser`, `--shard`,
  `--changed`; anything outside Linux x64; any failure to set up Quod.
- **Trust:** a fork's pull request only reads the ledger and never records.
  A ledger can make a test report "pass" without running, so only code from
  your own repository writes one.

In more detail, the action:

1. **Dependencies.** Restores what your install puts down, keyed on the
   lockfile, every `package.json`, the package manager's config, Node, the
   OS, the architecture and the runner image. For npm, `npm ci` then finds
   `node_modules` in place and returns at once. For pnpm, yarn and bun, the
   install runs as always and checks the store itself. If another step
   already restored `node_modules` or the store, Quod leaves it alone. After
   the job, it saves what the install produced, but only from jobs on your
   own code (push, same-repository pull request, merge queue, dispatch,
   schedule).
   npm workspace projects, local or linked dependencies, root `binding.gyp`,
   competing npm lockfiles, custom npm configuration and unsupported
   install inputs use native
   installation. Quod does not restore or save their `node_modules` trees.
   Unreviewed npm install arguments run native npm; they cannot skip an
   install or authorize saving its dependency tree.
   Safe npm trees use a new cache-key domain so earlier entries cannot
   bypass these checks.
2. **Task cache.** If the repository has a `turbo.json` or `nx.json`, the
   job has `id-token: write`, and none of `TURBO_API`, `TURBO_TOKEN`,
   `TURBO_TEAM`, `TURBO_TEAMID`, `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`,
   `NX_CLOUD_ACCESS_TOKEN` or `NX_NO_CLOUD` is set, turbo's (and Nx's)
   remote cache becomes Quod Cloud for this job. A pull request writes only
   its own branch's entries, so it never puts a task result in front of
   `main`.
3. **Tests.** Installs quod and restores the newest ledger: from Quod Cloud
   (the nearest recorded ancestor commit), else the Actions cache (your
   branch, then the pull request's base, then the default branch). It puts a
   `node` shim first on `PATH`, and every one-shot `vitest run` in the job
   (through npm scripts, npx, turbo, pnpm or `node_modules/.bin`) becomes
   `quod vitest` with the same arguments. Test reports reach Quod Cloud
   after each command. After the job, the post step saves each changed
   suite's final ledger to Quod Cloud alongside the Actions cache upload,
   and waits for both. A job that replays everything does not upload the
   ledger again.

Each part fails open: if it can't set up, the job runs as it would without
Quod.

## Upgrading from v1

Replace the action line's SHA and comment with v2's. Then:

- **Delete the `quod-shadow` job.** The test job records now. The shadow
  workflow still works, so nothing breaks if you leave it for a while.
- **Expect the first run or two to run every file.** v2 installs a newer
  quod, and records are tied to the quod that made them. The first run
  after upgrading records every file. The next run is the second witness
  for those records, so it runs them again. From then on, unchanged files
  replay.
- **Remove your own dependency and turbo cache steps if you like.** They
  keep working: Quod leaves a `node_modules` or store another step restored
  alone, and doesn't touch a remote cache you configured.

To keep the shadow job as your only recorder, give the action
`with: { record: false }`. The test job then only reads the ledger, as in
v1.

## Turning things off

| To turn off | Set |
| --- | --- |
| Quod entirely, for a job or a workflow | `QUOD_DISABLE: 1` in its `env` (or remove the line) |
| Recording in the test job (keep the shadow job) | `with: { record: false }` |
| The dependency cache | `with: { dependencies: false }` |
| The turbo/Nx remote cache | `with: { task-cache: false }` |
| Quod Cloud for the ledger (Actions cache only) | `with: { cloud: false }` |

## Inputs

All inputs are optional.

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | `check` | `check`: your test job. It replays what the ledger proves unchanged, then runs and records the rest. `shadow`: the older separate recording job, used inside `.github/workflows/shadow.yml`. It still works, and isn't needed any more. |
| `record` | `true` | In `check` mode, record in this job. `false` only reads the ledger, for a setup that keeps the shadow job. |
| `version` | `bin-024b929` | The bundled experimental quod binary. Other versions use their pinned release archive. |
| `sha256` | the pinned checksum | SHA-256 of that release's `quod-linux-x86_64.tar.gz`. Required when `version` is a release the action doesn't know. |
| `cloud` | `true` | Keep the ledger in Quod Cloud when this quod supports it and the job has `id-token: write`. `false` keeps it in the Actions cache. |
| `dependencies` | `true` | Restore and save what your install puts down: `node_modules` for npm, the store for pnpm, yarn and bun. `false` leaves your install alone. |
| `task-cache` | `true` | Point turbo's and Nx's remote cache at Quod Cloud, when the job has `id-token: write` and you have no remote cache configured. `false` leaves them alone. |
| `server` | `https://api.quodci.com` | The Quod Cloud server. |
| `server-key` | Quod Cloud's key | The server's Ed25519 public key. Every answer from the server is signed with it. |
| `job-id` | `${{ job.check_run_id }}` | This job's check run, for Quod Cloud's reports. |
| `token` | `${{ github.token }}` | Reads a triggering CI run's report artifact (a `workflow_run` shadow). |

More: [quodci.com/docs](https://www.quodci.com/docs).

## Experimental managed Vitest

On the experimental branch, opt in with `managed-vitest: v0`. This changes the
semantics of supported files: a declared epoch (default `1700000000000`), seed
(`42`), UTC and explicit environment (`{"NODE_ENV":"test"}`), with no native
network or filesystem access. `managed-vitest: control` runs the same managed
work without reading or writing receipts. The default is `off`.

The pinned runtime now declares the separately keyed frozen Array/Promise slot
policy. It retains seven native constructor, iterator, species, `then` and
`resolve` slots before freezing their four constructor/prototype objects.
Assignments that would shadow those inherited nonwritable properties on public
instances or subclasses may fail; an own `Object.defineProperty` remains
possible. The other capability and descriptor-mutation guards remain in force.
This is an explicit managed execution contract, and earlier-policy receipts
cannot be admitted under it. See the exact source pin's
[`managed runtime contract`](https://github.com/pango07/quod/blob/293afb713a1ceab141f290db8a002728298cb5c0/docs/managed-vitest-action-v0.md).

The first profile supports the expensive convex-helpers stream property test
under its reviewed Vitest 5 configuration. Every original test still runs;
remaining files and unsupported commands use ordinary Vitest. Preparation,
compilation and capability checks execute before every receipt lookup. A failed,
incomplete, unsupported or changed-policy result cannot become a receipt.

Managed receipts use immutable, branch-scoped GitHub Actions cache entries. The
trusted receipt byte digest comes from the key returned by the authenticated
cache service, never a manifest inside the downloaded cache. The trust scope is
the repository's authorized cache-writing workflows; an authorized malicious
publisher is outside that scope. Fork pull requests do not publish receipts, and
pull_request_target/workflow_run jobs never publish them. Quod Cloud is not used
for this experimental receipt transport.

The Action retains the runner's cache session in a private job-local file. The
bridge exposes it only during cache SDK operations, restores its environment
before ordinary children run, and the post step removes the file. Reports and
receipt artifacts exclude that file and the Action configuration.

`managed-epoch`, `managed-seed` and `managed-env` declare the keyed values.
`cache-namespace` isolates both dependency and receipt storage for a cold run.
The shipped Linux x64 runtime is built on GitHub from `managed-source.json` and
its archive digest is verified before extraction. See the pinned source's
managed runtime contract and benchmark evidence before interpreting savings.

### Matrix research draft

The separate `managed-vitest: matrix-research` profile is a draft awaiting its
reviewed runtime source pin and packaged GitHub build. `matrix-control` runs the
same investigation without receipt reads or writes. Neither changes the default
`off` mode or the v0 API. Only the exact repository-root `vitest run` command
under the finite reviewed Vitest5 configuration enters this profile. File,
project, test, coverage, reporter and output options execute the original
ordinary command. The npm script and its following release tests stay intact.

The profile freshly resolves actual project/file/pool instances and validates
current input proofs before independently admitting authenticated full execution
receipts. Unknown or unsupported instances run in one exact native batch.
Supported failures stay failures, and a failed whole command publishes no pack.
One branch-scoped collection restore and at most one acknowledged save carry the
bounded current candidate envelopes; embedded hashes are not cache authority.

The full report is an explicit logical names/states document, retaining actual
project multiplicity, duplicate names, skips and the final exit status. Its
schema is `quod-managed-matrix-input-logical-results-v1`, exposed by the distinct
`QUOD_MANAGED_MATRIX_INPUT_RESULT` log marker and the post artifact named
`quod-managed-matrix-logical-*`. Native JSON describes only the native subset;
it is not a full-suite report. Native timing and arbitrary reporter metadata are
not reconstructed. The reviewed108 candidate profile still executes12 native
instances, so `fullJobHit` remains false. No new controlled speedup is claimed.

The Action setup session remains available during earlier trusted install/build
steps in this finite public workflow. It is consumed before intercepted Vitest
dispatch and exists only in parent memory during awaited SDK operations.
Unsupported Vitest invocations consume the owned setup file before proceeding
ordinary; later invocations execute ordinary once it has been consumed. This is
not isolation from a hostile same-UID native workflow. Off/v0 retain their own
existing behavior. The proven finite npm install equivalence remains a separate
dependency-materialization decision and never supplies test/build authority.

### Finite property47 profile

`managed-vitest: matrix-property47` and `matrix-property47-control` use reviewed
runtime `f67fe14033de76f0b26b436cef4e5d50b0af1ee3`. Its finite GitHub gate
[42430045283](https://github.com/pango07/quod/actions/runs/42430045283) and two
independent data audits preserve all original 120 files and 4,131 test states.
The profile uses synthetic cache authority in that runtime gate; actual SDK and
complete Action job measurements require the separate packaged gate. These
modes retain the complete original 120 project/file/pool selection and select
only the reviewed 47-test `convex-helpers` stream property instance as a managed
candidate. Its explicit profile label is bound into both the collection scope
and the runtime execution identity. It cannot share a receipt collection with
the default 108 profile in the same Action build.

A cold candidate still receives actual native conformance; a passing replay
leaves 119 instances to native Vitest. The control performs neither receipt SDK
operations nor receipt writes. The ordinary npm script, build, release tests,
exact-root-run guard, private-session consumption and bounded SDK transport stay
on the existing path. This is not full-job replay or evidence for a new
full-window speedup. Default `off`, v0 and the default 108 matrix modes keep
their existing behavior. No listener concurrency is enabled by these modes.
