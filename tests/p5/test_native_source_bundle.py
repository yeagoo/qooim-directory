import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('source_bundle', Path(__file__).resolve().parents[2] / 'scripts/native-source-bundle.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class NativeSourceBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.write_bytes(b'original source input')
        self.entry = {'path': 'sources/native/example.tar', 'kind': 'native-archive',
                      'source': self.source, 'sha256': collector.digest(self.source.read_bytes()), 'bytes': self.source.stat().st_size}
        self.output = self.root / 'output.tar'

    def tearDown(self):
        self.temp.cleanup()

    def test_bundle_is_deterministic_and_manifest_is_explicitly_incomplete(self):
        report = collector.bundle([self.entry], self.output)
        other = self.root / 'other.tar'
        collector.bundle([self.entry], other)
        self.assertEqual(self.output.read_bytes(), other.read_bytes())
        self.assertFalse(report['historicalBuildVerified'])
        self.assertFalse(report['patchesApplied'])
        self.assertEqual(report['licenseClearance'], 'not-assessed')
        self.assertEqual(len(report['gaps']), 6)
        self.assertNotIn(str(self.root), json.dumps(report))
        with tarfile.open(self.output) as handle:
            self.assertEqual(handle.extractfile(self.entry['path']).read(), self.source.read_bytes())
            self.assertEqual(json.load(handle.extractfile('NATIVE-SOURCE-MANIFEST.json')), report)
            for member in handle:
                self.assertTrue(member.isfile())
                self.assertEqual((member.uid, member.gid, member.mtime, member.mode), (0, 0, 0, 0o644))

    def test_corruption_and_size_changes_never_publish_a_partial_archive(self):
        for value in [b'changed source input!', b'longer source input than expected']:
            self.source.write_bytes(value)
            with self.assertRaisesRegex(ValueError, 'Input .* mismatch'):
                collector.bundle([self.entry], self.output)
            self.assertFalse(self.output.exists())
            self.assertEqual(list(self.root.glob('.native-source-*')), [])

    def test_path_traversal_duplicates_and_total_limits_are_rejected(self):
        for name in ['../escape', '/absolute', 'a/./b', 'a//b', 'NATIVE-SOURCE-MANIFEST.json']:
            with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                collector.bundle([{**self.entry, 'path': name}], self.output)
        with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
            collector.bundle([self.entry, self.entry], self.output)
        with patch.object(collector, 'MAX_TOTAL', 1):
            with self.assertRaisesRegex(ValueError, 'total limit'):
                collector.bundle([self.entry], self.output)
        self.assertFalse(self.output.exists())

    def test_input_and_ancestor_symlinks_are_refused(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            collector.bundle([{**self.entry, 'source': alias}], self.output)
        directory = self.root / 'linked'
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            collector.bundle([{**self.entry, 'source': directory / 'source'}], self.output)
        self.assertFalse(self.output.exists())

    def test_existing_or_raced_destination_is_never_overwritten(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):
            collector.bundle([self.entry], self.output)
        self.assertEqual(self.output.read_bytes(), b'keep')
        self.output.unlink()
        original_link = collector.os.link
        def race(source, destination):
            self.output.write_bytes(b'raced')
            original_link(source, destination)
        with patch.object(collector.os, 'link', side_effect=race):
            with self.assertRaises(FileExistsError):
                collector.bundle([self.entry], self.output)
        self.assertEqual(self.output.read_bytes(), b'raced')
        self.assertEqual(list(self.root.glob('.native-source-*')), [])

    def test_input_changes_during_copy_are_detected_from_bytes_written(self):
        original_addfile = tarfile.TarFile.addfile
        def change_before_copy(handle, info, reader=None):
            if info.name == self.entry['path']:
                self.source.write_bytes(b'changed source input!')
            return original_addfile(handle, info, reader)
        with patch.object(collector.tarfile.TarFile, 'addfile', new=change_before_copy):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                collector.bundle([self.entry], self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.native-source-*')), [])

    def test_original_crate_build_metadata_in_filenames_is_preserved(self):
        entry = {**self.entry, 'path': 'sources/crates/toml-1.1.6+spec-1.1.0.crate', 'kind': 'crate-archive'}
        collector.bundle([entry], self.output)
        with tarfile.open(self.output) as handle:
            self.assertEqual(handle.extractfile(entry['path']).read(), self.source.read_bytes())

    def test_original_packaging_archive_is_a_separate_source_input(self):
        entry = {**self.entry, 'path': 'sources/packaging.tar.gz', 'kind': 'packaging-archive'}
        report = collector.bundle([entry], self.output)
        self.assertEqual(report['counts']['packaging-archive'], 1)
        with tarfile.open(self.output) as handle:
            self.assertEqual(handle.extractfile(entry['path']).read(), self.source.read_bytes())

    def test_node_validation_failure_cannot_be_skipped(self):
        with patch.object(collector, 'verified_evidence_records', side_effect=RuntimeError('invalid source evidence')):
            with self.assertRaisesRegex(RuntimeError, 'invalid source evidence'):
                collector.plan(self.root, self.root, self.root, self.source, 'node')
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
