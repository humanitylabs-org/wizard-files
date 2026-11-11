"""Read-only, descriptor-relative owner-files server. Uploads belong to Wizard's transfer service."""
import contextlib
import datetime
import errno
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
from provenance import PhotoProvenance
from thumbnails import ThumbnailCache, identity
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit, quote

VERSION = '0.1.6'
ASSETS = {'index.html', 'media-gallery.js', 'app.js', 'my-files.js', 'styles.css', 'my-files.css', 'restyle.css', 'integration.css', 'icon.png'}

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
        self.provenance = PhotoProvenance(self)
        self.thumbnails = ThumbnailCache(os.getenv('FILES_CACHE_DIR', '/data/cache/thumbnails'))

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
                             'type': kind(name),
                             'identity': f'{s.st_dev}:{s.st_ino}:{s.st_size}:{s.st_mtime_ns}:{s.st_ctime_ns}'})
                if len(rows) >= 5000:
                    result.update(entries=rows, truncated=True)
                    return result
        rows.sort(key=lambda r: (not r['is_dir'], r['name'].casefold()))
        result['entries'] = rows
        return result

    def index(self, query='', category='', scope='personal', sender='', offset=0, limit=120, snapshot=''):
        def page_number(value, low, high):
            if type(value) not in (int, str) or not re.fullmatch(r'0|[1-9][0-9]{0,4}', str(value)) or not low <= int(value) <= high:
                raise ValueError('invalid pagination')
            return int(value)
        offset, limit = page_number(offset, 0, 10000), page_number(limit, 1, 300)
        if not isinstance(snapshot, str) or (snapshot and not re.fullmatch('[a-f0-9]{64}', snapshot)):
            raise ValueError('invalid snapshot')
        if not isinstance(sender, str) or len(sender) > 134 or (sender not in {'', 'owner', 'unknown'} and not sender.startswith('agent:')):
            raise ValueError('invalid sender')
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
        provenance = self.provenance.enrich(rows)
        matching = [r for r in rows if (not category or r['type'] == category) and query.casefold() in r['path'].casefold()]
        sender_counts = {key: sum(key in r.get('senders', []) for r in matching) for key in ['owner', *['agent:' + a for a in provenance['agent_labels']], 'unknown']}
        selected = [r for r in matching if not sender or sender in r.get('senders', [])]
        selected.sort(key=lambda r: (r.get('sent_at', r['mtime']), r['path']), reverse=True)
        # Bind pages to verified ordering; changed libraries restart without gaps.
        signature = [scope, query, category, sender, [(r['path'], r['identity'], r.get('sent_at'), r.get('senders')) for r in selected]]
        current = hashlib.sha256(json.dumps(signature, separators=(',', ':')).encode()).hexdigest()
        reset = bool(snapshot and snapshot != current)
        if reset:
            offset = 0
        items = selected[offset:offset + limit]
        more = offset + len(items) < len(selected)
        return {'scope': scope, 'items': items, 'counts': counts, 'provenance': provenance, 'sender_counts': sender_counts,
                'total': len(selected), 'truncated': truncated or bool(pending), 'offset': offset, 'limit': limit,
                'has_more': more, 'next_offset': offset + len(items) if more else None, 'snapshot': current, 'reset': reset}


def kind(name):
    ext = Path(name).suffix.lower()
    if ext in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'}: return 'photo'
    if ext in {'.mp4', '.webm', '.mov', '.m4v'}: return 'video'
    if ext in {'.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac'}: return 'audio'
    if ext in {'.url', '.webloc'}: return 'link'
    return 'document'


def allowed_hosts(env=os.environ):
    """Hostnames this listener answers. Loopback and the service name always; FILES_ALLOWED_HOSTS is optional
    extra hostnames; WIZARD_TRUSTED_HOSTS is the box's own address, written by the App Manager at install and
    update (entries may carry a port, e.g. `box.tailnet.ts.net:443`). A Store install has no form to fill, so
    the box address must come from the App Manager rather than a required setting."""
    out = {'localhost', '127.0.0.1', 'wizard-files'}
    for var in ('FILES_ALLOWED_HOSTS', 'WIZARD_TRUSTED_HOSTS'):
        for item in env.get(var, '').lower().split(','):
            item = item.strip()
            if not item or '/' in item or '@' in item:
                continue
            try:
                name = urlsplit('http://' + item).hostname
            except ValueError:
                continue
            if name:
                out.add(name)
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # No owner file names in logs.

    def trusted(self):
        host = self.headers.get('Host', '').lower()
        allowed = allowed_hosts()
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
        if not extra or 'Cache-Control' not in extra:
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
                if set(q) - {'q', 'type', 'scope', 'sender', 'offset', 'limit', 'snapshot'}: return self.error(400, 'unknown_parameter')
                return self.json(200, self.server.root.index(q.get('q', ''), q.get('type', ''), q.get('scope', 'personal'), q.get('sender', ''), q.get('offset', 0), q.get('limit', 120), q.get('snapshot', '')))
            if parsed.path == '/api/files/thumbnail':
                if set(q) - {'path', 'v'}: return self.error(400, 'unknown_parameter')
                name = q.get('path', '')
                if kind(name) not in {'photo', 'video'}: return self.error(415, 'preview_unavailable')
                with self.server.root.open(name) as fd:
                    try:
                        body, key = self.server.root.thumbnails.get(fd, name, q.get('v', ''))
                    except BlockingIOError:
                        return self.error(503, 'preview_busy')
                    except ValueError:
                        return self.error(415, 'preview_unavailable')
                extra = {'Cache-Control': 'private, max-age=300, must-revalidate', 'ETag': '"' + key + '"', 'Vary': 'Cookie, Authorization'}
                if self.headers.get('If-None-Match') == extra['ETag']:
                    return self.respond(304, 'image/jpeg', 0, extra)
                self.respond(200, 'image/jpeg', len(body), extra)
                if self.command != 'HEAD': self.wfile.write(body)
                return
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
        # Always re-authorize at the gateway and re-stat the confined descriptor;
        # private clients can reuse unchanged bytes without mutable-path freshness leaks.
        extra.update({'Cache-Control': 'private, no-cache', 'ETag': '"' + hashlib.sha256((name + ':' + identity(os.fstat(fd))).encode()).hexdigest() + '"', 'Vary': 'Cookie, Authorization'})
        if self.headers.get('If-None-Match') == extra['ETag'] and not self.headers.get('Range'):
            return self.respond(304, mime, 0, extra)
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

# ---- wizard.app-switches/1 ------------------------------------------------------------------------------------------
# Owner feature switches for the Tracker's Try it (wizard-os docs/APP_SWITCHES.md). Shared block: the same text ships in
# every Wizard app (template: wizard-app-manager templates/hello-wizard). Every new feature ships behind a switch, off by
# default: append it to SWITCHES with the issue it delivers, e.g.
#   {'id': 'compact-header', 'name': 'Compact top bar', 'description': '...', 'default': False,
#    'issues': ['humanitylabs-org/<repo>#20']}
# and gate the feature on switch_on('compact-header'). State lives on the box (DATA_DIR/switches.json), so the app's
# page, the Tracker (through the App Manager) and the agent see one state. GET/POST /api/switches, owner only: the
# box's Tailscale Serve owner login with X-Wizard-Switch: 1; never a bearer, agent grant or box-local host.
import json as _sw_json
import os as _sw_os
import re as _sw_re
import threading as _sw_threading
from pathlib import Path as _SwPath
from urllib.parse import urlsplit as _sw_urlsplit

SWITCHES = []
_SW_CONTRACT = 'wizard.app-switches/1'
_SW_ROUTE = _sw_re.compile(r'(?:/[a-z0-9][a-z0-9-]{0,62})?/api/switches/?')
_SW_LOCAL = {'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'}
_sw_lock = _sw_threading.Lock()


def _sw_file():
    return _SwPath(_sw_os.environ.get('WIZARD_SWITCHES_DIR') or _sw_os.environ.get('DATA_DIR') or '/data') / 'switches.json'


def _sw_saved():
    try:
        saved = _sw_json.loads(_sw_file().read_text())
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def switches_doc():
    saved = _sw_saved()
    return {'contract': _SW_CONTRACT, 'switches': [
        dict(s, on=saved[s['id']] if isinstance(saved.get(s['id']), bool) else bool(s.get('default'))) for s in SWITCHES]}


def switch_on(switch_id):
    return next((s['on'] for s in switches_doc()['switches'] if s['id'] == switch_id), False)


def _sw_set(switch_id, on):
    with _sw_lock:
        ids = {s['id'] for s in SWITCHES}
        saved = {k: v for k, v in _sw_saved().items() if k in ids and isinstance(v, bool)}
        saved[switch_id] = on
        f = _sw_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + '.tmp')
        tmp.write_text(_sw_json.dumps(saved))
        _sw_os.replace(tmp, f)
    return switches_doc()


def _sw_owner(h, write):
    hd = h.headers
    if hd.get('Authorization') or hd.get('X-Wizard-Switch') != '1':
        return False
    if (hd.get('Sec-Fetch-Site') or 'same-origin').lower() not in ('same-origin', 'none'):
        return False
    host = (hd.get('Host') or '').strip().lower()
    name = host.split(']')[0] + ']' if host.startswith('[') else host.rsplit(':', 1)[0]
    if not name or name in _SW_LOCAL or '.' not in name:      # box-local and container hosts never prove the owner
        return False
    origin = hd.get('Origin')
    trusted = {o.strip() for o in (_sw_os.environ.get('WIZARD_TRUSTED_ORIGINS') or '').split(',') if o.strip()}
    if origin and _sw_urlsplit(origin).netloc.lower() != host and origin not in trusted:
        return False
    if write and not origin:
        return False
    logins = [x.strip() for x in (hd.get_all('Tailscale-User-Login') or [])]
    owners = {x.strip().lower() for x in (_sw_os.environ.get('WIZARD_OWNER_LOGINS') or '').split(',') if x.strip()}
    return len(logins) == 1 and '@' in logins[0] and (not owners or logins[0].lower() in owners)


def _sw_send(h, code, doc):
    body = _sw_json.dumps(doc).encode()
    h.send_response(code)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(body)))
    h.end_headers()
    if h.command != 'HEAD':
        h.wfile.write(body)


def _sw_handle(h):
    """Serve /api/switches (or /<app>/api/switches) and return True; False for every other request."""
    if not _SW_ROUTE.fullmatch(_sw_urlsplit(h.path).path):
        return False
    if h.command in ('GET', 'HEAD'):
        if not _sw_owner(h, False):
            _sw_send(h, 403, {'error': "Only this Wizard's owner can see these switches.", 'code': 'owner_only'})
        else:
            _sw_send(h, 200, switches_doc())
        return True
    if not _sw_owner(h, True):
        _sw_send(h, 403, {'error': "Only this Wizard's owner can change these switches.", 'code': 'owner_only'})
        return True
    try:
        if (h.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json':
            raise ValueError
        size = int(h.headers.get('Content-Length') or '0')
        if size <= 0 or size > 4096:
            raise ValueError
        body = _sw_json.loads(h.rfile.read(size))
        if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not isinstance(body.get('on'), bool) \
                or set(body) - {'id', 'on'}:
            raise ValueError
    except (ValueError, TypeError):
        _sw_send(h, 400, {'error': 'Send JSON {"id": "...", "on": true|false}', 'code': 'invalid_input'})
        return True
    if body['id'] not in {s['id'] for s in SWITCHES}:
        _sw_send(h, 404, {'error': 'No such switch', 'code': 'unknown_switch'})
        return True
    try:
        _sw_send(h, 200, _sw_set(body['id'], body['on']))
    except OSError:
        _sw_send(h, 500, {'error': 'storage_failure'})
    return True


def wizard_switches_install(handler_cls):
    """Route the switch endpoint ahead of the app's own GET/HEAD/POST handlers."""
    for method in ('do_GET', 'do_HEAD', 'do_POST'):
        orig = getattr(handler_cls, method, None)
        if getattr(orig, '_wizard_switches', False):
            continue

        def wrapped(self, _orig=orig):
            if _sw_handle(self):
                return None
            if _orig is None:
                return self.send_error(501)
            return _orig(self)
        wrapped._wizard_switches = True
        setattr(handler_cls, method, wrapped)
    return handler_cls
# ---- end wizard.app-switches/1 ---------------------------------------------------------------------------------------

wizard_switches_install(Handler)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT', '8080'))), Handler)
    server.root = Root(os.getenv('FILES_ROOT', '/files'), json.loads(os.getenv('FILES_APP_DATA_PREFIXES', '[]')))
    server.serve_forever()
