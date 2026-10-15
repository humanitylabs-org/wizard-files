/* One lazy decoder, bounded frame seek, device-local bounded cache. No library writes. */
(() => {
'use strict';
const memory = new Map(), jobs = new WeakMap(), observed = new Set();
let queue = [], running = false, active = null, suspended = false, dbPromise;
const content = path => new URL('api/files/content?path=' + encodeURIComponent(path), location.href).href;
const keyFor = item => JSON.stringify([location.pathname, item.path, item.identity || [item.size, item.mtime], 1]);
function database() {
  return dbPromise ||= new Promise(resolve => {
    let request, done = false;
    const finish = db => { if (done) { db?.close(); return; } done = true; clearTimeout(timer); resolve(db); };
    const timer = setTimeout(() => finish(null), 1500);
    try {
      request = indexedDB.open('wizard-files:video-frames:v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('frames', {keyPath:'key'});
      request.onsuccess = () => finish(request.result);
      request.onerror = request.onblocked = () => finish(null);
    } catch (_) { finish(null); }
  });
}
async function cached(key) {
  if (memory.has(key)) return memory.get(key);
  const db = await database(); if (!db) return null;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 1000);
    try { const r = db.transaction('frames').objectStore('frames').get(key);
      r.onsuccess = () => { clearTimeout(timer); resolve(r.result?.frame || null); };
      r.onerror = () => { clearTimeout(timer); resolve(null); };
    } catch (_) { clearTimeout(timer); resolve(null); }
  });
}
async function store(key, frame) {
  memory.set(key, frame);
  if (memory.size > 96) memory.delete(memory.keys().next().value);
  const db = await database(); if (!db) return;
  try {
    const s = db.transaction('frames','readwrite').objectStore('frames');
    s.put({key,frame});
    const request = s.getAllKeys();
    request.onsuccess = () => { for (const k of request.result.slice(0, Math.max(0, request.result.length - 96))) s.delete(k); };
  } catch (_) { /* storage unavailable is not a media error */ }
}
function decode(item) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'metadata';
    let settled = false;
    const finish = (error, frame) => {
      if (settled) return; settled = true; clearTimeout(timer);
      video.onloadedmetadata = video.onseeked = video.onerror = video.onloadeddata = null;
      video.pause(); video.removeAttribute('src'); video.load();
      if (active?.video === video) active = null;
      error ? reject(error) : resolve(frame);
    };
    const timer = setTimeout(() => finish(Error('Preview timed out')), 12000);
    active = {video, cancel: () => finish(Error('cancelled'))};
    const draw = () => {
      if (video.readyState < 2 || !video.videoWidth) return;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(null, {url:canvas.toDataURL('image/jpeg', .78), width:canvas.width, height:canvas.height});
      } catch (e) { finish(e); }
    };
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return finish(Error('No seekable frame'));
      // Near-start seek avoids a full preload and works with byte-range servers.
      const seek = Math.min(1, video.duration * .1);
      video.onseeked = draw;
      video.currentTime = seek;
    };
    video.onerror = () => finish(Error('Preview unavailable'));
    video.src = content(item.path);
  });
}
function paint(element, frame, fromCache) {
  const img = document.createElement('img'); img.alt = ''; img.src = frame.url;
  element.replaceChildren(img);
  element.style.aspectRatio = `${frame.width} / ${frame.height}`;
  element.dataset.thumbnail = fromCache ? 'cached' : 'decoded';
  const play = document.createElement('span'); play.className = 'video-play'; play.textContent = '▶';
  element.append(play);
}
async function pump() {
  if (running || suspended) return;
  running = true;
  try {
    while (queue.length && !suspended) {
      const {element,item} = queue.shift();
      if (!element.isConnected) continue;
      const key = keyFor(item);
      try {
        const existing = await cached(key);
        if (!element.isConnected) continue;
        if (suspended) { queue.unshift({element,item}); break; }
        const frame = existing || await decode(item);
        if (!existing) await store(key, frame);
        if (element.isConnected) paint(element, frame, !!existing);
      } catch (_) {
        if (suspended) { queue.unshift({element,item}); break; }
        if (element.isConnected) { element.textContent = '▶ Preview unavailable · tap to play'; element.dataset.thumbnail = 'unavailable'; }
      }
    }
  } finally { running = false; }
}
const observer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) {
    observer.unobserve(e.target); observed.delete(e.target);
    const item = jobs.get(e.target); if (item) queue.push({element:e.target,item});
  }
  pump();
}, {rootMargin:'160px'});
function thumbnail(element, item) {
  element.classList.add('video-thumbnail'); element.textContent = 'Preparing preview…';
  element.dataset.thumbnail = 'pending'; jobs.set(element,item); observed.add(element); observer.observe(element);
}
function suspend(value) { suspended = value; if (value) active?.cancel(); else pump(); }
// Remove detached observations and cancel work when its view goes away.
new MutationObserver(() => {
  queue = queue.filter(job => job.element.isConnected);
  for (const element of observed) if (!element.isConnected) { observer.unobserve(element); observed.delete(element); }
}).observe(document.body, {childList:true,subtree:true});
window.WizMediaGallery = Object.freeze({thumbnail, suspend});
})();
