#!/usr/bin/env python3
"""Offline fixed packaging-tree collection. Never executes collected source."""
import argparse
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path, PurePosixPath

REVISION = 'ebb95f8add54eee8bed840e3fb587e4cbec857d7'
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def blob(data, kind='blob'):
    return hashlib.sha1(kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def bounded(path, limit):
    path = Path(path).absolute()
    if path.resolve() != path or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('Bounded regular input without symlinks required')
    data = path.read_bytes()
    if len(data) > limit:
        raise ValueError('Input grew beyond limit')
    return data


def inspect_archive(data, tree, expected_tree):
    if len(data) > MAX_ARCHIVE or tree.get('truncated') is not False or tree.get('sha') != expected_tree:
        raise ValueError('Truncated or unbound Git tree')
    entries = tree.get('tree')
    if not isinstance(entries, list) or not 1 <= len(entries) <= 1000:
        raise ValueError('Invalid Git tree inventory')
    indexed = {}
    for entry in entries:
        name = entry.get('path', '')
        if (not re.fullmatch(r'[A-Za-z0-9._/-]+', name) or any(p in ('', '.', '..') for p in name.split('/')) or
                name in indexed or not re.fullmatch('[a-f0-9]{40}', entry.get('sha', ''))):
            raise ValueError('Unsafe or duplicate Git tree path')
        if not ((entry.get('type') == 'tree' and entry.get('mode') == '040000') or
                (entry.get('type') == 'blob' and entry.get('mode') in ('100644', '100755') and
                 type(entry.get('size')) is int and 0 <= entry['size'] <= MAX_FILE)):
            raise ValueError('Unsupported Git member type or mode')
        indexed[name] = entry
    for name in indexed:
        parent = name.rpartition('/')[0]
        if parent and (parent not in indexed or indexed[parent]['type'] != 'tree'):
            raise ValueError('Missing Git parent tree')
    for folder in [''] + [name for name, e in indexed.items() if e['type'] == 'tree']:
        children = [e for name, e in indexed.items() if name.rpartition('/')[0] == folder]
        children.sort(key=lambda e: (e['path'].rsplit('/', 1)[-1] + ('/' if e['type'] == 'tree' else '')).encode())
        encoded = b''.join((e['mode'].lstrip('0') + ' ' + e['path'].rsplit('/', 1)[-1]).encode() + b'\0' + bytes.fromhex(e['sha']) for e in children)
        expected = expected_tree if not folder else indexed[folder]['sha']
        if blob(encoded, 'tree') != expected:
            raise ValueError('Git directory object mismatch')
    pending, seen, total, count = {}, set(), 0, 0
    prefix = 'sharp-libvips-' + REVISION
    with tarfile.open(fileobj=io.BytesIO(data), mode='r|*') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            canonical = str(path)
            count += 1
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or canonical in seen or path.parts[:1] != (prefix,):
                raise ValueError('Unsafe, duplicate or wrong-root archive member')
            seen.add(canonical)
            total += member.size
            if count > 2000 or member.size < 0 or member.size > MAX_FILE or total > MAX_ARCHIVE:
                raise ValueError('Archive inventory limit exceeded')
            relative = '/'.join(path.parts[1:])
            if member.isdir():
                if relative and (relative not in indexed or indexed[relative]['type'] != 'tree'):
                    raise ValueError('Unexpected archive directory')
                continue
            entry = indexed.get(relative)
            if not member.isfile() or not entry or entry['type'] != 'blob':
                raise ValueError('Archive source must be a declared regular blob')
            content = archive.extractfile(member).read(MAX_FILE + 1)
            if len(content) != member.size or len(content) != entry['size'] or blob(content) != entry['sha']:
                raise ValueError('Archive blob content mismatch')
            if bool(member.mode & 0o111) != (entry['mode'] == '100755'):
                raise ValueError('Archive executable bit mismatch')
            pending[relative] = content
        if archive.pax_headers.get('comment') != REVISION:
            raise ValueError('Archive commit comment mismatch')
    if set(pending) != {name for name, e in indexed.items() if e['type'] == 'blob'}:
        raise ValueError('Archive source inventory incomplete')
    return pending, indexed


def collect(source_file, archive_file, tree_file, destination):
    source_file = Path(source_file).resolve()
    root = source_file.parent.parent
    source = json.loads(bounded(source_file, MAX_FILE))
    if source['packagingRevision'] != REVISION:
        raise ValueError('Unsupported packaging revision')
    review_pointer = source['mutableInputReview']
    if review_pointer['file'] != 'third-party/mutable-inputs/review.json':
        raise ValueError('Mutable source evidence required')
    review_bytes = bounded(root / review_pointer['file'], MAX_FILE)
    if digest(review_bytes) != review_pointer['sha256']:
        raise ValueError('Mutable source evidence digest mismatch')
    review = json.loads(review_bytes)
    commits = [a for a in review['assets'] if a['id'] == 'packaging-commit']
    if len(commits) != 1:
        raise ValueError('Exactly one packaging commit snapshot required')
    commit_asset = commits[0]
    if commit_asset['file'] != 'third-party/mutable-inputs/texts/' + commit_asset['sha256'] + '.txt':
        raise ValueError('Invalid packaging commit asset path')
    commit_bytes = bounded(root / commit_asset['file'], MAX_FILE)
    if digest(commit_bytes) != commit_asset['sha256']:
        raise ValueError('Packaging commit snapshot digest mismatch')
    commit = json.loads(commit_bytes)
    if commit['sha'] != REVISION:
        raise ValueError('Packaging commit identity mismatch')
    tree_bytes = bounded(Path(tree_file), MAX_FILE)
    tree = json.loads(tree_bytes)
    archive_bytes = bounded(Path(archive_file), MAX_ARCHIVE)
    pending, indexed = inspect_archive(archive_bytes, tree, commit['commit']['tree']['sha'])
    if len(pending) != 63:
        raise ValueError('Expected 63 fixed packaging files')
    aliases = {'build/posix.sh': 'build-posix.sh', 'versions.properties': 'versions.properties',
               'THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md', 'LICENSE': 'LICENSE'}
    for member, filename in aliases.items():
        path = 'third-party/sources/sharp-libvips-ebb95f8/' + filename
        recorded = [a for a in source['assets'] if a['file'] == path]
        if len(recorded) != 1 or digest(pending[member]) != recorded[0]['sha256'] or bounded(root / path, MAX_FILE) != pending[member]:
            raise ValueError('Previously retained packaging asset differs')
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    (output / 'texts').mkdir(mode=0o700)
    def retain(data):
        checksum = digest(data)
        path = output / 'texts' / (checksum + '.txt')
        if not path.exists():
            with path.open('xb') as handle:
                handle.write(data)
            path.chmod(0o600)
        elif path.is_symlink() or path.read_bytes() != data:
            raise ValueError('Packaging output collision')
        return {'file': 'third-party/packaging-source/texts/' + checksum + '.txt', 'sha256': checksum, 'bytes': len(data)}
    assets = []
    for name, data in sorted(pending.items()):
        entry = indexed[name]
        assets.append({**retain(data), 'archiveMember': 'sharp-libvips-' + REVISION + '/' + name,
                       'gitPath': name, 'gitMode': entry['mode'], 'gitBlobSha1': entry['sha']})
    report = {'format': 1, 'scope': 'fixed-packaging-tree-not-historical-environment',
              'revision': REVISION, 'gitTreeSha1': tree['sha'], 'historicalBuildVerified': False,
              'publisherSignatureVerified': False, 'sourceCodeExecuted': False, 'licenseClearance': 'not-assessed',
              'archive': {'sourceUrl': 'https://codeload.github.com/lovell/sharp-libvips/tar.gz/' + REVISION,
                          'sha256': digest(archive_bytes), 'bytes': len(archive_bytes), 'commitComment': REVISION},
              'tree': {**retain(tree_bytes), 'sourceUrl': 'https://api.github.com/repos/lovell/sharp-libvips/git/trees/' + tree['sha'] + '?recursive=1'},
              'commitSnapshot': {k: commit_asset[k] for k in ['file', 'sha256', 'bytes']},
              'collectorSha256': digest(Path(__file__).read_bytes()), 'assets': assets,
              'counts': {'regularFiles': len(assets), 'sourceBytes': sum(len(b) for b in pending.values())}}
    report_file = output / 'collection.json'
    report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    report_file.chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_review')
    parser.add_argument('archive')
    parser.add_argument('tree_json')
    parser.add_argument('new_directory')
    args = parser.parse_args()
    report = collect(args.source_review, args.archive, args.tree_json, args.new_directory)
    print(json.dumps(report['counts']))
