import copy
import importlib.util
import io
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('packaging', Path(__file__).resolve().parents[2] / 'scripts/collect-packaging-source.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class PackagingSourceTests(unittest.TestCase):
    def setUp(self):
        self.files = {'LICENSE': b'original copyright and permission', 'build/run.sh': b'original script'}
        self.tree = self.make_tree()

    def make_tree(self):
        license = {'path': 'LICENSE', 'mode': '100644', 'type': 'blob', 'sha': collector.blob(self.files['LICENSE']), 'size': len(self.files['LICENSE'])}
        run = {'path': 'build/run.sh', 'mode': '100755', 'type': 'blob', 'sha': collector.blob(self.files['build/run.sh']), 'size': len(self.files['build/run.sh'])}
        nested = b'100755 run.sh\0' + bytes.fromhex(run['sha'])
        build = {'path': 'build', 'mode': '040000', 'type': 'tree', 'sha': collector.blob(nested, 'tree')}
        root = b'100644 LICENSE\0' + bytes.fromhex(license['sha']) + b'40000 build\0' + bytes.fromhex(build['sha'])
        return {'sha': collector.blob(root, 'tree'), 'truncated': False, 'tree': [license, build, run]}

    def archive(self, files=None, comment=None, extra=None, executable=True):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': comment or collector.REVISION}) as handle:
            for path, data in (files or self.files).items():
                entry = tarfile.TarInfo('sharp-libvips-' + collector.REVISION + '/' + path)
                entry.mode = 0o755 if path.endswith('.sh') and executable else 0o644
                entry.size = len(data)
                handle.addfile(entry, io.BytesIO(data))
            if extra:
                handle.addfile(*extra)
        return output.getvalue()

    def test_whole_tree_and_regular_source_blob_identities_match(self):
        files, entries = collector.inspect_archive(self.archive(), self.tree, self.tree['sha'])
        self.assertEqual(files, self.files)
        self.assertEqual(entries['build/run.sh']['mode'], '100755')

    def test_tree_truncation_wrong_root_and_object_tampering_are_refused(self):
        for mutation in [lambda t: t.update(truncated=True), lambda t: t.update(sha='a' * 40),
                         lambda t: t['tree'][1].update(sha='a' * 40)]:
            tree = copy.deepcopy(self.tree)
            mutation(tree)
            with self.assertRaisesRegex(ValueError, 'Git tree|directory object'):
                collector.inspect_archive(self.archive(), tree, self.tree['sha'])

    def test_changed_or_missing_archive_files_and_modes_are_refused(self):
        for data in [self.archive(files={'LICENSE': b'changed', 'build/run.sh': self.files['build/run.sh']}),
                     self.archive(files={'LICENSE': self.files['LICENSE']}), self.archive(executable=False)]:
            with self.assertRaisesRegex(ValueError, 'blob content|inventory incomplete|executable bit'):
                collector.inspect_archive(data, self.tree, self.tree['sha'])

    def test_wrong_commit_comment_and_links_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'commit comment'):
            collector.inspect_archive(self.archive(comment='a' * 40), self.tree, self.tree['sha'])
        entry = tarfile.TarInfo('sharp-libvips-' + collector.REVISION + '/link')
        entry.type, entry.linkname = tarfile.SYMTYPE, '/etc/passwd'
        with self.assertRaisesRegex(ValueError, 'regular blob'):
            collector.inspect_archive(self.archive(extra=(entry, None)), self.tree, self.tree['sha'])

    def test_traversal_duplicates_and_unsupported_git_types_are_refused(self):
        for name in ['../escape', 'sharp-libvips-' + collector.REVISION + '/LICENSE']:
            entry = tarfile.TarInfo(name)
            with self.assertRaisesRegex(ValueError, 'Unsafe, duplicate'):
                collector.inspect_archive(self.archive(extra=(entry, io.BytesIO(b''))), self.tree, self.tree['sha'])
        tree = copy.deepcopy(self.tree)
        tree['tree'][0]['mode'] = '120000'
        with self.assertRaisesRegex(ValueError, 'Unsupported Git member'):
            collector.inspect_archive(self.archive(), tree, self.tree['sha'])

    def test_missing_git_parent_and_duplicate_paths_are_refused(self):
        tree = copy.deepcopy(self.tree)
        tree['tree'].pop(1)
        with self.assertRaisesRegex(ValueError, 'Missing Git parent'):
            collector.inspect_archive(self.archive(), tree, self.tree['sha'])
        tree = copy.deepcopy(self.tree)
        tree['tree'].append(tree['tree'][0])
        with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate Git tree'):
            collector.inspect_archive(self.archive(), tree, self.tree['sha'])


if __name__ == '__main__':
    unittest.main()
