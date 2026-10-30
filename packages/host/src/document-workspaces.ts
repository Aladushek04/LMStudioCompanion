import {randomUUID} from 'node:crypto';
import {LMStudioClient} from '@lmstudio/sdk';
import {createDocumentAdapter} from '../../documents/src/adapter.js';
import {createSdkDocumentBackend} from '../../documents/src/sdk-backend.js';
import {documentLimits,type DocumentBackend,type DocumentState,type DocumentLimits} from '../../documents/src/types.js';
import {hash} from '../../documents/src/text.js';
import type {DocumentItem,DocumentWorkspace} from '../../documents/src/workspace-types.js';
import type {DocumentSearchResponse} from '../../documents/src/workspace-types.js';
import {documentSections} from '../../documents/src/scope.js';
import type {DocumentScope,DocumentSnapshot,DocumentCitation} from '../../documents/src/retrieval-types.js';
import type {DocumentTokenizerSession} from './document-tokenizer.js';

export class DocumentHttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
export interface DocumentSession {backend:DocumentBackend;close():Promise<void>}
export interface DocumentsOptions {createSession?:()=>DocumentSession;now?:()=>number;idleMs?:number;limits?:Partial<DocumentLimits>;createTokenizer?:()=>DocumentTokenizerSession;searchDeadlineMs?:number}
interface Entry {item:DocumentItem;bytes:Uint8Array;document:DocumentState|null;attempt:number;abort:AbortController|null}
interface Workspace {id:string;entries:Map<string,Entry>;reservedCount:number;reservedBytes:number;touched:number;search?:{response:DocumentSearchResponse;isCurrent:()=>boolean}|null}
const bad=(message='Некорректный запрос.')=>new DocumentHttpError(400,message);
function nativeSession():DocumentSession {
 const client=new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:{debug(){},info(){},warn(){},error(){}}});
 return {backend:createSdkDocumentBackend(client),close:()=>client[Symbol.asyncDispose]()};
}

export function createDocumentWorkspaces(options:DocumentsOptions={}){
 const sets=new Map<string,Workspace>(),queue:{workspace:Workspace;entry:Entry;attempt:number}[]=[];
 const now=options.now??Date.now,idleMs=options.idleMs??30*60*1000;
 let closed=false,running=false,closeActive:(()=>Promise<void>)|null=null;
 const touch=(set:Workspace)=>{set.touched=now();};
 const cancel=(entry:Entry)=>{
  entry.attempt++;entry.abort?.abort();entry.abort=null;entry.document=null;
  Object.assign(entry.item,{status:'cancelled',selected:false,version:null,code:'CANCELLED',reason:'Обработка отменена.',revision:entry.item.revision+1,sections:[],sectionNotice:null});
 };
 const drop=(set:Workspace)=>{sets.delete(set.id);for(const entry of set.entries.values())cancel(entry);set.entries.clear();for(let i=queue.length-1;i>=0;i--)if(queue[i]!.workspace===set)queue.splice(i,1);};
 const sweep=()=>{for(const set of sets.values())if(now()-set.touched>=idleMs)drop(set);};
 const timer=setInterval(sweep,Math.min(idleMs,60000));timer.unref();
 function get(id:string){sweep();const set=sets.get(id);if(closed||!set)throw new DocumentHttpError(404,'Рабочий набор завершён. Добавьте файлы заново.');touch(set);return set;}
 function entryAt(set:Workspace,id:string){const entry=set.entries.get(id);if(!entry)throw new DocumentHttpError(404,'Файл уже убран из списка.');return entry;}
 function view(set:Workspace):DocumentWorkspace{return {id:set.id,items:structuredClone([...set.entries.values()].map(e=>e.item)),expiresAt:new Date(set.touched+idleMs).toISOString(),chatConnected:false};}
 async function pump(){
  if(running||closed)return;running=true;
  try{while(queue.length&&!closed){
   const job=queue.shift()!,{workspace:set,entry,attempt}=job;
   const current=()=>!closed&&sets.get(set.id)===set&&set.entries.get(entry.item.id)===entry&&entry.attempt===attempt;
   if(!current())continue;
   const controller=new AbortController();entry.abort=controller;
   entry.item.status='processing';entry.item.revision++;
   let session:DocumentSession|undefined,raw:Promise<unknown>|undefined,disposing:Promise<void>|undefined,complete=()=>{};
   const dispose=()=>disposing??=(async()=>{if(session)await session.close();})();
   const onAbort=()=>{void dispose().catch(()=>{});};controller.signal.addEventListener('abort',onAbort,{once:true});
   try{
    session=(options.createSession??nativeSession)();closeActive=dispose;
    const backend:DocumentBackend={parse(input){raw=Promise.resolve().then(()=>session!.backend.parse(input));return raw;}};
    const result=await createDocumentAdapter(backend,options.limits).prepareDocuments([{name:entry.item.name,bytes:entry.bytes}],{turnId:randomUUID(),chatScopeId:null,sessionId:null,projectId:null,mode:'auto',signal:controller.signal},{isCurrent:current});
    complete=()=>{if(current()){
     if(result.ok){const doc=result.value[0]!;entry.document=doc;Object.assign(entry.item,{status:doc.state==='ready'?'ready':doc.state==='unreadable'?'unreadable':'error',code:doc.code,reason:doc.reason,version:doc.version});}
     else Object.assign(entry.item,{status:result.code==='CANCELLED'?'cancelled':'error',code:result.code,reason:result.message,version:null});
     entry.item.revision++;
     set.search=null;entry.item.sections=[];entry.item.sectionNotice=null;
     if(entry.document?.state==='ready')try{entry.item.sections=documentSections(entry.document);}catch{entry.item.sectionNotice='Разделы не подготовлены: текст превышает поддержанный предел заголовков. Поиск этого файла пока недоступен.';}
    }};
    if(!result.ok||result.value[0]!.state!=='ready'){complete();complete=()=>{};}
   }catch{complete=()=>{if(current()){entry.document=null;Object.assign(entry.item,{status:'error',code:'API_UNAVAILABLE',reason:'Не удалось подключиться к обработке файлов LM Studio.',version:null,revision:entry.item.revision+1});}};complete();complete=()=>{};}
   finally{
    controller.signal.removeEventListener('abort',onAbort);
    try{await dispose();}catch{complete=()=>{if(current()){entry.document=null;Object.assign(entry.item,{status:'error',selected:false,version:null,code:'API_UNAVAILABLE',reason:'Не удалось завершить обработку файла. Повторите после перезапуска панели.',revision:entry.item.revision+1});}};}
    // A cancelled D1 caller may have returned before its raw RPC. Hold the global slot
    // until that RPC settles; a non-cooperative backend must never overlap its successor.
    if(raw)await raw.catch(()=>{});
    complete();
    closeActive=null;if(entry.abort===controller)entry.abort=null;
   }
  }}finally{running=false;}
 }
 function enqueue(set:Workspace,entry:Entry){set.search=null;entry.attempt++;entry.document=null;Object.assign(entry.item,{status:'queued',selected:false,code:null,reason:null,version:null,revision:entry.item.revision+1,sections:[],sectionNotice:null});queue.push({workspace:set,entry,attempt:entry.attempt});void pump();}
 return {
  create(){sweep();if(closed)throw new DocumentHttpError(503,'Панель закрывается.');if(sets.size>=4)throw new DocumentHttpError(429,'Открыто четыре набора. Очистите ненужный набор в другой вкладке или подождите 30 минут.');const set:Workspace={id:randomUUID(),entries:new Map(),reservedCount:0,reservedBytes:0,touched:now()};sets.set(set.id,set);return view(set);},
  snapshot(id:string){return view(get(id));},
  reserve(id:string,name:string,size:number){
   const set=get(id);
   if(!name||name.length>200||/[\\/:\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw bad('Некорректное имя файла.');
   if(!/\.(txt|pdf)$/i.test(name))throw bad('Поддерживаются TXT в UTF-8 и PDF.');
   if(!Number.isSafeInteger(size)||size<0||size>documentLimits.maxFileBytes)throw new DocumentHttpError(413,'Файл превышает 8 MiB.');
   const used=[...set.entries.values()].reduce((sum,e)=>sum+e.bytes.length,0);
   if(set.entries.size+set.reservedCount>=documentLimits.maxFiles||used+set.reservedBytes+size>documentLimits.maxBatchBytes)throw new DocumentHttpError(413,'В наборе допустимо до 5 файлов и 20 MiB. Уберите ненужные файлы.');
   set.reservedCount++;set.reservedBytes+=size;let released=false;
   const release=()=>{if(!released){released=true;set.reservedCount--;set.reservedBytes-=size;}};
   return {release,commit(bytes:Uint8Array){
    if(released||closed||sets.get(id)!==set)throw new DocumentHttpError(409,'Набор изменился во время загрузки.');
    if(bytes.length!==size)throw bad('Загрузка не завершена.');
    const entry:Entry={item:{id:randomUUID(),revision:0,name:name.normalize('NFC'),sizeBytes:size,contentHash:hash(bytes),status:'queued',selected:false,code:null,reason:null,version:null,sections:[],sectionNotice:null},bytes:new Uint8Array(bytes),document:null,attempt:0,abort:null};
    release();set.entries.set(entry.item.id,entry);touch(set);enqueue(set,entry);return view(set);
   }};
  },
  preview(id:string,itemId:string){const entry=entryAt(get(id),itemId);if(entry.item.status!=='ready'||!entry.document)throw new DocumentHttpError(409,'Готового текста пока нет.');return {item:structuredClone(entry.item),document:structuredClone(entry.document)};},
  capture(id:string,selection:DocumentScope[]){
   const set=get(id),selected=[...set.entries.values()].filter(e=>e.item.selected);
   if(selected.length!==selection.length||selected.some(e=>!selection.some(s=>s.documentId===e.item.id&&s.revision===e.item.revision&&s.contentHash===e.item.contentHash&&s.version===e.item.version)))throw new DocumentHttpError(409,'Выбор изменился. Обновите список документов.');
   const fingerprint=()=>JSON.stringify([...set.entries.values()].map(e=>[e.item.id,e.item.revision,e.item.selected])),stamp=fingerprint();
   const snapshots:DocumentSnapshot[]=selected.map(e=>{if(e.item.status!=='ready'||!e.document)throw new DocumentHttpError(409,'Готового текста нет.');return {documentId:e.item.id,revision:e.item.revision,document:structuredClone(e.document)};});
   return {snapshots,isCurrent:()=>!closed&&sets.get(id)===set&&now()-set.touched<idleMs&&fingerprint()===stamp};
  },
  clearSearch(id:string){get(id).search=null;},
  saveSearch(id:string,response:DocumentSearchResponse,isCurrent:()=>boolean){const set=get(id);if(!isCurrent())throw new DocumentHttpError(409,'Выбор изменился. Результат не опубликован.');set.search={response:structuredClone(response),isCurrent};},
  citation(id:string,searchId:string,sourceId:string,chunkId:string):DocumentCitation{
   const set=get(id),saved=set.search;if(!saved||saved.response.result.searchId!==searchId)throw new DocumentHttpError(404,'Этот результат поиска уже недоступен.');
   if(!saved.isCurrent()){set.search=null;throw new DocumentHttpError(409,'Выбор изменился. Повторите поиск.');}
   const source=saved.response.result.sources.find(s=>s.id===sourceId),chunk=source?.chunks.find(c=>c.id===chunkId),ref=saved.response.result.included.find(c=>c.id===chunkId);
   if(!source||!chunk||!ref)throw new DocumentHttpError(404,'Фрагмент не входил в этот результат.');
   return structuredClone({searchId,sourceId,documentId:ref.documentId,contentHash:ref.contentHash,version:ref.version,title:source.title,chunk});
  },
  action(id:string,itemId:string,action:string,body:{revision:number;selected?:boolean}){
   const set=get(id),entry=entryAt(set,itemId);
   if(entry.item.revision!==body.revision)throw new DocumentHttpError(409,'Статус файла изменился. Список обновлён; повторите действие.');
   set.search=null;
   if(action==='select'){if(entry.item.status!=='ready')throw new DocumentHttpError(409,'Выбирать можно только готовый текст.');entry.item.selected=body.selected===true;entry.item.revision++;}
   else if(action==='cancel'){if(!['queued','processing'].includes(entry.item.status))throw new DocumentHttpError(409,'Обработка уже завершилась.');cancel(entry);}
   else if(action==='retry'){if(!['error','unreadable','cancelled'].includes(entry.item.status))throw new DocumentHttpError(409,'Повтор доступен после ошибки или отмены.');enqueue(set,entry);}
   else if(action==='remove'){cancel(entry);set.entries.delete(itemId);for(let i=queue.length-1;i>=0;i--)if(queue[i]!.entry===entry)queue.splice(i,1);}
   else throw bad();
   return view(set);
  },
  remove(id:string){const set=get(id);drop(set);return {removed:true};},
  async close(){if(closed)return;closed=true;clearInterval(timer);for(const set of sets.values())drop(set);queue.length=0;await closeActive?.().catch(()=>{});},
 };
}
