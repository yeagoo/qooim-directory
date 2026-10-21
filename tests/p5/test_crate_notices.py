import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('crate_collector', ROOT / 'scripts/collect-crate-notices.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class CrateNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'archives').mkdir()
        (self.root / 'texts').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, members=None, manifest=None, include_notice=True):
        raw = io.BytesIO()
        if manifest is None:
            manifest = b'[package]\nname="example"\nversion="1.0"\nlicense="MIT"\n'
        entries = [('example-1.0/Cargo.toml', manifest)]
        if include_notice:
            entries.append(('example-1.0/LICENSE', b'Original Copyright\nPermission notice\n'))
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for name, data in entries + (members or []):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return raw.getvalue()

    def run_download(self, raw, checksum=None, url=None):
        package = {'name': 'example', 'version': '1.0', 'checksum': checksum or tool.digest(raw)}
        response = io.BytesIO(raw)
        response.url = url or 'https://static.crates.io/crates/example/1.0/download'
        with patch.object(tool.urllib.request, 'urlopen', return_value=response):
            return tool.collect_package(package, self.root)

    def test_exact_checksum_original_manifest_and_notice_bytes(self):
        result = self.run_download(self.archive())
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(result['licenseClearance'], 'not-assessed')
        self.assertEqual(result['declaredLicense'], 'MIT')
        self.assertEqual(len(result['notices']), 1)
        for record in [result['manifest'], *result['notices']]:
            raw = (self.root / 'texts' / Path(record['file']).name).read_bytes()
            self.assertEqual(tool.digest(raw), record['sha256'])
            self.assertEqual(len(raw), record['bytes'])

    def test_checksum_mismatch_never_inspects_or_publishes(self):
        with patch.object(tool.native, 'inspect_archive') as inspect:
            result = self.run_download(self.archive(), checksum='f' * 64)
        inspect.assert_not_called()
        self.assertEqual(result['status'], 'checksum-mismatch')
        self.assertEqual(list((self.root / 'texts').iterdir()), [])

    def test_rejects_cross_host_redirect_before_archive_write(self):
        result = self.run_download(self.archive(), url='https://other.test/file')
        self.assertEqual(result['status'], 'download-failed')
        self.assertEqual(list((self.root / 'archives').iterdir()), [])

    def test_unsafe_late_member_does_not_publish_earlier_notice(self):
        result = self.run_download(self.archive([('../escape', b'bad')]))
        self.assertEqual(result['status'], 'archive-rejected')
        self.assertEqual(result['notices'], [])
        self.assertEqual(list((self.root / 'texts').iterdir()), [])

    def test_different_manifest_identity_is_rejected_before_notice_commit(self):
        result = self.run_download(self.archive(manifest=b'[package]\nname="another"\nversion="1.0"'))
        self.assertEqual(result['status'], 'archive-rejected')
        self.assertEqual(list((self.root / 'texts').iterdir()), [])

    def test_network_failure_and_size_limit_remain_failures(self):
        with patch.object(tool.urllib.request, 'urlopen', side_effect=OSError('offline')):
            result = tool.collect_package({'name': 'example', 'version': '1.0', 'checksum': 'a' * 64}, self.root)
        self.assertEqual(result['status'], 'download-failed')
        with patch.object(tool, 'MAX_CRATE', 8):
            result = self.run_download(self.archive())
        self.assertEqual(result['status'], 'download-failed')
        self.assertEqual(result['notices'], [])

    def test_index_must_match_original_lock_before_creating_output(self):
        directory = self.root / 'inputs'
        (directory / 'sources').mkdir(parents=True)
        lock = b'version=4\n[[package]]\nname="local"\nversion="1"\n'
        (directory / 'sources/Cargo.lock').write_bytes(lock)
        inventory = {'format': 1, 'scope': 'complete-lockfile-not-compiled-graph', 'licenseClearance': 'not-assessed', 'assets': [{'file': 'third-party/rust-lock/sources/Cargo.lock', 'sha256': tool.digest(lock), 'bytes': len(lock)}], 'packages': []}
        source = directory / 'inventory.json'
        source.write_text(json.dumps(inventory))
        with self.assertRaisesRegex(ValueError, 'differs from original Cargo lock'):
            tool.collect(source, self.root / 'absent-config', self.root / 'new')
        self.assertFalse((self.root / 'new').exists())

    def test_unsupported_config_and_worker_count_do_not_create_output(self):
        config = self.root / 'config.json'
        config.write_text('{"dl":"https://other.test"}')
        inventory = ROOT / 'third-party/rust-lock/inventory.json'
        with self.assertRaisesRegex(ValueError, 'Unsupported registry'):
            tool.collect(inventory, config, self.root / 'new')
        config.write_text(json.dumps({'dl': tool.BASE}))
        with self.assertRaisesRegex(ValueError, 'Workers'):
            tool.collect(inventory, config, self.root / 'new', workers=5)
        self.assertFalse((self.root / 'new').exists())

    def test_offline_reinspection_still_verifies_checksum_and_never_networks(self):
        cached = self.root / 'cache'
        cached.mkdir()
        raw = self.archive([('example-1.0/UNLICENSE', b'Original dedication')])
        package = {'name': 'example', 'version': '1.0', 'checksum': tool.digest(raw)}
        (cached / 'example-1.0.crate').write_bytes(raw)
        with patch.object(tool.urllib.request, 'urlopen', side_effect=AssertionError('Unexpected network')):
            result = tool.collect_package(package, self.root, cached)
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(len(result['notices']), 2)
        # A fresh output directory is required even for local reinspection.
        other = self.root / 'other'
        (other / 'archives').mkdir(parents=True)
        (other / 'texts').mkdir()
        (cached / 'example-1.0.crate').write_bytes(b'corrupted')
        result = tool.collect_package(package, other, cached)
        self.assertEqual(result['status'], 'checksum-mismatch')
        self.assertEqual(list((other / 'texts').iterdir()), [])

    def test_missing_notice_preserves_readme_and_bounded_source_prefix(self):
        source = b'// Copyright Original\n' + b'x' * 5000
        result = self.run_download(self.archive([('example-1.0/README.md', b'License references only'), ('example-1.0/src/lib.rs', source)], include_notice=False))
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(result['notices'], [])
        self.assertEqual(result['supplementaryStatus'], 'captured')
        self.assertEqual(len(result['supplementary']), 2)
        prefix = next(s for s in result['supplementary'] if s['kind'] == 'rust-source-prefix')
        self.assertFalse(prefix['completeMember'])
        self.assertEqual(prefix['bytes'], 4096)
        self.assertEqual((self.root / 'texts' / Path(prefix['file']).name).read_bytes(), source[:4096])
        self.assertTrue(result['warnings'])

    def test_missing_notice_followup_does_not_publish_before_archive_validation(self):
        result = self.run_download(self.archive([('example-1.0/README.md', b'Original review input'), ('../escape', b'bad')], include_notice=False))
        self.assertEqual(result['status'], 'archive-rejected')
        self.assertEqual(list((self.root / 'texts').iterdir()), [])

    def test_missing_notice_with_no_candidate_stays_explicitly_unresolved(self):
        result = self.run_download(self.archive(include_notice=False))
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(result['supplementaryStatus'], 'no-candidate-found')
        self.assertEqual(result['supplementary'], [])
        self.assertEqual(result['licenseClearance'], 'not-assessed')
        self.assertTrue(result['warnings'])


if __name__ == '__main__':
    unittest.main()
