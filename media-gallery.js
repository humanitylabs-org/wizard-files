/* Lazy bounded thumbnails; never fetch original video/photo bytes for cards. */
(() => {
'use strict';
const memory=new Map(),jobs=new WeakMap(),observed=new Set();let queue=[],running=false,active=null,suspended=false,dbPromise;
const keyFor=item=>JSON.stringify([location.pathname,item.path,item.identity||[item.size,item.mtime],1]);
const urlFor=item=>new URL('api/files/thumbnail?'+new URLSearchParams({path:item.path,v:item.identity||''}),location.href).href;
// Preserve already-decoded private video frames from the preceding release.
function database(){return dbPromise ||= new Promise(resolve=>{let request,done=false;const finish=db=>{if(done){db?.close();return;}done=true;clearTimeout(timer);resolve(db);};const timer=setTimeout(()=>finish(null),1500);try{request=indexedDB.open('wizard-files:video-frames:v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('frames',{keyPath:'key'});request.onsuccess=()=>finish(request.result);request.onerror=request.onblocked=()=>finish(null);}catch(_){finish(null);}});}
async function cached(key,video){if(memory.has(key))return memory.get(key);if(!video)return null;const db=await database();if(!db)return null;return new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),1000);try{const r=db.transaction('frames').objectStore('frames').get(key);r.onsuccess=()=>{clearTimeout(timer);resolve(r.result?.frame||null);};r.onerror=()=>{clearTimeout(timer);resolve(null);};}catch(_){clearTimeout(timer);resolve(null);}});}
async function store(key,frame,video){memory.set(key,frame);if(memory.size>96)memory.delete(memory.keys().next().value);if(!video)return;const db=await database();if(!db)return;try{const s=db.transaction('frames','readwrite').objectStore('frames');s.put({key,frame});const r=s.getAllKeys();r.onsuccess=()=>{for(const k of r.result.slice(0,Math.max(0,r.result.length-96)))s.delete(k);};}catch(_){}}
async function decode(item,element){
  const controller=new AbortController(),job={element,cancelled:false,cancel:()=>{job.cancelled=true;controller.abort();}};active=job;
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(urlFor(item),{signal:controller.signal,credentials:'same-origin',priority:'low'});
    if(!response.ok)throw Error('preview unavailable');
    const blob=await response.blob();if(blob.size>512*1024)throw Error('preview bounds');
    const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    const img=new Image();img.src=url;await img.decode();return {url,width:img.naturalWidth,height:img.naturalHeight};
  }catch(error){if(job.cancelled)error.previewCancelled=true;throw error;}finally{clearTimeout(timer);if(active===job)active=null;}
}
function paint(element,frame,fromCache,video){const img=document.createElement('img');img.alt='';img.src=frame.url;element.replaceChildren(img);if(video)element.style.aspectRatio=`${frame.width} / ${frame.height}`;element.dataset.thumbnail=fromCache?'cached':'decoded';if(video){const play=document.createElement('span');play.className='video-play';play.textContent='▶';element.append(play);}}
async function pump(){if(running||suspended)return;running=true;try{while(queue.length&&!suspended){const {element,item}=queue.shift();if(!element.isConnected)continue;const key=keyFor(item),video=item.type==='video';try{const existing=await cached(key,video);if(!element.isConnected)continue;if(suspended){queue.unshift({element,item});break;}const frame=existing||await decode(item,element);if(!existing)await store(key,frame,video);if(element.isConnected)paint(element,frame,!!existing,video);}catch(_){if(suspended){queue.unshift({element,item});break;}if(_.previewCancelled)continue;if(element.isConnected){element.textContent=video?'▶ Tap to play':'Photo';element.dataset.thumbnail='unavailable';}}}}finally{running=false;}}
const observer=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting){const item=jobs.get(e.target);if(item&&!queue.some(j=>j.element===e.target)&&active?.element!==e.target&&e.target.dataset.thumbnail==='pending')queue.push({element:e.target,item});}else{queue=queue.filter(j=>j.element!==e.target);if(active?.element===e.target)active.cancel();}}pump();},{rootMargin:'80px'});
function thumbnail(element,item){if(item.type==='video')element.classList.add('video-thumbnail');element.textContent=item.type==='video'?'Preparing preview…':'';element.dataset.thumbnail='pending';jobs.set(element,item);observed.add(element);observer.observe(element);}
function suspend(value){suspended=value;if(value)active?.cancel();else pump();}
new MutationObserver(()=>{queue=queue.filter(job=>job.element.isConnected);if(active&&!active.element.isConnected)active.cancel();for(const element of observed)if(!element.isConnected||['cached','decoded'].includes(element.dataset.thumbnail)){observer.unobserve(element);observed.delete(element);}}).observe(document.body,{childList:true,subtree:true});
addEventListener('pagehide',()=>{suspend(true);memory.clear();});addEventListener('pageshow',e=>{if(e.persisted)suspend(false);});document.addEventListener('visibilitychange',()=>suspend(document.hidden));
window.WizMediaGallery=Object.freeze({thumbnail,suspend,urlFor});
})();
