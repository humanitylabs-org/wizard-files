(() => {
'use strict';
const $=s=>document.querySelector(s), state={items:[],generation:0,layout:'list',scope:null,sender:'',filterContext:null,next:null,snapshot:'',busy:false,controller:null,retryTimer:null,phase:'loading'};
const cache=new Map(), metadata=new Map(); // Memory only; exact scope/query/type/sender keys, 12 views / 60 seconds.
const api=new URL('api/index',location.href).pathname;
const types={videos:'video',photos:'photo',documents:'document',links:'link',audio:'audio'};
const names={video:'Videos',photo:'Photos',document:'Documents',link:'Links',audio:'Audio'};
const rawRoute=()=> (location.hash||'#/').split('?')[0].slice(2);
const scope=()=>rawRoute()==='app'||rawRoute().startsWith('app/')?'app':'personal';
const route=()=>scope()==='app'?rawRoute().slice(3).replace(/^\//,''):rawRoute();
const scopedHash=hash=>scope()==='app'?'#/app'+hash.slice(1):hash;
window.WizFilesScope=Object.freeze({scope,route,hash:scopedHash,label:()=>scope()==='app'?'App data':'Your files'});
function go(hash,replace=false){if((location.hash||'#/')===hash)return;history[replace?'replaceState':'pushState']({wizardFilesRoute:true},'',location.pathname+location.search+hash);dispatchEvent(new HashChangeEvent('hashchange'));}
function back(){const target=window.WizMyFiles?.backTarget();if(target!==null&&target!==undefined){window.WizMyFiles.go(target,{replace:true});return true;}if($('#search-input').value){$('#search-input').value='';load();return true;}if(route()){go(scopedHash('#/'),true);return true;}if(scope()==='app'){go('#/',true);return true;}return false;}
WizardApp.ready({name:'wizard-files',version:'0.1.4'});
WizardApp.back.register({canGoBack:()=>!!rawRoute()||!!$('#search-input').value,back});
WizardApp.back.useHistory({isRoot:()=>!rawRoute()&&!$('#search-input').value});
$('#back-button').addEventListener('click',e=>{e.preventDefault();back();});
document.addEventListener('click',e=>{if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey)return;const a=e.target.closest('a[href^="#/"]');if(!a||/^#\/(app\/)?my(?:\/|\?|$)/.test(a.getAttribute('href')))return;e.preventDefault();go(a.getAttribute('href'));});
$('#scope-toggle').addEventListener('click',e=>{const b=e.target.closest('[data-scope]');if(b)go(b.dataset.scope==='app'?'#/app/':'#/');});
function node(tag,cls,text){const n=document.createElement(tag);n.className=cls;if(text!=null)n.textContent=text;return n;}
const loading=node('div','feed-loading');loading.id='feed-loading';loading.setAttribute('role','status');loading.setAttribute('aria-live','polite');loading.append(node('span','loading-wheel'),node('span','loading-label','Loading files…'));loading.firstChild.setAttribute('aria-hidden','true');$('#feed').before(loading);
function feedback(){
  const pending=['loading','refreshing','preparing'].includes(state.phase);
  loading.hidden=!pending;loading.lastChild.textContent=state.phase==='refreshing'?'Refreshing saved view…':state.phase==='preparing'?'Preparing sender info…':'Loading files…';
  $('#empty-state').hidden=state.items.length>0||state.phase!=='ready';
  $('.feed-section').setAttribute('aria-busy',String(state.busy||state.phase==='preparing'||state.phase==='loading'));
}
function render(){
  const feed=$('#feed');feed.replaceChildren();
  feed.className='feed'+(state.layout==='grid'?' owner-grid':'')+(route()==='videos'?' video-gallery':'');
  for(const item of state.items){
    const a=node('a','item-row owner-item'+(item.type==='video'?' video-card':''));a.dataset.path=item.path;
    const folder=item.path.split('/').slice(0,-1).map(encodeURIComponent).join('/');a.href=scopedHash(`#/my${folder?'/'+folder:''}?f=${encodeURIComponent(item.name)}`);
    const thumb=node('span','my-icon');
    if(item.type==='photo'||item.type==='video'){
      WizMediaGallery.thumbnail(thumb,item);
      if(item.type==='video'){a.setAttribute('aria-label','Play '+item.name);a.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();window.WizMyFiles.openVideo(item,a);});}
    }else thumb.textContent={audio:'♪',link:'↗',document:'DOC'}[item.type];
    const copy=node('span','item-copy');const senders=item.verification_pending?'Preparing sender info…':item.sources?.length?[...new Set(item.sources.map(s=>s.sender_label))].join(' / '):item.type==='photo'?'Unknown':'';
    const date=item.sent_at?new Date(item.sent_at).toLocaleDateString():'';
    copy.append(node('span','item-title',item.name),node('span','item-meta',[senders,date,item.path].filter(Boolean).join(' · ')));a.append(thumb,copy);feed.append(a);
  }
  $('#empty-copy').textContent=scope()==='app'?'No app data matches this view.':'Your files appear here. App support files are kept in App data.';feedback();
}
function renderSenders(data){
  const group=$('#photo-senders'),meta=data?.provenance||{};group.hidden=route()!=='photos';
  const filters=[['','All'],...(meta.available?[['owner','From '+meta.owner_label],...Object.entries(meta.agent_labels).map(([id,label])=>['agent:'+id,'From '+label])]:[])];
  if(data?.sender_counts?.unknown||state.sender==='unknown')filters.push(['unknown','Other / unknown']);
  const signature=JSON.stringify(filters);
  if(group.dataset.filters!==signature){group.replaceChildren();for(const [value,label]of filters){const b=node('button','',label);b.type='button';b.dataset.sender=value;group.append(b);}group.dataset.filters=signature;}
  for(const b of group.children)b.setAttribute('aria-pressed',String(state.sender===b.dataset.sender));
  const note=$('#photo-provenance-note');note.hidden=route()!=='photos'||!data||(meta.available&&!meta.partial);
  note.textContent=meta.partial?`Preparing sender info… ${meta.pending} photos left. Counts may change.`:'Chat sender information is unavailable. Photos remain Other / unknown.';
}
const more=node('button','load-more','Load more');more.id='load-more';more.type='button';more.hidden=true;$('#feed').after(more);more.onclick=()=>fetchPage(state.generation,true);
function cancelLoad(){state.generation++;state.controller?.abort();clearTimeout(state.retryTimer);state.busy=false;more.hidden=true;}
$('#photo-senders').addEventListener('click',e=>{const b=e.target.closest('[data-sender]');if(b){state.sender=b.dataset.sender;load();}});
function summary(data){
  for(const [k,v]of Object.entries(data.counts)){const el=$('#count-'+k);if(el)el.textContent=v+' items';}
  $('#result-count').textContent=`${state.items.length} of ${data.total}${data.provenance?.partial?' · preparing sender info':data.truncated?' · limited scan':''}`;
  $('#status-banner').hidden=!data.truncated;$('#status-banner').textContent='Large library: showing a bounded scan. Browse folders to reach every file.';
}
async function load(){
  const selectedScope=scope(),r=route(),my=r==='my'||r.startsWith('my/');cancelLoad();const n=state.generation;
  state.next=null;state.snapshot='';state.attempts=0;const filterContext=selectedScope+':'+r;
  if(state.filterContext!==filterContext){state.sender='';state.filterContext=filterContext;}
  if(state.scope!==selectedScope){$('#search-input').value='';state.scope=selectedScope;for(const k of Object.values(types)){const el=$('#count-'+k);if(el)el.textContent='—';}}
  for(const b of $('#scope-toggle').children)b.setAttribute('aria-pressed',String(b.dataset.scope===selectedScope));
  $('#scope-hint').hidden=selectedScope!=='app';$('#search-input').placeholder=selectedScope==='app'?'Search app data':'Search your files';
  for(const a of $('#type-tiles').querySelectorAll('a')){a.dataset.route ||= a.getAttribute('href');a.href=scopedHash(a.dataset.route);}
  $('#folder-label').textContent=selectedScope==='app'?'App folders':'Your folders';$('#folder-detail').textContent=selectedScope==='app'?'Browse only':'Folders & uploads';
  $('.sticky-tools').hidden=my;$('.feed-section').hidden=my;$('#home-types').hidden=my||!!r||!!$('#search-input').value;
  if(my){state.items=[];render();return;}
  const type=types[r]||'',q=$('#search-input').value;$('#back-button').classList.toggle('visible',!!rawRoute()||!!q);$('#page-title').textContent=names[type]||window.WizFilesScope.label();$('#feed-label').textContent=q?'Search results':names[type]||'Recent';$('#clear-search').classList.toggle('visible',!!q);
  state.params={q,type,scope:selectedScope,sender:type==='photo'?state.sender:''};state.key=JSON.stringify(state.params);
  const saved=cache.get(state.key),valid=saved&&Date.now()-saved.at<60000;
  state.items=valid?saved.items:[];state.next=valid?saved.next:null;state.snapshot=valid?saved.data.snapshot:'';state.phase=valid?'refreshing':'loading';
  $('#result-count').textContent='';$('#status-banner').hidden=true;renderSenders(metadata.get(selectedScope));
  if(valid)summary(saved.data);render();await fetchPage(n);
}
async function fetchPage(n,append=false){
  if(n!==state.generation||state.busy||(append&&state.next===null))return;
  state.busy=true;state.controller=new AbortController();const controller=state.controller,key=state.key;more.disabled=true;
  if(append){more.hidden=false;more.textContent='Loading more…';}feedback();
  const timeout=setTimeout(()=>controller.abort(),15000);let preparing=false;
  try{
    const res=await fetch(api+'?'+new URLSearchParams({...state.params,limit:120,offset:append?state.next:0,snapshot:append?state.snapshot:''}),{cache:'no-store',signal:controller.signal});
    if(n!==state.generation)return;
    if(res.status===401||res.status===403){cache.clear();metadata.clear();state.items=[];render();}
    if(!res.ok)throw Error('unavailable');const data=await res.json();if(n!==state.generation)return;
    preparing=data.provenance?.partial===true;const unchanged=!append&&!preparing&&['ready','refreshing'].includes(state.phase)&&state.snapshot===data.snapshot&&state.items.length>0;
    if(!unchanged){const prior=append&&!data.reset&&!preparing?state.items:[];state.items=[...new Map([...prior,...data.items].map(item=>[item.path,item])).values()];state.next=preparing?null:data.next_offset;}
    state.snapshot=data.snapshot;state.phase=preparing?'preparing':'ready';metadata.set(state.params.scope,data);renderSenders(data);summary(data);
    if(!unchanged)render();more.hidden=state.next===null;more.textContent='Load more';
    if(!preparing){cache.delete(key);cache.set(key,{items:state.items.slice(0,1200),next:state.items.length>1200?1200:state.next,data,at:Date.now()});while(cache.size>12)cache.delete(cache.keys().next().value);}
    if(preparing){if(++state.attempts<8)state.retryTimer=setTimeout(()=>fetchPage(n),400);else{state.phase='error';$('#status-banner').hidden=false;$('#status-banner').textContent='Sender info is still preparing. Tap to retry.';}}
  }catch(e){
    if(n!==state.generation)return;state.phase='error';$('#status-banner').hidden=false;$('#status-banner').textContent=state.items.length?'Could not refresh. Showing saved files. Tap to retry.':'Could not load files. Tap to retry.';
    if(append){more.hidden=false;more.textContent='Retry loading more';}
  }finally{clearTimeout(timeout);if(n===state.generation){state.busy=false;more.disabled=false;feedback();}}
}
let timer;$('#search-input').addEventListener('input',()=>{clearTimeout(timer);cancelLoad();state.items=[];state.phase='loading';render();timer=setTimeout(load,180);});$('#clear-search').onclick=()=>{$('#search-input').value='';load();};$('#status-banner').onclick=()=>load();
$('#view-toggle').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;state.layout=b.dataset.view;for(const x of $('#view-toggle').children)x.setAttribute('aria-pressed',String(x===b));render();});$('#view-toggle [data-view="list"]').setAttribute('aria-pressed','true');
// Refresh counts/new source arrivals without indefinitely presenting a cached library as live.
setInterval(()=>{if(!document.hidden&&!state.busy&&!route().startsWith('my'))load();},30000);
addEventListener('pagehide',()=>{cancelLoad();cache.clear();metadata.clear();});
addEventListener('pageshow',e=>{if(e.persisted)load();});
addEventListener('hashchange',load);addEventListener('popstate',load);load();
})();
