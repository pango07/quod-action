// Remote-only admission evidence; this never records or authorizes a replay.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
const require = createRequire(import.meta.url)
const D = require('../deps.cjs'), P = require('../npm-install-profile.cjs')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_SHA = 'bea2adcbf5748c8e4251eeedbc69412e3ba36aaa10d510f9561bcf3b56d2a365'
const RUNTIME = new Set(['.cache', '.vite', '.vite-temp', '.vitest', '.quod-vitest', '.quod-deps.json'])
const info = {pm: 'npm', lock: 'package-lock.json'}
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')

// Same conditional rewrite as npmCi in hook.cjs, with one comparison version.
// No other hidden-lock field or any other installed file is normalized.
export function normalizeHidden(bytes, version) {
  const value = JSON.parse(bytes)
  if (value.version === version) return Buffer.from(bytes)
  if (version === undefined) delete value.version
  else value.version = version
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

export function inventory(root, comparisonVersion, {excludeRuntime = true} = {}) {
  const raw = [], compared = [], exclusions = [], normalizations = []
  function walk(absolute, relative, excludedBy = null) {
    const st = fs.lstatSync(absolute), entry = {path: relative || '.', mode: st.mode & 0o7777}
    if (st.isDirectory()) entry.kind = 'directory'
    else if (st.isFile()) {
      entry.kind = 'file'
      const bytes = fs.readFileSync(absolute)
      entry.size = bytes.length; entry.sha256 = hash(bytes)
      if (relative === '.package-lock.json' && !excludedBy) {
        const normalized = normalizeHidden(bytes, comparisonVersion)
        normalizations.push({path: relative, nativeVersion: JSON.parse(bytes).version ?? null,
          comparisonVersion: comparisonVersion ?? null, rawSha256: entry.sha256,
          comparisonSha256: hash(normalized), changed: !bytes.equals(normalized)})
        if (!excludedBy) compared.push({...entry, size: normalized.length, sha256: hash(normalized)})
      } else if (!excludedBy) compared.push({...entry})
    } else if (st.isSymbolicLink()) {
      entry.kind = 'symlink'; entry.target = fs.readlinkSync(absolute)
    } else throw new Error(`unsupported installed object ${relative}`)
    raw.push(excludedBy ? {...entry, excludedBy} : {...entry})
    if (!excludedBy && entry.kind !== 'file') compared.push({...entry})
    if (entry.kind !== 'directory') return
    const parentIsNodeModules = relative === '' || path.basename(absolute) === 'node_modules'
    for (const name of fs.readdirSync(absolute).sort()) {
      const rel = relative ? `${relative}/${name}` : name
      let exclusion = excludedBy
      if (!exclusion && excludeRuntime && parentIsNodeModules && RUNTIME.has(name)) {
        const kind = fs.lstatSync(path.join(absolute, name))
        if (name === '.quod-deps.json' ? kind.isFile() : kind.isDirectory()) {
          exclusion = rel
          exclusions.push({path: rel, rule: name === '.quod-deps.json' ? 'regular Quod marker file' : 'node_modules runtime cache directory'})
        }
      }
      walk(path.join(absolute, name), rel, exclusion)
    }
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error('node_modules must be a directory')
  walk(root, '')
  const order = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  raw.sort(order); compared.sort(order)
  return {raw, compared, exclusions, normalizations,
    rawSha256: hash(canonical(raw)), comparisonSha256: hash(canonical(compared))}
}

export function difference(before, after) {
  const a = new Map(before.map(row => [row.path, row])), b = new Map(after.map(row => [row.path, row]))
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(name =>
    canonical(a.get(name)) === canonical(b.get(name)) ? [] : [{path: name,
      change: !a.has(name) ? 'added' : !b.has(name) ? 'removed' : 'changed',
      before: a.get(name) ?? null, after: b.get(name) ?? null}])
}

function executable(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name)
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate) } catch {}
  }
  throw new Error(`missing executable ${name}`)
}
function fileIdentity(file) {
  try { const bytes = fs.readFileSync(file); return {path: path.resolve(file), sha256: hash(bytes), bytes: bytes.length} }
  catch (error) { if (error.code === 'ENOENT') return {path: path.resolve(file), missing: true}; throw error }
}
function scope(root, facts, env) {
  const pick = name => env[name] ?? env[name.toLowerCase()]
  const prefix = path.dirname(path.dirname(fs.realpathSync(facts.bin)))
  const files = [path.join(root, '.npmrc'), pick('NPM_CONFIG_USERCONFIG') || path.join(env.HOME || os.homedir(), '.npmrc'),
    pick('NPM_CONFIG_GLOBALCONFIG') || path.join(prefix, 'etc/npmrc')].map(fileIdentity)
  return {node: facts.node, npm: facts.npm, nodePath: facts.bin,
    platform: process.platform, arch: process.arch, kernel: os.release(), umask: process.umask(), ImageOS: env.ImageOS ?? '', ImageVersion: env.ImageVersion ?? '',
    NODE_ENV: env.NODE_ENV ?? '', npmEnvironment: Object.keys(env).filter(name => /^npm_config_/i.test(name)).sort()
      .map(name => ({name, valueSha256: hash(env[name])})), files,
    environmentSha256: hash(canonical(env))}
}

async function main(output) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('this install gate runs on GitHub only')
  if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('a new absolute output directory is required')
  fs.mkdirSync(output, {recursive: true})
  const project = path.join(output, 'project'), checks = [], rows = [], comparisons = []
  const report = {schema: 'quod-npm-install-equivalence-v1', passed: false, checks, rows, comparisons,
    contract: 'Finite same-host npm-ci materialization comparison; no replay or whole-command authority',
    order: ['c0', 'c2', 'c3', 'c4', 'c5', 'c6', 'c10', 'c11', 'c0-repeat'],
    compared: ['complete path roster', 'regular file bytes', 'POSIX permission bits', 'symlink target text'],
    metadataNotCompared: ['atime', 'mtime', 'ctime', 'inode', 'device', 'ownership', 'hardlink allocation'],
    exclusions: {onlyAtNodeModulesRoots: [...RUNTIME], kinds: 'runtime directories and regular marker file only; no symlinks', rawInventoryRetained: true,
      hiddenLock: 'Only root .package-lock.json version is rewritten by the exact npm hook algorithm to c0 version'},
    cache: 'No node_modules or Actions cache restore; real npm ci always deletes and materializes the tree. npm download cache is shared.',
    github: {runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, source: process.env.GITHUB_SHA},
    driverSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url)))}
  const check = (name, passed, details = {}) => checks.push({name, passed: Boolean(passed), ...details})
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.NODE_OPTIONS) throw new Error('unsupported platform or injected Node preloader')
    const fixtureBytes = fs.readFileSync(path.join(HERE, 'fixtures/npm-install-window.json.gz'))
    if (hash(fixtureBytes) !== FIXTURE_SHA) throw new Error('reviewed fixture archive digest mismatch')
    fs.writeFileSync(path.join(output, 'reviewed-fixture.json.gz'), fixtureBytes)
    const fixture = JSON.parse(zlib.gunzipSync(fixtureBytes))
    if (fixture.schema !== 'quod-npm-install-reviewed-window-v1' || fixture.commits.length !== 12) throw new Error('invalid finite fixture')
    for (const [digest, bytes] of Object.entries(fixture.blobs)) if (hash(bytes) !== digest) throw new Error('fixture bytes mismatch')
    const unique = new Map()
    for (const row of fixture.commits) {
      const tuple = canonical(row.files)
      if (!unique.has(tuple)) unique.set(tuple, {...row, represented: []})
      unique.get(tuple).represented.push(row.i)
    }
    const original = [...unique.values()]
    if (canonical(original.map(row => row.i)) !== canonical([0, 2, 3, 4, 5, 6, 10, 11])) throw new Error('reviewed eight-tuple roster changed')
    const npmCli = executable('npm'), npmRoot = path.dirname(path.dirname(npmCli))
    const npmPackage = JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json')))
    if (npmPackage.name !== 'npm') throw new Error('npm executable origin mismatch')
    const version = spawnSync(process.execPath, [npmCli, '--version'], {encoding: 'utf8', timeout: 10000})
    if (version.status !== 0 || version.stdout.trim() !== npmPackage.version) throw new Error('npm tool version mismatch')
    const facts = {node: process.version, npm: npmPackage.version, bin: fs.realpathSync(process.execPath)}
    const env = {...process.env}
    const npmTree = inventory(npmRoot, undefined, {excludeRuntime: false})
    json(path.join(output, 'npm-tool-inventory.json'), npmTree.raw)
    report.tools = {facts, node: fileIdentity(facts.bin), npmCli: fileIdentity(npmCli), npmPackage: fileIdentity(path.join(npmRoot, 'package.json')),
      npmTreeSha256: npmTree.rawSha256}
    report.source = {fixtureSha256: FIXTURE_SHA, deps: fileIdentity(path.join(HERE, '../deps.cjs')),
      profile: fileIdentity(path.join(HERE, '../npm-install-profile.cjs'))}
    const comparisonVersion = JSON.parse(fixture.blobs[fixture.commits[0].files['package.json']]).version
    const inventoryByLabel = new Map()
    let firstScope
    for (const [position, source] of [...original, original[0]].entries()) {
      const label = position === 8 ? 'c0-repeat' : `c${source.i}`, dir = path.join(output, label)
      fs.mkdirSync(dir)
      fs.rmSync(project, {recursive: true, force: true})
      for (const [name, digest] of Object.entries(source.files)) {
        if (!['package.json', 'package-lock.json', '.npmrc', 'packages/convex-helpers/package.json'].includes(name)) throw new Error('unreviewed fixture path')
        const file = path.join(project, name)
        fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, fixture.blobs[digest])
      }
      const before = scope(project, facts, env), scopeDigest = hash(canonical(before))
      firstScope ??= scopeDigest
      const row = {label, i: source.i, commit: source.commit, represented: source.represented, inputs: source.files,
        profile: D.selectInstallProfile(project, info, 'v0'), key: D.key(project, info, facts, env, P.ID),
        legacyKey: D.key(project, info, facts, env), scope: before, scopeSha256: scopeDigest,
        argv: [facts.bin, npmCli, 'ci', '--no-audit', '--no-fund']}
      rows.push(row)
      check(`${label} finite profile admitted`, row.profile === P.ID)
      check(`${label} same tool config environment image scope`, scopeDigest === firstScope)
      const stdout = fs.openSync(path.join(dir, 'stdout.log'), 'w'), stderr = fs.openSync(path.join(dir, 'stderr.log'), 'w')
      const started = performance.now()
      try {
        const child = spawnSync(facts.bin, row.argv.slice(1), {cwd: project, env, stdio: ['ignore', stdout, stderr], timeout: 120000})
        row.exitCode = child.status; row.signal = child.signal; row.error = child.error?.message ?? null
      } finally { fs.closeSync(stdout); fs.closeSync(stderr) }
      row.seconds = (performance.now() - started) / 1000
      row.stdoutSha256 = hash(fs.readFileSync(path.join(dir, 'stdout.log')))
      row.stderrSha256 = hash(fs.readFileSync(path.join(dir, 'stderr.log')))
      check(`${label} actual npm ci succeeds`, row.exitCode === 0 && !row.signal && !row.error)
      check(`${label} scope unchanged after install`, hash(canonical(scope(project, facts, env))) === scopeDigest)
      row.inputsAfter = Object.fromEntries(Object.keys(source.files).map(name => [name, fileIdentity(path.join(project, name))]))
      check(`${label} finite install inputs and roster unchanged`, D.selectInstallProfile(project, info, 'v0') === P.ID &&
        Object.entries(source.files).every(([name, digest]) => row.inputsAfter[name].sha256 === digest))
      try {
        const data = inventory(path.join(project, 'node_modules'), comparisonVersion)
        inventoryByLabel.set(label, data.compared)
        json(path.join(dir, 'inventory.raw.json'), data.raw)
        json(path.join(dir, 'inventory.comparison.json'), data.compared)
        fs.copyFileSync(path.join(project, 'node_modules/.package-lock.json'), path.join(dir, 'hidden-lock.native.json'))
        Object.assign(row, {rawInventorySha256: data.rawSha256, comparisonInventorySha256: data.comparisonSha256,
          rawEntries: data.raw.length, comparedEntries: data.compared.length, exclusions: data.exclusions, normalizations: data.normalizations})
        check(`${label} complete tree inventoried`, data.raw.length > 1 && data.normalizations.length === 1)
      } catch (error) { row.inventoryError = String(error); check(`${label} complete tree inventoried`, false) }
      json(path.join(dir, 'result.json'), row)
      json(path.join(output, 'result.json'), report)
    }
    check('all eight tuples and independent c0 repeat completed', rows.length === 9)
    for (const row of rows) {
      const previous = row.i === 11 ? 'c10' : 'c0'
      const a = inventoryByLabel.get(previous), b = inventoryByLabel.get(row.label)
      const diffs = a && b ? difference(a, b) : null
      const expectedEqual = row.i < 10
      const file = `${row.label}-vs-${previous}.json`
      json(path.join(output, file), diffs)
      comparisons.push({label: row.label, baseline: previous, expectedEqual, mismatchFile: file,
        mismatchCount: diffs?.length ?? null, mismatchSha256: hash(canonical(diffs))})
      check(`${row.label} installed materialization ${expectedEqual ? 'equals' : 'differs from'} ${previous}`,
        diffs !== null && (expectedEqual ? diffs.length === 0 : diffs.length > 0))
      check(`${row.label} install key has expected class`, row.i < 10 ? row.key === rows[0].key :
        row.key !== rows[0].key && (row.i !== 11 || row.key !== rows.find(value => value.i === 10).key))
    }
    check('Node binary and complete npm tool tree unchanged', fileIdentity(facts.bin).sha256 === report.tools.node.sha256 &&
      inventory(npmRoot, undefined, {excludeRuntime: false}).rawSha256 === report.tools.npmTreeSha256)
    report.passed = checks.every(item => item.passed)
  } catch (error) { report.error = error.stack ?? String(error); check('gate completes without infrastructure error', false) }
  finally { fs.rmSync(project, {recursive: true, force: true}); json(path.join(output, 'result.json'), report) }
  console.log(JSON.stringify({schema: report.schema, passed: report.passed, installs: rows.length,
    checks: checks.length, failed: checks.filter(item => !item.passed).map(item => item.name)}))
  if (!report.passed) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2])
