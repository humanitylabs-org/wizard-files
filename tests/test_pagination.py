import os
import unittest
from unittest.mock import patch
import test_provenance


class Pagination(unittest.TestCase):
    setUp = test_provenance.Provenance.setUp
    tearDown = test_provenance.Provenance.tearDown
    source = test_provenance.Provenance.source
    save = test_provenance.Provenance.save
    def test_all_pages_and_filter_counts(self):
        for i in range(610):
            (self.path / f'Photos/{i:04}.png').write_bytes(b'fixture')
        for sender, expected in [('', 614), ('owner', 2), ('agent:main', 2), ('unknown', 611)]:
            paths, offset, snapshot = [], 0, ''
            while True:
                data = self.root.index(category='photo', sender=sender, offset=offset, limit=37, snapshot=snapshot)
                self.assertEqual(data['total'], expected)
                self.assertFalse(data['truncated'])
                self.assertLessEqual(len(data['items']), 37)
                paths.extend(r['path'] for r in data['items'])
                snapshot = data['snapshot']
                if not data['has_more']:
                    self.assertIsNone(data['next_offset'])
                    break
                self.assertGreater(data['next_offset'], offset)
                offset = data['next_offset']
            self.assertEqual(len(set(paths)), expected)
            self.assertEqual(len(paths), expected)
        with self.assertRaises(ValueError):
            self.root.index(limit=301)
        for value in [-1, 'no', True, '01']:
            with self.assertRaises(ValueError):
                self.root.index(offset=value)

    def test_snapshot_change_restarts_and_ties_are_stable(self):
        first = self.root.index(category='photo', limit=1)
        again = self.root.index(category='photo', limit=1)
        self.assertEqual(first['items'], again['items'])
        (self.path / 'Photos/new.png').write_bytes(b'new')
        data = self.root.index(category='photo', offset=1, limit=1, snapshot=first['snapshot'])
        self.assertTrue(data['reset'])
        self.assertEqual(data['offset'], 0)
        self.assertEqual(data['next_offset'], 1)

    def test_pending_distinct_from_unknown_and_bounded_progress(self):
        with patch('provenance.HASH_BUDGET', 23):
            first = self.root.index(category='photo')
            self.assertTrue(first['provenance']['partial'])
            self.assertGreater(first['provenance']['pending'], 0)
            self.assertEqual(first['sender_counts']['unknown'], 1)
            for _ in range(4):
                final = self.root.index(category='photo')
            self.assertFalse(final['provenance']['partial'])
            self.assertEqual(final['sender_counts']['owner'], 2)
        self.root.provenance.hashes.clear()
        with patch('provenance.MAX_PHOTO', 1):
            data = self.root.index(category='photo')
            self.assertFalse(data['provenance']['partial'])
            self.assertEqual(data['sender_counts']['unknown'], 4)
