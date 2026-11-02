"""Browser boundary (WIZARD_BROWSER_BOUNDARY, wizard-os #385/#386): with the flag on, the data routes answer only the
Agent Service adapter (box-local, no browser or network-identity headers, this installation's credential); the
opaque frame still loads the page's static files; browser requests to /mcp are refused. Off: unchanged."""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import server
from server import Root, Handler, ThreadingHTTPServer

CRED = 'a' * 64


class BrowserBoundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / 'Folder').mkdir()
        (root / 'Folder' / 'clip.mp4').write_bytes(b'\0' * 4096)
        self.root = Root(str(root))
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.root = self.root
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.patch = mock.patch.multiple(server, BOUNDARY=True, APP_CREDENTIAL=CRED)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.server.shutdown(); self.thread.join(); self.server.server_close(); os.close(self.root.fd); self.tmp.cleanup()

    def get(self, path, headers=None, method='GET', body=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in {'Host': f'127.0.0.1:{self.server.server_port}', **(headers or {})}.items():
            c.putheader(k, v)
        if body is not None:
            c.putheader('Content-Length', str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, data, r

    def test_adapter_with_credential_reads(self):
        status, body, _ = self.get('/api/files?folder=Folder&scope=personal', {'X-Wizard-App-Credential': CRED, 'sec-fetch-mode': 'cors'})
        self.assertEqual(status, 200)
        self.assertEqual([e['name'] for e in json.loads(body)['entries']], ['clip.mp4'])
        status, body, r = self.get('/api/files/content?path=Folder%2Fclip.mp4', {'X-Wizard-App-Credential': CRED, 'Range': 'bytes=1024-2047'})
        self.assertEqual((status, len(body), r.headers['Content-Range']), (206, 1024, 'bytes 1024-2047/4096'))

    def test_browser_and_network_requests_are_refused(self):
        cases = [
            ({'Origin': 'null', 'Sec-Fetch-Site': 'cross-site', 'X-Wizard-App-Credential': CRED}, 403, 'browser_request_refused'),
            ({'Sec-Fetch-Site': 'same-origin', 'Cookie': 'x=1'}, 403, 'browser_request_refused'),
            ({'Tailscale-User-Login': 'owner@example.com', 'X-Wizard-App-Credential': CRED}, 403, 'network_identity_refused'),
            ({'X-Forwarded-For': '100.64.0.7'}, 403, 'network_identity_refused'),
            ({}, 401, 'adapter_credential_required'),
            ({'X-Wizard-App-Credential': 'b' * 64}, 401, 'adapter_credential_required'),
        ]
        for path in ('/api/files?folder=Folder', '/api/index', '/api/files/content?path=Folder%2Fclip.mp4', '/api/files/thumbnail?path=Folder%2Fclip.mp4'):
            for headers, status, error in cases:
                with self.subTest(path=path, headers=headers):
                    got, body, _ = self.get(path, headers)
                    self.assertEqual((got, json.loads(body)['error']), (status, error))

    def test_static_page_loads_for_the_opaque_frame(self):
        status, body, _ = self.get('/', {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe', 'Host': 'box.example'})
        self.assertEqual(status, 200)
        self.assertIn(b'browser-boundary-client.js', body)
        self.assertEqual(self.get('/files-data.js', {'Sec-Fetch-Site': 'cross-site', 'Origin': 'null'})[0], 200)
        self.assertEqual(self.get('/index.html', method='POST', body=b'')[0], 405)

    def test_container_health_probe_still_answers(self):
        # Dockerfile HEALTHCHECK: box-local, no credential. /health carries the version only, no owner data.
        status, body, _ = self.get('/health')
        self.assertEqual((status, json.loads(body)['ok']), (200, True))
        self.assertEqual(self.get('/health', method='POST', body=b'')[0], 405)

    def test_browser_mcp_refused_agent_mcp_kept(self):
        req = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}).encode()
        self.assertEqual(self.get('/mcp', {'Origin': 'null', 'Content-Type': 'application/json'}, 'POST', req)[0], 403)
        status, body, _ = self.get('/mcp', {'Content-Type': 'application/json'}, 'POST', req)
        self.assertEqual(status, 200)
        self.assertIn('files_list', body.decode())

    def test_off_is_unchanged(self):
        with mock.patch.object(server, 'BOUNDARY', False):
            self.assertEqual(self.get('/api/files?folder=Folder')[0], 200)
            self.assertEqual(self.get('/api/files?folder=Folder', {'Sec-Fetch-Site': 'cross-site'})[0], 403)

    def test_flag_without_credential_does_not_start(self):
        with mock.patch.multiple(server, BOUNDARY=True, APP_CREDENTIAL=''):
            self.assertIn('WIZARD_APP_CREDENTIAL', server.boundary_config_error())
        with mock.patch.multiple(server, BOUNDARY=False, APP_CREDENTIAL=''):
            self.assertEqual(server.boundary_config_error(), '')


if __name__ == '__main__':
    unittest.main()
