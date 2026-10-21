#!/usr/bin/env python3
"""Bundle retained, verified native source inputs offline; never a clearance or rebuild claim."""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

MAX_FILES = 4000
MAX_TOTAL = 512 * 1024 * 1024
LIMITS = {'native-archive': 96 * 1024 * 1024, 'crate-archive': 32 * 1024 * 1024,
          'gvdb-archive': 8 * 1024 * 1024, 'packaging-archive': 8 * 1024 * 1024,
          'evidence': 2 * 1024 * 1024}
GAPS = [
    'Complete nested native dependency graph beyond the retained declarations is not verified.',
    'Historical final Cargo lock and exact historical mutable network responses remain unknown.',
    'Patches and inline source edits are retained but not applied by this archive tool.',
    'Platform-specific binary linkage and correspondence to retained source are not verified.',
    'Fixed packaging tree is retained; toolchain, sysroot and historical build environment are not captured.',
    'Notice applicability, source fulfilment and distribution review remain incomplete.',
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_evidence_records(root, node):
    # Only trusted project tooling is run. No collected code, build scripts or patches execute.
    program = '''
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sourceFiles } from './scripts/release.mjs';
import { verifyNativeSourceEvidence } from './scripts/distribution.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const paths = (await sourceFiles()).filter(p => p.startsWith('third-party/') || p.startsWith('scripts/'));
const records = [];
for (const path of paths) { const bytes = await readFile(path); records.push({path, bytes:bytes.length, sha256:hash(bytes)}); }
const result = await verifyNativeSourceEvidence();
if (result.components !== 28 || result.collected !== 28) throw new Error('Expected 28 collected native declarations');
for (const entry of records) if (hash(await readFile(entry.path)) !== entry.sha256) throw new Error('Evidence changed during validation');
process.stdout.write(JSON.stringify(records));
'''
    result = subprocess.run([node, '--input-type=module', '-e', program], cwd=root,
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    return json.loads(result.stdout)


def open_regular(path):
    path = Path(os.path.abspath(path))
    if path.resolve() != path:
        raise ValueError('Input must not traverse symlinks')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError('Input must be a regular file')
        return os.fdopen(descriptor, 'rb')
    except BaseException:
        os.close(descriptor)
        raise


class HashingReader:
    def __init__(self, handle):
        self.handle = handle
        self.checksum = hashlib.sha256()
        self.count = 0

    def read(self, size=-1):
        data = self.handle.read(size)
        self.checksum.update(data)
        self.count += len(data)
        return data


def validate_entries(entries):
    if not entries or len(entries) > MAX_FILES:
        raise ValueError('Invalid source inventory size')
    names, total = set(), 0
    for entry in entries:
        name = entry['path']
        path = PurePosixPath(name)
        if (not re.fullmatch(r'[A-Za-z0-9.+_/-]+', name) or path.is_absolute() or
                any(p in ('.', '..', '') for p in name.split('/')) or name in names or
                name == 'NATIVE-SOURCE-MANIFEST.json'):
            raise ValueError('Unsafe or duplicate bundle path')
        names.add(name)
        size = entry['bytes']
        if (entry['kind'] not in LIMITS or type(size) is not int or size < 0 or
                size > LIMITS[entry['kind']] or not re.fullmatch('[a-f0-9]{64}', entry['sha256'])):
            raise ValueError('Invalid source file identity or size')
        total += size
    if total > MAX_TOTAL:
        raise ValueError('Source payload exceeds total limit')


def bundle(entries, destination):
    validate_entries(entries)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError('Destination already exists')
    if destination.parent.resolve() != Path(os.path.abspath(destination.parent)):
        raise ValueError('Destination parent must not traverse symlinks')
    public = [{k: e[k] for k in ('path', 'kind', 'sha256', 'bytes')} for e in sorted(entries, key=lambda e: e['path'])]
    counts = {kind: sum(e['kind'] == kind for e in entries) for kind in LIMITS}
    manifest = {'format': 1, 'scope': 'retained-native-source-inputs-not-complete-corresponding-source',
                'licenseClearance': 'not-assessed', 'historicalBuildVerified': False,
                'sourceCodeExecuted': False, 'patchesApplied': False,
                'applicationSourceIncluded': False, 'counts': counts,
                'payloadBytes': sum(e['bytes'] for e in entries), 'gaps': GAPS, 'files': public}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.native-source-', suffix='.tar', dir=destination.parent, delete=False) as handle:
            temporary = Path(handle.name)
            with tarfile.open(fileobj=handle, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for entry in sorted(entries, key=lambda e: e['path']):
                    info = tarfile.TarInfo(entry['path'])
                    info.size = entry['bytes']
                    info.mode = 0o644
                    # TarInfo defaults give deterministic uid/gid/mtime and empty owner names.
                    with open_regular(entry['source']) as source:
                        if os.fstat(source.fileno()).st_size != info.size:
                            raise ValueError('Input byte count mismatch: ' + entry['path'])
                        reader = HashingReader(source)
                        archive.addfile(info, reader)
                        if (reader.count != info.size or reader.checksum.hexdigest() != entry['sha256'] or source.read(1)):
                            raise ValueError('Input checksum mismatch: ' + entry['path'])
                data = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
                info = tarfile.TarInfo('NATIVE-SOURCE-MANIFEST.json')
                info.size, info.mode = len(data), 0o644
                archive.addfile(info, io.BytesIO(data))
            handle.flush()
            os.fsync(handle.fileno())
        # Same-directory hard link publishes atomically without overwriting a raced destination.
        os.link(temporary, destination)
        return manifest
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def plan(root, native_directory, crate_directory, gvdb_archive, node, packaging_archive=None):
    root = Path(root).resolve()
    records = verified_evidence_records(root, node)
    evidence = {}
    entries = []
    for record in records:
        entry = {'path': 'evidence/' + record['path'], 'kind': 'evidence',
                 'sha256': record['sha256'], 'bytes': record['bytes'], 'source': root / record['path']}
        entries.append(entry)
        evidence[record['path']] = entry
    def load(name):
        entry = evidence[name]
        with open_regular(entry['source']) as handle:
            data = handle.read(LIMITS['evidence'] + 1)
        if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
            raise ValueError('Evidence changed after verification')
        return json.loads(data)
    source = load('third-party/libvips-source-review.json')
    native = load('third-party/component-notices.json')
    crates = load(source['crateNoticeCollection']['file'])
    gvdb = load(source['gvdbSourceCollection']['file'])['component']
    packaging = load(source['packagingSourceCollection']['file'])['archive']
    if packaging_archive is None:
        raise ValueError('Fixed packaging archive is required')
    for record in native['components']:
        if record['status'] != 'collected':
            raise ValueError('All native source archives must be collected')
        entries.append({'path': 'sources/native/' + record['id'] + '.tar', 'kind': 'native-archive',
                        'source': Path(native_directory) / (record['id'] + '.tar'),
                        'sha256': record['archiveSha256'], 'bytes': record['archiveBytes']})
    for record in crates['packages']:
        if record['status'] != 'collected':
            raise ValueError('All registry source archives must be collected')
        name = record['name'] + '-' + record['version'] + '.crate'
        entries.append({'path': 'sources/crates/' + name, 'kind': 'crate-archive',
                        'source': Path(crate_directory) / name,
                        'sha256': record['checksum'], 'bytes': record['archiveBytes']})
    entries.append({'path': 'sources/gvdb.tar.gz', 'kind': 'gvdb-archive', 'source': Path(gvdb_archive),
                    'sha256': gvdb['archiveSha256'], 'bytes': gvdb['archiveBytes']})
    entries.append({'path': 'sources/packaging.tar.gz', 'kind': 'packaging-archive', 'source': Path(packaging_archive),
                    'sha256': packaging['sha256'], 'bytes': packaging['bytes']})
    return entries


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native_archives')
    parser.add_argument('crate_archives')
    parser.add_argument('gvdb_archive')
    parser.add_argument('new_tar')
    parser.add_argument('--root', default='.')
    parser.add_argument('--node', default='node')
    parser.add_argument('--packaging-archive', required=True)
    args = parser.parse_args()
    result = bundle(plan(args.root, args.native_archives, args.crate_archives, args.gvdb_archive, args.node, args.packaging_archive), args.new_tar)
    print(json.dumps({'scope': result['scope'], 'counts': result['counts'], 'payloadBytes': result['payloadBytes'], 'clearance': result['licenseClearance']}))
