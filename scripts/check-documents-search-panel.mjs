import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright-core';
import {startManagementServer} from '../dist/host/src/server.js';
const directory=await mkdtemp(join(tmpdir(),'companion-d3-ui-'));let browser,finish=()=>{};
const host=await startManagementServer(directory,new AbortController().signal,{probe:async()=>({lmStudioVersion:'fixture',checkedAt:new Date().toISOString(),features:{}}),documentsOptions:{
 createSession:()=>({backend:{async parse({bytes}){return {text:Buffer.from(bytes).toString(),parser:{library:'builtIn',version:'1'}};}},async close(){}}),
 createTokenizer:()=>({async prepare(query){if(query.includes('ошибка'))throw Error('fixture tokenizer');return {modelIdentifier:'synthetic-tokenizer',contextLength:32768,measure:async text=>{if(query.includes('ожидание'))return new Promise(r=>{finish=()=>r(1);});return query.includes('лимит')?999999:Math.ceil(text.length/3);}};},async close(){finish();}})
}});
try{
 browser=await chromium.launch({executablePath:process.env.COMPANION_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const a=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];a.on('pageerror',e=>errors.push(e.message));await a.goto(host.origin+'/#token='+host.token);await a.getByRole('button',{name:'Документы',exact:true}).click();
 const text='# Финансы\nБюджет 187500 рублей.\n# Контакты\nКоординатор Лидия Белова. <img src=x onerror="window.D3_XSS=1">';
 await a.getByLabel('Файлы TXT или PDF',{exact:true}).setInputFiles({name:'manual.txt',mimeType:'text/plain',buffer:Buffer.from(text)});await a.getByRole('button',{name:'Добавить файлы',exact:true}).click();const card=a.getByRole('article').filter({has:a.getByRole('heading',{name:'manual.txt',exact:true})});await card.getByText('Готов',{exact:true}).waitFor();await card.getByRole('checkbox').click();await a.getByLabel('Вопрос к документам',{exact:true}).waitFor();
 const question=a.getByLabel('Вопрос к документам',{exact:true}),run=a.getByRole('button',{name:'Найти фрагменты',exact:true}),area=a.getByLabel('Область manual.txt',{exact:true});
 await question.fill('Какой бюджет?');await run.click();await a.getByText('Найдены фрагменты',{exact:true}).waitFor();await a.getByRole('button',{name:'Открыть фрагмент 1',exact:true}).click();const dialog=a.getByRole('dialog');await dialog.getByText(/187500 рублей/).waitFor();await a.keyboard.press('Escape');
 await area.selectOption('sections');await a.getByRole('checkbox',{name:'Контакты',exact:true}).check();await run.click();await a.getByText('Совпадений не найдено',{exact:true}).waitFor();
 await a.getByRole('checkbox',{name:'Контакты',exact:true}).uncheck();await a.getByRole('checkbox',{name:'Финансы',exact:true}).check();await run.click();await a.getByText('Найдены фрагменты',{exact:true}).waitFor();
 const whole=a.getByRole('checkbox',{name:'Нужно изучить всю выбранную область',exact:true});await whole.check();
 await card.getByRole('checkbox').click();await area.waitFor({state:'detached'});await card.getByRole('checkbox').click();await area.waitFor();assert.equal(await area.inputValue(),'sections');assert.equal(await a.getByRole('checkbox',{name:'Финансы',exact:true}).isChecked(),true);assert.equal(await whole.isChecked(),true);await whole.uncheck();
 await area.selectOption('whole');await question.fill('Бюджет лимит');await run.click();await a.getByText('Фрагменты не поместились',{exact:true}).waitFor();assert.equal(await a.getByRole('button',{name:'Открыть фрагмент 1',exact:true}).count(),0);
 await question.fill('Бюджет ошибка');await run.click();await a.getByRole('alert').filter({hasText:'Токенизатор недоступен'}).waitFor();
 await question.fill('Бюджет ожидание');await run.click();await a.getByRole('button',{name:'Отменить подбор',exact:true}).click();await a.getByText('Подбор отменён.',{exact:true}).waitFor();
 await question.fill('Координатор');await run.click();await a.getByText('Найдены фрагменты',{exact:true}).waitFor();await a.getByRole('button',{name:'Открыть фрагмент 1',exact:true}).click();await dialog.getByText(/<img src=x/).waitFor();assert.equal(await dialog.locator('img').count(),0);assert.equal(await a.evaluate(()=>window.D3_XSS),undefined);await a.keyboard.press('Escape');
 const artifact=resolve('data/ui');await mkdir(artifact,{recursive:true});await a.screenshot({path:join(artifact,'documents-search-desktop.png'),fullPage:true});
 await a.setViewportSize({width:320,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await a.screenshot({path:join(artifact,'documents-search-mobile.png'),fullPage:true});await a.evaluate(()=>{document.documentElement.style.fontSize='200%';});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await question.focus();await a.keyboard.press('Tab');assert.notEqual(await a.evaluate(()=>document.activeElement?.tagName),'BODY');
 let release,markHeld;const held=new Promise(r=>{markHeld=r;});await a.route('**/api/documents/*/search',async route=>{const response=await route.fetch();markHeld();await new Promise(r=>{release=r;});try{await route.fulfill({response});}catch{/* Caller deliberately aborted on selection change. */}});
 await question.fill('Бюджет');await run.click();await held;await card.getByRole('checkbox').click();release();await a.waitForTimeout(100);assert.equal(await a.getByText('Найдены фрагменты',{exact:true}).count(),0);assert.equal(await a.getByRole('dialog').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS D3 synthetic UI: search/sections/exact citation/no-match/budget/error/cancel/stale/escaping/320px/200%/keyboard; pageerror=0');
}finally{await browser?.close();await host.close();await rm(directory,{recursive:true,force:true});}
