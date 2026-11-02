"""Derive a corpus from fixed public Git objects and the released Python reader."""
import hashlib
import json
import platform
import sys
from pathlib import Path
import subprocess
import tempfile

REPO = Path(__file__).resolve().parent.parent
COMMIT = '306dec450c30c3dd5945ca4f0ffb787b50dc4193'
TAG = '84ec87cb665977f7604505db6ee220b1acece8db'
PYTHON = sys.executable

if subprocess.check_output(['git', 'rev-parse', 'v0.1.0^{tag}'], cwd=REPO, text=True).strip() != TAG:
    raise SystemExit('Pinned public release tag does not match')
if subprocess.check_output(['git', 'rev-parse', TAG + '^{commit}'], cwd=REPO, text=True).strip() != COMMIT:
    raise SystemExit('Pinned public release commit does not match')


def git(path):
    return subprocess.check_output(['git', 'show', COMMIT + ':' + path], cwd=REPO)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', COMMIT], cwd=REPO, text=True).splitlines()
sources = {}
snapshots = []
with tempfile.TemporaryDirectory(prefix='morivyx-released-reader-') as temporary:
    runtime = Path(temporary)
    modules = [p for p in paths if p.startswith('packages/portable-core/') and p.count('/') == 2 and p.endswith('.py') and not p.rsplit('/', 1)[1].startswith('test_')]
    assert len(modules) == 26
    for path in modules:
        raw = git(path)
        (runtime / path.rsplit('/', 1)[1]).write_bytes(raw)
        sources[path] = sha(raw)
    schema_path = 'packages/portable-core/core-schema.yaml'
    schema = git(schema_path)
    (runtime / 'core-schema.yaml').write_bytes(schema)
    sources[schema_path] = sha(schema)

    def invoke(operation, value, status=0):
        result = subprocess.run([PYTHON, '-B', str(runtime / 'portable_cli.py'), operation],
                                input=json.dumps(value, ensure_ascii=False).encode(), capture_output=True, timeout=30)
        assert result.returncode == status, result.stderr
        assert not result.stderr, result.stderr
        return json.loads(result.stdout)

    def append(name, files, origin):
        read = invoke('read-package', files)
        exported = invoke('export-package', files)
        exported_read = invoke('read-package', exported)
        assert read['calculatedRootDigest'] == exported_read['calculatedRootDigest']
        assert read['calculatedSchemaLockDigest'] == exported_read['calculatedSchemaLockDigest']
        validation = invoke('validate-package', {'files': files}, 0 if name == 'complete-core' else 1)
        snapshots.append({
            'name': name, 'origin': origin,
            'files': files, 'fileSha256': {p: sha(s.encode()) for p, s in files.items()},
            'expectedLogical': {k: read[k] for k in ['schemaLock', 'revision', 'elements', 'approvals', 'changeSets', 'migrations', 'reports']},
            'expectedRootDigest': read['calculatedRootDigest'],
            'expectedSchemaLockDigest': read['calculatedSchemaLockDigest'],
            'expectedValidation': validation,
            'expectedExport': exported,
            'expectedExportLogical': {k: exported_read[k] for k in ['schemaLock', 'revision', 'elements', 'approvals', 'changeSets', 'migrations', 'reports']},
        })

    for name in ['package-v1', 'package-v1-roundtrip']:
        prefix = 'packages/kernel/test/fixtures/' + name + '/.morivyx/'
        files = {}
        for path in paths:
            if path.startswith(prefix):
                raw = git(path)
                sources[path] = sha(raw)
                files[path[len(prefix):]] = raw.decode('utf-8')
        append(name, files, {'directory': prefix})
    vector_path = 'packages/portable-core/fixtures/portable-cli-vectors.json'
    raw = git(vector_path)
    sources[vector_path] = sha(raw)
    vector = next(c for c in json.loads(raw)['cases'] if c['operation'] == 'read-package')
    append('complete-core', vector['input'], {'vectorPath': vector_path, 'case': vector['name']})
    assert sum(len(s['files']) for s in snapshots) == 19

result = {
    'format': 'morivyx.test.first-public-packages/1',
    'repository': 'koukemo/morivyx', 'commit': COMMIT, 'tag': 'v0.1.0', 'tagObject': TAG,
    'sourceManifestSha256': sha(git('SOURCE-MANIFEST.json')),
    'expectationReader': {'sourceCommit': COMMIT, 'python': platform.python_version(), 'productionModules': 26},
    'sourceFiles': sources, 'snapshots': snapshots,
}
print(json.dumps(result, ensure_ascii=False, indent=2))
