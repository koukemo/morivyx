import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from canonical import digest
from package_records import read_package_files
from package_trace import trace_package, trace_package_files
from test_graph_validation import identity
from test_package_core_validation import files_for
from test_package_export import materialize
from test_trace_query import package_queries
from trace_query import execute_trace_query


SCRIPT = Path(__file__).with_name('package_trace.py')


def cases():
    out = []
    for original in package_queries():
        query = original['input']['queryId']
        out.append({'name': query, **copy.deepcopy(original)})
        out.append({'name': query + '-spoofed-source', 'files': original['files'], 'input': {
            **original['input'], 'graphRevision': None, 'schemaLockDigest': 'sha256:' + '0' * 64,
            'elements': []}})
        out.append({'name': query + '-missing-focus', 'files': original['files'], 'input': {
            **original['input'], 'focusId': identity(998)}})
        elements = read_package_files(original['files'])['elements']
        out.append({'name': query + '-no-relations', 'files': files_for([e for e in elements if e['kind'] == 'entity']),
                    'input': original['input']})
        out.append({'name': query + '-empty', 'files': files_for([]), 'input': original['input']})
    return out


def invoke(directory, request=None, raw=None):
    return subprocess.run([sys.executable, '-B', str(SCRIPT), str(directory)],
        input=raw if raw is not None else json.dumps(request).encode(), capture_output=True, timeout=30)


class PackageTraceTests(unittest.TestCase):
    def test_queries_use_checked_source_and_preserve_inputs(self):
        states = set()
        for value in cases():
            with self.subTest(name=value['name']):
                before = copy.deepcopy(value)
                contents = read_package_files(value['files'])
                expected = execute_trace_query({**value['input'], 'graphRevision': contents['revision']['id'],
                    'schemaLockDigest': contents['revision']['schemaLockDigest'], 'elements': contents['elements']})
                actual = trace_package_files(value['files'], value['input'])
                self.assertEqual(actual['report'], expected)
                self.assertEqual(actual['digest'], digest('trace-report', expected)['digest'])
                self.assertTrue(actual['valid'])
                self.assertFalse(actual['validation']['schemaValidated'])
                self.assertFalse(actual['validation']['graphReferencesValidated'])
                self.assertFalse(actual['validation']['signaturesValidated'])
                self.assertEqual(value, before)
                states.add(actual['report']['status'])
        self.assertEqual(states, {'complete', 'partial', 'broken'})

    def test_invalid_package_is_rejected_before_query_assessment(self):
        files = dict(package_queries()[0]['files'])
        del files['revision.yaml']
        with self.assertRaises(ValueError) as caught:
            trace_package_files(files, {})
        self.assertNotEqual(getattr(caught.exception, 'code', None), 'TRACE_QUERY_UNKNOWN')

    def test_invalid_requests_do_not_change_source(self):
        value = package_queries()[0]
        before = copy.deepcopy(value)
        for request in ([], 'input', {}, {**value['input'], 'focusId': None},
                        {**value['input'], 'evaluatedAt': 'not-a-date'}):
            with self.assertRaises(ValueError):
                trace_package_files(value['files'], request)
        self.assertEqual(value, before)

    def test_directory_and_cli_match_file_mapping_without_writes(self):
        values = package_queries()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / '.morivyx'
            materialize(root, values[0]['files'])
            for value in values:
                expected = trace_package_files(value['files'], value['input'])
                self.assertEqual(trace_package(root, value['input']), expected)
                result = invoke(root, value['input'])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, b'')
                self.assertEqual(json.loads(result.stdout), expected)
            self.assertEqual({p.relative_to(root).as_posix(): p.read_text() for p in root.rglob('*') if p.is_file()}, values[0]['files'])

    def test_cli_invalid_transport_and_queries_emit_no_partial_result(self):
        value = package_queries()[0]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / '.morivyx'
            materialize(root, value['files'])
            for raw in (b'\xff', b'{"queryId":"x","queryId":"y"}', b'{SENSITIVE_TEST_VALUE'):
                result = invoke(root, raw=raw)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b'')
                self.assertNotIn(b'SENSITIVE_TEST_VALUE', result.stderr)
                self.assertEqual(json.loads(result.stderr)['error']['path'], '/')
            result = invoke(root, {})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(json.loads(result.stderr), {'error': {'code': 'TRACE_QUERY_UNKNOWN', 'path': '/queryId'}})

    def test_directory_guards_are_used_by_trace_entry(self):
        value = package_queries()[0]
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / '.morivyx'
            materialize(root, value['files'])
            link = base / 'linked-root'
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises((ValueError, OSError)):
                trace_package(link, value['input'])
            target = root / 'revision.yaml'
            saved = base / 'saved-revision.yaml'
            target.rename(saved)
            target.symlink_to(saved)
            with self.assertRaises((ValueError, OSError)):
                trace_package(root, value['input'])
            target.unlink()
            os.link(saved, target)
            with self.assertRaises((ValueError, OSError)):
                trace_package(root, value['input'])


if __name__ == '__main__':
    unittest.main()
