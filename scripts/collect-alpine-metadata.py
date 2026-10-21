#!/usr/bin/env python3
"""Collect APKINDEX metadata for the two pinned Alpine images.

This records package -> repository/order/license/source locator. It does not
download or claim license texts, and it does not prove binary contents.
"""
import io
import json
import tarfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
images = {
    "postgres-image": ("v3.24", "postgres-image"),
    "demo-proxy-image": ("v3.23", "demo-proxy-image"),
}
repos = ("main", "community")
arch = "aarch64"
cache = {}
for branch in {value[0] for value in images.values()}:
    for repo in repos:
        url = f"https://dl-cdn.alpinelinux.org/alpine/{branch}/{repo}/{arch}/APKINDEX.tar.gz"
        data = urllib.request.urlopen(url, timeout=60).read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            text = tar.extractfile("APKINDEX").read().decode()
        entries = {}
        for block in text.split("\n\n"):
            record = {}
            for line in block.splitlines():
                if len(line) > 2 and line[1] == ":":
                    record[line[0]] = line[2:]
            if record.get("P"):
                entries[(record["P"], record.get("V"))] = record
        cache[(branch, repo)] = entries
        print(branch, repo, len(entries))

document = {
    "format": 1,
    "scope": "APKINDEX locator metadata only; not license texts and not binary proof",
    "sources": [
        f"https://dl-cdn.alpinelinux.org/alpine/{branch}/{repo}/{arch}/APKINDEX.tar.gz"
        for branch in sorted({value[0] for value in images.values()})
        for repo in repos
    ],
    "images": {},
}
for image, (branch, evidence_name) in images.items():
    evidence = json.loads(
        (root / f"third-party/image-evidence/{evidence_name}.json").read_text()
    )
    packages = evidence["observations"]["packages"]
    result = []
    for package in packages:
        key = (package["name"], package["version"])
        found = None
        for repo in repos:
            record = cache[(branch, repo)].get(key)
            if record:
                found = (repo, record)
                break
        if not found:
            result.append(
                {
                    **package,
                    "repository": None,
                    "sourceLocator": None,
                    "status": "not-found-in-apkindex",
                }
            )
            continue
        repo, record = found
        origin = record.get("o")
        result.append(
            {
                "name": package["name"],
                "version": package["version"],
                "license": record.get("L") or package.get("license"),
                "origin": origin,
                "repository": repo,
                "sourceLocator": (
                    f"https://gitlab.alpinelinux.org/alpine/aports/-/tree/{branch}-stable/{origin}"
                    if origin
                    else None
                ),
                "status": "matched",
            }
        )
    document["images"][image] = {
        "alpine": branch,
        "architecture": arch,
        "packageCount": len(result),
        "matched": sum(1 for item in result if item["status"] == "matched"),
        "notFound": [item["name"] for item in result if item["status"] != "matched"],
        "packages": result,
    }

destination = root / "third-party/image-notices/alpine/manifest.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
print("wrote", destination)
for name, value in document["images"].items():
    print(name, value["matched"], "/", value["packageCount"], "notFound", value["notFound"])
