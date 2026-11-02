import copy
from functools import lru_cache
from io import BytesIO, StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from approval_assessment import assess_approvals
from canonical import digest
from changeset_apply import apply_change_set
from external_comparison import compare_external_artifact_reference
from graph_index import build_graph_index, graph_index_snapshot
from graph_validation import validate_graph
from migration_apply import apply_migration
from package_records import read_package_files, write_package_files
from package_validation import validate_package_files
from portable_cli import MAX_REQUEST_BYTES, OPERATIONS, main
from report_records import read_report_source, serialize_report_yaml
from semantic_diff import create_migration_semantic_diff, create_semantic_diff
from test_approval_assessment import golden as approval_input
from test_changeset_apply import cases as changeset_cases
from test_external_comparison import cases as external_cases
from test_graph_validation import SCHEMA, entity
from test_migration_apply import cases as migration_cases
from test_package_core_validation import files_for
from test_package_history import cases as history_cases
from test_report_records import reports
from test_semantic_diff_generation import cases as diff_cases
from test_trace_query import cases as trace_cases
from trace_query import execute_trace_query
from yaml_authoring import read_authoring_yaml


SCRIPT = Path(__file__).with_name('portable_cli.py')


@lru_cache(maxsize=1)
def fixtures():
    files = files_for([entity(1, attributes={"actorKind": "synthetic", "name": "合成😀"}), entity(2)])
    contents = read_package_files(files)
    graph = {"graphRevision": contents["revision"]["id"], "schemaLockDigest": contents["calculatedSchemaLockDigest"],
             "schemas": [SCHEMA], "elements": contents["elements"], "approvals": contents["approvals"]}
    trace = next(value["input"] for value in trace_cases() if value["name"].endswith('-golden'))
    trace_report = execute_trace_query(trace)
    report_source = serialize_report_yaml(trace_report)
    normal = next(value["input"] for value in diff_cases() if value["accepted"] and not value["migration"])
    migration_diff = next(value["input"] for value in diff_cases() if value["accepted"] and value["migration"])
    changeset = next(value["input"] for value in changeset_cases() if value["accepted"])
    migration = next(value["input"] for value in migration_cases() if value["accepted"])
    external = external_cases()[0]["input"]
    approvals = approval_input()
    out = []

    def add(name, operation, request, expected, exit_code=0):
        out.append({"name": name, "operation": operation, "input": copy.deepcopy(request),
                    "expected": expected, "exit": exit_code})

    add('root-digest', 'digest', {"kind": "root", "value": contents["elements"]}, digest('root', contents["elements"]))
    add('authoring-read', 'read-yaml', report_source, read_authoring_yaml(report_source))
    add('report-read', 'read-report', report_source, read_report_source(report_source))
    add('report-write', 'serialize-report', trace_report, report_source)
    add('package-read', 'read-package', files, contents)
    add('package-export', 'export-package', files, write_package_files(contents))
    add('package-validation', 'validate-package', {"files": files}, validate_package_files(files))
    add('graph-validation', 'validate-graph', graph, validate_graph(graph_revision=graph["graphRevision"], schema_lock_digest=graph["schemaLockDigest"],
        schemas=graph["schemas"], elements=graph["elements"], approvals=graph["approvals"]))
    index_input = {"graphRevision": graph["graphRevision"], "elements": graph["elements"]}
    add('index', 'index', index_input, graph_index_snapshot(build_graph_index(index_input)))
    add('trace', 'trace', trace, trace_report)
    add('diff', 'diff', normal, create_semantic_diff(normal))
    add('migration-diff', 'migration-diff', migration_diff, create_migration_semantic_diff(migration_diff))
    add('changeset', 'apply-changeset', changeset, apply_change_set(changeset))
    add('migration', 'apply-migration', migration, apply_migration(migration))
    add('external', 'compare-external', external, compare_external_artifact_reference(external))
    add('approvals', 'assess-approvals', approvals, assess_approvals(approvals['approvals'], approvals['context']))
    invalid_elements = [entity(1, lifecycle='legacy')]
    invalid_files = files_for(invalid_elements)
    invalid_graph = {**graph, "elements": invalid_elements}
    add('invalid-graph', 'validate-graph', invalid_graph, validate_graph(graph_revision=graph["graphRevision"], schema_lock_digest=graph["schemaLockDigest"],
        schemas=graph["schemas"], elements=invalid_elements, approvals=[]), 1)
    add('invalid-package', 'validate-package', {"files": invalid_files}, validate_package_files(invalid_files), 1)
    invalid_report = next(value for value in reports() if value.get('status') == 'invalid')
    invalid_source = serialize_report_yaml(invalid_report)
    add('invalid-evidence-is-readable', 'read-report', invalid_source, read_report_source(invalid_source))
    add('no-applicable-approval', 'assess-approvals', {**approvals, "approvals": []}, assess_approvals([], approvals['context']))
    add('invalid-external-report', 'compare-external', {}, compare_external_artifact_reference({}))
    broken_trace = {**trace, "focusId": 'urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff'}
    add('broken-trace-report', 'trace', broken_trace, execute_trace_query(broken_trace))
    for name in ('allowed-active-transition', 'core.criterion-draft-deprecated'):
        value = next(value for value in history_cases() if value['name'] == name)
        result = validate_package_files(value['files'], previous_files=value['previousFiles'])
        add('history-' + name, 'validate-package', {"files": value['files'], "previousFiles": value['previousFiles']}, result, 0 if result['valid'] else 1)
    return out


def invoke(operation, value=None, *, raw=None, cwd=None):
    data = raw if raw is not None else json.dumps(value, ensure_ascii=False).encode('utf-8')
    return subprocess.run([sys.executable, '-B', str(SCRIPT), operation], input=data, capture_output=True, cwd=cwd, timeout=30)


class FragmentedInput:
    def __init__(self, source, fragment):
        self.source = BytesIO(source)
        self.fragment = fragment
        self.requests = []

    def read(self, size):
        self.requests.append(size)
        return self.source.read(min(size, self.fragment))

    read1 = read


def invoke_with_stream(operation, stream):
    output, errors = BytesIO(), StringIO()
    with patch('portable_cli.sys.stdin', SimpleNamespace(buffer=stream)), \
            patch('portable_cli.sys.stdout', SimpleNamespace(buffer=output)), \
            patch('portable_cli.sys.stderr', errors):
        result = main([operation])
    return result, output.getvalue(), errors.getvalue()


class PortableCliTests(unittest.TestCase):
    def test_partial_reads_are_joined_before_utf8_json_or_trailing_content_validation(self):
        request = {'kind': 'schema-lock', 'value': {'text': '日本語😀', 'padding': 'x' * 20000}}
        source = json.dumps(request, ensure_ascii=False).encode('utf-8')
        for fragment in (1, 3, 16384, 16385, 65536):
            with self.subTest(fragment=fragment):
                stream = FragmentedInput(source, fragment)
                result, output, errors = invoke_with_stream('digest', stream)
                self.assertEqual(result, 0, errors)
                self.assertEqual(json.loads(output), digest(request['kind'], request['value']))
                self.assertEqual(errors, '')
                self.assertEqual(stream.source.tell(), len(source))
        complete = b'{"kind":"root","value":[]}'
        result, output, errors = invoke_with_stream('digest', FragmentedInput(complete + b' invalid', len(complete)))
        self.assertEqual(result, 1)
        self.assertEqual(output, b'')
        self.assertEqual(json.loads(errors), {'error': {'code': 'PORTABLE_INPUT_INVALID', 'path': '/'}})

    def test_stream_read_stops_at_limit_without_draining_remaining_input(self):
        stream = FragmentedInput(b' ' * (MAX_REQUEST_BYTES + 512), 32768)
        result, output, errors = invoke_with_stream('digest', stream)
        self.assertEqual(result, 1)
        self.assertEqual(output, b'')
        self.assertEqual(stream.source.tell(), MAX_REQUEST_BYTES + 1)
        self.assertLessEqual(max(stream.requests), 65536)
        self.assertEqual(json.loads(errors), {'error': {'code': 'PORTABLE_INPUT_INVALID', 'path': '/'}})

    def test_all_operations_and_existing_result_scopes(self):
        self.assertEqual({value['operation'] for value in fixtures()}, set(OPERATIONS))
        for value in fixtures():
            with self.subTest(name=value['name']):
                before = copy.deepcopy(value)
                result = invoke(value['operation'], value['input'])
                self.assertEqual(result.returncode, value['exit'], result.stderr)
                self.assertEqual(result.stderr, b'')
                self.assertEqual(json.loads(result.stdout), value['expected'])
                self.assertEqual(value, before)

    def test_transport_rejects_invalid_json_without_echo_or_partial_output(self):
        for raw in [b'\xff', b'', b'{"kind":"root","kind":"revision","value":[]}', b'{"kind":"root","value":NaN}',
                    b'{"kind":"root","value":[SENSITIVE_TEST_VALUE}', b'x' * (MAX_REQUEST_BYTES + 1)]:
            result = invoke('digest', raw=raw)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(json.loads(result.stderr), {"error": {"code": "PORTABLE_INPUT_INVALID", "path": "/"}})
            self.assertNotIn(b'SENSITIVE_TEST_VALUE', result.stderr)

    def test_exact_input_limit_and_negative_zero_preservation(self):
        base = b'{"kind":"root","value":[]}'
        result = invoke('digest', raw=base + b' ' * (MAX_REQUEST_BYTES - len(base)))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), digest('root', []))
        result = invoke('digest', raw=b'{"kind":"schema-lock","value":-0}')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')

    def test_existing_error_code_and_pointer_are_forwarded(self):
        result = invoke('trace', {})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(json.loads(result.stderr), {"error": {"code": "TRACE_QUERY_UNKNOWN", "path": "/queryId"}})
        result = invoke('diff', {})
        self.assertEqual(json.loads(result.stderr), {"error": {"code": "SEMANTIC_DIFF_INPUT_INVALID", "path": "/baseRevision"}})

    def test_json_pipeline_between_report_write_and_read(self):
        value = next(value for value in fixtures() if value['operation'] == 'serialize-report')
        written = invoke('serialize-report', value['input'])
        restored = invoke('read-report', raw=written.stdout)
        self.assertEqual(restored.returncode, 0)
        self.assertEqual(json.loads(restored.stdout), read_report_source(value['expected']))

    def test_no_data_files_created_and_help_requires_no_input(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in fixtures():
                result = invoke(value['operation'], value['input'], cwd=directory)
                self.assertEqual(result.returncode, value['exit'])
            self.assertEqual(list(Path(directory).iterdir()), [])
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--help'], input=b'', capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'validate-package', result.stdout)
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
