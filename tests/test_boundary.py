import contextlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from server import Root, Handler, ThreadingHTTPServer

class Boundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        root = self.base/'root'; root.mkdir()
        (root/'Folder').mkdir(); (root/'Folder'/'hello.txt').write_text('hello from owner files')
        (root/'photo.png').write_bytes(b'PNG fixture')
        (root/'.secret').write_text('hidden')
        (self.base/'outside').mkdir(); (self.base/'outside'/'secret.txt').write_text('PRIVATE')
        (root/'escape').symlink_to(self.base/'outside', target_is_directory=True)
        (root/'file-link').symlink_to(self.base/'outside'/'secret.txt')
        (root/'internal').symlink_to(root/'Folder', target_is_directory=True)
        os.mkfifo(root/'pipe')
        self.root = Root(str(root))
        self.server = ThreadingHTTPServer(('127.0.0.1',0),Handler); self.server.root=self.root
        self.thread=threading.Thread(target=self.server.serve_forever);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def tearDown(self):
        self.server.shutdown();self.thread.join();self.server.server_close();os.close(self.root.fd);self.tmp.cleanup()
    def request(self,path,**kwargs):
        try: return urllib.request.urlopen(urllib.request.Request(self.url+path,**kwargs))
        except urllib.error.HTTPError as e: return e
    def test_list_and_search(self):
        data=json.load(self.request('/api/files'))
        self.assertEqual([r['name'] for r in data['entries']],['Folder','photo.png'])
        data=json.load(self.request('/api/index?q=hello'))
        self.assertEqual(data['total'],1);self.assertEqual(data['items'][0]['path'],'Folder/hello.txt')
        self.assertEqual(json.load(self.request('/api/index?type=link'))['items'],[])
    def test_read_range_head(self):
        path='/api/files/content?path=Folder/hello.txt'
        self.assertEqual(self.request(path).read(),b'hello from owner files')
        r=self.request(path,headers={'Range':'bytes=6-9'});self.assertEqual(r.status,206);self.assertEqual(r.read(),b'from')
        r=self.request(path,method='HEAD');self.assertEqual(r.headers['Content-Length'],'22');self.assertEqual(r.read(),b'')
        self.assertEqual(self.request(path,headers={'Range':'bytes=999-1000'}).status,416)
    def test_escape_rejection(self):
        for path in ['../outside/secret.txt','/etc/passwd','escape/secret.txt','file-link','internal/hello.txt','.secret','Folder/../photo.png','Folder//hello.txt','pipe','C:/etc/passwd','Folder\\hello.txt']:
            with self.subTest(path=path):
                q=urllib.parse.quote(path,safe='')
                self.assertIn(self.request('/api/files/content?path='+q).status,[400,404])
        for path in ['../outside','escape','internal','/','Folder/..']:
            self.assertIn(self.request('/api/files?folder='+urllib.parse.quote(path,safe='')).status,[400,404])
    def test_descriptor_survives_name_swap(self):
        with self.root.open('Folder/hello.txt') as fd:
            (self.base/'root'/'Folder').rename(self.base/'root'/'Old')
            (self.base/'root'/'Folder').symlink_to(self.base/'outside',target_is_directory=True)
            self.assertEqual(os.read(fd,100),b'hello from owner files')
        self.assertIn(self.request('/api/files/content?path=Folder/secret.txt').status,[400,404])
    def test_host_origin_and_static(self):
        self.assertEqual(self.request('/api/files',headers={'Host':'evil.example'}).status,421)
        self.assertEqual(self.request('/api/files',headers={'Origin':'https://evil.example'}).status,403)
        self.assertEqual(self.request('/api/files',headers={'Sec-Fetch-Site':'cross-site'}).status,403)
        for p in ['/server.py','/.git/config','/api/index?source=legacy','/api/files?source=/etc','/collections.json','/api/apps']:
            self.assertIn(self.request(p).status,[400,404])
        self.assertEqual(self.request('/api/uploads',data=b'{}').status,405)
    def test_active_content_download(self):
        (self.base/'root'/'active.html').write_text('<script>evil()</script>')
        r=self.request('/api/files/content?path=active.html')
        self.assertEqual(r.headers['Content-Type'],'application/octet-stream')
        self.assertTrue(r.headers['Content-Disposition'].startswith('attachment'))
        self.assertIn('sandbox',r.headers['Content-Security-Policy'])
    def test_fresh_empty_root(self):
        empty = self.base/'empty'; empty.mkdir()
        root = Root(str(empty))
        try:
            self.assertEqual(root.list('')['entries'], [])
            self.assertEqual(root.index()['total'], 0)
            self.assertTrue(all(v == 0 for v in root.index()['counts'].values()))
        finally: os.close(root.fd)
    def test_root_symlink_rejected(self):
        link = self.base/'root-link'; link.symlink_to(self.base/'root', target_is_directory=True)
        with self.assertRaises(OSError): Root(str(link))
    def test_private_content_validation(self):
        path='/api/files/content?path=Folder/hello.txt'
        with self.request(path) as r:
            tag=r.headers['ETag']
            self.assertEqual(r.headers['Cache-Control'],'private, no-cache')
            self.assertIn('Cookie',r.headers['Vary'])
        with self.request(path,headers={'If-None-Match':tag}) as r:
            self.assertEqual(r.status,304)
        (self.base/'root/Folder/hello.txt').write_text('changed source')
        with self.request(path,headers={'If-None-Match':tag}) as r:
            self.assertEqual(r.status,200)
            self.assertNotEqual(r.headers['ETag'],tag)
            self.assertEqual(r.read(),b'changed source')
        for name in ['../outside/secret.txt','.secret','escape/secret.txt','file-link']:
            with self.request('/api/files/thumbnail?path='+urllib.parse.quote(name,safe='')+'&v=x') as r:
                self.assertIn(r.status,[400,404,415])

    def test_mcp(self):
        data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'files_list','arguments':{'folder':'Folder'}}}).encode()
        r=json.load(self.request('/mcp',data=data))
        self.assertIn('hello.txt',r['result']['content'][0]['text'])

if __name__=='__main__':unittest.main()
