import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server import Root
import test_boundary


class Policy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        for name in ['Library/chapter.md', 'Library/art/cover.png', 'Recorder/manifest.json',
                     'Recorder/session.wav', 'Library-extra/notes.md', 'mysterious-agent-draft.json',
                     'Videos/owner.mp4', 'Mixed/nested/private/index.json', 'Mixed/nested/owner.txt']:
            p = self.path / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(name)
        self.root = Root(str(self.path), ['Library', 'Library/art', 'Recorder/manifest.json', 'Mixed/nested/private'])

    def tearDown(self):
        os.close(self.root.fd)
        self.tmp.cleanup()

    def test_partition_and_unknown_retained(self):
        personal = self.root.index()
        app = self.root.index(scope='app')
        self.assertEqual(personal['total'], 5)
        self.assertEqual(app['total'], 4)
        p = {r['path'] for r in personal['items']}
        a = {r['path'] for r in app['items']}
        self.assertFalse(p & a)
        self.assertIn('mysterious-agent-draft.json', p)
        self.assertIn('Library-extra/notes.md', p)
        self.assertIn('Recorder/session.wav', p)
        self.assertEqual(sum(personal['counts'].values()), 5)
        self.assertEqual(sum(app['counts'].values()), 4)
        self.assertEqual(self.root.index(category='photo')['total'], 0)
        self.assertEqual(self.root.index(category='photo', scope='app')['total'], 1)
        self.assertEqual(self.root.index(query='chapter')['total'], 0)
        self.assertEqual(self.root.index(query='chapter', scope='app')['total'], 1)

    def test_folders_ancestors_and_upload_policy(self):
        def names(folder, scope):
            return {r['name'] for r in self.root.list(folder, scope)['entries']}
        self.assertEqual(names('', 'app'), {'Library', 'Recorder', 'Mixed'})
        self.assertEqual(names('Recorder', 'app'), {'manifest.json'})
        self.assertEqual(names('Recorder', 'personal'), {'session.wav'})
        self.assertEqual(names('Mixed', 'app'), {'nested'})
        self.assertEqual(names('Mixed/nested', 'app'), {'private'})
        self.assertEqual(names('Mixed/nested', 'personal'), {'owner.txt'})
        self.assertEqual(names('Library', 'personal'), set())
        self.assertEqual(names('Videos', 'app'), set())
        self.assertFalse(self.root.list('Library')['upload_allowed'])
        self.assertFalse(self.root.list('Recorder', 'app')['upload_allowed'])
        self.assertTrue(self.root.list('Recorder')['upload_allowed'])
        self.assertEqual(list(self.root.list('Recorder')['app_data_prefixes']), list(self.root.app_data_prefixes))

    def test_traverses_only_selected_scope(self):
        original = self.root.open
        opened = []
        def tracked(path, directory=False):
            opened.append(path)
            return original(path, directory)
        with patch.object(self.root, 'open', tracked):
            self.root.index(scope='app')
            self.assertNotIn('Videos', opened)
            self.assertNotIn('Library-extra', opened)
            opened.clear()
            self.root.index()
            self.assertNotIn('Library', opened)
            self.assertNotIn('Mixed/nested/private', opened)

    def test_default_empty_policy_preserves_every_file(self):
        root = Root(str(self.path))
        try:
            self.assertEqual(root.index()['total'], 9)
            self.assertEqual(root.index(scope='app')['total'], 0)
        finally:
            os.close(root.fd)

    def test_invalid_config_and_scope(self):
        for prefixes in [None, 'Library', {}, [''], ['/'], ['/etc'], ['../'], ['a/../b'],
                         ['a//b'], ['a/'], ['.private'], ['a\\b'], ['C:/x'], ['a\x00b'],
                         [2], ['a'] * 257]:
            with self.subTest(prefixes=prefixes), self.assertRaises(ValueError):
                Root(str(self.path), prefixes)
        for scope in ['', 'all', '../', '/etc', 'personal,app']:
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                self.root.index(scope=scope)
        for scope in ['app', 'personal']:
            with self.assertRaises(ValueError):
                self.root.list('../outside', scope)

    def test_policy_is_not_read_authorization(self):
        with self.root.open('Library/chapter.md') as fd:
            self.assertEqual(os.read(fd, 100), b'Library/chapter.md')


class ScopedHTTP(unittest.TestCase):
    setUp = test_boundary.Boundary.setUp
    tearDown = test_boundary.Boundary.tearDown
    request = test_boundary.Boundary.request
    def test_scoped_routes_and_mcp(self):
        self.root.app_data_prefixes = ('Folder',)
        self.assertEqual(json.load(self.request('/api/index'))['total'], 1)
        app = json.load(self.request('/api/index?scope=app'))
        self.assertEqual(app['total'], 1)
        self.assertEqual(app['items'][0]['path'], 'Folder/hello.txt')
        self.assertEqual(json.load(self.request('/api/files?scope=app'))['entries'][0]['name'], 'Folder')
        self.assertEqual(json.load(self.request('/api/files?folder=Folder'))['entries'], [])
        self.assertEqual(self.request('/api/files/content?path=Folder/hello.txt').status, 200)
        for endpoint in ['files', 'index']:
            for scope in ['', 'all', '..%2Fetc', '%2Fprivate']:
                self.assertEqual(self.request('/api/' + endpoint + '?scope=' + scope).status, 400)
        req = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'files_search', 'arguments': {'query': 'hello', 'scope': 'app'}}}
        data = json.load(self.request('/mcp', data=json.dumps(req).encode()))
        self.assertEqual(json.loads(data['result']['content'][0]['text'])['total'], 1)
