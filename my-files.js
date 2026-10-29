/* Files · My files: a folder view of the owner's user-files root with Upload.
 *
 * Listing and reading: scoped /api/files and unchanged same-root /api/files/content.
 * Upload: the same resumable path as chat attachments and the share sheet (/wizard/v1/uploads), with
 * destination {folder}: the folder being browsed, or Inbox/<today> from the top level. Chunks are cut
 * with Blob.slice (nothing is held whole in memory), PATCHed with Upload-Offset, and resumed from the
 * server's offset after a network loss. Upload ids and file identity (name, size, lastModified) are kept
 * in localStorage, so after a reload the user re-picks the same file and it carries on where it stopped.
 *
 * Routes: #/my, #/my/<folder>/<sub>, #/my/<folder>?f=<name> (preview). Back goes: preview → folder →
 * parent folder → My files → Files home (never out of the app).
 */
(() => {
  'use strict';
  const API = new URL('api/files', location.href).pathname;
  const scope = window.WizFilesScope;
  const UPLOADS = '/wizard/v1/uploads';
  const STORE = 'wizard-files:uploads:v1';
  const MIB = 1048576;
  const DEFAULT_CHUNK = 8 * MIB, MIN_CHUNK = 256 * 1024, MAX_CHUNK = 64 * MIB;
  const STALL_MS = 45000;
  const NO_SPACE = 'Not enough space on your Wizard';
  const TOO_LARGE = 'File too large for this Wizard';
  const $ = selector => document.querySelector(selector);
  const els = {
    section: $('#my-files'), crumbs: $('#my-crumbs'), list: $('#my-list'), empty: $('#my-empty'), error: $('#my-error'),
    upload: $('#my-upload'), picker: $('#my-picker'), repick: $('#my-repick'), hint: $('#my-upload-hint'), uploads: $('#my-uploads'),
    sheet: $('#my-sheet'), sheetPreview: $('#my-sheet-preview'), sheetTitle: $('#my-sheet-title'), sheetMeta: $('#my-sheet-meta'),
    sheetActions: $('#my-sheet-actions'), sheetClose: $('#my-sheet .sheet-close'), sheetScrim: $('#my-sheet .sheet-scrim'),
    back: $('#back-button'), title: $('#page-title'), toast: $('#toast'),
  };
  if (!els.section) return;

  // ---- routes ---------------------------------------------------------------------------------------
  const enc = folder => folder.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const hashFor = (folder, file = '') => scope.hash(`#/my${folder ? `/${enc(folder)}` : ''}${file ? `?f=${encodeURIComponent(file)}` : ''}`);
  function route() {
    const raw = (location.hash || '').slice(1);
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'app') parts.shift();
    if (parts[0] !== 'my') return null;
    let folder = '';
    try { folder = parts.slice(1).map(decodeURIComponent).join('/'); } catch (_) { folder = ''; }
    return { folder, file: new URLSearchParams(query).get('f') || '' };
  }
  const parentOf = folder => folder.split('/').slice(0, -1).join('/');
  // In-app steps go through the History API, not bare fragment navigation: a fragment navigation fires a
  // state-less popstate, which the standalone Back guard (WizardApp) reads as a Back press. Forward steps
  // push an entry; Back steps replace the current one, so the history never points back down into a folder.
  // Both app routes use pushState and dispatch hashchange; the shared client owns root Back.
  // A Back step to the entry we came from pops it (history.back) instead of replacing.
  function go(hash, { replace = false } = {}) {
    const here = location.hash || '#/';
    if (hash === here) return;
    const url = location.pathname + location.search + hash;
    if (replace) history.replaceState(history.state, '', url);
    else history.pushState({ wizardFilesRoute: true }, '', url);
    dispatchEvent(new HashChangeEvent('hashchange'));
  }
  /** Where one Back step goes from here (null = not in My files). */
  function backTarget() {
    const r = route();
    if (!r) return null;
    if (r.file) return hashFor(r.folder);
    if (r.folder) return hashFor(parentOf(r.folder));
    return scope.hash('#/');
  }

  // ---- formatting -----------------------------------------------------------------------------------
  const size = bytes => {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < MIB) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * MIB) return `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MB`;
    return `${(bytes / 1024 / MIB).toFixed(2)} GB`;
  };
  const when = iso => { try { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso)); } catch (_) { return ''; } };
  const ext = name => (/\.([A-Za-z0-9]{1,6})$/.exec(name) || [, ''])[1].toLowerCase();
  const kind = name => {
    const e = ext(name);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
    if (['mp4', 'm4v', 'mov', 'webm'].includes(e)) return 'video';
    if (['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac'].includes(e)) return 'audio';
    return 'file';
  };
  const contentUrl = (path, download = false) => `${API}/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  let toastTimer = 0;
  function toast(message) {
    clearTimeout(toastTimer); els.toast.textContent = message; els.toast.classList.add('visible');
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2200);
  }
  const node = (tag, className, text) => { const n = document.createElement(tag); if (className || tag === 'button') n.className = (className || '') + (tag === 'button' ? ' wz-button' + (className === 'primary' ? '' : ' secondary') : ''); if (text != null) n.textContent = text; return n; };

  // ---- listing --------------------------------------------------------------------------------------
  const view = { folder: null, showing: null, entries: [], generation: 0, available: null, uploadAllowed: false };
  async function load(folder) {
    const generation = ++view.generation;
    els.error.hidden = true;
    els.empty.hidden = true;
    els.list.replaceChildren(node('div', 'feed-loading', 'Loading folder…'));
    els.list.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`${API}?folder=${encodeURIComponent(folder)}&scope=${scope.scope()}`, { cache: 'no-store', credentials: 'same-origin' });
      if (generation !== view.generation) return;
      if (response.status === 404) { showError('That folder isn’t there any more.', true); return; }
      if (response.status === 503) { showError('My files isn’t set up on this Wizard yet.'); view.available = false; renderUploadButton(); return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (generation !== view.generation) return;
      view.available = true; view.uploadAllowed = data.upload_allowed === true; renderUploadButton();
      view.folder = folder; view.entries = Array.isArray(data.entries) ? data.entries : [];
      renderList();
      if (data.truncated) showError('This folder is large; showing the first 5,000 entries.');
    } catch (_) {
      if (generation === view.generation) showError('Couldn’t load this folder. Tap to retry.');
    } finally {
      if (generation === view.generation) els.list.setAttribute('aria-busy', 'false');
    }
  }
  function showError(message, toParent = false) {
    els.list.replaceChildren(); els.empty.hidden = true;
    els.error.hidden = false; els.error.textContent = message;
    els.error.onclick = () => { const r = route(); if (!r) return; if (toParent) go(hashFor(parentOf(r.folder)), { replace: true }); else load(r.folder); };
  }
  function renderCrumbs(folder) {
    const parts = folder ? folder.split('/') : [];
    const items = [[scope.label(), '']].concat(parts.map((name, i) => [name, parts.slice(0, i + 1).join('/')]));
    els.crumbs.replaceChildren(...items.flatMap(([name, path], i) => {
      const last = i === items.length - 1;
      const link = node(last ? 'span' : 'a', 'crumb', name);
      if (!last) link.href = hashFor(path); else link.setAttribute('aria-current', 'page');
      return i ? [node('span', 'crumb-sep', '›'), link] : [link];
    }));
  }
  function renderList() {
    const folder = view.folder || '';
    els.list.replaceChildren();
    els.empty.hidden = view.entries.length > 0;
    for (const entry of view.entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      const row = node('a', `item-row my-row ${entry.is_dir ? 'my-folder' : 'my-file'}`);
      row.href = entry.is_dir ? hashFor(path) : hashFor(folder, entry.name);
      row.dataset.name = entry.name;
      const icon = node('span', 'my-icon');
      if (entry.is_dir) icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
      else if (kind(entry.name) === 'image') { WizMediaGallery.thumbnail(icon,{...entry,path,type:'photo'}); }
      else if(kind(entry.name)==='video'){
        row.classList.add('video-card'); WizMediaGallery.thumbnail(icon,{...entry,path});
        row.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();openVideo({...entry,path},row);});
      }else icon.textContent = (ext(entry.name) || 'file').slice(0, 4);
      const copy = node('span', 'item-copy');
      copy.append(node('span', 'item-title', entry.name), node('span', 'item-meta', entry.is_dir ? 'Folder' : [size(entry.size), when(entry.mtime)].filter(Boolean).join(' · ')));
      row.append(icon, copy, node('span', 'my-chevron', entry.is_dir ? '›' : ''));
      els.list.append(row);
    }
  }

  // ---- preview sheet --------------------------------------------------------------------------------
  let overlay = null, directVideo = false, returnFocus = null;
  function stopMedia() {
    for (const media of els.sheetPreview.querySelectorAll('video,audio')) { media.pause(); media.removeAttribute('src'); media.load(); }
  }
  function openVideo(item, trigger) {
    directVideo = true; returnFocus = trigger;
    const parts = item.path.split('/'); const name = parts.pop();
    openSheet(parts.join('/'), name, true);
  }
  function openSheet(folder, name, play = false) {
    stopMedia();
    const path = folder ? `${folder}/${name}` : name;
    const entry = view.entries.find(e => e.name === name && !e.is_dir);
    els.sheetPreview.replaceChildren();
    const k = kind(name);
    if (k === 'image') { const img = node('img'); img.src = contentUrl(path); img.alt = name; els.sheetPreview.append(img); }
    else if (k === 'video') {
      WizMediaGallery.suspend(true);
      const v = node('video'); v.src = contentUrl(path); v.controls = true; v.preload = 'metadata'; v.playsInline = true; v.muted = true; els.sheetPreview.append(v);
      if (play) v.play().catch(() => { /* native controls remain available */ });
    }
    else if (k === 'audio') { const a = node('audio'); a.src = contentUrl(path); a.controls = true; a.preload = 'metadata'; els.sheetPreview.append(a); }
    else els.sheetPreview.append(node('div', 'doc-preview', (ext(name) || 'file').slice(0, 4)));
    els.sheetTitle.textContent = name;
    els.sheetMeta.textContent = [folder ? `${scope.label()} › ${folder.split('/').join(' › ')}` : scope.label(), entry ? size(entry.size) : ''].filter(Boolean).join(' · ');
    const open = node('a', 'primary', 'Open'); open.href = contentUrl(path); open.target = '_blank'; open.rel = 'noopener noreferrer';
    const download = node('a', '', 'Download'); download.href = contentUrl(path, true);
    els.sheetActions.replaceChildren(open, download);
    if(k==='video'){
      const full=node('button','primary','Fullscreen');full.type='button';
      full.onclick=()=>{const v=els.sheetPreview.querySelector('video');if(v.requestFullscreen)v.requestFullscreen().catch(()=>toast('Fullscreen unavailable'));else if(v.webkitEnterFullscreen)v.webkitEnterFullscreen();else toast('Fullscreen unavailable');};
      els.sheetActions.prepend(full);
    }
    els.sheet.hidden = false; document.body.style.overflow = 'hidden';
    if (!overlay && window.WizardApp?.back?.push) overlay = window.WizardApp.back.push(() => { closeSheet(); return true; });
    setTimeout(() => els.sheetClose.focus(), 0);
  }
  function hideSheet() {
    els.sheet.hidden = true; document.body.style.overflow = '';
    stopMedia(); els.sheetPreview.replaceChildren();
    WizMediaGallery.suspend(false);
    directVideo=false;returnFocus?.focus({preventScroll:true});returnFocus=null;
    if (overlay) { const o = overlay; overlay = null; try { o.release(); } catch (_) {} }
  }
  function closeSheet() { if(directVideo){hideSheet();return;} const r = route(); if (r && r.file) go(hashFor(r.folder), { replace: true }); else hideSheet(); }
  els.sheetClose.addEventListener('click', closeSheet);
  els.sheetScrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.sheet.hidden) closeSheet(); });

  // ---- uploads: persisted queue ---------------------------------------------------------------------
  const jobs = new Map(); // key → job (live state; File handles only in memory)
  const saved = () => { try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  function persist() {
    const rows = [...jobs.values()].filter(j => !['done', 'cancelled'].includes(j.state) && j.state !== 'failed').map(j => ({
      key: j.key, client_upload_id: j.clientId, upload_id: j.uploadId || '', name: j.name, size: j.size, lastModified: j.lastModified,
      type: j.type, folder: j.folder, created: j.created,
    }));
    try { localStorage.setItem(STORE, JSON.stringify(rows)); } catch (_) { /* storage off: resume needs the page to stay open */ }
  }
  const newId = () => 'files-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
  let hold = null;
  const activeCount = () => [...jobs.values()].filter(j => ['waiting', 'uploading', 'reconnecting', 'finishing'].includes(j.state)).length;
  function syncHold() {
    if (activeCount() && !hold && window.WizardApp?.update?.hold) { try { hold = window.WizardApp.update.hold('Uploading files'); } catch (_) { hold = null; } }
    if (!activeCount() && hold) { try { hold.release(); } catch (_) {} hold = null; }
  }
  addEventListener('beforeunload', e => { if (activeCount()) { e.preventDefault(); e.returnValue = ''; } });

  function addJob(file, folder) {
    const job = { key: newId(), clientId: newId(), uploadId: '', file, name: file.name || 'upload', size: file.size, lastModified: file.lastModified || 0,
      type: file.type || 'application/octet-stream', folder, created: Date.now(), state: 'waiting', sent: 0, message: '', controller: null, result: null };
    jobs.set(job.key, job);
    persist(); renderJobs(); pump();
  }
  function restore() {
    for (const row of saved()) {
      if (!row || !row.key || jobs.has(row.key)) continue;
      jobs.set(row.key, { key: row.key, clientId: row.client_upload_id, uploadId: row.upload_id, file: null, name: row.name, size: row.size,
        lastModified: row.lastModified, type: row.type, folder: row.folder || '', created: row.created || Date.now(), state: 'needs-file', sent: 0, message: '', controller: null, result: null });
    }
    for (const job of jobs.values()) if (job.state === 'needs-file' && job.uploadId) refreshNeedsFile(job);
    renderJobs();
  }
  async function refreshNeedsFile(job) {
    try {
      const r = await fetch(`${UPLOADS}/${encodeURIComponent(job.uploadId)}`, { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 404) { fail(job, 'The upload expired on your Wizard · upload the file again.'); return; }
      const j = await r.json().catch(() => ({}));
      if (j.status === 'complete') { job.state = 'done'; job.result = j.file || null; job.sent = job.size; persist(); renderJobs(); refreshIfShowing(j.file); return; }
      if (j.status === 'failed') { fail(job, 'The upload stopped on your Wizard · upload the file again.'); return; }
      if (Number.isFinite(Number(j.offset))) { job.sent = Number(j.offset); job.known = true; }
      renderJobs();
    } catch (_) { /* offline: keep asking for the file */ }
  }
  function fail(job, message) { job.state = 'failed'; job.message = message; persist(); renderJobs(); syncHold(); }

  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = [...jobs.values()].find(j => j.state === 'waiting' && j.file);
        if (!job) break;
        await run(job);
      }
    } finally { pumping = false; syncHold(); }
  }

  // ---- uploads: the resumable protocol --------------------------------------------------------------
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('cancelled', 'AbortError'));
    const done = () => { clearTimeout(t); removeEventListener('online', wake); resolve(); };
    const wake = () => setTimeout(done, 300);
    const t = setTimeout(done, ms);
    addEventListener('online', wake);
    signal.addEventListener('abort', () => { clearTimeout(t); removeEventListener('online', wake); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
  });
  const backoff = n => Math.min(30000, 1000 * 2 ** Math.min(n, 5)) * (0.75 + Math.random() * 0.5);
  const transient = s => s === 0 || s === 408 || s === 425 || s === 429 || (s >= 500 && s !== 507);
  function words(status, body = {}) {
    const code = String(body.error || '');
    if (status === 507 || code === 'insufficient_storage') return NO_SPACE;
    if (status === 413 || code === 'file_too_large') return TOO_LARGE;
    if (code === 'folder_not_found' || status === 404) return 'That folder isn’t there any more.';
    if (code === 'folder_not_writable' || status === 403) return 'That folder can’t be written to.';
    if (code === 'destination_unavailable') return 'Uploads to My files aren’t set up on this Wizard.';
    if (status === 422 || code === 'sha256_mismatch') return 'The file changed while uploading · upload it again.';
    if (status === 410) return 'The upload stopped on your Wizard · upload the file again.';
    if (code === 'client_upload_id_conflict') return 'That file doesn’t match the one being uploaded.';
    return `Upload failed (${status}).`;
  }
  async function call(method, url, body, signal) {
    try {
      const r = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin', signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) { if (signal.aborted) throw e; return { status: 0, j: {} }; }
  }
  function patch(url, blob, offset, onBytes, signal) {
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
  async function run(job) {
    const controller = new AbortController();
    const signal = controller.signal;
    job.controller = controller;
    const set = (state, sent = job.sent) => { if (!jobs.has(job.key)) return; job.state = state; job.sent = Math.min(sent, job.size); renderJob(job); };
    let fails = 0;
    const wait = async () => { fails += 1; await sleep(backoff(fails), signal); };
    try {
      // Re-check saved jobs too: policy may have changed since the file was picked.
      // This protects UI destinations, not the independent transfer service's authority.
      const policyResponse = await fetch(`${API}?folder=${encodeURIComponent(job.folder)}&scope=personal`, {cache:'no-store', signal});
      if (!policyResponse.ok) throw Object.assign(new Error('Could not check the upload destination. Retry when connected.'), {user:true});
      const policy = await policyResponse.json();
      const path = job.folder ? `${job.folder}/${job.name}` : `Inbox/${job.name}`;
      const blocked = !policy.upload_allowed || !Array.isArray(policy.app_data_prefixes) || policy.app_data_prefixes.some(p =>
        path === p || path.startsWith(p + '/') || (!job.folder && (p === 'Inbox' || p.startsWith('Inbox/'))));
      if (blocked) throw Object.assign(new Error('App data is read-only here. Choose a folder in Your files.'), {user:true});
      set('uploading', job.sent);
      // 1) create, or find the existing upload again (same client_upload_id → same upload and its offset)
      let up;
      for (;;) {
        const r = await call('POST', UPLOADS, { client_upload_id: job.clientId, filename: job.name, mime: job.type, bytes: job.size, destination: { folder: job.folder } }, signal);
        if (r.status >= 200 && r.status < 300 && r.j.upload_id) { up = r.j; break; }
        if (!transient(r.status)) { fail(job, words(r.status, r.j)); return; }
        set('reconnecting'); await wait();
      }
      job.uploadId = up.upload_id; persist();
      const url = `${UPLOADS}/${encodeURIComponent(up.upload_id)}`;
      const chunk = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Number(up.chunk_bytes) || DEFAULT_CHUNK));
      let offset = Number(up.offset) || 0, status = up.status, receipt = up.file || null, conflicts = 0;
      set('uploading', offset);
      const reconcile = async () => {
        const r = await call('GET', url, null, signal);
        if (r.status === 200 && Number.isFinite(Number(r.j.offset))) { offset = Number(r.j.offset); status = r.j.status; if (r.j.file) receipt = r.j.file; return true; }
        if (r.status === 404) throw Object.assign(new Error('The upload expired on your Wizard · upload the file again.'), { user: true });
        return false;
      };
      for (;;) {
        while (status !== 'complete' && offset < job.size) {
          const at = offset, end = Math.min(job.size, at + chunk);
          const r = await patch(url, job.file.slice(at, end), at, n => set('uploading', at + n), signal);
          if (r.status === 204 || r.status === 200) { offset = Number.isFinite(r.offset) && r.offset >= at ? r.offset : end; fails = 0; conflicts = 0; set('uploading', offset); continue; }
          if (r.status === 409 && Number.isFinite(Number(r.j.offset))) {
            if (++conflicts > 20) { fail(job, 'The upload got out of step with your Wizard · upload the file again.'); return; }
            offset = Number(r.j.offset); set('uploading', offset); continue;
          }
          if (!transient(r.status)) { fail(job, words(r.status, r.j)); return; }
          set('reconnecting', offset);
          await wait();
          if (await reconcile()) set('uploading', offset);
        }
        if (receipt) break;
        set('finishing', job.size);
        const r = await call('POST', `${url}/complete`, {}, signal);
        if (r.status === 200 && r.j.file) { receipt = r.j.file; break; }
        if (r.status === 409) { if (!(await reconcile())) await wait(); continue; }
        if (!transient(r.status)) { fail(job, words(r.status, r.j)); return; }
        set('reconnecting', job.size); await wait();
      }
      for (;;) {
        try {
          const check = await fetch(`${API}/content?path=${encodeURIComponent(receipt.path)}`, {method: 'HEAD', cache: 'no-store'});
          if (!check.ok || Number(check.headers.get('Content-Length')) !== job.size) throw new Error('Readback unavailable');
          break;
        } catch (_) { set('reconnecting', job.size); await wait(); }
      }
      job.result = receipt; job.file = null;
      set('done', job.size); persist();
      toast(`Uploaded to ${receipt.folder ? receipt.folder.split('/').join(' › ') : 'My files'}`);
      refreshIfShowing(receipt);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      fail(job, error?.user ? error.message : 'Upload failed.');
    } finally { job.controller = null; syncHold(); }
  }
  function refreshIfShowing(file) {
    const r = route();
    // The new file, or the folder it created (e.g. Inbox/<today>), shows up in the folder being browsed.
    if (r && file && typeof file.folder === 'string' && (file.folder === r.folder || !r.folder || file.folder.startsWith(`${r.folder}/`))) load(r.folder);
  }

  // ---- uploads: UI ----------------------------------------------------------------------------------
  const rowNodes = new Map();
  function renderJobs() {
    const visible = [...jobs.values()].filter(j => j.state !== 'cancelled').sort((a, b) => a.created - b.created);
    els.uploads.hidden = scope.scope() === 'app' || !visible.length;
    for (const [key, n] of rowNodes) if (!jobs.has(key) || jobs.get(key).state === 'cancelled') { n.remove(); rowNodes.delete(key); }
    for (const job of visible) renderJob(job);
    syncHold();
  }
  function stateText(job) {
    const pct = job.size ? Math.floor((job.sent / job.size) * 100) : 0;
    const progress = `${size(job.sent)} of ${size(job.size)}`;
    switch (job.state) {
      case 'waiting': return 'Waiting';
      case 'uploading': return `Uploading ${pct}% · ${progress}`;
      case 'reconnecting': return `Reconnecting… ${pct}% kept`;
      case 'finishing': return 'Finishing…';
      case 'done': return `Uploaded to ${job.result?.path ? `My files › ${job.result.path.split('/').slice(0, -1).join(' › ') || ''}`.replace(/ › $/, '') : 'My files'}`;
      case 'needs-file': return job.known ? `Paused at ${pct}% · choose the same file to resume` : 'Paused · choose the same file to resume';
      case 'failed': return job.message || 'Upload failed.';
      default: return '';
    }
  }
  function renderJob(job) {
    let n = rowNodes.get(job.key);
    if (!n) {
      n = node('div', 'my-upload'); n.dataset.key = job.key;
      const top = node('div', 'my-upload-top');
      top.append(node('span', 'my-upload-name'), node('span', 'my-upload-actions'));
      const bar = node('div', 'my-upload-bar'); bar.append(node('span', 'my-upload-fill'));
      n.append(top, bar, node('div', 'my-upload-state'));
      rowNodes.set(job.key, n); els.uploads.append(n);
    }
    n.dataset.state = job.state;
    n.querySelector('.my-upload-name').textContent = job.name;
    n.querySelector('.my-upload-fill').style.width = `${job.size ? Math.min(100, (job.sent / job.size) * 100) : 0}%`;
    const state = n.querySelector('.my-upload-state');
    state.textContent = stateText(job);
    state.setAttribute('role', job.state === 'failed' ? 'alert' : 'status');
    const actions = n.querySelector('.my-upload-actions');
    actions.replaceChildren();
    const button = (label, fn, cls = '') => { const b = node('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); actions.append(b); };
    if (job.state === 'needs-file') button('Choose file', () => { repickFor = job.key; els.repick.value = ''; els.repick.click(); }, 'my-primary');
    if (job.state === 'failed' && job.file) button('Retry', () => { job.state = 'waiting'; job.message = ''; persist(); renderJob(job); pump(); });
    if (job.state === 'done') button('Dismiss', () => { jobs.delete(job.key); renderJobs(); });
    else if (job.state === 'failed') button('Dismiss', () => { jobs.delete(job.key); persist(); renderJobs(); });
    else button('Cancel', () => { job.controller?.abort(); job.state = 'cancelled'; jobs.delete(job.key); persist(); renderJobs(); }, 'my-cancel');
  }
  let repickFor = '';
  els.repick.addEventListener('change', () => {
    const job = jobs.get(repickFor); const file = els.repick.files?.[0]; repickFor = '';
    els.repick.value = '';
    if (!job || !file) return;
    if (file.name !== job.name || file.size !== job.size || (job.lastModified && file.lastModified && file.lastModified !== job.lastModified)) {
      toast('That’s a different file · choose the same one to resume'); return;
    }
    job.file = file; job.state = 'waiting'; renderJob(job); pump();
  });
  els.upload.addEventListener('click', () => { if (scope.scope() !== 'personal' || !view.uploadAllowed) return; els.picker.value = ''; els.picker.click(); });
  els.picker.addEventListener('change', () => {
    const r = route(); const folder = r ? r.folder : '';
    if (!r || scope.scope() !== 'personal' || !view.uploadAllowed) { els.picker.value = ''; return; }
    const files = [...(els.picker.files || [])];
    for (const file of files) if (file.size > 0) addJob(file, folder); else toast('Empty files can’t be uploaded');
    els.picker.value = '';
  });
  function renderUploadButton() {
    const readOnly = scope.scope() === 'app' || !view.uploadAllowed;
    els.upload.hidden = scope.scope() === 'app';
    els.upload.disabled = view.available !== true || readOnly;
    const r = route();
    els.hint.textContent = readOnly ? 'This view is read-only.' : r && !r.folder ? 'Uploads here go to Inbox, in a folder for today.' : '';
    els.hint.hidden = !els.hint.textContent;
    $('#my-empty-copy').textContent = readOnly ? 'No matching app data or personal files in this folder.' : 'Use Upload to add files here.';
  }

  // ---- route handling -------------------------------------------------------------------------------
  function apply() {
    const r = route();
    document.body.classList.toggle('my-files-open', Boolean(r));
    els.section.hidden = !r;
    if (!r) { hideSheet(); view.showing = null; view.generation++; return; }
    els.title.textContent = r.folder ? r.folder.split('/').pop() : scope.label();
    els.back.classList.add('visible');
    const showing = scope.scope() + ':' + r.folder;
    if (view.showing !== showing) { view.showing = showing; view.uploadAllowed = false; view.entries = []; els.list.replaceChildren(); els.empty.hidden = true; load(r.folder); }
    renderCrumbs(r.folder); renderUploadButton(); renderJobs();
    if (r.file) openSheet(r.folder, r.file); else hideSheet();
  }
  addEventListener('hashchange', apply);
  addEventListener('popstate', apply);
  // The top-bar back button and the Wizard shell's Back (which presses it) step up one level here, before
  // the Files router handles anything else.
  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('#back-button')) return;
    const target = backTarget();
    if (target == null) return;
    e.preventDefault(); e.stopImmediatePropagation();
    go(target, { replace: true });
  }, true);
  // Links into My files (the home tile, folders, files, breadcrumbs) navigate in-app.
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest && e.target.closest('a[href^="#/my"],a[href^="#/app/my"]');
    if (!link) return;
    e.preventDefault();
    go(link.getAttribute('href'));
  });
  window.WizMyFiles = Object.freeze({ backTarget, route, go, openVideo });
  restore();
  apply();
})();
