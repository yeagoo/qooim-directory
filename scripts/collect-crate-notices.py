#!/usr/bin/env python3
"""Collect checksum-verified crates.io archive evidence; never execute crate code."""
import argparse
import concurrent.futures
import importlib.util
import json
import re
import tarfile
import tomllib
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


native = module('native_notice_collector', 'collect-native-sources.py')
rust = module('rust_lock_inventory', 'inventory-rust-lock.py')
digest = native.digest
MAX_CRATE = 32 * 1024**2
BASE = 'https://static.crates.io/crates'
PREFIX = 'third-party/crate-notices/texts/'
RECIPE = 'third-party/sources/sharp-libvips-ebb95f8/build-posix.sh'
LOCK_STATUS = 'original-before-recipe-cargo-update-workspace'


def supplementary_materials(archive_path, package):
    """Candidate review inputs only; source prefixes are explicitly incomplete."""
    result, total = [], 0
    prefix = f"{package['name']}-{package['version']}/"
    with tarfile.open(archive_path, 'r|*') as archive:
        for member in archive:
            if not member.isfile():
                continue
            path = native.PurePosixPath(member.name)
            if not str(path).startswith(prefix):
                raise ValueError('Supplementary member outside crate root')
            if re.fullmatch(r'README(?:\.[A-Za-z0-9_-]+)?', path.name, re.I):
                if member.size > native.MAX_NOTICE:
                    raise ValueError('Supplementary README exceeds 2 MiB')
                data = archive.extractfile(member).read(native.MAX_NOTICE + 1)
                kind = 'readme'
            elif path.suffix == '.rs':
                data = archive.extractfile(member).read(4096)
                if not re.search(rb'copyright|licen[cs]e|permission|public domain', data, re.I):
                    continue
                kind = 'rust-source-prefix'
            else:
                continue
            if len(data) != min(member.size, 4096 if kind == 'rust-source-prefix' else native.MAX_NOTICE):
                raise ValueError('Truncated supplementary input')
            total += len(data)
            if len(result) >= 100 or total > 8 * 1024**2:
                raise ValueError('Supplementary inventory limit exceeded')
            checksum = digest(data)
            result.append(({"kind": kind, "archiveMember": member.name, "file": PREFIX + checksum + '.txt', "sha256": checksum, "bytes": len(data), "memberBytes": member.size, "offset": 0, "completeMember": len(data) == member.size}, data))
    return result


def load_inventory(inventory_file):
    path = Path(inventory_file)
    raw = path.read_bytes()
    inventory = json.loads(raw)
    if inventory.get('format') != 1 or inventory.get('scope') != 'complete-lockfile-not-compiled-graph' or inventory.get('licenseClearance') != 'not-assessed':
        raise ValueError('Invalid Rust input inventory scope')
    locks = [a for a in inventory['assets'] if a['file'] == 'third-party/rust-lock/sources/Cargo.lock']
    if len(locks) != 1:
        raise ValueError('Exactly one original Cargo lock required')
    lock_file = path.parent / 'sources/Cargo.lock'
    if lock_file.is_symlink() or not lock_file.is_file() or lock_file.stat().st_size > 2 * 1024**2:
        raise ValueError('Cargo lock must be a bounded regular file')
    lock = lock_file.read_bytes()
    if digest(lock) != locks[0]['sha256'] or len(lock) != locks[0]['bytes']:
        raise ValueError('Original Cargo lock integrity mismatch')
    packages = rust.packages_from_lock(lock)
    if inventory['packages'] != packages:
        raise ValueError('Rust inventory differs from original Cargo lock')
    return raw, lock, [p for p in packages if p['source'] == rust.REGISTRY]


def collect_package(package, output, archive_directory=None):
    name, version = package['name'], package['version']
    # Input has been validated against the original lock before creating output.
    url = f'{BASE}/{name}/{version}/download'
    result = {"name": name, "version": version, "checksum": package['checksum'], "sourceUrl": url, "licenseClearance": "not-assessed", "notices": []}
    archive_path = output / 'archives' / f'{name}-{version}.crate'
    checksum, size = native.hashlib.sha256(), 0
    try:
        if archive_directory is None:
            response = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'navigation-source-review/1'}), timeout=25)
        else:
            cached = Path(archive_directory).resolve() / f'{name}-{version}.crate'
            if cached.is_symlink() or not cached.is_file() or cached.stat().st_size > MAX_CRATE:
                raise ValueError('Cached crate must be a bounded regular file')
            response = cached.open('rb')
        with response:
            if archive_directory is None:
                final = urlsplit(response.url)
                if final.scheme != 'https' or final.hostname != 'static.crates.io' or final.username or final.password:
                    raise ValueError('Crate redirect must stay on official HTTPS storage')
            with archive_path.open('xb') as handle:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_CRATE:
                        raise ValueError('Crate exceeds 32 MiB')
                    checksum.update(chunk)
                    handle.write(chunk)
        archive_path.chmod(0o600)
        result.update(archiveSha256=checksum.hexdigest(), archiveBytes=size)
    except Exception as error:
        result.update(status='download-failed', error=str(error))
        return result
    if checksum.hexdigest() != package['checksum']:
        result.update(status='checksum-mismatch', error='Crate archive does not match original lock checksum')
        return result
    try:
        manifest_member = f'{name}-{version}/Cargo.toml'
        manifest = None
        # Bounded streaming metadata pass. The shared archive validator below
        # checks all member paths/duplicates before committing any notice.
        with tarfile.open(archive_path, 'r|*') as archive:
            total = 0
            for count, member in enumerate(archive, 1):
                total += member.size
                if count > native.MAX_MEMBERS or total > native.MAX_UNPACKED or member.size < 0:
                    raise ValueError('Crate inventory limit exceeded')
                if str(native.PurePosixPath(member.name)) != manifest_member:
                    continue
                if manifest is not None or not member.isfile() or member.size > native.MAX_NOTICE:
                    raise ValueError('Invalid or duplicate original crate manifest')
                manifest = archive.extractfile(member).read(native.MAX_NOTICE + 1)
                if len(manifest) != member.size:
                    raise ValueError('Truncated original crate manifest')
        if manifest is None:
            raise ValueError('Original crate manifest missing')
        metadata = tomllib.loads(manifest.decode('utf-8'))['package']
        if metadata.get('name') != name or metadata.get('version') != version:
            raise ValueError('Original crate manifest identity mismatch')
        for field in ('license', 'license-file'):
            if metadata.get(field) is not None and not isinstance(metadata[field], str):
                raise ValueError('Invalid original license declaration')
        notices, warnings = native.inspect_archive(archive_path, output / 'texts')
        for notice in notices:
            notice['file'] = PREFIX + notice['sha256'] + '.txt'
        manifest_sha = digest(manifest)
        supplementary = supplementary_materials(archive_path, package) if not notices else []
        with native._NOTICE_LOCK:
            for checksum, data in [(manifest_sha, manifest), *((record['sha256'], data) for record, data in supplementary)]:
                target = output / 'texts' / (checksum + '.txt')
                try:
                    with target.open('xb') as handle:
                        handle.write(data)
                    target.chmod(0o600)
                except FileExistsError:
                    if target.is_symlink() or digest(target.read_bytes()) != checksum:
                        raise ValueError('Original manifest or supplementary output collision')
        result.update(status='collected', manifest={"archiveMember": manifest_member, "file": PREFIX + manifest_sha + '.txt', "sha256": manifest_sha, "bytes": len(manifest)}, declaredLicense=metadata.get('license'), declaredLicenseFile=metadata.get('license-file'), notices=notices, warnings=warnings, supplementary=[record for record, data in supplementary], supplementaryStatus='not-requested' if notices else ('captured' if supplementary else 'no-candidate-found'))
        if not notices:
            result['warnings'].append('No original notice candidates; license declaration alone is not clearance')
    except Exception as error:
        result.update(status='archive-rejected', error=str(error))
    return result


def collect(inventory_file, config_file, destination, workers=4, archive_directory=None):
    raw, lock, packages = load_inventory(inventory_file)
    config_bytes = Path(config_file).read_bytes()
    config = json.loads(config_bytes)
    if config.get('dl') != BASE or config.get('auth-required'):
        raise ValueError('Unsupported registry download configuration')
    if not 1 <= workers <= 4:
        raise ValueError('Workers must be between 1 and 4')
    recipe_bytes = (Path(__file__).resolve().parent.parent / RECIPE).read_bytes()
    mutation_lines = [i for i, line in enumerate(recipe_bytes.decode('utf-8').splitlines(), 1) if line.strip() == 'cargo update --workspace']
    if len(mutation_lines) != 1:
        raise ValueError('Expected original recipe lock mutation not found')
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    (output / 'archives').mkdir(mode=0o700)
    (output / 'texts').mkdir(mode=0o700)
    (output / 'registry-config.json').write_bytes(config_bytes)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(lambda p: collect_package(p, output, archive_directory), packages))
    scripts = ['collect-crate-notices.py', 'collect-native-sources.py', 'inventory-rust-lock.py']
    report = {"format": 1, "scope": "complete-registry-lock-not-compiled-graph", "licenseClearance": "not-assessed", "inputSha256": digest(raw), "lockFileSha256": digest(lock), "collectors": [{"file": 'scripts/' + name, "sha256": digest((Path(__file__).parent / name).read_bytes())} for name in scripts], "registryConfig": {"file": "third-party/crate-notices/registry-config.json", "sha256": digest(config_bytes), "bytes": len(config_bytes)}, "packages": results}
    report.update(buildLockStatus=LOCK_STATUS, buildRecipe={"file": RECIPE, "sha256": digest(recipe_bytes), "bytes": len(recipe_bytes), "lockMutation": {"line": mutation_lines[0], "command": 'cargo update --workspace'}})
    (output / 'collection.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (output / 'collection.json').chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inventory')
    parser.add_argument('registry_config')
    parser.add_argument('new_directory')
    parser.add_argument('--archive-directory', help='Reinspect retained local crate archives without network; checksums remain mandatory')
    args = parser.parse_args()
    report = collect(args.inventory, args.registry_config, args.new_directory, archive_directory=args.archive_directory)
    failed = [f"{p['name']}@{p['version']}" for p in report['packages'] if p['status'] != 'collected']
    print(json.dumps({"packages": len(report['packages']), "collected": len(report['packages']) - len(failed), "failures": failed, "licenseClearance": "not-assessed"}))
    raise SystemExit(1 if failed else 0)
