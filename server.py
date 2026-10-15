"""Read-only, descriptor-relative owner-files server. Uploads belong to Wizard's transfer service."""
import contextlib
import datetime
import errno
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit, quote

VERSION = '0.1.1'
ASSETS = {'index.html', 'app.js', 'my-files.js', 'styles.css', 'my-files.css', 'restyle.css', 'integration.css', 'icon.png'}

class Root:
    def __init__(self, path, app_data_prefixes=()):
        # Visibility policy, not authorization. Invalid configuration stops startup.
        if not isinstance(app_data_prefixes, (list, tuple)) or len(app_data_prefixes) > 256:
            raise ValueError('app-data prefixes must be a bounded array')
        for prefix in app_data_prefixes:
            if not self.parts(prefix):
                raise ValueError('app-data prefix must not be the root')
        self.app_data_prefixes = tuple(sorted(set(app_data_prefixes)))
        if os.path.abspath(path) == '/':
            raise ValueError('root must be narrower than filesystem')
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    @staticmethod
    def parts(path):
        if not isinstance(path, str) or len(path) > 4096 or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path):
            raise ValueError('invalid path')
        parts = path.split('/') if path else []
        if len(parts) > 64 or any(not p or p.startswith('.') or ':' in p for p in parts):
            raise ValueError('invalid path')
        return parts

    @contextlib.contextmanager
    def open(self, path, directory=False):
        parts = self.parts(path)
        fd = os.dup(self.fd)
        try:
            for i, part in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if i < len(parts)-1 or directory:
                    flags |= os.O_DIRECTORY
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            mode = os.fstat(fd).st_mode
            if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
                raise ValueError('not a regular file or directory')
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    def scope(scope):
        if scope not in {'personal', 'app'}:
            raise ValueError('invalid scope')
        return scope

    def is_app_data(self, path):
        return any(path == p or path.startswith(p + '/') for p in self.app_data_prefixes)

    def visible(self, path, is_dir, scope):
        classified = self.is_app_data(path)
        if scope == 'personal':
            return not classified
        return classified or (is_dir and (not path or any(p.startswith(path + '/') for p in self.app_data_prefixes)))

    def list(self, path, scope='personal'):
        self.scope(scope)
        self.parts(path)
        result = {'folder': path, 'scope': scope, 'entries': [], 'truncated': False,
                  'upload_allowed': scope == 'personal' and not self.is_app_data(path),
                  'app_data_prefixes': self.app_data_prefixes}
        if not self.visible(path, True, scope):
            return result
        rows = []
        with self.open(path, directory=True) as fd:
            for name in sorted(os.listdir(fd), key=str.casefold):
                if name.startswith('.'):
                    continue
                try:
                    self.parts(name)
                    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except (OSError, ValueError):
                    continue
                if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                    continue
                child = '/'.join(filter(None, [path, name]))
                if not self.visible(child, stat.S_ISDIR(s.st_mode), scope):
                    continue
                rows.append({'name': name, 'path': '/'.join(filter(None, [path, name])), 'is_dir': stat.S_ISDIR(s.st_mode),
                             'size': s.st_size if stat.S_ISREG(s.st_mode) else 0,
                             'mtime': datetime.datetime.fromtimestamp(s.st_mtime, datetime.timezone.utc).isoformat(),
                             'type': kind(name)})
                if len(rows) >= 5000:
                    result.update(entries=rows, truncated=True)
                    return result
        rows.sort(key=lambda r: (not r['is_dir'], r['name'].casefold()))
        result['entries'] = rows
        return result

    def index(self, query='', category='', scope='personal'):
        self.scope(scope)
        # Bounded on-demand walk, never a host index or private database.
        pending, rows, seen, truncated = [''], [], 0, False
        while pending and seen < 10000:
            folder = pending.pop()
            try:
                data = self.list(folder, scope)
            except (OSError, ValueError):
                continue
            truncated |= data['truncated']
            for entry in data['entries']:
                seen += 1
                if seen >= 10000:
                    truncated = True
                    break
                if entry['is_dir']:
                    if len(entry['path'].split('/')) < 32:
                        pending.append(entry['path'])
                    else:
                        truncated = True
                else:
                    rows.append(entry)
        counts = {k: sum(r['type'] == k for r in rows) for k in ['video', 'photo', 'document', 'link', 'audio']}
        selected = [r for r in rows if (not category or r['type'] == category) and query.casefold() in r['path'].casefold()]
        selected.sort(key=lambda r: r['mtime'], reverse=True)
        return {'scope': scope, 'items': selected[:300], 'counts': counts, 'total': len(selected), 'truncated': truncated or bool(pending) or len(selected) > 300}


def kind(name):
    ext = Path(name).suffix.lower()
    if ext in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'}: return 'photo'
    if ext in {'.mp4', '.webm', '.mov', '.m4v'}: return 'video'
    if ext in {'.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac'}: return 'audio'
    if ext in {'.url', '.webloc'}: return 'link'
    return 'document'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # No owner file names in logs.

    def trusted(self):
        host = self.headers.get('Host', '').lower()
        allowed = {'localhost', '127.0.0.1', 'wizard-files'} | set(filter(None, os.getenv('FILES_ALLOWED_HOSTS', '').lower().split(',')))
        hostname = urlsplit('http://' + host).hostname
        if hostname not in allowed:
            self.error(421, 'untrusted_host'); return False
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.error(403, 'cross_site'); return False
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc.lower() != host:
            self.error(403, 'untrusted_origin'); return False
        return True

    def respond(self, status, mime, length, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(length))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'same-origin')
        for k, v in (extra or {}).items(): self.send_header(k, str(v))
        self.end_headers()

    def json(self, status, value):
        body = json.dumps(value).encode()
        self.respond(status, 'application/json', len(body))
        if self.command != 'HEAD': self.wfile.write(body)

    def error(self, status, error):
        self.json(status, {'error': error})

    def do_HEAD(self): self.do_GET()

    def do_GET(self):
        if not self.trusted(): return
        parsed = urlsplit(self.path)
        q = {k: v[-1] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
        try:
            if parsed.path == '/health':
                return self.json(200, {'ok': True, 'version': VERSION})
            if parsed.path == '/api/files':
                if set(q) - {'folder', 'scope'}: return self.error(400, 'unknown_parameter')
                return self.json(200, self.server.root.list(q.get('folder', ''), q.get('scope', 'personal')))
            if parsed.path == '/api/index':
                if set(q) - {'q', 'type', 'scope'}: return self.error(400, 'unknown_parameter')
                return self.json(200, self.server.root.index(q.get('q', ''), q.get('type', ''), q.get('scope', 'personal')))
            if parsed.path == '/api/files/content':
                if set(q) - {'path', 'download'}: return self.error(400, 'unknown_parameter')
                with self.server.root.open(q.get('path', '')) as fd:
                    return self.content(fd, q.get('path', ''), q.get('download') == '1')
            name = parsed.path.removeprefix('/') or 'index.html'
            if name not in ASSETS: return self.error(404, 'not_found')
            body = (Path(__file__).parent / name).read_bytes()
            self.respond(200, mimetypes.guess_type(name)[0] or 'application/octet-stream', len(body))
            if self.command != 'HEAD': self.wfile.write(body)
        except (ValueError, OSError) as e:
            self.error(404 if isinstance(e, FileNotFoundError) else 400, 'unavailable_or_unsafe_path')
        except (BrokenPipeError, ConnectionResetError):
            pass

    def content(self, fd, name, download):
        size = os.fstat(fd).st_size
        mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
        safe = mime.startswith(('image/', 'video/', 'audio/')) and mime != 'image/svg+xml' or mime in {'text/plain', 'application/pdf'}
        if not safe: mime = 'application/octet-stream'
        disposition = 'attachment' if download or not safe else 'inline'
        extra = {'Content-Disposition': f"{disposition}; filename*=UTF-8''{quote(Path(name).name)}", 'Accept-Ranges': 'bytes',
                 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'"}
        start, end, status_code = 0, size-1, 200
        value = self.headers.get('Range')
        if value:
            m = re.fullmatch(r'bytes=(\d*)-(\d*)', value)
            if not m or not any(m.groups()) or not size:
                return self.error(416, 'invalid_range')
            a, b = m.groups()
            start = int(a) if a else max(0, size-int(b))
            end = min(int(b), size-1) if a and b else size-1
            if start > end or start >= size: return self.error(416, 'invalid_range')
            extra['Content-Range'] = f'bytes {start}-{end}/{size}'
            status_code = 206
        remaining = max(0, end-start+1)
        self.respond(status_code, mime, remaining, extra)
        if self.command == 'HEAD': return
        os.lseek(fd, start, os.SEEK_SET)
        while remaining:
            data = os.read(fd, min(262144, remaining))
            if not data: break
            self.wfile.write(data); remaining -= len(data)

    def do_POST(self):
        if not self.trusted(): return
        if self.path != '/mcp': return self.error(405, 'uploads_use_wizard_transfer_service')
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n < 1 or n > 65536: return self.error(413, 'request_too_large')
            req = json.loads(self.rfile.read(n))
            method, params = req.get('method'), req.get('params', {})
            if method == 'notifications/initialized':
                self.respond(202, 'application/json', 0); return
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'wizard-files', 'version': VERSION}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'files_list', 'description': 'List relative folders. Defaults to personal files; app scope explicitly includes configured app data.', 'inputSchema': {'type': 'object', 'properties': {'folder': {'type': 'string'}, 'scope': {'type': 'string', 'enum': ['personal', 'app']}}, 'additionalProperties': False}}, {'name': 'files_search', 'description': 'Search names in personal files (default) or configured app data.', 'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}, 'scope': {'type': 'string', 'enum': ['personal', 'app']}}, 'additionalProperties': False}}]}
            elif method == 'tools/call':
                args = params.get('arguments', {})
                if params.get('name') == 'files_list': data = self.server.root.list(args.get('folder', ''), args.get('scope', 'personal'))
                elif params.get('name') == 'files_search': data = self.server.root.index(args.get('query', ''), scope=args.get('scope', 'personal'))
                else: raise ValueError('unknown tool')
                result = {'content': [{'type': 'text', 'text': json.dumps(data)}]}
            else: raise ValueError('unknown method')
            self.json(200, {'jsonrpc': '2.0', 'id': req.get('id'), 'result': result})
        except (ValueError, OSError, TypeError):
            self.error(400, 'invalid_or_unsafe_request')

if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT', '8080'))), Handler)
    server.root = Root(os.getenv('FILES_ROOT', '/files'), json.loads(os.getenv('FILES_APP_DATA_PREFIXES', '[]')))
    server.serve_forever()
