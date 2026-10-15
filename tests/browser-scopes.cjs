/* Isolated fixture browser QA. Real app/server and approved core; transfer API is an explicit fixture. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict'), fs=require('node:fs');
const base=process.env.BASE_URL || 'http://127.0.0.1:18877/';
const out=process.env.QA_OUT || '.';
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const checks=[], errors=[];
  const ok=(condition,label)=>{assert(condition,label);checks.push(label);console.log('PASS',label);};
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    assert(process.env.CORE_URL,'CORE_URL must point to approved app-client.js');
    const core=await context.request.get(process.env.CORE_URL);assert(core.ok());
    const coreBody=await core.body();
    await page.route('**/wizard-os-home/core/app-client.js',r=>r.fulfill({status:200,contentType:'text/javascript',body:coreBody}));
    const uploadCalls=[];let offset=0, uploadSize=0;
    await page.route('**/wizard/v1/uploads**',async route=>{
      const request=route.request(), method=request.method(), path=new URL(request.url()).pathname;
      uploadCalls.push({method,path,body:method==='POST'?request.postDataJSON():null});
      if(method==='POST'&&path==='/wizard/v1/uploads'){
        uploadSize=request.postDataJSON().bytes;
        return route.fulfill({json:{upload_id:'fixture-upload',offset,chunk_bytes:262144}});
      }
      if(method==='PATCH'){
        assert.equal(Number(request.headers()['upload-offset']),offset);
        offset+=request.postDataBuffer().length;
        return route.fulfill({status:204,headers:{'Upload-Offset':String(offset)}});
      }
      if(method==='POST'&&path.endsWith('/complete'))return route.fulfill({json:{file:{path:'Recorder/user-upload.txt',folder:'Recorder'}}});
      return route.fulfill({json:{offset,status:'uploading'}});
    });
    await page.route('**/api/files/content?path=Recorder%2Fuser-upload.txt',r=>r.fulfill({status:200,headers:{'Content-Length':String(uploadSize)}}));
    await page.goto(base);await page.locator('.feed-section[aria-busy="false"]').waitFor();
    ok(await page.locator('[data-scope="personal"]').getAttribute('aria-pressed')==='true','default personal');
    ok((await page.locator('#feed').innerText()).includes('mysterious-agent-draft.json'),'unknown agent-looking filename retained');
    ok(!(await page.locator('#feed').innerText()).includes('chapter.md'),'app chapter absent from personal Recent');
    await page.locator('[data-scope="app"]').click();await page.locator('.feed-section[aria-busy="false"]').waitFor();
    ok((await page.locator('#feed').innerText()).includes('chapter.md'),'app Recent present');
    ok(!(await page.locator('#feed').innerText()).includes('session.wav'),'recording absent from app scope');
    await page.locator('#search-input').fill('chapter');await page.waitForFunction(()=>document.querySelector('#result-count').textContent==='1 of 1');
    await page.locator('#feed a').click();await page.locator('#my-sheet:not([hidden])').waitFor();
    const chapter=await context.request.get(new URL(await page.locator('#my-sheet-actions .primary').getAttribute('href'),base).href);
    ok(chapter.ok()&&(await chapter.text()).includes('chapter'),'chapter opens through unchanged content boundary');
    await page.locator('#my-sheet .sheet-close').click();await page.locator('#my-sheet').waitFor({state:'hidden'});
    ok(await page.locator('#my-upload').isHidden(),'App data upload hidden');
    await page.goBack();await page.waitForTimeout(100);
    ok(!page.isClosed()&&page.url().startsWith(base),'nested browser Back stays in app');
    await page.locator('[data-scope="personal"]').click();await page.locator('.feed-section[aria-busy="false"]').waitFor();
    ok(await page.locator('#search-input').inputValue()==='','scope clears prior search');
    ok(!(await page.locator('#feed').innerText()).includes('chapter.md'),'return personal has no stale app results');
    // Hold an app index reply, return to personal, then release the old reply.
    let release,started;const began=new Promise(r=>started=r), held=new Promise(r=>release=r);
    await page.route('**/api/index?**',async r=>{if(new URL(r.request().url()).searchParams.get('scope')==='app'){const response=await r.fetch();started();await held;await r.fulfill({response});}else await r.continue();});
    await page.locator('[data-scope="app"]').click();await began;
    await page.locator('[data-scope="personal"]').click();await page.locator('.feed-section[aria-busy="false"]').waitFor();release();await page.waitForTimeout(250);
    ok(!(await page.locator('#feed').innerText()).includes('chapter.md'),'late app response discarded');
    await page.unroute('**/api/index?**');
    await page.locator('[data-type="my"]').click();await page.locator('#my-list[aria-busy="false"]').waitFor();
    ok(await page.locator('.my-folder[data-name="Library"]').count()===0,'personal folders skip app subtree');
    await page.locator('.my-folder[data-name="Recorder"]').click();await page.locator('#my-list[aria-busy="false"]').waitFor();
    ok((await page.locator('#my-list').innerText()).includes('session.wav'),'personal recording available');
    ok(!(await page.locator('#my-list').innerText()).includes('manifest.json'),'mixed parent hides only app metadata');
    ok(await page.locator('#my-upload').isEnabled(),'personal upload enabled');
    await page.locator('#my-picker').setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    await page.getByText('App data is read-only here. Choose a folder in Your files.',{exact:true}).waitFor();
    ok(uploadCalls.length===0,'metadata filename upload rejected before transfer');
    await page.locator('#my-picker').setInputFiles({name:'user-upload.txt',mimeType:'text/plain',buffer:Buffer.alloc(600000,97)});
    await page.locator('.my-upload[data-state="done"]').waitFor();
    ok(uploadCalls[0].body.destination.folder==='Recorder','personal upload destination preserved');
    ok(uploadCalls.filter(c=>c.method==='PATCH').length===3&&offset===600000,'shared chunk and completion protocol preserved (fixture)');
    await page.screenshot({path:out+'/fixture-phone.png',fullPage:true});
    // A saved paused upload into now-classified data must also fail before POST.
    const blockedCalls=uploadCalls.length;
    await page.evaluate(()=>localStorage.setItem('wizard-files:uploads:v1',JSON.stringify([{key:'protected-resume',client_upload_id:'protected-resume',upload_id:'',name:'manifest.json',size:2,lastModified:0,type:'application/json',folder:'Recorder',created:1}])));
    await page.reload();await page.locator('#my-list[aria-busy="false"]').waitFor();
    await page.getByText('Choose file',{exact:true}).click();
    await page.locator('#my-repick').setInputFiles({name:'manifest.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    await page.getByText('App data is read-only here. Choose a folder in Your files.',{exact:true}).waitFor();
    ok(uploadCalls.length===blockedCalls,'saved app-data upload cannot resume');
    ok(errors.length===0,'no browser errors');
    fs.writeFileSync(out+'/fixture-browser.json',JSON.stringify({checks,errors,uploadCalls,transfer:'isolated fixture; no production writes'},null,2));
    await context.close();
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
