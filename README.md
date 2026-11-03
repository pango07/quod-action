# Quod for vitest

Quod replays the vitest test files whose inputs did not change since they last
passed. It runs only the files your change can reach, inside your existing test
command. The summary, the JSON/JUnit reports and the exit code are what a full
`vitest run` gives.

## Add Quod to your CI

Pin the action and the workflow to the commit of the release, `0d639e9a85fde5f27f06d44811332a6f0fb6fe1e` (the
`v1` tag; `@v1` works too if your policy allows tags).

1. **Permissions.** Quod Cloud keeps the ledger. It knows your job by its
   GitHub OIDC token. Give the test job:

   ```yaml
     check:
       permissions:
         contents: read
         id-token: write
   ```

   Without `id-token: write`, or when the server doesn't answer, the Actions
   cache carries the ledger instead. Your repository must be in a Quod team,
   with the Quod GitHub App installed on it.

2. **One line in your test job,** right after `actions/setup-node`. Your install
   and test commands stay as they are:

   ```yaml
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - uses: pango07/quod-action@0d639e9a85fde5f27f06d44811332a6f0fb6fe1e # v1   ← this line
         - run: npm ci
         - run: npx turbo run test          # unchanged: vitest goes through Quod
   ```

That's all: no second job. The first run runs every test file, at about
plain vitest speed, and records them. A recorded file replays once a second
run of the same inputs agreed with it (the second witness), so from the
second commit on only what changed runs.

**Turning it off:** set `QUOD_DISABLE: 1` in the job's or the workflow's `env`
for plain vitest, or remove the line.

**Had the shadow job?** It still works, and you can delete it: the test job
records now. To keep it as your only recorder, give the action
`with: { record: false }`.

## What happens

- **Your test job (`mode: check`):**
  - installs quod and restores the newest ledger: from Quod Cloud (nearest
    recorded ancestor commit), else the Actions cache (your branch, then the
    pull request's base, then the default branch).
  - puts a `node` shim first on `PATH`, which preloads a small hook into each
    node process.
  - turns every one-shot `vitest run` started in the job (through npm scripts,
    npx, turbo, pnpm or `node_modules/.bin`) into `quod vitest` with the same
    arguments. Files whose inputs are unchanged since a run that a second run
    confirmed replay; the rest run and are recorded as they run.
  - saves the ledger: to Quod Cloud from quod itself, and to the Actions cache
    in a post step.
- **The second witness:** a recording is provisional until another run of the
  same inputs (the same file contents, packages, environment, vitest
  arguments) produced the same per-test results; only then does it replay. A
  run that disagrees quarantines the file until it re-proves itself.
- **Stays plain vitest:**
  - watch mode, `--coverage`, `-u`, `--ui`, `--browser`, `--shard`,
    `--changed`
  - anything outside Linux x64
  - any failure to install quod
- **Always runs:** a test that failed, spawned a process, used the network or
  wrote into the repository.
- **Trust:** a fork's pull request only reads the ledger, never records. A ledger is an
  input that can make a test report "pass" without running, so only code from
  your own repository writes one.

Requirements: vitest 4.x, Node 22.15+ (`module.registerHooks`), a Linux x64
runner.
