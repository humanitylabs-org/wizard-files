/* Files data: one place for every read, preview and upload, in both modes.
 *
 * Normal Wizard (same origin): this app's own api/ (listing, search, thumbnails, Range reads) and the box's resumable
 * upload service (/wizard/v1/uploads), exactly as before.
 *
 * Browser boundary (WIZARD_BROWSER_BOUNDARY, default off; wizard-os #385/#386): the shell runs this page in an opaque
 * sandboxed frame (origin "null") with no direct API. Everything goes through the shell's typed, owner-granted
 * operations instead (the Agent Service checks the installation and grant on every call):
 *   files.list / files.index / files.thumbnail  (WizardApp.data.call)
 *   files.content                               (WizardApp.media.open: a 60 s Range-capable read ticket for <video>,
 *                                                <img>, <audio>; renewed through the same binding when it lapses)
 *   download / open                             (WizardApp.download.request: the shell saves or opens the file)
 *   upload port                                 (WizardApp.upload.*: create, 1 MiB chunks with a SHA-256 each, one
 *                                                outstanding, status after an uncertain reply, commit with the whole
 *                                                file's SHA-256, abort). The same offset/backoff/resume loop as before.
 * Files are named by the opaque resource id the listing returned, never a path or URL.
 */
'use strict';
(() => {
  const opaque = (() => { try { return parent !== window && self.origin === 'null'; } catch (_) { return true; } })();
  const API = new URL('api/files', location.href).pathname;
  const INDEX = new URL('api/index', location.href).pathname;
  const UPLOADS = '/wizard/v1/uploads';
  const coded = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);
  let connecting = null;
  function connected() {
    if (window.WizBoundaryClient?.ready) return Promise.resolve();
    if (!window.WizBoundaryClient || !window.WizardApp?.data) return Promise.reject(coded('unavailable'));
    return connecting ||= new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connecting = null; reject(coded('timeout')); }, 10000);
      addEventListener('wizard:boundary:connected', () => { clearTimeout(timer); connecting = null; resolve(); }, { once: true });
    });
  }
  const STATUS = { not_found: 404, bad_request: 400, not_allowed: 403, revoked: 403, stale_binding: 403, backend_unavailable: 503, unsupported_capability: 503 };
  async function op(operation, args) { await connected(); return window.WizardApp.data.call({ operation, args }); }

  /** {status, data}: status mirrors the HTTP answer the page already handles (200, 404, 503, 0 = unreachable). */
  async function list(folder, scope, signal) {
    if (!opaque) {
      try {
        const r = await fetch(`${API}?folder=${encodeURIComponent(folder)}&scope=${scope}`, { cache: 'no-store', credentials: 'same-origin', signal });
        return { status: r.status, data: r.ok ? await r.json() : null };
      } catch (e) { if (signal?.aborted) throw e; return { status: 0, data: null }; }
    }
    try { return { status: 200, data: await op('files.list', { folder, scope }) }; }
    catch (e) { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); return { status: STATUS[e.code] || 0, data: null, code: e.code }; }
  }
  async function index(params, signal) {
    if (!opaque) {
      const r = await fetch(INDEX + '?' + new URLSearchParams(params), { cache: 'no-store', signal });
      if (!r.ok) throw coded('http_' + r.status);
      return r.json();
    }
    const value = await op('files.index', { q: String(params.q || ''), type: String(params.type || ''), scope: params.scope === 'app' ? 'app' : 'personal',
      sender: String(params.sender || ''), offset: Number(params.offset) || 0, limit: Number(params.limit) || 120, snapshot: String(params.snapshot || '') });
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    return value;
  }
  /** A thumbnail as a Response (the gallery decodes it either way). Throws {code:'busy'} while the box is busy. */
  async function thumbnail(item, signal, sameOriginUrl) {
    if (!opaque) return fetch(sameOriginUrl, { signal, credentials: 'same-origin', priority: 'low' });
    if (!item.resource) return new Response(null, { status: 415 });
    try {
      const v = await op('files.thumbnail', { resourceId: item.resource });
      const bin = atob(v.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(new Blob([bytes], { type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    } catch (e) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      return new Response(null, { status: e.code === 'busy' || e.code === 'quota_exceeded' ? 503 : e.code === 'not_found' ? 415 : 502 });
    }
  }
  const contentUrl = (path, download = false) => `${API}/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  /** A media source for this file: the app's own route, or a short-lived read ticket ({url, expiresAt}). */
  async function media(item, purpose = 'read') {
    if (!opaque) return { url: contentUrl(item.path), expiresAt: Infinity };
    if (!item.resource) throw coded('not_found');
    await connected();
    const t = await window.WizardApp.media.open({ resourceId: item.resource, purpose: purpose === 'play' ? 'play' : 'read' });
    return { url: t.url, expiresAt: Date.parse(t.expiresAt) || 0 };
  }
  /**
   * Point a <video>/<audio>/<img> at the file and keep it playable past its ticket (60 s on a box): when the element
   * needs bytes again (a seek, a stall, a failed load) after the ticket lapsed, take a fresh one through the same
   * binding and carry on at the same time and play state. Bounded by the Service's renewal budget (10 a minute,
   * 8 hours a binding); a refusal leaves the element as it is.
   */
  function attach(el, item, purpose) {
    if (!opaque) { el.src = contentUrl(item.path); return; }
    let expires = 0, renewing = null, renewals = 0, alive = true, target = null;
    const load = async at => {
      try {
        const m = await media(item, purpose);
        if (!alive || !el.isConnected) return;
        const playing = 'paused' in el && !el.paused;
        expires = m.expiresAt; el.src = m.url;
        if ('currentTime' in el && at) el.addEventListener('loadedmetadata', () => { try { el.currentTime = target ?? at; } catch (_) {} target = null; if (playing) el.play?.().catch(() => {}); }, { once: true });
      } catch (_) { el.dispatchEvent(new CustomEvent('wizard-files:media-unavailable')); }
    };
    const renew = () => {
      if (!alive || renewing || renewals >= 600 || !el.getAttribute('src')) return;
      renewals++;
      const at = 'currentTime' in el ? el.currentTime : 0;
      renewing = load(at).finally(() => { renewing = null; });
    };
    const lapsed = () => Date.now() >= expires - 1500;
    // A seek after the ticket lapsed: renew right away (the old URL would only answer 410 and the browser retries it).
    el.addEventListener('seeking', () => { if (lapsed()) { target = el.currentTime; renew(); } });
    for (const type of ['waiting', 'stalled']) el.addEventListener(type, () => { if (lapsed()) renew(); });
    el.addEventListener('error', renew);
    el.addEventListener('wizard-files:release', () => { alive = false; }, { once: true });
    load(0);
  }
  /** Download or open in a new tab. Same origin: a plain link. Boundary: the shell saves/opens (owner action only). */
  async function transfer(item, action) {
    await connected();
    return window.WizardApp.download.request({ resourceId: item.resource, action });
  }

  // ---- uploads ---------------------------------------------------------------------------------------------------
  // Incremental SHA-256 (the commit carries the whole file's hash; crypto.subtle has no streaming digest).
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256() {
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const W = new Uint32Array(64), buf = new Uint8Array(64); let fill = 0, total = 0;
    const block = (b, o) => {
      for (let i = 0; i < 16; i++) W[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const x = W[i - 15], y = W[i - 2];
        W[i] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + W[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + W[i - 16];
      }
      let a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b2) ^ (a & c) ^ (b2 & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b2; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    };
    return {
      update(bytes) {
        let i = 0; total += bytes.length;
        if (fill) { while (fill < 64 && i < bytes.length) buf[fill++] = bytes[i++]; if (fill === 64) { block(buf, 0); fill = 0; } }
        for (; i + 64 <= bytes.length; i += 64) block(bytes, i);
        while (i < bytes.length) buf[fill++] = bytes[i++];
      },
      hex() {
        const bits = total * 8, pad = new Uint8Array(((fill < 56 ? 56 : 120) - fill) + 8); pad[0] = 0x80;
        const v = new DataView(pad.buffer); v.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32)); v.setUint32(pad.length - 4, bits >>> 0);
        this.update(pad);
        return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
      },
    };
  }
  const hexOf = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  async function digest(bytes) {
    try { if (crypto.subtle) return hexOf(await crypto.subtle.digest('SHA-256', bytes)); } catch (_) {}
    const h = sha256(); h.update(new Uint8Array(bytes)); return h.hex();
  }
  async function fileHash(file, signal) {
    const h = sha256();
    for (let at = 0; at < file.size; at += 4 * 1048576) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      h.update(new Uint8Array(await file.slice(at, at + 4 * 1048576).arrayBuffer()));
    }
    return h.hex();
  }
  const uuid = () => { try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (_) {} const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  // Boundary error code -> the HTTP status the existing loop already understands (0 = transient, reconcile).
  const UPLOAD_STATUS = { offset_mismatch: 409, conflict: 409, expired: 410, quota_exceeded: 507, too_large: 413, integrity: 422, not_found: 404, not_allowed: 403, revoked: 403, stale_binding: 403, bad_request: 400 };
  const uploadReply = e => ({ status: UPLOAD_STATUS[e?.code] || 0, j: { error: e?.code === 'quota_exceeded' ? 'insufficient_storage' : e?.code === 'integrity' ? 'sha256_mismatch' : e?.code || '', ...(Number.isSafeInteger(e?.offset) ? { offset: e.offset } : {}) } });
  /**
   * The upload transport. Same-origin: the box's /wizard/v1/uploads routes. Boundary: the shell's upload port. Every
   * method answers {status, j[, offset]} so the page's one resumable loop (create, chunks from the server's offset,
   * 409 resume, backoff, reconcile, complete) runs unchanged on either.
   */
  const uploads = opaque ? {
    port: true,
    async create(body, signal) {
      try {
        await connected();
        const v = await window.WizardApp.upload.create({ folder: body.destination.folder, filename: body.filename, mime: body.mime, bytes: body.bytes, clientUploadId: body.client_upload_id });
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        return { status: 201, j: { upload_id: v.uploadId, offset: v.offset, chunk_bytes: v.chunkBytes, status: v.status === 'committed' ? 'complete' : 'uploading' } };
      } catch (e) { if (e?.name === 'AbortError') throw e; return uploadReply(e); }
    },
    async status(id) {
      try { const v = await window.WizardApp.upload.status({ uploadId: id }); return { status: 200, j: { offset: v.offset, status: v.status === 'committed' ? 'complete' : v.status === 'open' ? 'uploading' : 'failed' } }; }
      catch (e) { return uploadReply(e); }
    },
    async patch(id, blob, offset, onBytes, signal) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      try {
        const bytes = await blob.arrayBuffer(), sha = await digest(bytes);
        const v = await window.WizardApp.upload.chunk({ uploadId: id, offset, sha256: sha, bytes });
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        onBytes(blob.size);
        return { status: 204, offset: v.offset, j: {} };
      } catch (e) { if (e?.name === 'AbortError') throw e; return uploadReply(e); }
    },
    async complete(id, file, signal) {
      try {
        const sha = await fileHash(file, signal);
        const v = await window.WizardApp.upload.commit({ uploadId: id, sha256: sha, operationKey: uuid() });
        return { status: 200, j: { file: { path: v.path, folder: v.folder, filename: v.name, bytes: v.bytes } } };
      } catch (e) { if (e?.name === 'AbortError') throw e; return uploadReply(e); }
    },
    async abort(id) { try { return (await window.WizardApp.upload.abort({ uploadId: id })).status; } catch (_) { return 'unknown'; } },
    // Commit already read the file back through the app (listed, same size).
    async readback() { return true; },
  } : {
    port: false,
    async create(body, signal) { return call('POST', UPLOADS, body, signal); },
    async status(id, signal) { return call('GET', `${UPLOADS}/${encodeURIComponent(id)}`, null, signal); },
    patch(id, blob, offset, onBytes, signal) { return patchXhr(`${UPLOADS}/${encodeURIComponent(id)}`, blob, offset, onBytes, signal); },
    async complete(id, _file, signal) { return call('POST', `${UPLOADS}/${encodeURIComponent(id)}/complete`, {}, signal); },
    async abort() { return 'unknown'; },
    async readback(receipt, bytes) {
      const check = await fetch(`${API}/content?path=${encodeURIComponent(receipt.path)}`, { method: 'HEAD', cache: 'no-store' });
      return check.ok && Number(check.headers.get('Content-Length')) === bytes;
    },
  };
  async function call(method, url, body, signal) {
    try {
      const r = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin', signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) { if (signal?.aborted) throw e; return { status: 0, j: {} }; }
  }
  const STALL_MS = 45000;
  function patchXhr(url, blob, offset, onBytes, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('cancelled', 'AbortError'));
      const x = new XMLHttpRequest();
      let stall = 0, done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(stall); signal.removeEventListener('abort', stop); resolve(v); };
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => { try { x.abort(); } catch (_) {} finish({ status: 0, j: {} }); }, STALL_MS); };
      const stop = () => { done = true; clearTimeout(stall); try { x.abort(); } catch (_) {} reject(new DOMException('cancelled', 'AbortError')); };
      x.open('PATCH', url);
      x.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      x.setRequestHeader('Upload-Offset', String(offset));
      x.upload.onprogress = e => { arm(); onBytes(e.loaded); };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText || '{}'); } catch (_) {} const h = x.getResponseHeader('Upload-Offset'); finish({ status: x.status, offset: h == null || h === '' ? NaN : Number(h), j }); };
      x.onerror = x.ontimeout = () => finish({ status: 0, j: {} });
      x.onabort = () => { if (!done) finish({ status: 0, j: {} }); };
      signal.addEventListener('abort', stop, { once: true });
      arm();
      x.send(blob);
    });
  }
  /**
   * The saved upload queue. Same origin: localStorage. Boundary (no storage in an opaque frame): the app's own
   * persistent state through the shell (WizardApp.state, 64 KiB, this installation only).
   */
  const STORE = 'wizard-files:uploads:v1';
  let stateRevision = null, stateQueue = Promise.resolve();
  const queue = opaque ? {
    async load() {
      try { await connected(); const v = await window.WizardApp.state.read({ area: 'persistent', key: 'uploads' }); stateRevision = v.revision; return v.exists && Array.isArray(v.value) ? v.value : []; }
      catch (_) { return []; }
    },
    save(rows) {
      stateQueue = stateQueue.then(async () => {
        try { await connected(); const v = await window.WizardApp.state.write({ area: 'persistent', key: 'uploads', value: rows.slice(0, 50), ifRevision: stateRevision, operationKey: uuid() }); stateRevision = v.revision; }
        catch (e) { if (e?.code === 'conflict') { try { stateRevision = (await window.WizardApp.state.read({ area: 'persistent', key: 'uploads' })).revision; } catch (_) {} } }
      });
    },
  } : {
    async load() { try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } },
    save(rows) { try { localStorage.setItem(STORE, JSON.stringify(rows)); } catch (_) { /* storage off: resume needs the page to stay open */ } },
  };
  window.WizFilesData = Object.freeze({ opaque, list, index, thumbnail, media, attach, transfer, contentUrl, uploads, queue, _sha256: sha256 });
})();
