import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location('native_collector', Path(__file__).resolve().parents[2] / 'scripts/collect-native-sources.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class SourceCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.notices = self.root / 'notices'
        self.notices.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, entries):
        path = self.root / 'source.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data, link in entries:
                info = tarfile.TarInfo(name)
                if link:
                    info.type = tarfile.SYMTYPE
                    info.linkname = link
                    archive.addfile(info)
                else:
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
        return path

    def test_notice_bytes_are_preserved_and_deduplicated(self):
        data = b'Copyright Original author\nPermission notice\n'
        path = self.archive([('source/LICENSE', data, None), ('source/docs/COPYING', data, None), ('source/code.c', b'never executed', None)])
        notices, warnings = collector.inspect_archive(path, self.notices)
        self.assertEqual(len(notices), 2)
        self.assertEqual(warnings, [])
        self.assertEqual(len(list(self.notices.iterdir())), 1)
        self.assertEqual(next(self.notices.iterdir()).read_bytes(), data)

    def test_rejected_archive_leaves_no_apparently_valid_notices(self):
        path = self.archive([('source/LICENSE', b'valid first notice', None), ('../escape', b'bad', None)])
        with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
            collector.inspect_archive(path, self.notices)
        self.assertEqual(list(self.notices.iterdir()), [])
        self.assertFalse((self.root / 'escape').exists())

    def test_normalized_duplicate_members_are_rejected(self):
        path = self.archive([('source/LICENSE', b'first', None), ('./source/LICENSE', b'second', None)])
        with self.assertRaisesRegex(ValueError, 'Duplicate archive'):
            collector.inspect_archive(path, self.notices)
        self.assertEqual(list(self.notices.iterdir()), [])

    def test_link_notices_are_not_followed_and_limits_are_enforced(self):
        path = self.archive([('source/LICENSE', b'', '/etc/passwd')])
        notices, warnings = collector.inspect_archive(path, self.notices)
        self.assertEqual(notices, [])
        self.assertIn('not a regular', warnings[0])
        path = self.archive([('source/LICENSE', b'123456789', None)])
        with patch.object(collector, 'MAX_NOTICE', 8):
            with self.assertRaisesRegex(ValueError, 'Notice exceeds'):
                collector.inspect_archive(path, self.notices)

    def test_spdx_license_directories_are_preserved_without_following_aliases(self):
        path = self.archive([('source/LICENSES/LGPL-2.1-or-later.txt', b'original LGPL text', None), ('source/COPYING', b'', 'LICENSES/LGPL-2.1-or-later.txt')])
        notices, warnings = collector.inspect_archive(path, self.notices)
        self.assertEqual(len(notices), 1)
        self.assertTrue(notices[0]['archiveMember'].endswith('LGPL-2.1-or-later.txt'))
        self.assertEqual(len(warnings), 1)

    def test_network_failure_is_recorded_without_claiming_clearance(self):
        output = self.root / 'output'
        output.mkdir()
        (output / 'archives').mkdir()
        (output / 'notices').mkdir()
        component = {'id': 'example', 'declaredVersion': '1.0', 'declaredSourceUrl': 'https://example.test/source.tar.gz'}
        with patch.object(collector.urllib.request, 'urlopen', side_effect=OSError('unavailable')):
            result = collector.collect_component(component, output)
        self.assertEqual(result['status'], 'download-failed')
        self.assertEqual(result['licenseClearance'], 'not-assessed')
        self.assertEqual(result['notices'], [])

    def test_parallel_shared_notices_remain_consistent(self):
        path = self.archive([('source/LICENSE', b'shared notice', None)])
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: collector.inspect_archive(path, self.notices), range(30)))
        self.assertTrue(all(len(notices) == 1 for notices, warnings in results))
        self.assertEqual(len(list(self.notices.iterdir())), 1)

    def test_unlicense_original_text_is_not_lost(self):
        path = self.archive([('source/UNLICENSE', b'Original public domain dedication', None)])
        notices, warnings = collector.inspect_archive(path, self.notices)
        self.assertEqual(len(notices), 1)
        self.assertEqual(warnings, [])


if __name__ == '__main__':
    unittest.main()
