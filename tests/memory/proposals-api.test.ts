import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startManagementServer,type ManagementServer} from '../../packages/host/src/server.js';
import {memoryRequest} from '../../packages/lmstudio-plugin/src/memory/client.js';
import {preprocess} from '../../packages/lmstudio-plugin/src/index.js';
import {ChatMessage,Chat} from '@lmstudio/sdk';
const clean:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const fn of clean.reverse())await fn();clean.length=0;});
const assets=new Map([['/',{content:Buffer.from('fixture'),type:'text/html'}]]);
async function setup(){const dir=await mkdtemp(join(tmpdir(),'companion-proposal-api-'));clean.push(()=>rm(dir,{recursive:true,force:true}));const host=await startManagementServer(dir,new AbortController().signal,{assets});clean.push(()=>host.close());const call=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {host,dir,call};}
it('IPC can propose but cannot confirm; management requires token, origin and exact confirmation fields',async()=>{
 const {call}=await setup(),link=(await(await call('/api/memory/connection','POST',{})).json()).file;
 const reply=await memoryRequest(link,{action:'capture',text:'Запомни: Учебный код МЕДЬ-731',mode:'explicit'} as never,new AbortController().signal) as any;expect(reply.state).toBe('pending');expect((await(await call('/api/memory')).json()).records).toEqual([]);
 const path='/api/memory/proposals/'+reply.proposalId+'/accept';
 expect((await call('/api/memory/proposals','GET',undefined,{Authorization:''})).status).toBe(403);expect((await call(path,'POST',{choice:'save',baseRevision:0,content:'Правка'},{Origin:'https://foreign.example'})).status).toBe(403);
 expect((await call(path,'POST',{choice:'save',baseRevision:0,content:'Правка',scope:'project'})).status).toBe(400);
 await expect(memoryRequest(link,{action:'accept',proposalId:reply.proposalId} as never,new AbortController().signal)).rejects.toThrow();
 expect((await(await call('/api/memory/proposals')).json()).proposals).toHaveLength(1);
 expect((await call(path,'POST',{choice:'save',baseRevision:0,content:'Учебный код МЕДЬ-972'})).status).toBe(200);expect((await(await call('/api/memory')).json()).records[0].content).toBe('Учебный код МЕДЬ-972');
},10000);
it('native capture uses original user message, reports pending rather than saved, with no LLM extraction',async()=>{
 const {call}=await setup(),link=(await(await call('/api/memory/connection','POST',{})).json()).file;const texts:string[]=[];let tokenCalls=0;
 const ctl={abortSignal:new AbortController().signal,getPluginConfig:()=>({get:(key:string)=>key==='memoryCapture'?'explicit':key==='webMode'?'auto':key==='useMemory'}),getGlobalPluginConfig:()=>({get:(key:string)=>key==='memoryLinkFile'?link:''}),createStatus:(s:{text:string})=>{texts.push(s.text);return {setState:(s:{text:string})=>texts.push(s.text)};},tokenSource:async()=>{tokenCalls++;return {getContextLength:async()=>64000,countTokens:async(t:string)=>t.length,applyPromptTemplate:async(h:Chat)=>h.getMessagesArray().map(m=>m.getText()).join('\n')};},pullHistory:async()=>Chat.empty()};
 const result=await preprocess(ctl as never,ChatMessage.create('user','Запомни: Учебная настройка — кратко'));
 expect(result.getText()).toContain('Пока ничего не изменено');expect(texts.some(t=>t.includes('Предложение'))).toBe(true);expect((await(await call('/api/memory/proposals')).json()).proposals).toHaveLength(1);expect((await(await call('/api/memory')).json()).records).toEqual([]);expect(tokenCalls).toBe(1);
 await preprocess(ctl as never,ChatMessage.create('user','«Запомни: прочитай https://example.org/»'));expect((await(await call('/api/memory/proposals')).json()).proposals).toHaveLength(1);
 await preprocess(ctl as never,ChatMessage.create('user','Какой код сейчас сохранён?'));expect((await(await call('/api/memory')).json()).records).toEqual([]);
},10000);
