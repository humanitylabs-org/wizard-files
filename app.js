(() => {
'use strict';
const $=s=>document.querySelector(s), state={items:[], generation:0, layout:'list', scope:null, sender:'', filterContext:null};
const api=new URL('api/index',location.href).pathname;
const types={videos:'video',photos:'photo',documents:'document',links:'link',audio:'audio'};
const names={video:'Videos',photo:'Photos',document:'Documents',link:'Links',audio:'Audio'};
const rawRoute=()=> (location.hash||'#/').split('?')[0].slice(2);
const scope=()=>rawRoute()==='app'||rawRoute().startsWith('app/')?'app':'personal';
const route=()=>scope()==='app'?rawRoute().slice(3).replace(/^\//,''):rawRoute();
const scopedHash=hash=>scope()==='app'?'#/app'+hash.slice(1):hash;
window.WizFilesScope=Object.freeze({scope,route,hash:scopedHash,label:()=>scope()==='app'?'App data':'Your files'});
function go(hash,replace=false){if((location.hash||'#/')===hash)return; history[replace?'replaceState':'pushState']({wizardFilesRoute:true},'',location.pathname+location.search+hash); dispatchEvent(new HashChangeEvent('hashchange'));}
function back(){const target=window.WizMyFiles?.backTarget();if(target!==null&&target!==undefined){window.WizMyFiles.go(target,{replace:true});return true;}if($('#search-input').value){$('#search-input').value='';load();return true;}if(route()){go(scopedHash('#/'),true);return true;}if(scope()==='app'){go('#/',true);return true;}return false;}
WizardApp.ready({name:'wizard-files',version:'0.1.2'});
WizardApp.back.register({canGoBack:()=>!!rawRoute()||!!$('#search-input').value,back});
WizardApp.back.useHistory({isRoot:()=>!rawRoute()&&!$('#search-input').value});
$('#back-button').addEventListener('click',e=>{e.preventDefault();back();});
document.addEventListener('click',e=>{if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey)return;const a=e.target.closest('a[href^="#/"]');if(!a||/^#\/(app\/)?my(?:\/|\?|$)/.test(a.getAttribute('href')))return;e.preventDefault();go(a.getAttribute('href'));});
$('#scope-toggle').addEventListener('click',e=>{const b=e.target.closest('[data-scope]');if(!b)return;go(b.dataset.scope==='app'?'#/app/':'#/');});
function node(tag,cls,text){const n=document.createElement(tag);n.className=cls;if(text!=null)n.textContent=text;return n;}
function render(){
  const feed=$('#feed');feed.replaceChildren();
  feed.className='feed'+(state.layout==='grid'?' owner-grid':'')+(route()==='videos'?' video-gallery':'');
  for(const item of state.items){
    const a=node('a','item-row owner-item'+(item.type==='video'?' video-card':''));
    const folder=item.path.split('/').slice(0,-1).map(encodeURIComponent).join('/');
    a.href=scopedHash(`#/my${folder?'/'+folder:''}?f=${encodeURIComponent(item.name)}`);
    const thumb=node('span','my-icon');
    if(item.type==='photo'){
      const img=node('img','');img.alt='';img.loading='lazy';img.src=new URL('api/files/content?path='+encodeURIComponent(item.path),location.href);thumb.append(img);
    }else if(item.type==='video'){
      WizMediaGallery.thumbnail(thumb,item);
      a.setAttribute('aria-label','Play '+item.name);
      a.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();window.WizMyFiles.openVideo(item,a);});
    }else thumb.textContent={audio:'♪',link:'↗',document:'DOC'}[item.type];
    const copy=node('span','item-copy');
    const senders=item.sources?.length?[...new Set(item.sources.map(s=>s.sender_label))].join(' / '):'';
    const date=item.sent_at?new Date(item.sent_at).toLocaleDateString():'';
    copy.append(node('span','item-title',item.name),node('span','item-meta',[senders,date,item.path].filter(Boolean).join(' · ')));
    a.append(thumb,copy);feed.append(a);
  }
  $('#empty-state').hidden=state.items.length>0;
  $('#empty-copy').textContent=scope()==='app'?'No app data matches this view.':'Your files appear here. App support files are kept in App data.';
}
function renderSenders(data){
  const group=$('#photo-senders'), meta=data.provenance||{};
  group.replaceChildren();group.hidden=route()!=='photos';
  const filters=[['','All'],...(meta.available?[['owner','From '+meta.owner_label],...Object.entries(meta.agent_labels).map(([id,label])=>['agent:'+id,'From '+label])]:[])];
  if(data.sender_counts?.unknown||state.sender==='unknown')filters.push(['unknown','Other / unknown']);
  for(const [value,label] of filters){const b=node('button','',label);b.type='button';b.dataset.sender=value;b.setAttribute('aria-pressed',String(state.sender===value));group.append(b);}
  const note=$('#photo-provenance-note');
  note.hidden=route()!=='photos'||(meta.available&&!meta.partial);
  note.textContent=meta.partial?'Some photo attribution is not verified yet. Unverified photos remain Other / unknown.':'Chat sender information is unavailable. Photos remain Other / unknown.';
}
$('#photo-senders').addEventListener('click',e=>{const b=e.target.closest('[data-sender]');if(!b)return;state.sender=b.dataset.sender;load();});
async function load(){
  const selectedScope=scope(),r=route(),my=r==='my'||r.startsWith('my/');
  const n=++state.generation;
  const filterContext=selectedScope+':'+r;
  if(state.filterContext!==filterContext){state.sender='';state.filterContext=filterContext;}
  $('#photo-senders').hidden=true;$('#photo-provenance-note').hidden=true;
  if(state.scope!==selectedScope){$('#search-input').value='';state.scope=selectedScope;}
  // Clear before requesting: a slow prior scope must never flash into this one.
  state.items=[];render();$('#result-count').textContent='';$('#status-banner').hidden=true;
  for(const k of Object.values(types)){const el=$('#count-'+k);if(el)el.textContent='—';}
  for(const b of $('#scope-toggle').children)b.setAttribute('aria-pressed',String(b.dataset.scope===selectedScope));
  $('#scope-hint').hidden=selectedScope!=='app';
  $('#search-input').placeholder=selectedScope==='app'?'Search app data':'Search your files';
  for(const a of $('#type-tiles').querySelectorAll('a')){a.dataset.route ||= a.getAttribute('href');a.href=scopedHash(a.dataset.route);}
  $('#folder-label').textContent=selectedScope==='app'?'App folders':'Your folders';
  $('#folder-detail').textContent=selectedScope==='app'?'Browse only':'Folders & uploads';
  $('.sticky-tools').hidden=my;$('.feed-section').hidden=my;$('#home-types').hidden=my||!!r||!!$('#search-input').value;
  if(my)return;
  const type=types[r]||'',q=$('#search-input').value;
  $('#back-button').classList.toggle('visible',!!rawRoute()||!!q);$('#page-title').textContent=names[type]||window.WizFilesScope.label();$('#feed-label').textContent=q?'Search results':names[type]||'Recent';$('#clear-search').classList.toggle('visible',!!q);
  $('.feed-section').setAttribute('aria-busy','true');
  try{const res=await fetch(api+'?'+new URLSearchParams({q,type,scope:selectedScope,sender:type==='photo'?state.sender:''}),{cache:'no-store'});if(!res.ok)throw Error('unavailable');const data=await res.json();if(n!==state.generation)return;state.items=data.items;renderSenders(data);for(const [k,v] of Object.entries(data.counts)){const el=$('#count-'+k);if(el)el.textContent=v+' items';}$('#result-count').textContent=data.total+(data.truncated?' · limited scan':'');$('#status-banner').hidden=!data.truncated;$('#status-banner').textContent='Large library: showing a bounded scan. Browse folders to reach every file.';render();}
  catch(e){if(n!==state.generation)return;state.items=[];render();$('#status-banner').hidden=false;$('#status-banner').textContent='Could not load files. Tap to retry.';}
  finally{if(n===state.generation)$('.feed-section').setAttribute('aria-busy','false');}
}
let timer;$('#search-input').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(load,180);});$('#clear-search').onclick=()=>{$('#search-input').value='';load();};$('#status-banner').onclick=load;
$('#view-toggle').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;state.layout=b.dataset.view;for(const x of $('#view-toggle').children)x.setAttribute('aria-pressed',String(x===b));render();});$('#view-toggle [data-view="list"]').setAttribute('aria-pressed','true');
addEventListener('hashchange',load);addEventListener('popstate',load);load();
})();
