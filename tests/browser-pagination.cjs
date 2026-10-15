/* Worker-only synthetic transport/lifecycle regression, not actual photo proof. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const out=process.env.QA_OUT,checks=[];
const ok=(v,s)=>{assert(v,s);checks.push(s);console.log('PASS',s);};
(async()=>{
 const core=await fetch(process.env.CORE_URL).then(r=>r.text());
 const server=http.createServer((req,res)=>{const p=new URL(req.url,'http://localhost').pathname;const file=p==='/'?'index.html':p.slice(1);if(p.endsWith('app-client.js')){res.setHeader('Content-Type','text/javascript');res.end(core);return;}if(!fs.existsSync(file)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const p=await browser.newPage({viewport:{width:390,height:844}});let calls=0,mode='cold',delay=0;
  const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/api/index?*',async r=>{
   calls++;const u=new URL(r.request().url()),q=u.searchParams;const offset=Number(q.get('offset')||0),sender=q.get('sender'),app=q.get('scope')==='app';
   const partial=mode==='stuck'||mode==='cold'&&calls<3;
   const total=app?1:sender==='owner'?427:sender==='agent:main'?159:sender==='unknown'?1:615;
   const items=Array.from({length:Math.min(120,total-offset)},(_,i)=>({path:(app?'Support/':'Photos/')+(offset+i)+'.png',name:(offset+i)+'.png',type:'photo',senders:partial?[]:[sender||'owner'],verification_pending:partial}));
   const body={items,total,counts:{photo:615},sender_counts:{owner:427,'agent:main':159,unknown:1},provenance:{available:true,partial,pending:partial?100:0,owner_label:'Fixture Owner',agent_labels:{main:'Fixture Guide'}},snapshot:'a'.repeat(64),next_offset:offset+items.length<total?offset+items.length:null,has_more:offset+items.length<total,reset:false,truncated:false};
   if(delay)await new Promise(x=>setTimeout(x,delay));
   await r.fulfill({json:body}).catch(()=>{});
  });
  await p.route('**/api/files/content?*',r=>r.fulfill({status:404}));
  const idle=()=>p.locator('.feed-section[aria-busy="false"]').waitFor();
  await p.goto(`http://127.0.0.1:${server.address().port}/#/photos`);
  await p.locator('#photo-provenance-note').waitFor();ok((await p.locator('#photo-provenance-note').innerText()).includes('Preparing sender info'),'partial visibly preparing, not Unknown');
  await idle();ok(calls===3,'cold verification automatically converges in bounded requests');
  while(await p.locator('#load-more').isVisible()){await p.locator('#load-more').click();await idle();}
  ok(await p.locator('#feed a').count()===615,'every synthetic photo paginated beyond 300');
  ok((await p.locator('#result-count').innerText())==='615 of 615','complete filtered count');
  for(const [s,n] of [['owner',427],['agent:main',159],['unknown',1]]){
   await p.locator(`[data-sender="${s}"]`).click();await idle();
   while(await p.locator('#load-more').isVisible()){await p.locator('#load-more').click();await idle();}
   ok(await p.locator('#feed a').count()===n,'all filter pages '+s);
  }
  delay=500;await p.locator('[data-sender="owner"]').click();await p.locator('[data-scope="app"]').click();await idle();await p.waitForTimeout(600);
  ok(await p.locator('#feed a').count()===1&&(await p.locator('#feed a').getAttribute('data-path')).startsWith('Support/'),'late previous sender response cannot contaminate App data');
  delay=0;await p.locator('[data-scope="personal"]').click();await idle();
  await p.locator('[data-type="photo"]').click();await idle();
  ok(await p.locator('[data-sender=""]').getAttribute('aria-pressed')==='true','scope/category resets sender');
  await p.locator('#search-input').fill('first');await p.locator('#search-input').fill('second');await idle();await p.waitForTimeout(250);
  ok((await p.locator('#result-count').innerText()).startsWith('120 of'),'search resets pagination');
  mode='stuck';calls=0;await p.reload();await idle();ok(calls===8,'persistent partial stops after eight requests');
  ok((await p.locator('#status-banner').innerText()).includes('Tap to retry'),'bounded exhaustion offers explicit retry');
  mode='ready';await p.locator('#status-banner').click();await idle();ok(await p.locator('#photo-provenance-note').isHidden(),'explicit retry resolves preparation');
  ok(errors.length===0,'no browser errors');
  fs.writeFileSync(out+'/fixture-pagination.json',JSON.stringify({fixture:true,checks,errors},null,2));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});
