import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gvdb_collector', Path(__file__).resolve().parents[2] / 'scripts/collect-gvdb-source.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class GvdbCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / 'input.tar.gz'
        self.output = self.root / 'output'
        self.wrap = self.root / 'third-party/sources/glib-2.90.0/gvdb.wrap'
        self.wrap.parent.mkdir(parents=True)
        self.wrap.write_text(f'[wrap-git]\ndirectory=gvdb\nurl={collector.REPOSITORY}\nrevision={collector.REVISION}\ndepth=1\n\n[provide]\ndependency_names = gvdb\n')
        self.recipe = self.root / 'third-party/sources/sharp-libvips-ebb95f8/build-posix.sh'
        self.recipe.parent.mkdir(parents=True)
        self.recipe.write_text('meson setup --force-fallback-for=gvdb\n')
        self.manifest = self.root / 'third-party/libvips-source-review.json'
        parent = {'file': str(self.wrap.relative_to(self.root)), 'sha256': collector.digest(self.wrap.read_bytes()),
                  'sourceUrl': 'https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz',
                  'archiveSha256': 'a' * 64, 'archiveMember': 'glib-2.90.0/subprojects/gvdb.wrap'}
        recipe = {'file': str(self.recipe.relative_to(self.root)), 'sha256': collector.digest(self.recipe.read_bytes())}
        self.source = {'componentDeclarations': [{'id': 'glib', 'declaredVersion': '2.90.0',
                        'declaredSourceUrl': parent['sourceUrl'], 'retrieval': {'sha256': 'a' * 64}}],
                       'assets': [parent, recipe], 'patchRecipe': recipe}
        self.save()
        self.entries = {n: ('original:' + n).encode() for n in collector.MEMBERS}
        self.make_archive()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.manifest.write_text(json.dumps(self.source))

    def make_archive(self, extra=None, missing=None):
        with tarfile.open(self.archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': collector.REVISION}) as handle:
            for name, data in sorted(self.entries.items()):
                if name == missing:
                    continue
                member = tarfile.TarInfo('gvdb-' + collector.REVISION + '/' + name)
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))
            if extra:
                handle.addfile(*extra)
        self.checksum = collector.digest(self.archive.read_bytes())

    def collect(self):
        return collector.collect(self.manifest, self.archive, self.checksum, self.output)

    def test_preserves_all_original_files_and_two_full_notices(self):
        report = self.collect()
        self.assertEqual(report['counts']['regularFiles'], 14)
        self.assertEqual(len(report['notices']), 2)
        self.assertEqual(report['warnings'], [])
        self.assertFalse(report['sourceCodeExecuted'])
        self.assertEqual(report['historicalBinaryMatch'], 'not-asserted')
        for asset in report['assets']:
            relative = asset['archiveMember'].split('/', 1)[1]
            self.assertEqual((self.output / 'texts' / (asset['sha256'] + '.txt')).read_bytes(), self.entries[relative])

    def test_checksum_is_verified_before_any_material_is_published(self):
        self.checksum = '0' * 64
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.collect()
        self.assertFalse(self.output.exists())

    def test_paths_duplicate_members_and_incomplete_inventories_are_rejected(self):
        for name in ['../outside', '/absolute', 'gvdb-' + collector.REVISION + '/README.md']:
            member = tarfile.TarInfo(name)
            member.size = 1
            self.make_archive((member, io.BytesIO(b'x')))
            with self.assertRaisesRegex(ValueError, 'Unsafe, duplicate'):
                self.collect()
            self.assertFalse(self.output.exists())
        self.make_archive(missing='meson.options')
        with self.assertRaisesRegex(ValueError, 'inventory incomplete'):
            self.collect()
        self.assertFalse(self.output.exists())

    def test_links_and_oversized_archives_are_refused(self):
        member = tarfile.TarInfo('gvdb-' + collector.REVISION + '/link')
        member.type = tarfile.SYMTYPE
        member.linkname = '/etc/passwd'
        self.make_archive((member, None))
        with self.assertRaisesRegex(ValueError, 'must be regular'):
            self.collect()
        with patch.object(collector, 'MAX_ARCHIVE', 1):
            with self.assertRaisesRegex(ValueError, 'bounded regular'):
                self.collect()
        self.assertFalse(self.output.exists())

    def test_branch_substitution_and_wrong_parent_are_rejected(self):
        self.wrap.write_text(self.wrap.read_text().replace(collector.REVISION, 'main'))
        self.source['assets'][0]['sha256'] = collector.digest(self.wrap.read_bytes())
        self.save()
        with self.assertRaisesRegex(ValueError, 'Unsupported gvdb wrap'):
            self.collect()
        self.source['assets'][0]['archiveSha256'] = 'b' * 64
        self.save()
        with self.assertRaisesRegex(ValueError, 'Parent GLib archive'):
            self.collect()

    def test_missing_recipe_selection_and_existing_outputs_are_not_overwritten(self):
        self.recipe.write_text('no fallback\n')
        self.source['patchRecipe']['sha256'] = collector.digest(self.recipe.read_bytes())
        self.save()
        with self.assertRaisesRegex(ValueError, 'Unique gvdb fallback'):
            self.collect()
        self.recipe.write_text('meson setup --force-fallback-for=gvdb\n')
        self.source['patchRecipe']['sha256'] = collector.digest(self.recipe.read_bytes())
        self.save()
        self.output.mkdir()
        marker = self.output / 'keep'
        marker.write_text('keep')
        with self.assertRaises(FileExistsError):
            self.collect()
        self.assertEqual(marker.read_text(), 'keep')

    def test_mismatched_archive_commit_metadata_is_rejected(self):
        with tarfile.open(self.archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': 'b' * 40}) as handle:
            for name, data in sorted(self.entries.items()):
                member = tarfile.TarInfo('gvdb-' + collector.REVISION + '/' + name)
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))
        self.checksum = collector.digest(self.archive.read_bytes())
        with self.assertRaisesRegex(ValueError, 'commit comment'):
            self.collect()
        self.assertFalse(self.output.exists())

    def test_source_and_notices_use_the_same_verified_snapshot(self):
        original_open = tarfile.open
        changed = False
        def open_after_input_changes(*args, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                self.entries['README.md'] = b'changed after checksum verification'
                self.entries['COPYING'] = b'changed original notice'
                # Build replacement without recursively calling the patched opener.
                with original_open(self.archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': collector.REVISION}) as handle:
                    for name, data in sorted(self.entries.items()):
                        member = tarfile.TarInfo('gvdb-' + collector.REVISION + '/' + name)
                        member.size = len(data)
                        handle.addfile(member, io.BytesIO(data))
            return original_open(*args, **kwargs)
        with patch.object(collector.tarfile, 'open', side_effect=open_after_input_changes):
            report = self.collect()
        readme = next(a for a in report['assets'] if a['archiveMember'].endswith('/README.md'))
        notice = next(a for a in report['notices'] if a['archiveMember'].endswith('/COPYING'))
        self.assertEqual(readme['sha256'], collector.digest(b'original:README.md'))
        self.assertEqual(notice['sha256'], collector.digest(b'original:COPYING'))
        self.assertEqual(report['component']['archiveSha256'], self.checksum)


if __name__ == '__main__':
    unittest.main()
