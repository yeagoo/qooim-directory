#!/usr/bin/env python3
"""Maintainer-only offline Cargo tree scenarios. No crate build scripts are run."""
import argparse
import importlib.util
import json
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

spec = importlib.util.spec_from_file_location('crate_inputs', Path(__file__).parent / 'collect-crate-notices.py')
crate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crate)
digest = crate.digest
PREFIX = 'third-party/rust-resolution/'
SCOPE = 'current-offline-cargo-tree-scenarios-not-historical-build'
TARGETS = ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl']
BUILD_INPUTS = ['meson.build', 'meson_options.txt', 'meson/cargo_wrapper.py', 'rsvg/meson.build']


def checked_archive(path, checksum, size=None):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 96 * 1024**2:
        raise ValueError('Archive must be a bounded regular file')
    raw = path.read_bytes()
    if digest(raw) != checksum or (size is not None and len(raw) != size):
        raise ValueError('Source archive checksum or size mismatch')


def extract_regular(archive_file, output, top, workspace=False):
    """Only regular bytes, no executable modes or links; all output is disposable."""
    files, seen, total, skipped = {}, set(), 0, 0
    with tarfile.open(archive_file, 'r|*') as archive:
        for count, member in enumerate(archive, 1):
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or str(path) in seen or not path.parts or path.parts[0] != top:
                raise ValueError('Unsafe or duplicate source member')
            seen.add(str(path))
            total += member.size
            if count > 100000 or total > 2 * 1024**3 or member.size < 0:
                raise ValueError('Source extraction limit exceeded')
            if not member.isfile():
                skipped += not member.isdir()
                continue
            relative = str(path.relative_to(top))
            if relative == '.cargo-checksum.json' or (workspace and relative in ('.cargo/config', '.cargo/config.toml')):
                raise ValueError('Uncontrolled Cargo configuration or checksum input')
            if member.size > 64 * 1024**2:
                raise ValueError('Source member exceeds 64 MiB')
            data = archive.extractfile(member).read(64 * 1024**2 + 1)
            if len(data) != member.size:
                raise ValueError('Truncated source member')
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as handle:
                handle.write(data)
            target.chmod(0o600)
            files[relative] = digest(data)
    return files, skipped


def modify_manifest(data, image=False):
    lines = data.decode('utf-8').splitlines(keepends=True)
    for field, old in ([("image", ', "gif", "webp"')] if image else []) + [("cairo-rs", ', "pdf", "ps"')]:
        matching = [i for i, line in enumerate(lines) if re.match(r'^' + re.escape(field) + r'[ \t]*=', line)]
        if len(matching) != 1 or lines[matching[0]].count(old) != 1:
            raise ValueError('Expected exact manifest feature edit not found')
        lines[matching[0]] = lines[matching[0]].replace(old, '')
    return ''.join(lines).encode('utf-8')


def parse_tree(text, allowed):
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(r'([A-Za-z0-9_-]+) v([A-Za-z0-9.+_-]+)(?: \([^()\r\n]*\))?(?: \(\*\))?', line)
        if not match or match.groups() not in allowed:
            raise ValueError('Unexpected or uncollected Cargo tree package')
        key = match.groups()
        result[key] = {"name": key[0], "version": key[1], "checksum": allowed[key]['checksum']}
    if not result or ('librsvg-c', '2.63.2') not in result:
        raise ValueError('Cargo tree root package missing')
    return [result[key] for key in sorted(result)]


def rustc_info(text):
    lines = text.splitlines()
    hosts = [line.removeprefix('host: ') for line in lines if line.startswith('host: ')]
    if not lines or not lines[0].startswith('rustc ') or len(hosts) != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]+', hosts[0]):
        raise ValueError('Rustc host toolchain evidence missing')
    return {'rustc': lines[0], 'host': hosts[0]}


def resolve(source_review, rsvg_archive, crate_archives, destination, cargo):
    source_path = Path(source_review).resolve()
    project = source_path.parent.parent
    source = json.loads(source_path.read_bytes())
    inventory_file = project / 'third-party/rust-lock/inventory.json'
    inventory_raw, original_lock, _ = crate.load_inventory(inventory_file)
    collection_raw = (project / 'third-party/crate-notices/collection.json').read_bytes()
    if source['rustLockInventory']['sha256'] != digest(inventory_raw) or source['crateNoticeCollection']['sha256'] != digest(collection_raw):
        raise ValueError('Original input collection binding mismatch')
    collection = json.loads(collection_raw)
    inventory = json.loads(inventory_raw)
    expected = {(p['name'], p['version']): p for p in inventory['packages'] if p['source'] is not None}
    if not isinstance(collection.get('packages'), list) or len(collection['packages']) != len(expected):
        raise ValueError('Registry collection does not match original lock')
    for package in collection['packages']:
        key = (package.get('name'), package.get('version'))
        declared_package = expected.pop(key, None)
        if not declared_package or package.get('checksum') != declared_package['checksum'] or package.get('status') != 'collected' or not isinstance(package.get('archiveBytes'), int) or not 0 < package['archiveBytes'] <= 32 * 1024**2:
            raise ValueError('Invalid registry collection package identity')
    declarations = [p for p in source['componentDeclarations'] if p['id'] == 'rsvg']
    if len(declarations) != 1 or declarations[0].get('sourceArchiveStatus') != 'retrieved':
        raise ValueError('Exactly one retrieved rsvg archive required')
    declared = declarations[0]
    checked_archive(rsvg_archive, declared['retrieval']['sha256'], declared['retrieval']['bytes'])
    cargo = Path(cargo).resolve(strict=True)
    rustc = cargo.parent / 'rustc'
    if cargo.name != 'cargo' or not cargo.is_file() or not rustc.is_file() or rustc.is_symlink():
        raise ValueError('Use an installed Cargo toolchain binary with sibling rustc')
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    assets = []

    def publish(name, raw):
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(raw)
        target.chmod(0o600)
        record = {"file": PREFIX + name, "sha256": digest(raw), "bytes": len(raw)}
        assets.append(record)
        return record

    # The project/home ancestor Cargo configuration is never inherited.
    with tempfile.TemporaryDirectory(prefix='navigation-rust-scope-') as temporary:
        work = Path(temporary)
        for parent in [work, *work.parents]:
            if any((parent / '.cargo' / name).exists() for name in ['config', 'config.toml']):
                raise ValueError('Ambient ancestor Cargo configuration refused')
        workspace, vendor, cargo_home = work / 'source', work / 'vendor', work / 'cargo-home'
        _, skipped = extract_regular(rsvg_archive, workspace, 'librsvg-' + declared['declaredVersion'], workspace=True)
        for name in BUILD_INPUTS:
            publish('inputs/' + name, (workspace / name).read_bytes())
        for name in ['rsvg/Cargo.toml', 'librsvg-c/Cargo.toml']:
            target = workspace / name
            target.write_bytes(modify_manifest(target.read_bytes(), image=name.startswith('rsvg/')))
            publish('patched/' + name, target.read_bytes())
        for package in collection['packages']:
            if package['status'] != 'collected':
                raise ValueError('All registry source archives must be collected')
            name = package['name'] + '-' + package['version']
            archive = Path(crate_archives) / (name + '.crate')
            checked_archive(archive, package['checksum'], package['archiveBytes'])
            folder = vendor / name
            files, nonregular = extract_regular(archive, folder, name)
            skipped += nonregular
            (folder / '.cargo-checksum.json').write_text(json.dumps({'files': files, 'package': package['checksum']}))
        cargo_home.mkdir()
        (cargo_home / 'config.toml').write_text('[source.crates-io]\nreplace-with="local-vendor"\n[source.local-vendor]\ndirectory=' + json.dumps(str(vendor)) + '\n[net]\noffline=true\n')
        env = {'PATH': str(cargo.parent) + ':/usr/bin:/bin', 'LANG': 'C', 'CARGO_HOME': str(cargo_home), 'CARGO_NET_OFFLINE': 'true', 'RUSTC': str(rustc)}
        commands = []

        def run(arguments, label):
            result = subprocess.run([str(cargo), *arguments], cwd=workspace, env=env, capture_output=True, timeout=60)
            logs = output / 'local-logs'
            logs.mkdir(exist_ok=True)
            (logs / (label + '.stderr')).write_bytes(result.stderr)
            if result.returncode:
                raise ValueError(f'Offline Cargo {label} failed with code {result.returncode}; see local-logs')
            commands.append({'arguments': arguments, 'exitCode': result.returncode, 'hasStderr': bool(result.stderr)})
            return result.stdout.decode('utf-8').strip()

        cargo_version = run(['--version'], 'cargo-version')
        compiler = rustc_info(subprocess.run([str(rustc), '-vV'], env=env, capture_output=True, check=True, timeout=10).stdout.decode())
        run(['update', '--workspace', '--offline'], 'update-workspace')
        reconstructed_raw = (workspace / 'Cargo.lock').read_bytes()
        reconstructed = crate.rust.packages_from_lock(reconstructed_raw)
        allowed = {(p['name'], p['version']): p for p in reconstructed}
        before = {(p['name'], p['version']): p for p in inventory['packages']}
        if any(key not in before or before[key]['checksum'] != value['checksum'] for key, value in allowed.items()):
            raise ValueError('Offline resolution added or changed original locked packages')
        lock_asset = publish('reconstructed-Cargo.lock', reconstructed_raw)
        scenarios = []
        for target in TARGETS:
            for avif in [False, True]:
                identity = target + ('-avif-on' if avif else '-avif-off')
                args = ['tree', '--offline', '--locked', '--package', 'librsvg-c', '--target', target, '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}', '--charset', 'ascii']
                if avif:
                    args += ['--features', 'avif']
                packages = parse_tree(run(args, identity), allowed)
                listing = publish('scenarios/' + identity + '.txt', ''.join(p['name'] + '@' + p['version'] + '\n' for p in packages).encode())
                scenarios.append({'id': identity, 'target': target, 'avif': avif, 'rootPackage': 'librsvg-c', 'edges': ['normal', 'build'], 'packages': packages, 'listing': listing})
        if (workspace / 'Cargo.lock').read_bytes() != reconstructed_raw:
            raise ValueError('Locked scenario unexpectedly changed reconstructed lock')
        missing = [{'name': p['name'], 'version': p['version'], 'presentInScenarios': [s['id'] for s in scenarios if any(q['name'] == p['name'] and q['version'] == p['version'] for q in s['packages'])]} for p in collection['packages'] if not p['notices']]
    report = {'format': 1, 'scope': SCOPE, 'licenseClearance': 'not-assessed', 'historicalBuildVerified': False, 'sourceCodeExecuted': False, 'sourcePatchesApplied': False, 'collector': {'file': 'scripts/resolve-rust-scope.py', 'sha256': digest(Path(__file__).read_bytes())}, 'toolchain': {'cargo': cargo_version, **compiler}, 'inputs': {'rustInventorySha256': digest(inventory_raw), 'crateCollectionSha256': digest(collection_raw), 'nativeArchiveSha256': declared['retrieval']['sha256'], 'recipeSha256': collection['buildRecipe']['sha256']}, 'assets': assets, 'reconstructedLock': lock_asset, 'originalPackages': len(before), 'reconstructedPackages': len(allowed), 'removedPackages': [{'name': key[0], 'version': key[1], 'checksum': before[key]['checksum']} for key in sorted(before.keys() - allowed.keys())], 'scenarios': scenarios, 'missingNoticePackages': missing, 'commands': commands, 'nonRegularMembersSkipped': skipped}
    (output / 'resolution.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (output / 'resolution.json').chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_review')
    parser.add_argument('rsvg_archive')
    parser.add_argument('crate_archives')
    parser.add_argument('new_directory')
    parser.add_argument('--cargo', required=True, help='Installed toolchain cargo binary; never install a toolchain')
    args = parser.parse_args()
    result = resolve(args.source_review, args.rsvg_archive, args.crate_archives, args.new_directory, args.cargo)
    print(json.dumps({'scenarios': {s['id']: len(s['packages']) for s in result['scenarios']}, 'removedPackages': result['removedPackages'], 'historicalBuildVerified': False}))
