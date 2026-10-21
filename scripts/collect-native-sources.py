#!/usr/bin/env python3
"""Maintainer-only source/notice collection. Never executes or extracts source trees."""
import argparse
import concurrent.futures
import hashlib
import json
import re
import tarfile
import threading
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

MAX_ARCHIVE = 96 * 1024 * 1024
MAX_NOTICE = 2 * 1024 * 1024
MAX_TOTAL_NOTICES = 32 * 1024 * 1024
MAX_UNPACKED = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 100000
_NOTICE_LOCK = threading.Lock()
NOTICE = re.compile(r"^(?:(?:unlicen[cs]e|licen[cs]e|copying|copyright|notice|authors|patents)(?:[._-].*)?|FTL\.TXT)$", re.I)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def declaration_digest(components):
    return digest("".join(f"{c['id']}\t{c['declaredVersion']}\t{c['declaredSourceUrl']}\n" for c in sorted(components, key=lambda c: c['id'])).encode())


def inspect_archive(filename, notices_dir):
    """Read regular notice members only; member names never become output paths."""
    notices, warnings, seen, pending = [], [], set(), {}
    unpacked = total_notices = count = 0
    with tarfile.open(filename, "r|*") as archive:
        for member in archive:
            count += 1
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or "\\" in member.name:
                raise ValueError("Unsafe archive member name")
            canonical = str(path)
            if canonical in seen:
                raise ValueError("Duplicate archive member name")
            seen.add(canonical)
            unpacked += member.size
            if count > MAX_MEMBERS or unpacked > MAX_UNPACKED or member.size < 0:
                raise ValueError("Archive inventory limit exceeded")
            if not NOTICE.fullmatch(path.name) and not any(part.lower() in ("license", "licence", "licenses", "licences") for part in path.parts[:-1]):
                continue
            if not member.isfile():
                warnings.append(f"Notice is not a regular member: {member.name}")
                continue
            if member.size > MAX_NOTICE:
                raise ValueError("Notice exceeds 2 MiB")
            data = archive.extractfile(member).read(MAX_NOTICE + 1)
            total_notices += len(data)
            if len(data) != member.size or total_notices > MAX_TOTAL_NOTICES:
                raise ValueError("Notice inventory limit exceeded or truncated member")
            if not data.strip():
                warnings.append(f"Empty notice: {member.name}")
                continue
            checksum = digest(data)
            pending[checksum] = data
            notices.append({"archiveMember": member.name, "file": "notices/" + checksum + ".txt", "sha256": checksum, "bytes": len(data)})
    # No notice is published before the entire archive has passed validation.
    # Shared licenses are committed under a lock so parallel collectors never
    # mistake another worker's partially written file for a collision.
    with _NOTICE_LOCK:
        for checksum, data in pending.items():
            output = notices_dir / (checksum + ".txt")
            try:
                with output.open("xb") as handle:
                    handle.write(data)
                output.chmod(0o600)
            except FileExistsError:
                if output.is_symlink() or digest(output.read_bytes()) != checksum:
                    raise ValueError("Notice output collision")
    return notices, warnings


def collect_component(component, output):
    identity = component['id']
    if not re.fullmatch(r"[a-z0-9-]+", identity):
        raise ValueError("Invalid component identity")
    url = component['declaredSourceUrl']
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Source URL must use HTTPS without credentials")
    record = {"id": identity, "declaredVersion": component['declaredVersion'], "sourceUrl": url, "licenseClearance": "not-assessed", "notices": []}
    archive_path = output / "archives" / (identity + ".tar")
    checksum = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "navigation-source-review/1"}), timeout=25) as response:
            if urlsplit(response.url).scheme != "https":
                raise ValueError("Source redirect downgraded HTTPS")
            with archive_path.open("xb") as handle:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_ARCHIVE:
                        raise ValueError("Source archive exceeds 96 MiB")
                    checksum.update(chunk)
                    handle.write(chunk)
        archive_path.chmod(0o600)
        record.update(archiveSha256=checksum.hexdigest(), archiveBytes=size, archiveFile="archives/" + archive_path.name)
    except Exception as error:
        record.update(status="download-failed", error=str(error))
        return record
    try:
        notices, warnings = inspect_archive(archive_path, output / "notices")
        record.update(status="collected", notices=notices, warnings=warnings)
        if not notices:
            record['warnings'].append("No original notice candidates found; manual source review required")
    except Exception as error:
        record.update(status="archive-rejected", error=str(error))
    return record


def collect(manifest_file, destination, workers=4):
    manifest_bytes = Path(manifest_file).read_bytes()
    source = json.loads(manifest_bytes)
    components = source['componentDeclarations']
    ids = [c['id'] for c in components]
    if not components or len(components) > 100 or len(ids) != len(set(ids)):
        raise ValueError("Invalid or duplicate component inventory")
    if not 1 <= workers <= 4:
        raise ValueError("Workers must be between 1 and 4")
    output = Path(destination)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    (output / "archives").mkdir(mode=0o700)
    (output / "notices").mkdir(mode=0o700)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        records = list(executor.map(lambda c: collect_component(c, output), components))
    report = {"format": 1, "status": "incomplete", "scope": "Original archive notice candidates only; not license clearance, historical build verification or corresponding source delivery", "collectorSha256": digest(Path(__file__).read_bytes()), "inputSha256": digest(manifest_bytes), "declarationsSha256": declaration_digest(components), "components": records}
    report_path = output / "collection.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    report_path.chmod(0o600)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("new_directory")
    args = parser.parse_args()
    result = collect(args.manifest, args.new_directory)
    failures = [c['id'] for c in result['components'] if c['status'] != 'collected']
    print(json.dumps({"components": len(result['components']), "collected": len(result['components']) - len(failures), "failures": failures, "clearance": "not-assessed"}))
    raise SystemExit(1 if failures else 0)
