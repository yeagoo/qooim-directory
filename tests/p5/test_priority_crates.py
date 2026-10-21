import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('priority_crates', Path(__file__).resolve().parents[2] / 'scripts/review-priority-crates.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class PriorityCrateTests(unittest.TestCase):
    def archive(self, path, entries):
        with tarfile.open(path, 'w:gz') as archive:
            for name, data, link in entries:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = link
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        raw = path.read_bytes()
        return {'name': 'example', 'version': '1.0', 'checksum': tool.digest(raw), 'archiveBytes': len(raw)}

    def fixture(self, root):
        third, archives = root / 'third-party', root / 'archives'
        (third / 'crate-notices').mkdir(parents=True)
        (third / 'rust-resolution').mkdir()
        archives.mkdir()
        packages, memberships, responses = [], [], {}
        for name, version in tool.PRIORITY.items():
            repo, revision, sub = ('sourcefrog/cargo-mutants', 'a' * 40, 'mutants_attrs') if name == 'mutants' else ('servo/stylo', 'b' * 40, 'selectors')
            manifest = f'[package]\nname="{name}"\nversion="{version}"\nrepository="https://github.com/{repo}"\n'.encode()
            vcs = json.dumps({'git': {'sha1': revision}, 'path_in_vcs': sub}).encode()
            source = b'// Copyright Fixture\n' if name == 'mutants' else b'// Mozilla Public License https://mozilla.org/MPL/2.0/\n'
            prefix = name + '-' + version + '/'
            entries = [(prefix + 'Cargo.toml', manifest, None), (prefix + 'Cargo.toml.orig', manifest, None), (prefix + '.cargo_vcs_info.json', vcs, None), (prefix + 'src/lib.rs', source, None)]
            archive = archives / (name + '-' + version + '.crate')
            package = self.archive(archive, entries)
            package.update(name=name, version=version, status='collected', notices=[])
            packages.append(package)
            memberships.append({'name': name, 'version': version, 'presentInScenarios': ['fixture-scenario']})
            for relative, data in [('Cargo.toml', manifest), ('src/lib.rs', source)]:
                responses[f'https://raw.githubusercontent.com/{repo}/{revision}/{sub}/{relative}'] = data
            tree = {'sha': revision, 'truncated': False, 'tree': []}
            if name == 'mutants':
                license = b'MIT License\nCopyright Fixture\nOriginal fixture permission\n'
                blob = hashlib.sha1(b'blob ' + str(len(license)).encode() + b'\0' + license).hexdigest()
                tree['tree'].append({'path': 'LICENSE', 'type': 'blob', 'sha': blob})
                responses[f'https://raw.githubusercontent.com/{repo}/{revision}/LICENSE'] = license
            responses[f'https://api.github.com/repos/{repo}/git/trees/{revision}'] = json.dumps(tree).encode()
        responses[tool.MPL_URL] = b'<html>Mozilla Public License Version 2.0 (test fixture)</html>'
        collection, resolution = json.dumps({'packages': packages}).encode(), json.dumps({'missingNoticePackages': memberships}).encode()
        (third / 'crate-notices/collection.json').write_bytes(collection)
        (third / 'rust-resolution/resolution.json').write_bytes(resolution)
        source_review = third / 'source.json'
        source_review.write_text(json.dumps({'crateNoticeCollection': {'sha256': tool.digest(collection)}, 'rustResolution': {'sha256': tool.digest(resolution)}}))
        def respond(request, **kwargs):
            url = request.full_url
            response = io.BytesIO(responses[url])
            response.url = url
            return response
        return source_review, archives, responses, respond

    def test_vcs_identity_rejects_credentials_branches_and_path_traversal(self):
        vcs = {'git': {'sha1': 'a' * 40}, 'path_in_vcs': 'package'}
        self.assertEqual(tool.github_identity('https://github.com/owner/repo', vcs)[0], 'owner/repo')
        for repo in ['https://user:password@github.com/owner/repo', 'https://github.com/../repo', 'https://other.test/owner/repo']:
            with self.subTest(repo=repo), self.assertRaises(ValueError):
                tool.github_identity(repo, vcs)
        with self.assertRaises(ValueError):
            tool.github_identity('https://github.com/owner/repo', {'git': {'sha1': 'main'}, 'path_in_vcs': '../escape'})

    def test_archive_checksum_is_required_before_member_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'example.crate'
            package = self.archive(path, [('example-1.0/lib.rs', b'bytes', None)])
            package['checksum'] = 'f' * 64
            with self.assertRaisesRegex(ValueError, 'checksum'):
                tool.archive_files(path, package)

    def test_archive_traversal_duplicates_and_links_are_refused(self):
        for entries in [[('../escape', b'bad', None)], [('example-1.0/a', b'a', None), ('./example-1.0/a', b'b', None)], [('example-1.0/a', b'', '/etc/passwd')]]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'example.crate'
                package = self.archive(path, entries)
                with self.assertRaises(ValueError):
                    tool.archive_files(path, package)

    def test_source_matches_and_offline_cache_reinspection_do_not_claim_clearance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, archives, responses, respond = self.fixture(root)
            with patch.object(tool.urllib.request, 'urlopen', side_effect=respond):
                report = tool.review(source, archives, root / 'first')
            self.assertEqual(sum(len(p['matches']) for p in report['packages']), 4)
            self.assertEqual(report['licenseClearance'], 'not-assessed')
            self.assertFalse(report['publisherSignatureVerified'])
            with patch.object(tool.urllib.request, 'urlopen', side_effect=AssertionError('Unexpected network')):
                again = tool.review(source, archives, root / 'second', root / 'first/cache')
            self.assertEqual(report, again)
            self.assertTrue(all(p['originalCrateNoticeMissing'] for p in report['packages']))

    def test_different_fixed_commit_source_never_produces_successful_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, archives, responses, respond = self.fixture(root)
            key = next(k for k in responses if k.endswith('/mutants_attrs/src/lib.rs'))
            responses[key] = b'changed upstream source'
            with patch.object(tool.urllib.request, 'urlopen', side_effect=respond), self.assertRaisesRegex(ValueError, 'differs from original crate'):
                tool.review(source, archives, root / 'output')
            self.assertFalse((root / 'output/review.json').exists())

    def test_changed_cached_license_is_rejected_by_pinned_git_blob(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, archives, responses, respond = self.fixture(root)
            with patch.object(tool.urllib.request, 'urlopen', side_effect=respond):
                tool.review(source, archives, root / 'first')
            url = next(k for k in responses if k.endswith('/LICENSE'))
            (root / 'first/cache' / (tool.digest(url.encode()) + '.body')).write_bytes(b'changed license')
            with patch.object(tool.urllib.request, 'urlopen', side_effect=AssertionError('Unexpected network')), self.assertRaisesRegex(ValueError, 'Git blob mismatch'):
                tool.review(source, archives, root / 'second', root / 'first/cache')
            self.assertFalse((root / 'second/review.json').exists())


if __name__ == '__main__':
    unittest.main()
