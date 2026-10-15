"""Bounded reader of the one trusted photo projection; never opens history stores."""
import datetime
import hashlib
import json
import os
import re
import stat
import threading

MAX_MANIFEST = 8 * 1024 * 1024
MAX_PHOTO = 32 * 1024 * 1024
HASH_BUDGET = 128 * 1024 * 1024


def text(value, maximum=160):
    return isinstance(value, str) and 0 < len(value) <= maximum and not any(ord(c) < 32 or ord(c) == 127 for c in value)


def timestamp(value):
    if not text(value, 64):
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            return None
        return dt.astimezone(datetime.timezone.utc).isoformat()
    except ValueError:
        return None


class PhotoProvenance:
    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.hashes = {}

    def manifest(self):
        # This is the only exception to the public hidden-path exclusion. Both
        # components are fixed literals, descriptor-relative and no-follow.
        directory = os.open('.wizard', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.root.fd)
        try:
            fd = os.open('photo-provenance.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                s = os.fstat(fd)
                if not stat.S_ISREG(s.st_mode) or s.st_size > MAX_MANIFEST:
                    raise ValueError('manifest bounds')
                with os.fdopen(os.dup(fd), 'rb') as f:
                    raw = f.read(MAX_MANIFEST + 1)
                if len(raw) > MAX_MANIFEST:
                    raise ValueError('manifest bounds')
                doc = json.loads(raw)
            finally:
                os.close(fd)
        finally:
            os.close(directory)
        if not isinstance(doc, dict) or type(doc.get('schema')) is not int or doc['schema'] != 1:
            raise ValueError('schema')
        if not text(doc.get('owner_label')) or not isinstance(doc.get('agent_labels'), dict) or len(doc['agent_labels']) > 128:
            raise ValueError('labels')
        if not all(text(k, 128) and text(v) for k, v in doc['agent_labels'].items()):
            raise ValueError('agent labels')
        if not isinstance(doc.get('files'), list) or len(doc['files']) > 10000:
            raise ValueError('files bounds')
        return doc

    def enrich(self, rows):
        with self.lock:
            return self._enrich(rows)

    def _enrich(self, rows):
        photos = {r['path']: r for r in rows if r['type'] == 'photo'}
        metadata = {'available': False, 'owner_label': 'you', 'agent_labels': {}, 'partial': False, 'pending': 0}
        for row in photos.values():
            row.update(sources=[], senders=['unknown'])
        try:
            doc = self.manifest()
        except (OSError, ValueError, TypeError, RecursionError):
            return metadata
        metadata.update(available=True, owner_label=doc['owner_label'], agent_labels=doc['agent_labels'])
        budget = HASH_BUDGET
        for entry in doc['files']:
            if not isinstance(entry, dict):
                continue
            path, expected, sources = entry.get('path'), entry.get('sha256'), entry.get('sources')
            if not isinstance(path, str) or path not in photos or not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
                continue
            if not isinstance(sources, list) or not sources or len(sources) > 512:
                continue
            safe = []
            for source in sources:
                if not isinstance(source, dict) or not isinstance(source.get('role'), str) or source['role'] not in {'user', 'assistant'}:
                    continue
                agent = source.get('agent_id')
                if not text(agent, 128) or agent not in doc['agent_labels'] or not text(source.get('sender_label')):
                    continue
                if not all(text(source.get(k), 256) for k in ('thread_id', 'message_id')):
                    continue
                sent = timestamp(source.get('sent_at'))
                if sent is None:
                    continue
                # UI never needs the private thread/message identifiers.
                safe.append({'role': source['role'], 'agent_id': agent, 'sender_label': source['sender_label'], 'sent_at': sent})
            if not safe:
                continue
            try:
                with self.root.open(path) as fd:
                    s = os.fstat(fd)
                    key = (path, s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                    digest = self.hashes.get(key)
                    if digest is None:
                        if s.st_size > MAX_PHOTO:
                            continue  # permanently outside bounds, not retryable
                        if s.st_size > budget:
                            metadata['partial'] = True
                            photos[path]['senders'] = []
                            photos[path]['verification_pending'] = True
                            continue
                        budget -= s.st_size
                        h = hashlib.sha256()
                        remaining = s.st_size
                        while remaining:
                            data = os.read(fd, min(262144, remaining))
                            if not data:
                                break
                            h.update(data)
                            remaining -= len(data)
                        after = os.fstat(fd)
                        if remaining or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (s.st_size, s.st_mtime_ns, s.st_ctime_ns):
                            continue
                        digest = h.hexdigest()
                        if len(self.hashes) >= 10000:
                            self.hashes.clear()
                        self.hashes[key] = digest
                    if digest != expected:
                        continue
            except (OSError, ValueError):
                continue
            row = photos[path]
            row.pop('verification_pending', None)
            row['sources'].extend(v for v in safe if v not in row['sources'])
            row['senders'] = sorted({'owner' if v['role'] == 'user' else 'agent:' + v['agent_id'] for v in row['sources']})
            row['sent_at'] = max(v['sent_at'] for v in row['sources'])
        metadata['pending'] = sum(bool(r.get('verification_pending')) for r in photos.values())
        metadata['partial'] = metadata['pending'] > 0
        return metadata
