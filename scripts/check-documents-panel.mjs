// D2 UI acceptance through the real management server with a synthetic parser.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {startManagementServer} from '../dist/host/src/server.js';
const directory=await mkdtemp(join(tmpdir(),'companion-doc-ui-')),artifact=resolve('data/ui');
await mkdir(artifact,{recursive:true});let badCalls=0,closed=0,browser;
const host=await startManagementServer(directory,new AbortController().signal,{probe:async()=>({lmStudioVersion:'fixture',checkedAt:new Date().toISOString(),features:{}}),documentsOptions:{createSession:()=>({backend:{async parse({name,bytes,signal}){
 if(name==='slow.pdf')return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
 if(name==='scan.pdf')return {text:' ',parser:{library:'builtIn',version:'1'}};
 if(name==='broken.pdf'&&badCalls++===0)throw Error('private fixture failure');
 return {text:name.endsWith('.txt')?Buffer.from(bytes).toString():'D2 PDF MINT-482',parser:{library:'builtIn',version:'1'}};
}},async close(){closed++;}})}});
try{
 browser=await chromium.launch({executablePath:process.env.COMPANION_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const errors=[];
 async function page(){const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));await p.goto(host.origin+'/#token='+host.token);await p.getByRole('button',{name:'Документы',exact:true}).click();await p.getByText('Файлов пока нет.',{exact:true}).waitFor();return p;}
 const a=await page(),input=a.getByLabel('Файлы TXT или PDF',{exact:true});
 await input.setInputFiles(['harbor.txt','text.pdf','scan.pdf','broken.pdf'].map(name=>resolve('tests/fixtures/documents',name)));await a.getByRole('button',{name:'Добавить файлы',exact:true}).click();
 const card=name=>a.getByRole('article').filter({has:a.getByRole('heading',{name,exact:true})});
 await card('harbor.txt').getByText('Готов',{exact:true}).waitFor();await card('text.pdf').getByText('Готов',{exact:true}).waitFor();await card('scan.pdf').getByText('Текст не извлечён',{exact:true}).waitFor();await card('broken.pdf').getByText('Ошибка',{exact:true}).waitFor();
 const firstChoice=card('harbor.txt').getByRole('checkbox');await firstChoice.click();await assertChecked(firstChoice);await firstChoice.click();await assertChecked(firstChoice,false);
 await card('text.pdf').getByRole('button',{name:'Посмотреть текст',exact:true}).click();const dialog=a.getByRole('dialog');await dialog.getByText('D2 PDF MINT-482',{exact:true}).waitFor();await dialog.getByText(/Номера страниц и главы/).waitFor();await a.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 await card('broken.pdf').getByRole('button',{name:'Повторить',exact:true}).click();await card('broken.pdf').getByText('Готов',{exact:true}).waitFor();
 const b=await page();assert.equal(await b.getByRole('article').count(),0);await b.close();
 const [clone]=await Promise.all([a.waitForEvent('popup'),a.evaluate(()=>{window.open(location.href);})]);clone.on('pageerror',e=>errors.push(e.message));await clone.getByRole('button',{name:'Документы',exact:true}).click();await clone.getByText('Файлов пока нет.',{exact:true}).waitFor({timeout:3000});assert.equal(await clone.getByRole('article').count(),0);await clone.getByRole('button',{name:'Очистить список',exact:true}).isDisabled();await clone.close();
 await input.setInputFiles({name:'slow.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});await a.getByRole('button',{name:'Добавить файлы',exact:true}).click();await card('slow.pdf').getByText('Обрабатывается',{exact:true}).waitFor();await card('slow.pdf').getByRole('button',{name:'Отменить обработку',exact:true}).click();await card('slow.pdf').getByText('Отменено',{exact:true}).waitFor();assert.equal(await card('slow.pdf').getByRole('button',{name:'Посмотреть текст',exact:true}).count(),0);
 await card('slow.pdf').getByRole('button',{name:'Убрать из списка',exact:true}).click();await card('slow.pdf').waitFor({state:'detached'});
 const payload='<img src=x onerror="window.D2_XSS=1">';await input.setInputFiles({name:'a'.repeat(185)+'.txt',mimeType:'text/plain',buffer:Buffer.from(payload)});await a.getByRole('button',{name:'Добавить файлы',exact:true}).click();const long=card('a'.repeat(185)+'.txt');await long.getByText('Готов',{exact:true}).waitFor();await long.getByRole('button',{name:'Посмотреть текст',exact:true}).click();await dialog.getByText(payload,{exact:true}).waitFor();assert.equal(await dialog.locator('img').count(),0);assert.equal(await a.evaluate(()=>window.D2_XSS),undefined);await a.keyboard.press('Escape');
 await a.screenshot({path:join(artifact,'documents-desktop.png'),fullPage:true});
 await a.getByRole('button',{name:'Обзор',exact:true}).click();await a.getByRole('button',{name:'Документы',exact:true}).click();assert.equal(await a.getByRole('article').count(),5);
 await a.reload();await a.getByRole('button',{name:'Документы',exact:true}).click();await card('harbor.txt').waitFor();assert.equal(await a.getByRole('article').count(),5);
 await a.setViewportSize({width:320,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.screenshot({path:join(artifact,'documents-mobile.png'),fullPage:true});
 await a.evaluate(()=>{document.documentElement.style.fontSize='200%';});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const checkbox=card('harbor.txt').getByRole('checkbox');await checkbox.focus();await a.keyboard.press('Space');await assertChecked(checkbox);await a.keyboard.press('Tab');assert.notEqual(await a.evaluate(()=>document.activeElement?.tagName),'BODY');
 await card('harbor.txt').getByRole('button',{name:'Посмотреть текст',exact:true}).click();await dialog.waitFor();assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.keyboard.press('Escape');
 await a.getByRole('button',{name:'Очистить список',exact:true}).click();await a.getByText('Файлов пока нет.',{exact:true}).waitFor();assert.equal(await a.getByRole('article').count(),0);assert.equal(await a.evaluate(()=>sessionStorage.getItem('companion-document-workspace')),null);
 assert(closed>=6);assert.deepEqual(errors,[]);console.log('PASS D2 synthetic UI: TXT/PDF/scan/error/retry/cancel/selection/tab isolation/reload/escaping/keyboard/320px/200%; pageerror=0');
}finally{await browser?.close();await host.close();await rm(directory,{recursive:true,force:true});}
async function assertChecked(locator,checked=true){for(let i=0;i<20;i++){if(await locator.isChecked()===checked)return;await new Promise(r=>setTimeout(r,50));}assert.fail('Checkbox did not update');}
