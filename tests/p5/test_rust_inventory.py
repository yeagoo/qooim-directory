import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('rust_inventory', ROOT / 'scripts/inventory-rust-lock.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class RustInventoryTests(unittest.TestCase):
    def lock(self, body):
        return ('version = 4\n' + body).encode()

    def test_preserves_multiple_versions_and_dependency_references(self):
        data = self.lock('''[[package]]
name = "sample"
version = "1.0.0"
[[package]]
name = "sample"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
dependencies = ["sample 1.0.0"]
''')
        rows = tool.packages_from_lock(data)
        self.assertEqual(len(rows), 2)
        self.assertIsNone(rows[0]['source'])
        self.assertEqual(rows[1]['dependencies'], ['sample 1.0.0'])

    def test_registry_requires_original_checksum(self):
        with self.assertRaisesRegex(ValueError, 'checksum'):
            tool.packages_from_lock(self.lock('[[package]]\nname="a"\nversion="1"\nsource="' + tool.REGISTRY + '"\n'))

    def test_duplicate_identity_and_unknown_sources_fail_closed(self):
        entry = '[[package]]\nname="a"\nversion="1"\n'
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            tool.packages_from_lock(self.lock(entry + entry))
        with self.assertRaisesRegex(ValueError, 'Unsupported Cargo package source'):
            tool.packages_from_lock(self.lock(entry + 'source="git+https://example.test/repo"\n'))

    def fixture(self, root, members):
        archive = root / 'rsvg.tar'
        with tarfile.open(archive, 'w') as tar:
            for name, data in members:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        raw = archive.read_bytes()
        manifest = root / 'source.json'
        manifest.write_text(json.dumps({'componentDeclarations': [{'id': 'rsvg', 'declaredVersion': '1', 'declaredSourceUrl': 'https://example.test/rsvg.tar', 'sourceArchiveStatus': 'retrieved', 'retrieval': {'sha256': tool.digest(raw), 'bytes': len(raw)}}]}))
        return manifest, archive, root / 'new'

    def test_rejects_later_traversal_without_publishing_valid_earlier_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fixture(root, [('librsvg-1/Cargo.toml', b'[workspace]'), ('../escape', b'x')])
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                tool.inventory(*args)
            self.assertFalse(args[2].exists())

    def test_rejects_duplicate_normalized_members_and_changed_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = self.fixture(root, [('librsvg-1/Cargo.toml', b'a'), ('./librsvg-1/Cargo.toml', b'b')])
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                tool.inventory(*args)
            args[1].write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                tool.inventory(*args)
            self.assertFalse(args[2].exists())

    def test_original_bytes_reproducible_output_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = self.lock('[[package]]\nname="local"\nversion="1"\n')
            args = self.fixture(root, [('librsvg-1/Cargo.toml', b'[workspace]\n'), ('librsvg-1/Cargo.lock', lock)])
            report = tool.inventory(*args)
            self.assertEqual((args[2] / 'sources/Cargo.lock').read_bytes(), lock)
            self.assertEqual(report['counts'], {'total': 1, 'registry': 0, 'workspace': 1})
            other = root / 'second'
            self.assertEqual(report, tool.inventory(args[0], args[1], other))
            with self.assertRaises(FileExistsError):
                tool.inventory(*args)

    def test_many_cargo_inputs_are_bounded_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory), [(f'librsvg-1/p{i}/Cargo.toml', b'x') for i in range(101)])
            with self.assertRaisesRegex(ValueError, 'Cargo input inventory limit'):
                tool.inventory(*args)
            self.assertFalse(args[2].exists())


if __name__ == '__main__':
    unittest.main()
