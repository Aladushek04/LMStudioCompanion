import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {startManagementServer} from '../dist/host/src/server.js';
import {memoryRequest} from '../dist/lmstudio-plugin/src/memory/client.js';

const dir=await mkdtemp(join(tmpdir(),'companion-memory-feedback-'));
const host=await startManagementServer(dir,new AbortController().signal,{probe:async()=>({lmStudioVersion:'fixture',checkedAt:new Date().toISOString(),features:{}})});
let browser;
const releases=[];
try{
 browser=await chromium.launch({executablePath:process.env.COMPANION_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(host.origin+'/#token='+host.token);
 await page.getByRole('button',{name:'Память',exact:true}).click();
 await page.getByText('Записей пока нет. Добавьте первую запись.',{exact:true}).waitFor();
 await page.getByText('Ожидающих предложений нет.',{exact:true}).waitFor();
 const list=page.getByRole('status',{name:'Обновление списка памяти',exact:true});
 const proposals=page.getByRole('status',{name:'Обновление предложений памяти',exact:true});
 async function refresh(path,button,status,loading,result){
  let release;
  const held=new Promise(resolve=>{release=resolve;});releases.push(release);
  await page.route('**'+path,async route=>{const response=await route.fetch();await held;await route.fulfill({response});},{times:1});
  await button.click();
  await status.filter({hasText:loading}).waitFor({timeout:2000});
  assert.equal(await button.isDisabled(),true);
  release();await status.filter({hasText:result}).waitFor({timeout:2000});
  assert.equal(await button.isEnabled(),true);
 }
 const listButton=page.getByRole('button',{name:'Обновить список',exact:true});
 const proposalButton=page.getByRole('button',{name:'Обновить предложения',exact:true});
 await refresh('/api/memory',listButton,list,'Обновляем список…',/Список обновлён в \d{2}:\d{2}:\d{2}\. Всего записей: 0\./);
 await refresh('/api/memory/proposals',proposalButton,proposals,'Обновляем предложения…',/Предложения обновлены в \d{2}:\d{2}:\d{2}\. Ожидают подтверждения: 0\./);
 // A failed refresh must clear the previous success, and a retry must recover.
 for(const [path,button,status] of [['/api/memory',listButton,list],['/api/memory/proposals',proposalButton,proposals]]){
  await page.route('**'+path,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Тестовый отказ обновления'})}),{times:1});
  await button.click();await page.getByRole('alert').waitFor({timeout:2000});
  assert.equal((await status.textContent()).trim(),'');
  assert.equal(await button.isEnabled(),true);
  await button.click();await status.filter({hasText:/обновл[её]н/}).waitFor({timeout:2000});
  assert.equal(await page.getByRole('alert').count(),0);
 }
 const call=async(path,method='GET',body)=>{
  const response=await fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert(response.ok);return response.json();
 };
 const file=(await call('/api/memory/connection','POST',{})).file;
 await memoryRequest(file,{action:'capture',mode:'explicit',text:'Запомни: Учебный код СОСНА-731'},new AbortController().signal);
 await proposalButton.click();await proposals.filter({hasText:'Ожидают подтверждения: 1.'}).waitFor();
 await page.getByRole('article',{name:'Предложение памяти',exact:true}).getByRole('button',{name:'Сохранить',exact:true}).click();
 await page.getByText('Предложение применено.',{exact:true}).waitFor();
 await listButton.click();await list.filter({hasText:'Всего записей: 1.'}).waitFor();
 const out=resolve('data/ui');await mkdir(out,{recursive:true});
 await page.screenshot({path:join(out,'memory-feedback-desktop.png'),fullPage:true});
 await page.setViewportSize({width:320,height:900});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:join(out,'memory-feedback-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS memory feedback: loading/disabled/completion/time/count/empty/error/retry/proposal acceptance/320px');
}finally{
 for(const release of releases)release();
 await browser?.close();await host.close();
 // mkdtemp supplies the exact test-owned directory; no user storage is opened.
 await rm(dir,{recursive:true,force:true});
}
