# Quod for vitest

Quod replays the vitest test files whose inputs did not change since they last
passed. It runs only the files your change can reach, inside your existing test
command. The summary, the JSON/JUnit reports and the exit code are what a full
`vitest run` gives.

## Add Quod to your CI

1. **One line in your CI job,** right after `actions/setup-node`:

   ```yaml
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - uses: pango07/quod-action@v1     # ← this line
         - run: npm ci
         - run: npx turbo run test          # unchanged: vitest goes through Quod
   ```

2. **One new file, `.github/workflows/quod-shadow.yml`.** It records off the
   critical path, after your CI finishes, and is never a check. Replace `CI` with
   your workflow's `name:`, and use your own setup and test command:

   ```yaml
   name: Quod shadow
   on:
     workflow_run:
       workflows: [CI]
       types: [completed]
   permissions:
     contents: read
     actions: read
   jobs:
     record:
       if: github.event.workflow_run.conclusion != 'cancelled' && github.event.workflow_run.head_repository.full_name == github.repository
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             ref: ${{ github.event.workflow_run.head_sha }}
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - uses: pango07/quod-action@v1
           with:
             mode: shadow
         - run: npm ci
         - run: npx turbo run test
   ```

3. **Merge it to your default branch.** GitHub runs `workflow_run` workflows
   only from the default branch. Until the shadow has recorded once, every test
   file runs, at plain vitest speed.

To turn it off, set `QUOD_DISABLE: 1` in the job's or the workflow's `env`, or
remove the line.

## What happens

- **Your CI job (`mode: check`)** installs quod and restores the newest
  recording through `actions/cache`. It tries your branch first, then the pull
  request's base, then the default branch. It then puts a small shim in
  `NODE_OPTIONS`. Every one-shot `vitest run` started in that job (through
  npm scripts, npx, turbo or `node_modules/.bin`) becomes
  `quod vitest --no-record` with the same arguments. Unchanged files replay, and
  the rest run as plain vitest without instrumentation. The ledger is only read.
  A post step uploads each run's per-test results as an artifact.
- **The shadow (`mode: shadow`)** runs the same command with recording. It
  records only a file whose tests did exactly what they did in your CI run, so
  recording can never change a result. It audits a few replayed files and saves
  the ledger for this commit. Its exit code is diagnostics only.
- **Stays plain vitest:**
  - watch mode, `--coverage`, `-u`, `--ui`, `--browser`, `--shard`,
    `--changed`
  - anything outside Linux x64
  - any failure to install quod

  A test that failed, spawned a process, used the network or wrote into the
  repository always runs.
- **Trust:** the shadow never records a fork's pull request. A ledger is an
  input that can make a test report "pass" without running, so only code from
  your own repository writes one.

Requirements: vitest 4.x, Node 22.15+ (`module.registerHooks`).
