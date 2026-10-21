import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rust_scope', Path(__file__).resolve().parents[2] / 'scripts/resolve-rust-scope.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class RustScopeTests(unittest.TestCase):
    def archive(self, root, entries):
        path = root / 'source.tar'
        with tarfile.open(path, 'w') as archive:
            for name, data, symlink in entries:
                member = tarfile.TarInfo(name)
                if symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = symlink
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        return path

    def test_extraction_never_follows_links_or_retains_executable_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = self.archive(root, [('package/code.rs', b'not executed', None), ('package/linked', b'', '/etc/passwd')])
            out = root / 'out'
            files, skipped = tool.extract_regular(path, out, 'package')
            self.assertEqual(list(files), ['code.rs'])
            self.assertEqual(skipped, 1)
            self.assertFalse((out / 'linked').exists())
            self.assertEqual((out / 'code.rs').stat().st_mode & 0o777, 0o600)

    def test_traversal_duplicate_and_ambient_config_inputs_are_rejected(self):
        for entries in [
            [('package/../escape', b'bad', None)],
            [('package/a', b'a', None), ('./package/a', b'b', None)],
            [('package/.cargo/config.toml', b'[build]', None)],
        ]:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = self.archive(root, entries)
                with self.assertRaises(ValueError):
                    tool.extract_regular(path, root / 'out', 'package', workspace=True)
                self.assertFalse((root / 'escape').exists())

    def test_checksum_mismatch_and_links_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'bytes'
            path.write_bytes(b'original')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                tool.checked_archive(path, 'f' * 64)
            link = root / 'link'
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'regular'):
                tool.checked_archive(link, tool.digest(b'original'))

    def test_manifest_edits_require_exact_original_features(self):
        original = b'image = ["jpeg", "png", "gif", "webp"]\ncairo-rs = ["png", "pdf", "ps"]\n'
        self.assertEqual(tool.modify_manifest(original, image=True), b'image = ["jpeg", "png"]\ncairo-rs = ["png"]\n')
        with self.assertRaisesRegex(ValueError, 'exact manifest'):
            tool.modify_manifest(original + original, image=True)
        with self.assertRaisesRegex(ValueError, 'exact manifest'):
            tool.modify_manifest(b'changed')

    def test_tree_normalization_deduplicates_and_drops_local_paths(self):
        allowed = {('librsvg-c', '2.63.2'): {'checksum': None}, ('sample', '1.0'): {'checksum': 'a' * 64}}
        rows = tool.parse_tree('librsvg-c v2.63.2 (/private/local/source)\nsample v1.0\nsample v1.0 (*)\n', allowed)
        self.assertEqual(len(rows), 2)
        self.assertNotIn('/private', json.dumps(rows))
        with self.assertRaisesRegex(ValueError, 'uncollected'):
            tool.parse_tree('librsvg-c v2.63.2\nunknown v1.0', allowed)
        with self.assertRaisesRegex(ValueError, 'root package'):
            tool.parse_tree('sample v1.0', allowed)

    def test_member_size_limit_is_checked_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'large.tar'
            with tarfile.open(path, 'w') as archive:
                member = tarfile.TarInfo('package/large')
                member.size = 64 * 1024**2 + 1
                archive.fileobj.write(member.tobuf())
            with self.assertRaisesRegex(ValueError, '64 MiB'):
                tool.extract_regular(path, root / 'out', 'package')

    def test_feature_edits_do_not_silently_modify_an_unrelated_field(self):
        original = b'image = ["jpeg","gif","webp"]\nother = ["jpeg", "gif", "webp"]\ncairo-rs = ["png", "pdf", "ps"]\n'
        with self.assertRaisesRegex(ValueError, 'exact manifest'):
            tool.modify_manifest(original, image=True)

    def test_untrusted_registry_identity_fails_before_filesystem_or_cargo_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            third = root / 'third-party'
            (third / 'rust-lock/sources').mkdir(parents=True)
            (third / 'crate-notices').mkdir()
            lock = ('version=4\n[[package]]\nname="example"\nversion="1.0"\nsource="' + tool.crate.rust.REGISTRY + '"\nchecksum="' + 'a' * 64 + '"\n').encode()
            (third / 'rust-lock/sources/Cargo.lock').write_bytes(lock)
            inventory = {'format': 1, 'scope': 'complete-lockfile-not-compiled-graph', 'licenseClearance': 'not-assessed', 'packages': tool.crate.rust.packages_from_lock(lock), 'assets': [{'file': 'third-party/rust-lock/sources/Cargo.lock', 'sha256': tool.digest(lock), 'bytes': len(lock)}]}
            raw = json.dumps(inventory).encode()
            (third / 'rust-lock/inventory.json').write_bytes(raw)
            collection = json.dumps({'packages': [{'name': '../../escape', 'version': '1.0', 'checksum': 'a' * 64, 'status': 'collected', 'archiveBytes': 1}]}).encode()
            (third / 'crate-notices/collection.json').write_bytes(collection)
            source = third / 'source.json'
            source.write_text(json.dumps({'rustLockInventory': {'sha256': tool.digest(raw)}, 'crateNoticeCollection': {'sha256': tool.digest(collection)}}))
            with patch.object(tool.subprocess, 'run', side_effect=AssertionError('Unexpected tool execution')):
                with self.assertRaisesRegex(ValueError, 'package identity'):
                    tool.resolve(source, root / 'absent-archive', root / 'absent-cache', root / 'output', root / 'absent-cargo')
            self.assertFalse((root / 'output').exists())

    def test_host_toolchain_is_explicit_and_cannot_be_inferred_from_target(self):
        self.assertEqual(tool.rustc_info('rustc 1.96.0 (fixture)\nhost: aarch64-unknown-linux-gnu\n')['host'], 'aarch64-unknown-linux-gnu')
        with self.assertRaisesRegex(ValueError, 'host toolchain'):
            tool.rustc_info('rustc 1.96.0 (fixture)\n')


if __name__ == '__main__':
    unittest.main()
