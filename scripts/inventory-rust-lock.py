#!/usr/bin/env python3
"""Inventory original librsvg Cargo inputs; never resolve, download or execute crates.

Maintainer tool requiring Python 3.11+. Output is independent of its directory.
"""
import argparse
import hashlib
import json
import re
import tarfile
import tomllib
from pathlib import Path, PurePosixPath

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
PREFIX = "third-party/rust-lock/"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def packages_from_lock(data):
    lock = tomllib.loads(data.decode("utf-8"))
    packages = lock.get("package")
    if lock.get("version") != 4 or not isinstance(packages, list) or not 1 <= len(packages) <= 5000:
        raise ValueError("Unsupported or oversized Cargo lock inventory")
    result, seen = [], set()
    for package in packages:
        name, version, source = (package.get(k) for k in ("name", "version", "source"))
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9.+_-]+", version):
            raise ValueError("Invalid Cargo package identity")
        if source not in (None, REGISTRY):
            raise ValueError("Unsupported Cargo package source; explicit review required")
        identity = (name, version, source)
        if identity in seen:
            raise ValueError("Duplicate Cargo package identity")
        seen.add(identity)
        checksum = package.get("checksum")
        if source == REGISTRY:
            if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
                raise ValueError("Registry package checksum missing or invalid")
        elif checksum is not None:
            raise ValueError("Unexpected workspace package checksum")
        dependencies = package.get("dependencies", [])
        if not isinstance(dependencies, list) or any(not isinstance(d, str) or not d.strip() or any(c in d for c in "\r\n\t") for d in dependencies) or len(set(dependencies)) != len(dependencies):
            raise ValueError("Invalid Cargo dependency references")
        result.append({"name": name, "version": version, "source": source, "checksum": checksum, "dependencies": dependencies})
    return sorted(result, key=lambda p: (p['name'], p['version'], p['source'] or ''))


def inventory(manifest_file, archive_file, destination):
    source = json.loads(Path(manifest_file).read_bytes())
    declarations = [c for c in source['componentDeclarations'] if c['id'] == 'rsvg']
    if len(declarations) != 1 or declarations[0].get('sourceArchiveStatus') != 'retrieved':
        raise ValueError("Exactly one retrieved rsvg declaration required")
    declared = declarations[0]
    archive = Path(archive_file)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 96 * 1024 * 1024:
        raise ValueError("Archive must be a bounded regular file")
    raw = archive.read_bytes()
    if digest(raw) != declared['retrieval']['sha256'] or len(raw) != declared['retrieval']['bytes']:
        raise ValueError("Archive retrieval identity mismatch")
    top = 'librsvg-' + declared['declaredVersion']
    selected, seen, total, cargo_bytes = {}, set(), 0, 0
    with tarfile.open(archive, 'r|*') as members:
        for count, member in enumerate(members, 1):
            path = PurePosixPath(member.name)
            canonical = str(path)
            total += member.size
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or canonical in seen:
                raise ValueError("Unsafe or duplicate archive member")
            seen.add(canonical)
            if count > 100000 or total > 2 * 1024**3 or member.size < 0:
                raise ValueError("Archive inventory limit exceeded")
            if path.name not in ('Cargo.lock', 'Cargo.toml'):
                continue
            if not member.isfile() or not path.parts or path.parts[0] != top or member.size > 2 * 1024**2:
                raise ValueError("Invalid Cargo archive input")
            cargo_bytes += member.size
            if len(selected) >= 100 or cargo_bytes > 16 * 1024**2:
                raise ValueError("Cargo input inventory limit exceeded")
            data = members.extractfile(member).read(2 * 1024**2 + 1)
            if len(data) != member.size:
                raise ValueError("Truncated Cargo input")
            selected[str(path.relative_to(top))] = data
    if 'Cargo.lock' not in selected or 'Cargo.toml' not in selected:
        raise ValueError("Original Cargo lock and workspace manifest required")
    packages = packages_from_lock(selected['Cargo.lock'])
    assets = [{"file": PREFIX + 'sources/' + name, "archiveMember": top + '/' + name, "sha256": digest(data), "bytes": len(data)} for name, data in sorted(selected.items())]
    report = {"format": 1, "scope": "complete-lockfile-not-compiled-graph", "licenseClearance": "not-assessed", "collectorSha256": digest(Path(__file__).read_bytes()), "component": {"id": "rsvg", "version": declared['declaredVersion'], "sourceUrl": declared['declaredSourceUrl'], "archiveSha256": digest(raw), "archiveBytes": len(raw)}, "assets": assets, "packages": packages, "counts": {"total": len(packages), "registry": sum(p['source'] == REGISTRY for p in packages), "workspace": sum(p['source'] is None for p in packages)}}
    # Validate all inputs before creating any output, and never overwrite a run.
    output = Path(destination)
    output.mkdir(mode=0o700, exist_ok=False)
    for name, data in selected.items():
        target = output / 'sources' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o600)
    (output / 'inventory.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (output / 'inventory.json').chmod(0o600)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest')
    parser.add_argument('archive')
    parser.add_argument('new_directory')
    args = parser.parse_args()
    print(json.dumps(inventory(args.manifest, args.archive, args.new_directory)['counts']))
