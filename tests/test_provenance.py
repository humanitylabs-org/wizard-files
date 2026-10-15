import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server import Root


class Provenance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        (self.path / '.wizard').mkdir()
        for path in ['Photos/Chats/both.png', 'Photos/Chats/user.png', 'Photos/Chats/agent.png', 'Photos/unknown.png', 'Support/art.png']:
            f = self.path / path
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(path.encode())  # explicitly synthetic bytes; reader tests are not image decoder proof
        self.root = Root(str(self.path), ['Support'])
        self.doc = {'schema': 1, 'owner_label': 'Fixture Owner', 'agent_labels': {'main': 'Fixture Guide', 'other': 'Fixture Other'}, 'files': []}
        for name, roles in [('both', ['user', 'assistant']), ('user', ['user']), ('agent', ['assistant'])]:
            path = 'Photos/Chats/' + name + '.png'
            self.doc['files'].append({'path': path, 'sha256': hashlib.sha256((self.path/path).read_bytes()).hexdigest(), 'sources': [self.source(role) for role in roles]})
        self.save()

    def source(self, role):
        return {'role': role, 'agent_id': 'main', 'sender_label': 'Fixture Owner' if role == 'user' else 'Fixture Guide', 'thread_id': 'fixture-thread', 'message_id': 'fixture-'+role, 'sent_at': '2025-04-12T14:23:00Z'}

    def save(self):
        (self.path/'.wizard/photo-provenance.json').write_text(json.dumps(self.doc))

    def tearDown(self):
        os.close(self.root.fd)
        self.tmp.cleanup()

    def test_roles_dedupe_labels_and_scopes(self):
        data = self.root.index(category='photo')
        self.assertEqual(data['total'], 4)
        self.assertEqual(data['sender_counts'], {'owner': 2, 'agent:main': 2, 'agent:other': 0, 'unknown': 1})
        for sender in ['owner', 'agent:main']:
            rows = self.root.index(category='photo', sender=sender)['items']
            self.assertEqual(len(rows), 2)
            self.assertIn('Photos/Chats/both.png', [r['path'] for r in rows])
        self.assertEqual(self.root.index(scope='app')['total'], 1)
        self.assertEqual(self.root.index(scope='app')['sender_counts']['owner'], 0)
        both = next(r for r in data['items'] if r['name'] == 'both.png')
        self.assertEqual(len(both['sources']), 2)
        self.assertNotIn('thread_id', both['sources'][0])
        self.assertEqual(both['sent_at'], '2025-04-12T14:23:00+00:00')
        self.assertEqual(data['provenance']['owner_label'], 'Fixture Owner')
        self.assertNotIn('.wizard', str(self.root.list('')))
        with self.assertRaises(ValueError):
            with self.root.open('.wizard/photo-provenance.json'):
                pass

    def test_mismatch_and_changed_bytes_invalidate_cache(self):
        self.assertEqual(self.root.index(sender='owner')['total'], 2)
        f = self.path/'Photos/Chats/both.png'
        original = f.stat()
        f.write_bytes(b'x' * original.st_size)
        os.utime(f, ns=(original.st_atime_ns, original.st_mtime_ns))
        data = self.root.index(sender='owner')
        self.assertEqual(data['total'], 1)
        self.assertEqual(data['sender_counts']['unknown'], 2)

    def test_missing_malformed_bounded_and_wrong_schema(self):
        file = self.path/'.wizard/photo-provenance.json'
        file.unlink()
        self.assertFalse(self.root.index()['provenance']['available'])
        for content in ['{', '[]', '{"schema":true}', json.dumps({**self.doc, 'schema': 2}), json.dumps({**self.doc, 'files': {}}), '['*1100]:
            file.write_text(content)
            self.assertFalse(self.root.index()['provenance']['available'])
            self.assertEqual(self.root.index(sender='unknown')['total'], 4)
        file.write_bytes(b' ' * 100)
        with patch('provenance.MAX_MANIFEST', 50):
            self.assertFalse(self.root.index()['provenance']['available'])

    def test_symlinks_and_nonregular_manifest(self):
        file = self.path/'.wizard/photo-provenance.json'
        file.rename(self.path/'outside.json')
        file.symlink_to(self.path/'outside.json')
        self.assertFalse(self.root.index()['provenance']['available'])
        file.unlink()
        os.mkfifo(file)
        self.assertFalse(self.root.index()['provenance']['available'])
        file.unlink()
        (self.path/'.wizard').rmdir()
        (self.path/'.wizard').symlink_to(self.path, target_is_directory=True)
        self.assertFalse(self.root.index()['provenance']['available'])

    def test_unsafe_entries_and_multiple_agents(self):
        base = self.doc['files'][0]
        for path in ['../outside.png', '/etc/foo.png', 'Photos/../Chats/both.png', '.secret.png']:
            self.doc['files'].append({**base, 'path': path})
        self.doc['files'].extend([None, {'path': []}, {**base, 'sources': [{'role': {}}]}])
        other = {**self.source('assistant'), 'agent_id': 'other', 'sender_label': 'Fixture Other'}
        base['sources'].append(other)
        self.save()
        self.assertEqual(self.root.index(sender='agent:other')['total'], 1)
        self.assertEqual(self.root.index(sender='owner')['total'], 2)
        f = self.path/'Photos/Chats/both.png'
        f.unlink(); f.symlink_to(self.path/'Photos/Chats/user.png')
        self.assertEqual(self.root.index(sender='agent:other')['total'], 0)

    def test_budget_is_unknown_until_verified_and_warm_cache(self):
        with patch('provenance.HASH_BUDGET', 1):
            data = self.root.index()
            self.assertTrue(data['provenance']['partial'])
            self.assertEqual(data['sender_counts']['unknown'], 4)
        self.root.index()
        with patch('provenance.HASH_BUDGET', 1):
            self.assertFalse(self.root.index()['provenance']['partial'])
        with self.assertRaises(ValueError):
            self.root.index(sender='../bad')
