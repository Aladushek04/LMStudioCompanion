import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startManagementServer,type ManagementServer} from '../../packages/host/src/server.js';
import {openMemoryStore} from '../../packages/memory/src/store.js';
const servers:ManagementServer[]=[];const dirs:string[]=[];
const assets=new Map([['/',{content:Buffer.from('test'),type:'text/html'}]]);
async function start(dir?:string,beforeCommit?:()=>Promise<void>){const root=dir??await mkdtemp(join(tmpdir(),'companion-memory-api-'));if(!dir)dirs.push(root);const host=await startManagementServer(root,new AbortController().signal,{assets,...(beforeCommit?{memoryOptions:{beforeCommit}}:{})});servers.push(host);return {host,root};}
async function call(host:ManagementServer,path='/api/memory',method='GET',body?:unknown,extra:Record<string,string>={}){return fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const draft={content:'Синтетический факт',category:'note',scope:'global',projectId:null,pinned:false};
it('connection is explicit, protected and returns path without credential',async()=>{
 const {host}=await start();const path='/api/memory/connection';
 expect((await call(host,path,'POST',{}, {Origin:'https://foreign.example'})).status).toBe(403);
 expect((await (await call(host,path)).json()).enabled).toBe(false);
 const response=await call(host,path,'POST',{});expect(response.status).toBe(200);const state=await response.json();expect(state.enabled).toBe(true);expect(state.file).toContain('connection.json');expect(JSON.stringify(state)).not.toContain('secret');
 expect((await call(host,path,'DELETE',{})).status).toBe(200);expect((await (await call(host,path)).json()).enabled).toBe(false);
},10000);
afterEach(async()=>{for(const s of servers.splice(0))await s.close();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it('memory API creates, edits with revision, exports and survives host restart',async()=>{
  let {host,root}=await start();expect((await (await call(host)).json()).records).toEqual([]);
  const created=await call(host,'/api/memory','POST',draft);expect(created.status).toBe(200);const r=(await created.json()).value;
  expect(r.source).toBe('user');expect(r.manualPriority).toBe(true);
  expect((await call(host,'/api/memory/'+r.id,'PATCH',{content:'Правка',category:'preference',pinned:true,expectedRevision:r.revision})).status).toBe(200);
  const backup=await call(host,'/api/memory/export');expect((await backup.json()).payload.records[0].content).toBe('Правка');
  await host.close();host=(await start(root)).host;const records=(await (await call(host)).json()).records;
  expect(records[0].content).toBe('Правка');expect(records[0].pinned).toBe(true);
  expect((await call(host,'/api/memory/'+r.id,'DELETE',{expectedRevision:records[0].revision})).status).toBe(200);
  expect((await (await call(host)).json()).records).toEqual([]);
});
it('two windows cannot silently overwrite or delete a stale revision',async()=>{
  const {host}=await start();const r=(await (await call(host,'/api/memory','POST',draft)).json()).value;
  expect((await call(host,'/api/memory/'+r.id,'PATCH',{content:'Окно 1',category:'note',pinned:false,expectedRevision:1})).status).toBe(200);
  expect((await call(host,'/api/memory/'+r.id,'PATCH',{content:'Окно 2',category:'note',pinned:false,expectedRevision:1})).status).toBe(409);
  expect((await call(host,'/api/memory/'+r.id,'DELETE',{expectedRevision:1})).status).toBe(409);
});
it('memory and export require token; writes require same-origin JSON and strict fields',async()=>{
  const {host}=await start();
  expect((await call(host,'/api/memory/export','GET',undefined,{Authorization:''})).status).toBe(403);
  expect((await call(host,'/api/memory','POST',draft,{Origin:'https://foreign.example'})).status).toBe(403);
  expect((await call(host,'/api/memory','POST',{...draft,manualPriority:false})).status).toBe(400);
  expect((await call(host,'/api/memory','POST',{...draft,scope:'session',sessionId:'fake'})).status).toBe(400);
  expect((await call(host,'/api/memory','POST',{...draft,scope:'project',projectId:null})).status).toBe(400);
});
it('write failure returns failure and keeps last confirmed record',async()=>{
  let fail=false;const {host}=await start(undefined,async()=>{if(fail)throw Error('ENOSPC');});
  const r=(await (await call(host,'/api/memory','POST',draft)).json()).value;fail=true;
  const result=await call(host,'/api/memory/'+r.id,'PATCH',{content:'Не сохранено',category:'note',pinned:false,expectedRevision:1});
  expect(result.status).toBe(500);expect((await result.json()).ok).toBe(false);
  expect((await (await call(host)).json()).records[0].content).toBe(draft.content);
});
it('unavailable memory does not break overview and retry opens after owner releases',async()=>{
  const {host,root}=await start();const owner=await openMemoryStore(join(root,'memory'));
  try{expect((await call(host)).status).toBe(503);expect((await call(host,'/api/status')).status).toBe(200);}finally{await owner.close();}
  expect((await call(host)).status).toBe(200);
});
it('shutdown waits for accepted write before releasing both owners',async()=>{
  let armed=false,release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const {host,root}=await start(undefined,async()=>{if(armed){entered();await new Promise<void>(r=>release=r);}});
  const r=(await (await call(host,'/api/memory','POST',draft)).json()).value;
  armed=true;const mutation=call(host,'/api/memory/'+r.id,'PATCH',{content:'Перед закрытием',category:'note',pinned:false,expectedRevision:r.revision}).catch(()=>null);
  await ready;let closed=false;const stopping=host.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,25));expect(closed).toBe(false);
  release();await mutation;await stopping;
  const next=(await start(root)).host;expect((await (await call(next)).json()).records[0].content).toBe('Перед закрытием');
});
