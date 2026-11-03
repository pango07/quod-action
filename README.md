# Quod for vitest

Quod replays the vitest test files whose inputs did not change since they last
passed. It runs only the files your change can reach, inside your existing test
command. The summary, the JSON/JUnit reports and the exit code are what a full
`vitest run` gives.

## Add Quod to your CI

1. **One line in your test job,** right after `actions/setup-node`. Your install
   and test commands stay as they are:

   ```yaml
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - uses: pango07/quod-action@v1     # ← this line
         - run: npm ci
         - run: npx turbo run test          # unchanged: vitest goes through Quod
   ```

2. **One job in the same workflow file: the shadow.** It records after your test
   job finishes, and it is never your check. Use your test job's id and your test
   command:

   ```yaml
     quod-shadow:
       needs: check
       uses: pango07/quod-action/.github/workflows/shadow.yml@v1
       with: { test: npx turbo run test }
   ```

   Other inputs:
   - `install` (default `npm ci`)
   - `node-version` (default `24`)
   - `cache` (setup-node's cache; default `npm`)
   - `fetch-depth` (default `0`)
   - `working-directory`

3. **Push.** The first run runs every test file, at plain vitest speed, and its
   shadow records them. From the next commit on, only what changed runs.

**Quod Cloud:** let the workflow ask GitHub for an OIDC token. Put this at the
top of the workflow file, or in both jobs:

```yaml
permissions:
  contents: read
  id-token: write
```

The ledger then lives on Quod Cloud, which finds the nearest recorded ancestor
commit and shows each run on the dashboard. The Actions cache stays the
fallback. Without the permission, or when the server doesn't answer, the
Actions cache alone carries the ledger. Your repository must be in a Quod team,
with the Quod GitHub App installed on it.

**Turning it off:** set `QUOD_DISABLE: 1` in the job's or the workflow's `env`
for plain vitest, or remove the line and the job.

## What happens

- **Your test job (`mode: check`):**
  - installs quod and restores the newest recording. It tries your branch first,
    then the pull request's base, then the default branch.
  - puts a `node` shim first on `PATH`, which preloads a small hook into each
    node process.
  - turns every one-shot `vitest run` started in the job (through npm scripts,
    npx, turbo, pnpm or `node_modules/.bin`) into `quod vitest --no-record` with
    the same arguments. Unchanged files replay; the rest run as plain vitest
    without instrumentation. The ledger is only read.
  - uploads each run's per-test results as an artifact in a post step.
- **The shadow (`mode: shadow`):**
  - runs the same command with recording.
  - records a file only if its tests did exactly what they did in your job, so
    recording can never change a result.
  - audits a few replayed files and saves the ledger for this commit.
  - its exit code is diagnostics only.
- **Stays plain vitest:**
  - watch mode, `--coverage`, `-u`, `--ui`, `--browser`, `--shard`,
    `--changed`
  - anything outside Linux x64
  - any failure to install quod
- **Always runs:** a test that failed, spawned a process, used the network or
  wrote into the repository.
- **Trust:** the shadow never records a fork's pull request. A ledger is an
  input that can make a test report "pass" without running, so only code from
  your own repository writes one.

Requirements: vitest 4.x, Node 22.15+ (`module.registerHooks`), a Linux x64
runner.
