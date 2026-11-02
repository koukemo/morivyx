"""Emit native patches for pinned Unicode 16 data, with upstream hash verification.

Run with js or py for the embedded tables, or tests INDEX [PART] for the
conformance corpus. Test chunks have 1200 lines; PART splits a chunk into
100-line pieces. Apply in order. No repository files are written by this tool.
"""

import hashlib
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHECK = '--check' in sys.argv
if CHECK:
    sys.argv.remove('--check')
if len(sys.argv) < 2 or sys.argv[1] not in ('js', 'py', 'tests'):
    raise SystemExit('usage: generate-unicode-data.py js|py|tests [INDEX [PART]] [--check]')
HASHES = {
    'UnicodeData.txt': 'ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f',
    'DerivedNormalizationProps.txt': '4d4c03892dea9146d674b686e495df2d55a28d071ac474041d73518f887abddc',
    'NormalizationTest.txt': 'd811971453e7075e1ad56fb1b301eece5aa80757b81f6156e74a1bfb3ae5ceb1',
}

def read(name):
    data = urllib.request.urlopen('https://www.unicode.org/Public/16.0.0/ucd/' + name, timeout=30).read()
    assert hashlib.sha256(data).hexdigest() == HASHES[name]
    return data.decode('utf-8')

def patch(path, old, new, add=False):
    if CHECK:
        assert new in (ROOT / path).read_text()
        print('Pinned Unicode 16 data matches: ' + path)
        return
    print('*** Begin Patch')
    print(('*** Add File: ' if add else '*** Update File: ') + str(ROOT / path))
    if not add:
        print('@@')
        for line in old.splitlines(): print('-' + line)
    for line in new.splitlines(): print('+' + line)
    print('*** End Patch')

if sys.argv[1] == 'tests':
    lines = ['# Derived from Unicode 16.0.0 NormalizationTest.txt; SHA-256 ' + HASHES['NormalizationTest.txt'],
             '# Unicode License V3: see ../src/unicode-nfc.js for the complete notice.']
    for line in read('NormalizationTest.txt').splitlines():
        line = line.split('#')[0].strip()
        if line.startswith('@'): lines.append(line)
        elif line: lines.append(';'.join(part.strip() for part in line.split(';')[:5]))
    if CHECK:
        assert (ROOT / 'packages/kernel/test/fixtures/unicode-normalization-16.txt').read_text() == '\n'.join(lines) + '\n'
        print('Pinned Unicode 16 corpus matches: 19965 rows')
        raise SystemExit(0)
    index = int(sys.argv[2])
    assert 0 <= index * 1200 < len(lines)
    chunk = lines[index * 1200:(index + 1) * 1200]
    sentinel = '# CONTINUE UNICODE DATA ' + str(index)
    if len(sys.argv) > 3:
        part = int(sys.argv[3])
        whole = chunk
        assert 0 <= part * 100 < len(whole)
        chunk = whole[part * 100:(part + 1) * 100]
        if part: sentinel += '-' + str(part)
        if (part + 1) * 100 < len(whole): chunk.append('# CONTINUE UNICODE DATA ' + str(index) + '-' + str(part + 1))
        elif (index + 1) * 1200 < len(lines): chunk.append('# CONTINUE UNICODE DATA ' + str(index + 1))
    elif (index + 1) * 1200 < len(lines): chunk.append('# CONTINUE UNICODE DATA ' + str(index + 1))
    patch('packages/kernel/test/fixtures/unicode-normalization-16.txt', sentinel, '\n'.join(chunk), index == 0)
else:
    exclusions = set()
    for line in read('DerivedNormalizationProps.txt').splitlines():
        parts = line.split('#')[0].split(';')
        if len(parts) < 2 or parts[1].strip() != 'Full_Composition_Exclusion': continue
        bounds = parts[0].strip().split('..')
        first, last = int(bounds[0], 16), int(bounds[-1], 16)
        exclusions.update(range(first, last + 1))
    combining, decompositions, compositions = [], [], []
    for line in read('UnicodeData.txt').splitlines():
        fields = line.split(';'); point = int(fields[0], 16)
        if int(fields[3]): combining.append([point, int(fields[3])])
        if fields[5] and not fields[5].startswith('<'):
            parts = [int(v, 16) for v in fields[5].split()]
            decompositions.append([point, parts])
            if len(parts) == 2 and point not in exclusions:
                compositions.append([parts[0] * 0x110000 + parts[1], point])
    license = urllib.request.urlopen('https://www.unicode.org/license.txt', timeout=30).read().decode()
    assert hashlib.sha256(license.encode()).hexdigest() == 'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96'
    js = sys.argv[1] == 'js'
    prefix = '// ' if js else '# '
    new = '\n'.join((prefix + line).rstrip() for line in license.splitlines()) + '\n'
    for name, sha in HASHES.items():
        if name != 'NormalizationTest.txt': new += prefix + name + ' SHA-256 ' + sha + '\n'
    for name, values in [('COMBINING', combining), ('DECOMPOSITIONS', decompositions), ('COMPOSITIONS', compositions)]:
        if js: new += 'const ' + name + ' = new Map(' + json.dumps(values, separators=(',', ':')) + ');\n'
        else: new += name + ' = dict(' + repr(values) + ')\n'
    path = 'packages/kernel/src/unicode-nfc.js' if js else 'packages/portable-core/unicode_nfc.py'
    patch(path, prefix.rstrip() + ' GENERATED UNICODE DATA', new)
