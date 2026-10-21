#!/usr/bin/env python3
"""Offline maintainer collection of the exact gvdb input declared by GLib. No source execution."""
import argparse
import configparser
import hashlib
import importlib.util
import io
import json
import re
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

spec = importlib.util.spec_from_file_location('native_source', Path(__file__).with_name('collect-native-sources.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
REVISION = '2b42fc75f09dbe1cd1057580b5782b08f2dcb400'
REPOSITORY = 'https://gitlab.gnome.org/GNOME/gvdb.git'
MEMBERS = {'.gitignore', 'COPYING', 'LICENSES/LGPL-2.1-or-later.txt', 'README.md', 'gvdb.doap',
           'gvdb/gvdb-builder.c', 'gvdb/gvdb-builder.h', 'gvdb/gvdb-format.h',
           'gvdb/gvdb-reader.c', 'gvdb/gvdb-reader.h', 'gvdb/tests/gvdb.c',
           'gvdb/tests/meson.build', 'meson.build', 'meson.options'}
MAX_ARCHIVE = 8 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bounded(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('Input must be a bounded regular file')
    data = path.read_bytes()
    if len(data) > limit:
        raise ValueError('Input grew beyond limit')
    return data


def collect(manifest_file, archive_file, expected_sha256, destination):
    manifest_file = Path(manifest_file).resolve()
    root = manifest_file.parent.parent
    source = json.loads(bounded(manifest_file, 2 * 1024 * 1024))
    glibs = [c for c in source['componentDeclarations'] if c['id'] == 'glib']
    if len(glibs) != 1:
        raise ValueError('Exactly one GLib parent required')
    glib = glibs[0]
    wrap_file = f"third-party/sources/glib-{glib['declaredVersion']}/gvdb.wrap"
    wraps = [a for a in source['assets'] if a['file'] == wrap_file]
    if len(wraps) != 1:
        raise ValueError('Original gvdb wrap required')
    wrap = wraps[0]
    if (wrap.get('archiveSha256') != glib['retrieval']['sha256'] or
            wrap.get('archiveMember') != f"glib-{glib['declaredVersion']}/subprojects/gvdb.wrap" or
            wrap.get('sourceUrl') != glib['declaredSourceUrl']):
        raise ValueError('Parent GLib archive identity mismatch')
    wrap_path = root / wrap_file
    if wrap_path.resolve() != wrap_path:
        raise ValueError('Wrap path must not traverse symlinks')
    wrap_bytes = bounded(wrap_path, 2 * 1024 * 1024)
    if digest(wrap_bytes) != wrap['sha256']:
        raise ValueError('Original wrap digest mismatch')
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(wrap_bytes.decode('utf-8'))
    if (set(parser.sections()) != {'wrap-git', 'provide'} or parser.defaults() or
            dict(parser['wrap-git']) != {'directory': 'gvdb', 'url': REPOSITORY, 'revision': REVISION, 'depth': '1'} or
            dict(parser['provide']) != {'dependency_names': 'gvdb'}):
        raise ValueError('Unsupported gvdb wrap identity')
    recipe = source['patchRecipe']
    if (recipe['file'] != 'third-party/sources/sharp-libvips-ebb95f8/build-posix.sh' or
            not any(a['file'] == recipe['file'] and a['sha256'] == recipe['sha256'] for a in source['assets'])):
        raise ValueError('Original packaging recipe required')
    recipe_path = root / recipe['file']
    if recipe_path.resolve() != recipe_path:
        raise ValueError('Recipe path must not traverse symlinks')
    recipe_bytes = bounded(recipe_path, 2 * 1024 * 1024)
    if digest(recipe_bytes) != recipe['sha256']:
        raise ValueError('Original recipe digest mismatch')
    selection = [i + 1 for i, line in enumerate(recipe_bytes.decode('utf-8').splitlines()) if '--force-fallback-for=gvdb' in line]
    if len(selection) != 1:
        raise ValueError('Unique gvdb fallback selection required')
    archive_file = Path(archive_file)
    data = bounded(archive_file, MAX_ARCHIVE)
    if not re.fullmatch('[a-f0-9]{64}', expected_sha256) or digest(data) != expected_sha256:
        raise ValueError('Archive checksum mismatch')
    prefix = 'gvdb-' + REVISION
    pending, seen, total, count = {}, set(), 0, 0
    # Reading only; never use tarfile.extract/extractall or a source member as an output path.
    with tarfile.open(fileobj=io.BytesIO(data), mode='r|*') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            canonical = str(path)
            count += 1
            if (path.is_absolute() or '..' in path.parts or '\\' in member.name or
                    canonical in seen or path.parts[:1] != (prefix,)):
                raise ValueError('Unsafe, duplicate or unexpected archive member')
            seen.add(canonical)
            total += member.size
            if count > 2000 or total > MAX_TOTAL or member.size < 0:
                raise ValueError('Archive inventory limit exceeded')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('Source member must be regular; links are refused')
            if member.size > 2 * 1024 * 1024:
                raise ValueError('Source member too large')
            relative = '/'.join(path.parts[1:])
            if relative not in MEMBERS:
                raise ValueError('Unexpected fixed-commit source member')
            content = archive.extractfile(member).read(2 * 1024 * 1024 + 1)
            if len(content) != member.size:
                raise ValueError('Truncated source member')
            pending[relative] = content
        archive_commit = archive.pax_headers.get('comment')
    if archive_commit != REVISION:
        raise ValueError('Archive commit comment does not match fixed revision')
    if set(pending) != MEMBERS:
        raise ValueError('Fixed-commit source inventory incomplete')
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    texts = output / 'texts'
    texts.mkdir(mode=0o700)
    # Feed the shared notice checker a private copy of the same verified bytes.
    # The caller's archive may change while this maintenance job is running.
    with tempfile.TemporaryDirectory(prefix='navigation-gvdb-') as temporary:
        snapshot = Path(temporary) / 'source.tar.gz'
        with snapshot.open('xb') as handle:
            handle.write(data)
        snapshot.chmod(0o600)
        notices, warnings = native.inspect_archive(snapshot, texts)
    assets = []
    for relative, content in sorted(pending.items()):
        checksum = digest(content)
        file = texts / (checksum + '.txt')
        if file.exists():
            if file.is_symlink() or file.read_bytes() != content:
                raise ValueError('Source output collision')
        else:
            with file.open('xb') as handle:
                handle.write(content)
            file.chmod(0o600)
        assets.append({'archiveMember': prefix + '/' + relative,
                       'file': 'third-party/gvdb-source/texts/' + checksum + '.txt',
                       'sha256': checksum, 'bytes': len(content)})
    for notice in notices:
        notice['file'] = 'third-party/gvdb-source/texts/' + notice['sha256'] + '.txt'
    report = {'format': 1, 'scope': 'fixed-gvdb-source-and-notice-candidates-not-clearance',
              'licenseClearance': 'not-assessed', 'historicalBinaryMatch': 'not-asserted',
              'publisherSignatureVerified': False, 'sourceCodeExecuted': False,
              'component': {'id': 'gvdb', 'parent': 'glib', 'repository': REPOSITORY, 'revision': REVISION,
                            'sourceUrl': REPOSITORY.removesuffix('.git') + '/-/archive/' + REVISION + '/gvdb-' + REVISION + '.tar.gz',
                            'archiveSha256': expected_sha256, 'archiveBytes': len(data),
                            'archiveCommitComment': archive_commit, 'archiveIncluded': False},
              'parentWrap': {**wrap, 'bytes': len(wrap_bytes)},
              'recipe': {**recipe, 'bytes': len(recipe_bytes), 'selectionLine': selection[0], 'selectionToken': '--force-fallback-for=gvdb'},
              'collectors': [{'file': 'scripts/' + p.name, 'sha256': digest(p.read_bytes())} for p in
                             [Path(__file__), Path(__file__).with_name('collect-native-sources.py')]],
              'assets': assets, 'notices': notices, 'warnings': warnings,
              'counts': {'regularFiles': len(assets), 'noticeReferences': len(notices),
                         'assetFiles': len({a['file'] for a in assets}),
                         'assetBytes': sum(len(b) for b in {digest(b): b for b in pending.values()}.values())}}
    file = output / 'collection.json'
    file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    file.chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest')
    parser.add_argument('archive')
    parser.add_argument('archive_sha256')
    parser.add_argument('new_directory')
    args = parser.parse_args()
    result = collect(args.manifest, args.archive, args.archive_sha256, args.new_directory)
    print(json.dumps({'files': result['counts']['regularFiles'], 'notices': len(result['notices']), 'clearance': result['licenseClearance']}))
