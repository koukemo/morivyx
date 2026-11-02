import copy
import re
import unittest

from canonical import canonical_json
from package_records import read_package_files
from package_validation import validate_package_files
from report_records import read_report_source, serialize_report_yaml
from test_package_export import cases as export_cases
from test_report_records import reports
from test_yaml_authoring import cases as authoring_cases
from test_yaml_sequences_unicode import source as block_source
from yaml_authoring import read_authoring_yaml
from yaml_records import MAX_BYTES, MAX_DEPTH, mapping_pair, read_yaml, write_yaml


def wrapped(source, mode):
    """Change value spellings only; do not wrap implicit mapping keys."""
    lines = []
    for raw in source.split('\n')[:-1]:
        text = raw.lstrip(' ')
        pair = mapping_pair(text)
        rest = text[2:] if text.startswith('- ') and not mapping_pair(text[2:]) else pair[1] if pair else ''
        if rest.startswith('"') and rest.endswith('"'):
            prefix = raw[:-len(rest)]
            continuation = ' ' * (len(prefix) + 2)
            content = rest[1:-1]
            if mode in (0, 2):
                content = re.sub(r'^ +', lambda m: '\\ ' * len(m[0]), content)
                content = '\\\n' + continuation + content
            if mode in (1, 2):
                content += '\\\n' + continuation
            lines.append(prefix + '"' + content + '"')
        else:
            lines.append(raw)
    return '\n'.join(lines) + '\n'


def examples():
    return [
        ('space', 'x: "first\n  second"\n', {'x': 'first second'}),
        ('one-blank', 'x: "first\n\n  second"\n', {'x': 'first\nsecond'}),
        ('two-blanks', 'x: "first\n  \n\n  second"\n', {'x': 'first\n\nsecond'}),
        ('trailing-spaces', 'x: "first   \n  second"\n', {'x': 'first second'}),
        ('escaped-space', 'x: "first\\ \n  second"\n', {'x': 'first  second'}),
        ('escaped-break', 'x: "first\\\n  second"\n', {'x': 'firstsecond'}),
        ('escaped-one-blank', 'x: "first\\\n\n  second"\n', {'x': 'first second'}),
        ('escaped-two-blanks', 'x: "first\\\n\n\n  second"\n', {'x': 'first\nsecond'}),
        ('empty-final', 'x: "first\n  "\n', {'x': 'first '}),
        ('empty-initial', 'x: "\n  second"\n', {'x': ' second'}),
        ('empty-lines', 'x: "\n\n  "\n', {'x': '\n'}),
        ('escaped-spaces-before-break', 'x: "a  \\\n  b"\n', {'x': 'a  b'}),
        ('backslashes', 'x: "a\\\\\n  b"\n', {'x': 'a\\ b'}),
        ('escaped-quote', 'x: "a\\\"\n  b"\n', {'x': 'a" b'}),
        ('unicode-pair', 'x: "\\uD83D\\\n  \\uDE00"\n', {'x': '😀'}),
        ('unicode-normalized', 'x: "e\\\n  \\u0301"\n', {'x': 'é'}),
        ('literal-markers', 'x: "a\n  # text\n  ---\n  % directive"\n', {'x': 'a # text --- % directive'}),
        ('nested-list', 'x:\n- key: "a\n    b"\n  next: "c"\n', {'x': [{'key': 'a b', 'next': 'c'}]}),
        ('list-value', 'x:\n- "a\n  b"\ny: "after"\n', {'x': ['a b'], 'y': 'after'}),
        ('list-colon', 'x:\n- "a: text\n  b"\n', {'x': ['a: text b']}),
        ('nested-map', 'x:\n  y: "a\n   b"\nz: "after"\n', {'x': {'y': 'a b'}, 'z': 'after'}),
    ]


def invalid_sources():
    return ['x: "unfinished\n', 'x: "a\nb"\n', 'x: "a\n  b" extra\n',
            'x: "a\n  b" # comment\n', 'x: "a\n---\n  b"\n',
            'x: "a\\q\n  b"\n', 'x: "\\uD800\n  b"\n',
            'x: "a\n  b"\n# comment\n', 'x: "a\n  b"\n---\n',
            'x: "a\n  b"\ny: |\n  text\n', 'x: "a\n  b"\ny: [1]\n',
            'x: "a\n  b"\ny: &anchor "text"\n', 'x: "a\n  b"\ny: *alias\n',
            'x: "a\n  b"\nx: "duplicate"\n', '"multi\n  key": "value"\n',
            'x: "a\n  b"\n\n', 'x: "a\n\tb"\n', 'x: "a\r\n  b"\n']


def cases():
    out = []
    for original in authoring_cases():
        for mode in (0, 1, 2):
            out.append({**original, 'name': original['name'] + '-wrap-' + str(mode),
                        'source': wrapped(original['source'], mode), 'policyCase': True})
    for name, source, expected in examples():
        out.append({'name': name, 'source': source, 'accepted': True, 'expected': expected})
    for root in (0, 2):
        for indent in (1, 4):
            for tail_id, tail in enumerate(('', '  ', '\\ ', '  \\ ')):
                for escaped in (False, True):
                    for blanks in range(4):
                        source = ' ' * root + 'x: "a' + tail + ('\\' if escaped else '') + '\n'
                        source += '\n' * blanks + ' ' * (root + indent) + 'b"\n'
                        out.append({'name': f'fold-{root}-{indent}-{tail_id}-{escaped}-{blanks}',
                                    'source': source, 'accepted': True})
    out.extend({'name': 'invalid-' + str(i), 'source': source, 'accepted': False}
               for i, source in enumerate(invalid_sources()))
    return out


def package_cases():
    out = []
    for original in export_cases():
        if original['name'] not in ('valid-core', 'all-records-and-reports', 'report-alias'):
            continue
        for mode in (0, 1, 2):
            out.append({'name': original['name'] + '-wrap-' + str(mode), 'baselineFiles': original['files'],
                        'files': {name: wrapped(value, mode) for name, value in original['files'].items()}})
    return out


class MultilineYamlTests(unittest.TestCase):
    def test_folding_and_escaped_line_breaks(self):
        for name, source, expected in examples():
            with self.subTest(name=name):
                self.assertEqual(read_yaml(source), expected)

    def test_existing_authoring_rules_and_diagnostics(self):
        for original in authoring_cases():
            try:
                baseline = read_authoring_yaml(original['source'])
                error = None
            except ValueError as caught:
                error = (getattr(caught, 'code', None), getattr(caught, 'path', None))
            for mode in (0, 1, 2):
                source = wrapped(original['source'], mode)
                if error:
                    with self.assertRaises(ValueError) as caught:
                        read_authoring_yaml(source)
                    self.assertEqual((getattr(caught.exception, 'code', None), getattr(caught.exception, 'path', None)), error)
                else:
                    self.assertEqual(read_authoring_yaml(source), baseline)

    def test_invalid_sources_and_resource_guards(self):
        for source in invalid_sources() + [b'x: "a\n  \xff"\n', b'\xef\xbb\xbfx: "a\n  b"\n',
                'x: "' + 'a' * MAX_BYTES + '\n  b"\n']:
            with self.subTest(source=str(source)[:40]), self.assertRaises(ValueError):
                read_yaml(source)
        nested = 'value'
        for _ in range(MAX_DEPTH + 2):
            nested = {'x': nested}
        with self.assertRaises(ValueError):
            read_yaml(wrapped(block_source(nested), 2))

    def test_wrapping_preserves_spaces_and_linear_long_values(self):
        source = 'x: "  leading and trailing  "\n'
        for mode in (0, 1, 2):
            self.assertEqual(read_yaml(wrapped(source, mode)), read_yaml(source))
        self.assertEqual(read_yaml('x: "a' + '\n  a' * 10000 + '"\n')['x'], ' '.join(['a'] * 10001))

    def test_checked_packages_and_original_inputs(self):
        for case in package_cases():
            before = copy.deepcopy(case)
            baseline = read_package_files(case['baselineFiles'])
            actual = read_package_files(case['files'])
            baseline.pop('schemaSources'); actual.pop('schemaSources')
            self.assertEqual(canonical_json(actual), canonical_json(baseline))
            self.assertEqual(validate_package_files(case['files']), validate_package_files(case['baselineFiles']))
            self.assertEqual(case, before)

    def test_report_contents_digests_and_writer_are_unchanged(self):
        for report in reports():
            baseline = serialize_report_yaml(report)
            for mode in (0, 1, 2):
                source = wrapped(baseline, mode)
                self.assertEqual(read_report_source(source), read_report_source(baseline))
                self.assertEqual(write_yaml(read_yaml(source)), baseline)


if __name__ == '__main__':
    unittest.main()
