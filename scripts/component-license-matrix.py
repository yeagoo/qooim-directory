#!/usr/bin/env python3
"""Build a review matrix for the 28 declared sharp-libvips components.

The family hints are text matches, not license conclusions. The matrix only
joins evidence that already exists in the repository.
"""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
notices = json.loads((root / "third-party/component-notices.json").read_text())
source = json.loads((root / "third-party/libvips-source-review.json").read_text())
table = (root / "third-party/sources/sharp-libvips-ebb95f8/THIRD-PARTY-NOTICES.md").read_text()

name_map = {
    "proxy-libintl": "proxy-libintl",
    "zlib-ng": "zlib-ng",
    "ffi": "libffi",
    "glib": "glib",
    "xml2": "libxml2",
    "exif": "libexif",
    "lcms": "lcms",
    "aom": "aom",
    "heif": "libheif",
    "mozjpeg": "mozjpeg",
    "png": "libpng",
    "imagequant": "libimagequant",
    "webp": "libwebp",
    "tiff": "libtiff",
    "highway": "highway",
    "freetype": "freetype",
    "expat": "expat",
    "archive": "libarchive",
    "fontconfig": "fontconfig",
    "harfbuzz": "harfbuzz",
    "pixman": "pixman",
    "cairo": "cairo",
    "fribidi": "fribidi",
    "pango": "pango",
    "rsvg": "librsvg",
    "cgif": "cgif",
    "uhdr": "libultrahdr",
    "vips": "libvips",
}

def table_licenses():
    result = {}
    for line in table.splitlines():
        match = re.match(r"^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$", line)
        if not match or match.group(1) in {"Library", "-------"}:
            continue
        result[match.group(1).strip()] = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", match.group(2)).strip()
    return result

licenses = table_licenses()

markers = {
    "lgpl": ("GNU LESSER GENERAL PUBLIC LICENSE", "GNU LIBRARY GENERAL PUBLIC LICENSE"),
    "gpl": ("GNU GENERAL PUBLIC LICENSE",),
    "mit": ("Permission is hereby granted, free of charge",),
    "bsd": ("Redistribution and use in source and binary forms",),
    "mpl": ("Mozilla Public License",),
    "apache": ("Apache License",),
    "zlib": ("This software is provided 'as-is'", "zlib License"),
    "cc0": ("CC0 1.0 Universal",),
}

def expected_families(text):
    lowered = text.lower()
    expected = set()
    if "lgpl" in lowered:
        expected.add("lgpl")
    if "gpl" in lowered and "lgpl" not in lowered:
        expected.add("gpl")
    if "mit" in lowered:
        expected.add("mit")
    if "bsd" in lowered:
        expected.add("bsd")
    if "mozilla public license" in lowered or "mpl" in lowered:
        expected.add("mpl")
    if "apache" in lowered:
        expected.add("apache")
    if "zlib" in lowered:
        expected.add("zlib")
    if "public domain" in lowered or "cc0" in lowered:
        expected.add("public-domain")
    if "libpng" in lowered:
        expected.add("custom-png")
    if "freetype" in lowered:
        expected.add("custom-freetype")
    if "fontconfig" in lowered:
        expected.add("custom-fontconfig")
    return expected

def families_in(text):
    found = set()
    lowered = text.lower()
    for family, needles in markers.items():
        if any(needle.lower() in lowered for needle in needles):
            found.add(family)
    if "public domain" in lowered or "cc0 1.0 universal" in lowered:
        found.add("public-domain")
    if "copyright notice, disclaimer, and license" in lowered:
        found.add("custom-png")
    if "freetype licenses" in lowered or "freetype project license" in lowered:
        found.add("custom-freetype")
    if "fontconfig/copying" in lowered or "permission to use, copy, modify, distribute, and sell this software" in lowered:
        found.add("custom-fontconfig")
    return found

declarations = {item["id"]: item for item in source["componentDeclarations"]}
matrix = []
for component in notices["components"]:
    identifier = component["id"]
    table_name = name_map[identifier]
    declared = licenses.get(table_name, "")
    expected = expected_families(declared)
    found = set()
    files = []
    for notice in component["notices"]:
        path = root / notice["file"]
        text = path.read_text(errors="replace")
        found |= families_in(text)
        files.append(
            {
                "file": notice["file"],
                "sha256": notice["sha256"],
                "bytes": notice["bytes"],
                "archiveMember": notice.get("archiveMember"),
            }
        )
    declaration = declarations[identifier]
    matrix.append(
        {
            "id": identifier,
            "declaredVersion": component["declaredVersion"],
            "declaredLicense": declared,
            "expectedFamilies": sorted(expected),
            "noticeFamiliesFound": sorted(found),
            "matchingFamilyText": bool(expected & found),
            "archiveSha256": component.get("archiveSha256"),
            "archiveBytes": component.get("archiveBytes"),
            "applicability": declaration.get("recipeApplicability"),
            "binaryPresence": declaration.get("binaryPresence"),
            "noticeCount": len(files),
            "notices": files,
            "status": "evidence-joined; clearance not assessed",
        }
    )

summary = {
    "components": len(matrix),
    "withArchive": sum(1 for item in matrix if item["archiveSha256"]),
    "withMatchingFamilyText": sum(1 for item in matrix if item["matchingFamilyText"]),
    "withoutMatchingFamilyText": [
        item["id"] for item in matrix if not item["matchingFamilyText"]
    ],
    "withoutExpectedFamily": [
        item["id"] for item in matrix if not item["expectedFamilies"]
    ],
    "customFamilyComponents": [
        item["id"]
        for item in matrix
        if any(family.startswith("custom-") for family in item["expectedFamilies"])
    ],
    "noticeCandidates": sum(item["noticeCount"] for item in matrix),
}
document = {
    "format": 1,
    "scope": "Automated join of existing component, archive and notice evidence; family hints are text matches, not license clearance.",
    "sourceReviewSha256": hashlib.sha256(
        (root / "third-party/libvips-source-review.json").read_bytes()
    ).hexdigest(),
    "componentNoticesSha256": hashlib.sha256(
        (root / "third-party/component-notices.json").read_bytes()
    ).hexdigest(),
    "noticeTableSha256": hashlib.sha256(
        (root / "third-party/sources/sharp-libvips-ebb95f8/THIRD-PARTY-NOTICES.md").read_bytes()
    ).hexdigest(),
    "summary": summary,
    "components": matrix,
}
destination = root / "third-party/component-license-matrix.json"
destination.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(summary, indent=2, ensure_ascii=False))
