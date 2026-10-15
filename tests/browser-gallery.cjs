/* Run on configured worker. Fixture proof and actual deployed-owner proof are distinct receipts. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict'), fs=require('node:fs');
const base=process.env.BASE_URL || 'http://127.0.0.1:18879/';
const out=process.env.QA_OUT || '.', live=process.env.LIVE==='1';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,downloadsPath:out+'/downloads'});
 const checks=[],errors=[],ranges=[],pixels=[],playback=[];
 const ok=(condition,label)=>{assert(condition,label);checks.push(label);console.log('PASS',label);};
 try {
  for(const phone of [true,false]){
   const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1280,height:900},isMobile:phone,hasTouch:phone});
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   page.on('response',r=>{if(r.url().includes('/api/files/content?')&&r.request().headers().range)ranges.push({status:r.status(),range:r.request().headers().range,contentRange:r.headers()['content-range'],path:new URL(r.url()).searchParams.get('path')});});
   if(!live){
    const core=await context.request.get(process.env.CORE_URL);assert(core.ok());
    const body=await core.body();await page.route('**/wizard-os-home/core/app-client.js',r=>r.fulfill({body,contentType:'text/javascript'}));
   }
   await page.goto(base);
   let f=page;
   if(live){
    await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>new URL(f.src||'about:blank',location.href).pathname==='/wizard-files/'));
    for(let attempt=0;attempt<100;attempt++){
      f=page.frames().find(frame=>new URL(frame.url()||'about:blank').pathname==='/wizard-files/');
      if(f)break;
      await page.waitForTimeout(100);
    }
    assert(f,'canonical app iframe navigation completed');
   }
   await f.locator('.feed-section[aria-busy="false"]').waitFor();
   ok(await f.locator('[data-scope="personal"]').getAttribute('aria-pressed')==='true','cold personal '+phone);
   if(live)ok(await f.evaluate(()=>WizardApp.hosted),'approved real hosted client '+phone);
   await f.locator('[data-type="video"]').click();await f.locator('.feed-section[aria-busy="false"]').waitFor();
   const hash=await f.evaluate(()=>location.hash);
   const cards=f.locator('#feed .video-card');const count=await cards.count();ok(count>0,'video gallery populated '+phone);
   // Exercise every currently listed real video, not just the first src string.
   for(let i=0;i<count;i++){
    const card=cards.nth(i);await card.scrollIntoViewIfNeeded();
    await card.locator('.video-thumbnail img').waitFor({timeout:45000});
    const pixel=await card.locator('.video-thumbnail img').evaluate(async img=>{
      await img.decode();const c=document.createElement('canvas');c.width=32;c.height=32;
      const g=c.getContext('2d');g.drawImage(img,0,0,32,32);const d=g.getImageData(0,0,32,32).data;
      const colors=new Set();let sum=0;for(let i=0;i<d.length;i+=4){colors.add([d[i],d[i+1],d[i+2]].join(','));sum+=d[i]+d[i+1]+d[i+2];}
      const r=img.parentElement.getBoundingClientRect();return {width:img.naturalWidth,height:img.naturalHeight,colors:colors.size,sum,displayWidth:r.width,displayHeight:r.height,state:img.parentElement.dataset.thumbnail};
    });
    pixels.push({phone,index:i,...pixel});
    ok(pixel.width>=160&&pixel.colors>8&&pixel.sum>0,'decoded real thumbnail pixels '+phone+'/'+i);
    ok(pixel.displayWidth>=250&&pixel.displayHeight>=160,'large thumbnail '+phone+'/'+i);
    await card.locator('.item-title').click();await f.locator('#my-sheet:not([hidden]) video').waitFor();
    await f.waitForFunction(()=>{const v=document.querySelector('#my-sheet video');return v&&!v.paused&&v.currentTime>.25;},{},{timeout:25000});
    const first=await f.locator('#my-sheet video').evaluate(v=>({time:v.currentTime,duration:v.duration,controls:v.controls,muted:v.muted,width:v.videoWidth}));
    await page.waitForTimeout(350);const next=await f.locator('#my-sheet video').evaluate(v=>v.currentTime);
    playback.push({phone,index:i,...first,next});
    ok(first.controls&&first.muted&&first.width>0&&next>first.time,'title tap directly plays progressing muted video '+phone+'/'+i);
    ok(await f.locator('video').count()===1,'only one live player '+phone+'/'+i);
    await f.locator('#my-sheet video').evaluate(v=>v.pause());
    const target=Math.min(first.duration/2,2);
    await f.locator('#my-sheet video').evaluate((v,t)=>v.currentTime=t,target);
    await f.waitForFunction(t=>Math.abs(document.querySelector('#my-sheet video').currentTime-t)<.2,target);
    ok(await f.locator('#my-sheet video').evaluate(v=>v.paused),'pause and seek '+phone+'/'+i);
    if(i===0){
      await f.getByRole('button',{name:'Fullscreen',exact:true}).click();
      await f.waitForFunction(()=>!!document.fullscreenElement);
      ok(true,'native fullscreen entered '+phone);
      await f.evaluate(()=>document.exitFullscreen());
    }
    if(live&&i===0){
      const result=await page.evaluate(()=>WizAppServices.back([...document.querySelectorAll('iframe')].find(f=>new URL(f.src||'about:blank',location.href).pathname==='/wizard-files/')));
      ok(result==='handled','host Back closes player '+phone);
    }else await f.locator('#my-sheet .sheet-close').click();
    await f.locator('#my-sheet').waitFor({state:'hidden'});
    ok(await f.evaluate(()=>location.hash)===hash,'close restores exact gallery '+phone+'/'+i);
    ok(await f.locator('video').count()===0,'close releases media '+phone+'/'+i);
   }
   // Re-render must use the device cache, not decode each video again.
   await f.locator('[data-view="grid"]').click();
   await f.locator('#feed .video-card').first().scrollIntoViewIfNeeded();
   await f.locator('#feed [data-thumbnail="cached"]').first().waitFor();
   ok(true,'bounded frame cache reused '+phone);
   await page.screenshot({path:out+`/${live?'live':'fixture'}-${phone?'phone':'desktop'}-gallery.png`,fullPage:true});
   if(!live&&phone){
    await f.locator('[data-scope="app"]').click();await f.locator('.feed-section[aria-busy="false"]').waitFor();
    ok((await f.locator('#feed').innerText()).includes('chapter.md'),'App data preserved');
    await f.locator('[data-scope="personal"]').click();await f.locator('.feed-section[aria-busy="false"]').waitFor();
    await f.locator('[data-type="photo"]').click();await f.locator('.feed-section[aria-busy="false"]').waitFor();
    ok(await f.locator('#feed a').count()===4,'fixture photos exclude app artwork');
    for(const [label,n,names] of [['From Fixture Owner',2,['both.png','user.png']],['From Fixture Guide',2,['both.png','agent.png']],['Other / unknown',1,['unknown.png']],['All',4,[]]]){
      await f.getByRole('button',{name:label,exact:true}).click();await f.locator('.feed-section[aria-busy="false"]').waitFor();
      const text=await f.locator('#feed').innerText();ok(await f.locator('#feed a').count()===n&&names.every(name=>text.includes(name)),'fixture sender '+label);
    }
    await page.screenshot({path:out+'/fixture-photo-filters.png',fullPage:true});
    const file=process.env.FIXTURE_ROOT+'/.wizard/photo-provenance.json',original=fs.readFileSync(file);
    try{
      fs.writeFileSync(file,'{');await page.reload();await f.locator('.feed-section[aria-busy="false"]').waitFor();
      ok(await f.locator('#photo-provenance-note').isVisible(),'missing/malformed provenance graceful unknown UI');
      ok(await f.locator('#feed a').count()===4,'missing provenance loses no photos');
    }finally{fs.writeFileSync(file,original);}
   }
   await context.close();
  }
  ok(ranges.some(r=>r.status===206&&r.contentRange),'observed real media byte Range / 206 requests');
  ok(errors.length===0,'no uncaught browser errors');
  fs.writeFileSync(out+'/'+(live?'live':'fixture')+'-gallery.json',JSON.stringify({live,base,checks,errors,ranges,pixels,playback,productionWrites:0},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
