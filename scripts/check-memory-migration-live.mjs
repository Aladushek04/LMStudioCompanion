// Explicit selected-loaded-model acceptance; synthetic state only, no user chat/history/config.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {LMStudioClient,ChatMessage,Chat} from '@lmstudio/sdk';
import {startManagementServer} from '../dist/host/src/server.js';
import {preprocess} from '../dist/lmstudio-plugin/src/index.js';
const requested=process.argv[2];if(!requested)throw Error('Укажите ID уже загруженной 12B; загрузка не выполняется.');
const client=new LMStudioClient(),loaded=await client.llm.listLoaded(),model=loaded.find(m=>m.identifier===requested||m.modelKey===requested);if(!model||!/12b/i.test(model.modelKey+' '+model.identifier))throw Error('Нужна указанная уже загруженная 12B.');
const root=resolve('.tools'),dir=await mkdtemp(join(root,'c5-live-'));let host;
try{
 host=await startManagementServer(dir,new AbortController().signal);const call=async(path,method='GET',body)=>{const r=await fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert(r.ok);return r.json();};
 const file=(await call('/api/memory/connection','POST',{})).file;
 const upload=await fetch(host.origin+'/api/memory/migration/preview',{method:'POST',headers:{Authorization:'Bearer '+host.token,Origin:host.origin,'Content-Type':'application/octet-stream','X-Companion-Offline-Copy':'confirmed'},body:await readFile(new URL('../tests/fixtures/memory-v2.json',import.meta.url))});assert(upload.ok);const preview=await upload.json();assert.equal(preview.skippedSessions,1);
 const result=(await call('/api/memory/migration/apply','POST',{previewId:preview.id,baseRevision:preview.baseRevision,ids:preview.records.map(r=>r.id)})).value;assert.equal(result.imported,2);
 const states=[];const ctl={abortSignal:AbortSignal.timeout(90000),getPluginConfig:()=>({get:key=>key==='useMemory'?true:'off'}),getGlobalPluginConfig:()=>({get:key=>key==='memoryLinkFile'?file:''}),createStatus:s=>{states.push(s.text);return {setState:s=>states.push(s.text)};},tokenSource:async()=>model,pullHistory:async()=>Chat.empty()};
 const prepared=await preprocess(ctl,ChatMessage.create('user','Назови код учебного порта из памяти. Ответь только кодом.'));assert(prepared.getText().includes('ЛАЗУРЬ-615'));assert(!prepared.getText().includes('Учебный проект — Берег'));assert(!prepared.getText().includes('SECRET_SESSION_FIXTURE'));
 const generate=async message=>{const h=Chat.empty();h.append(message);const prediction=model.respond(h,{maxTokens:1024,temperature:0}),cancel=()=>prediction.cancel();ctl.abortSignal.addEventListener('abort',cancel,{once:true});try{const r=await prediction;return r.nonReasoningContent;}finally{ctl.abortSignal.removeEventListener('abort',cancel);}};
 const answer=await generate(prepared);assert(answer.includes('ЛАЗУРЬ-615'));const before=(await call('/api/memory/connection')).usage;assert.equal(before.refs.length,1);
 await call('/api/memory/migration/undo','POST',{id:result.backupId,expectedRevision:result.revision});const next=await preprocess(ctl,ChatMessage.create('user','Сколько будет 2+2? Ответь одним числом.'));const after=(await call('/api/memory/connection')).usage;assert.deepEqual(after.refs,[]);assert.equal((await call('/api/memory')).records.length,0);const normal=await generate(next);assert.equal(normal.trim(),'4');
 await mkdir(resolve('data'),{recursive:true});await writeFile(resolve('data/memory-c5-live.json'),JSON.stringify({checkedAt:new Date().toISOString(),model:model.identifier,loadedOnly:true,synthetic:true,imported:2,skippedSession:1,globalInjected:before.refs.length,projectNotInjected:true,modelReturnedImportedValue:true,undo:true,afterUndoIds:after.refs,normalAnswerAfterUndo:normal.trim(),nativeUi:false,extraModelForRecall:false},null,2));console.log('PASS C5 live: selected loaded12B, synthetic import/global recall/model answer/undo/zero refs/4; no private chat.');
}finally{await host?.close();if(dirname(dir)!==root||!basename(dir).startsWith('c5-live-'))throw Error('Unexpected cleanup path');await rm(dir,{recursive:true,force:true});}
