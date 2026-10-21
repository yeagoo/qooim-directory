#!/usr/bin/env python3
"""Match priority crate files to their recorded commits and retain license inputs.

This is evidence collection, never a license-clearance or build-verification step.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import re
import tarfile
import tomllib
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('crate_materials', Path(__file__).parent / 'collect-crate-notices.py')
crate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crate)
digest = crate.digest
PRIORITY = {'mutants': '0.0.4', 'selectors': '0.40.0'}
PREFIX = 'third-party/priority-crates/texts/'
SCOPE = 'pinned-priority-crate-source-and-license-material-not-clearance'
MPL_URL = 'https://www.mozilla.org/en-US/MPL/2.0/'
MAX_FILE = 2 * 1024**2


def github_identity(repository, vcs):
    match = re.fullmatch(r'https://github.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)', repository)
    revision, subdirectory = vcs.get('git', {}).get('sha1'), vcs.get('path_in_vcs')
    if not match or any(p in ('.', '..') for p in match[1].split('/')) or not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision) or not isinstance(subdirectory, str) or not re.fullmatch(r'[A-Za-z0-9_/-]+', subdirectory) or any(p in ('', '.', '..') for p in subdirectory.split('/')):
        raise ValueError('Unsafe or missing original GitHub VCS identity')
    return match[1], revision, subdirectory


def archive_files(path, package):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > crate.MAX_CRATE:
        raise ValueError('Priority crate must be a bounded regular archive')
    raw = path.read_bytes()
    if digest(raw) != package['checksum'] or len(raw) != package['archiveBytes']:
        raise ValueError('Priority crate checksum mismatch')
    top = package['name'] + '-' + package['version']
    result, seen, total = {}, set(), 0
    with tarfile.open(path, 'r|*') as archive:
        for count, member in enumerate(archive, 1):
            p = PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or '\\' in member.name or str(p) in seen or not p.parts or p.parts[0] != top:
                raise ValueError('Unsafe or duplicate priority crate member')
            seen.add(str(p))
            total += member.size
            if count > 100000 or member.size < 0 or total > 32 * 1024**2 or member.size > MAX_FILE:
                raise ValueError('Priority source inventory limit exceeded')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('Priority source links and special members refused')
            data = archive.extractfile(member).read(MAX_FILE + 1)
            if len(data) != member.size:
                raise ValueError('Truncated priority source member')
            result[str(p.relative_to(top))] = data
    return result


def review(source_review, archives, destination, cache_directory=None):
    path = Path(source_review).resolve()
    project = path.parent.parent
    source = json.loads(path.read_bytes())
    collection_raw = (project / 'third-party/crate-notices/collection.json').read_bytes()
    resolution_raw = (project / 'third-party/rust-resolution/resolution.json').read_bytes()
    if digest(collection_raw) != source['crateNoticeCollection']['sha256'] or digest(resolution_raw) != source['rustResolution']['sha256']:
        raise ValueError('Priority source input binding mismatch')
    collection, resolution = json.loads(collection_raw), json.loads(resolution_raw)
    selected_rows = [p for p in collection['packages'] if p['name'] in PRIORITY and p['version'] == PRIORITY[p['name']]]
    selected = {p['name']: p for p in selected_rows}
    if len(selected_rows) != len(PRIORITY) or set(selected) != set(PRIORITY):
        raise ValueError('Exact priority package inventory required')
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    (output / 'texts').mkdir(mode=0o700)
    (output / 'cache').mkdir(mode=0o700)
    assets, records = {}, []

    def retain(data):
        checksum = digest(data)
        target = output / 'texts' / (checksum + '.txt')
        if checksum not in assets:
            with target.open('xb') as handle:
                handle.write(data)
            target.chmod(0o600)
            assets[checksum] = {'file': PREFIX + checksum + '.txt', 'sha256': checksum, 'bytes': len(data)}
        return dict(assets[checksum])

    def fetch(url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('api.github.com', 'raw.githubusercontent.com', 'www.mozilla.org') or parsed.username or parsed.password:
            raise ValueError('Unexpected priority source URL')
        key = digest(url.encode()) + '.body'
        if cache_directory is not None:
            cached = Path(cache_directory) / key
            if cached.is_symlink() or not cached.is_file() or cached.stat().st_size > MAX_FILE:
                raise ValueError('Priority cached response must be bounded regular data')
            data = cached.read_bytes()
        else:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'navigation-source-review/1'}), timeout=25) as response:
                final = urlsplit(response.url)
                if final.scheme != 'https' or final.hostname != parsed.hostname or final.username or final.password:
                    raise ValueError('Priority source redirect changed official host')
                data = response.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('Priority response exceeds 2 MiB')
        target = output / 'cache' / key
        with target.open('xb') as handle:
            handle.write(data)
        target.chmod(0o600)
        return data

    for name, version in PRIORITY.items():
        package = selected[name]
        membership = next(p for p in resolution['missingNoticePackages'] if p['name'] == name and p['version'] == version)
        if package['status'] != 'collected' or package['notices'] or not membership['presentInScenarios']:
            raise ValueError('Priority candidate must remain a missing-notice scenario member')
        members = archive_files(Path(archives) / (name + '-' + version + '.crate'), package)
        normalized = tomllib.loads(members['Cargo.toml'].decode())['package']
        if normalized['name'] != name or normalized['version'] != version:
            raise ValueError('Priority manifest identity mismatch')
        vcs = json.loads(members['.cargo_vcs_info.json'])
        repository, revision, subdirectory = github_identity(normalized['repository'], vcs)
        vcs_asset = retain(members['.cargo_vcs_info.json'])
        tree_url = f'https://api.github.com/repos/{repository}/git/trees/{revision}'
        tree_raw = fetch(tree_url)
        tree = json.loads(tree_raw)
        if tree.get('sha') != revision or tree.get('truncated') is not False or not isinstance(tree.get('tree'), list):
            raise ValueError('Fixed revision root tree incomplete or mismatched')
        tree_asset = retain(tree_raw)
        matched = []
        ordinary = [(relative, data) for relative, data in sorted(members.items()) if relative not in ('Cargo.toml', 'Cargo.lock', '.cargo_vcs_info.json')]
        if not ordinary or 'Cargo.toml.orig' not in members:
            raise ValueError('Original crate manifest and source members required')
        def compare(entry):
            relative, original = entry
            upstream = subdirectory + '/' + ('Cargo.toml' if relative == 'Cargo.toml.orig' else relative)
            url = f'https://raw.githubusercontent.com/{repository}/{revision}/{upstream}'
            data = fetch(url)
            if data != original:
                raise ValueError('Pinned upstream source differs from original crate: ' + relative)
            return relative, upstream, url, data
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            compared = list(executor.map(compare, ordinary))
        for relative, upstream, url, data in compared:
            matched.append({**retain(data), 'archiveMember': name + '-' + version + '/' + relative, 'upstreamPath': upstream, 'sourceUrl': url, 'archiveMemberSha256': digest(members[relative])})
        if name == 'mutants':
            license_node = [n for n in tree['tree'] if n.get('path') == 'LICENSE' and n.get('type') == 'blob']
            if len(license_node) != 1:
                raise ValueError('Pinned repository license missing')
            url = f'https://raw.githubusercontent.com/{repository}/{revision}/LICENSE'
            license_raw = fetch(url)
            blob = hashlib.sha1(b'blob ' + str(len(license_raw)).encode() + b'\0' + license_raw).hexdigest()
            if blob != license_node[0].get('sha'):
                raise ValueError('Pinned license Git blob mismatch')
            license_record = {**retain(license_raw), 'kind': 'repository-license', 'sourceUrl': url, 'immutableReference': True, 'gitBlobSha1': blob}
        else:
            if not any(b'https://mozilla.org/MPL/2.0/' in data for relative, data in members.items() if relative.endswith('.rs')):
                raise ValueError('Original MPL header reference missing')
            license_raw = fetch(MPL_URL)
            if b'Mozilla Public License' not in license_raw or b'Version 2.0' not in license_raw:
                raise ValueError('Official MPL document markers missing')
            license_record = {**retain(license_raw), 'kind': 'official-standard-document-html', 'sourceUrl': MPL_URL, 'immutableReference': False}
        records.append({'name': name, 'version': version, 'checksum': package['checksum'], 'licenseClearance': 'not-assessed', 'originalCrateNoticeMissing': True, 'repository': repository, 'revision': revision, 'pathInVcs': subdirectory, 'vcsWorkingTreeStatus': 'not-asserted', 'vcsInfo': {**vcs_asset, 'archiveMember': name + '-' + version + '/.cargo_vcs_info.json'}, 'rootTree': {**tree_asset, 'sourceUrl': tree_url}, 'matches': matched, 'license': license_record})
    report = {'format': 1, 'scope': SCOPE, 'licenseClearance': 'not-assessed', 'publisherSignatureVerified': False, 'historicalBuildVerified': False, 'collector': {'file': 'scripts/review-priority-crates.py', 'sha256': digest(Path(__file__).read_bytes())}, 'inputs': {'crateCollectionSha256': digest(collection_raw), 'rustResolutionSha256': digest(resolution_raw)}, 'assets': list(assets.values()), 'packages': records}
    (output / 'review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (output / 'review.json').chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_review')
    parser.add_argument('crate_archives')
    parser.add_argument('new_directory')
    parser.add_argument('--cache-directory', help='Recheck retained HTTP response bytes without network')
    args = parser.parse_args()
    report = review(args.source_review, args.crate_archives, args.new_directory, args.cache_directory)
    print(json.dumps({'packages': len(report['packages']), 'sourceMatches': sum(len(p['matches']) for p in report['packages']), 'assets': len(report['assets']), 'licenseClearance': 'not-assessed'}))
