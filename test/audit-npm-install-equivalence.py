#!/usr/bin/env python3
import argparse, gzip, hashlib, io, json, math, pathlib, re, stat, sys, zipfile

RUN = 42404970746
SOURCE = 'bbb73ea3ed754043ed0709428d1d77cd40d4a1e0'
PROFILE = 'convex-helpers-original12-npm-install-v1'
FIXTURE = 'bea2adcbf5748c8e4251eeedbc69412e3ba36aaa10d510f9561bcf3b56d2a365'
parser = argparse.ArgumentParser(description='Data-only audit of the frozen original12 npm materialization evidence; never executes artifact code')
parser.add_argument('artifact_root', type=pathlib.Path)
parser.add_argument('metadata_prefix', type=pathlib.Path, help='prefix for -run.json, -jobs.json, -artifacts.json, .zip and .log')
parser.add_argument('source_checkout', type=pathlib.Path, help='reviewed Action source files at the frozen gate implementation')
parser.add_argument('out', type=pathlib.Path)
args = parser.parse_args()
BASE, META, CODE, OUT = args.artifact_root.resolve(), args.metadata_prefix, args.source_checkout.resolve(), args.out
issues, phases = [], []

def need(value, message):
    if not value:
        raise ValueError(message)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def read(file):
    def pairs(rows):
        value = {}
        for key, item in rows:
            need(key not in value, 'duplicate JSON key')
            value[key] = item
        return value
    return json.loads(file.read_bytes(), object_pairs_hook=pairs)

def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None

def validate_inventory(rows):
    need(isinstance(rows, list) and len(rows) > 1, 'missing complete inventory')
    names = [row['path'] for row in rows]
    need(len(names) == len(set(names)) and names == sorted(names, key=lambda x: x.encode('utf-16-be')), 'duplicate or unsorted paths')
    by_name = {row['path']: row for row in rows}
    for row in rows:
        name, kind = row['path'], row['kind']
        need(isinstance(name, str) and (name == '.' or (not name.startswith('/') and '..' not in name.split('/') and '\x00' not in name)), 'invalid relative path')
        need(type(row['mode']) is int and 0 <= row['mode'] <= 0o7777, 'invalid mode')
        common = {'path', 'kind', 'mode'}
        if kind == 'file':
            need(set(row) == common | {'size', 'sha256'} and type(row['size']) is int and row['size'] >= 0 and digest(row['sha256']), 'invalid file row')
        elif kind == 'symlink':
            need(set(row) == common | {'target'} and isinstance(row['target'], str), 'invalid symlink row')
        else:
            need(kind == 'directory' and set(row) == common, 'invalid directory/special/excluded row')
        if name != '.':
            parent = name.rsplit('/', 1)[0] if '/' in name else '.'
            need(parent in by_name and by_name[parent]['kind'] == 'directory', 'missing directory parent')
    need(by_name['.']['kind'] == 'directory', 'missing tree root')
    return by_name

try:
    run = read(pathlib.Path(str(META) + '-run.json'))
    jobs = read(pathlib.Path(str(META) + '-jobs.json'))['jobs']
    artifacts = read(pathlib.Path(str(META) + '-artifacts.json'))['artifacts']
    need(run['id'] == RUN and run['head_sha'] == SOURCE and run['head_branch'] == 'exp/npm-install-equivalence-sol-ultra' and run['event'] == 'workflow_dispatch' and run['conclusion'] == 'success', 'wrong authoritative run')
    need(len(artifacts) == 1, 'wrong artifact count')
    artifact = artifacts[0]
    archive = pathlib.Path(str(META) + '.zip').read_bytes()
    need(artifact['id'] == 13587446148 and artifact['name'] == 'npm-install-equivalence' and not artifact['expired'] and len(archive) == artifact['size_in_bytes'] and 'sha256:' + sha(archive) == artifact['digest'], 'archive authority mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        entries = zipped.infolist()
        need(len(entries) == 66 and sum(entry.file_size for entry in entries) < 500_000_000, 'wrong archive entry/byte count')
        names = set()
        for entry in entries:
            name = pathlib.PurePosixPath(entry.filename)
            need(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename and entry.filename not in names and not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16), 'unsafe or duplicate archive entry')
            names.add(entry.filename)
            local = BASE.joinpath(*name.parts)
            need(local.resolve().is_relative_to(BASE) and not local.is_symlink() and local.is_file(), 'unsafe extracted file')
            payload = zipped.read(entry)
            need(len(payload) == local.stat().st_size and sha(payload) == sha(local.read_bytes()), 'extracted data differs from authenticated archive')
        need(names == {file.relative_to(BASE).as_posix() for file in BASE.rglob('*') if file.is_file()}, 'extracted archive roster mismatch')
    measured = [job for job in jobs if job['name'] == 'npm-install-equivalence']
    need(len(measured) == 1 and measured[0]['conclusion'] == 'success' and all(step['conclusion'] == 'success' for step in measured[0]['steps']), 'gate steps incomplete')
    log = pathlib.Path(str(META) + '.log').read_text()
    need(re.search(r'ℹ tests 33\s', log) and re.search(r'ℹ pass 33\s', log) and re.search(r'ℹ fail 0\s', log), 'remote regression suite did not pass all33')
    fixture_bytes = (BASE / 'reviewed-fixture.json.gz').read_bytes()
    need(sha(fixture_bytes) == FIXTURE, 'unreviewed fixture archive')
    fixture = json.loads(gzip.decompress(fixture_bytes))
    need(len(fixture['commits']) == 12, 'missing original source states')
    for key, value in fixture['blobs'].items():
        need(sha(value.encode()) == key, 'fixture input digest mismatch')
    result = read(BASE / 'result.json')
    order = ['c0', 'c2', 'c3', 'c4', 'c5', 'c6', 'c10', 'c11', 'c0-repeat']
    need(result['schema'] == 'quod-npm-install-equivalence-v1' and result['passed'] is True and result['order'] == order and len(result['rows']) == 9 and len(result['comparisons']) == 9, 'wrong or incomplete gate result')
    need(result['github']['runId'] == str(RUN) and result['github']['source'] == SOURCE and result['github']['runAttempt'] == '1', 'wrong producer identity')
    need(result['driverSha256'] == sha((CODE / 'test/npm-install-equivalence.mjs').read_bytes()), 'driver source mismatch')
    need(result['source']['fixtureSha256'] == FIXTURE and result['source']['deps']['sha256'] == sha((CODE / 'deps.cjs').read_bytes()) and result['source']['profile']['sha256'] == sha((CODE / 'npm-install-profile.cjs').read_bytes()), 'source policy mismatch')
    need(result['tools']['facts']['node'] == 'v24.18.0' and result['tools']['facts']['npm'] == '11.16.0', 'wrong observed tools')
    tools = read(BASE / 'npm-tool-inventory.json')
    validate_inventory(tools)
    need(sha(canonical(tools)) == result['tools']['npmTreeSha256'], 'npm tool tree mismatch')
    baseline_version = json.loads(fixture['blobs'][fixture['commits'][0]['files']['package.json']])['version']
    baseline_scope = None
    keys, summaries = {}, {}
    for label, row in zip(order, result['rows']):
        need(row['label'] == label and row['i'] == (0 if label == 'c0-repeat' else int(label[1:])), 'wrong fixed install order')
        source = fixture['commits'][row['i']]
        need(row['commit'] == source['commit'] and row['inputs'] == source['files'], 'wrong actual source tuple')
        need(row['profile'] == PROFILE and re.fullmatch('[a-f0-9]{40}', row['key']) is not None and re.fullmatch('[a-f0-9]{40}', row['legacyKey']) is not None, 'invalid install key/profile')
        need(row['exitCode'] == 0 and row['signal'] is None and row['error'] is None and isinstance(row['seconds'], (int, float)) and math.isfinite(row['seconds']) and row['seconds'] > 0, 'native npm ci did not pass')
        need(row['argv'] == [result['tools']['facts']['bin'], result['tools']['npmCli']['path'], 'ci', '--no-audit', '--no-fund'], 'wrong native installer invocation')
        need(sha(canonical(row['scope'])) == row['scopeSha256'], 'scope digest mismatch')
        baseline_scope = baseline_scope or row['scopeSha256']
        need(row['scopeSha256'] == baseline_scope and row['scope']['node'] == 'v24.18.0' and row['scope']['npm'] == '11.16.0', 'scope drift')
        need(row['scope']['files'][0]['sha256'] == source['files']['.npmrc'], 'project npmrc scope missing')
        need(set(row['inputsAfter']) == set(source['files']) and all(row['inputsAfter'][name]['sha256'] == value and row['inputsAfter'][name]['bytes'] == len(fixture['blobs'][value].encode()) for name, value in source['files'].items()), 'install mutated declared inputs')
        directory = BASE / label
        need(read(directory / 'result.json') == row, 'per-install result mismatch')
        need(sha((directory / 'stdout.log').read_bytes()) == row['stdoutSha256'] and sha((directory / 'stderr.log').read_bytes()) == row['stderrSha256'], 'native log bytes mismatch')
        raw, compared = read(directory / 'inventory.raw.json'), read(directory / 'inventory.comparison.json')
        raw_map, compared_map = validate_inventory(raw), validate_inventory(compared)
        need(row['exclusions'] == [] and len(raw) == len(compared) == row['rawEntries'] == row['comparedEntries'], 'unreviewed materialization exclusion')
        hidden = (directory / 'hidden-lock.native.json').read_bytes()
        value = json.loads(hidden)
        normalized = hidden
        if value.get('version') != baseline_version:
            value['version'] = baseline_version
            normalized = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
        need(sha(hidden) == raw_map['.package-lock.json']['sha256'] and len(hidden) == raw_map['.package-lock.json']['size'], 'native hidden-lock bytes mismatch')
        expected = [{**entry, 'sha256': sha(normalized), 'size': len(normalized)} if entry['path'] == '.package-lock.json' else entry for entry in raw]
        need(expected == compared, 'comparison changed bytes/modes/paths beyond the hook header rewrite')
        need(len(row['normalizations']) == 1 and row['normalizations'][0] == {'path': '.package-lock.json', 'nativeVersion': json.loads(hidden).get('version'), 'comparisonVersion': baseline_version, 'rawSha256': sha(hidden), 'comparisonSha256': sha(normalized), 'changed': hidden != normalized}, 'normalization proof mismatch')
        need(sha(canonical(raw)) == row['rawInventorySha256'] and sha(canonical(compared)) == row['comparisonInventorySha256'], 'complete inventory digest mismatch')
        other = 'c10' if row['i'] == 11 else 'c0'
        previous = compared_map if label == 'c0' else validate_inventory(read(BASE / other / 'inventory.comparison.json'))
        mismatches = []
        for name in sorted(set(previous) | set(compared_map), key=lambda x: x.encode('utf-16-be')):
            before, after = previous.get(name), compared_map.get(name)
            if before != after:
                mismatches.append({'path': name, 'change': 'added' if before is None else 'removed' if after is None else 'changed', 'before': before, 'after': after})
        comparison = result['comparisons'][len(phases)]
        need(comparison == {'label': label, 'baseline': other, 'expectedEqual': row['i'] < 10, 'mismatchFile': f'{label}-vs-{other}.json', 'mismatchCount': len(mismatches), 'mismatchSha256': sha(canonical(mismatches))}, 'reported mismatch inventory summary mismatch')
        need(read(BASE / comparison['mismatchFile']) == mismatches, 'full mismatch inventory incomplete')
        need((not mismatches) if row['i'] < 10 else bool(mismatches), 'unexpected equivalence/dependency change')
        keys[label] = row['key']
        phases.append({'label': label, 'seconds': row['seconds'], 'entries': len(raw), 'mismatches': len(mismatches), 'comparisonSha256': row['comparisonInventorySha256']})
    need(len({keys[label] for label in order if label not in ['c10', 'c11']}) == 1 and len({keys['c0'], keys['c10'], keys['c11']}) == 3, 'wrong install equivalence classes')
    need(len(result['checks']) == 74 and len({row['name'] for row in result['checks']}) == 74 and all(row['passed'] is True for row in result['checks']), 'missing or failed producer checks')
except (OSError, ValueError, TypeError, KeyError, IndexError, AssertionError) as error:
    issues.append(str(error))

files = {file.relative_to(BASE).as_posix(): {'bytes': file.stat().st_size, 'sha256': sha(file.read_bytes())} for file in sorted(BASE.rglob('*')) if file.is_file()}
audit = {'schema': 'quod-npm-install-independent-audit-v1', 'passed': not issues, 'issues': issues, 'run': RUN,
         'source': SOURCE, 'readerSha256': sha(pathlib.Path(__file__).read_bytes()), 'phases': phases, 'files': files,
         'scope': 'Data-only audit of API-authenticated archive, complete byte/mode/symlink inventories, exact header normalization, source/tool/config scopes and full mismatch files; no artifact code executed'}
OUT.write_text(json.dumps(audit, indent=2) + '\n')
print(json.dumps({'passed': audit['passed'], 'issues': issues, 'phases': phases, 'files': len(files), 'out': str(OUT)}))
sys.exit(0 if audit['passed'] else 1)
