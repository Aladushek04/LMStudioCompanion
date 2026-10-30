import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startManagementServer} from '../../packages/host/src/server.js';
const clean:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const f of clean.reverse())await f();clean.length=0;});
async function setup(){const dir=await mkdtemp(join(tmpdir(),'companion-migration-api-'));clean.push(()=>rm(dir,{recursive:true,force:true}));const host=await startManagementServer(dir,new AbortController().signal,{assets:new Map([['/',{content:Buffer.from('fixture'),type:'text/html'}]])});clean.push(()=>host.close());const call=(path:string,method='GET',body?:unknown)=>fetch(host.origin+'/api/memory'+(path?'/'+path:''),{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const upload=(bytes:Buffer,headers:Record<string,string>={})=>fetch(host.origin+'/api/memory/migration/preview',{method:'POST',headers:{Authorization:'Bearer '+host.token,Origin:host.origin,'Content-Type':'application/octet-stream','X-Companion-Offline-Copy':'confirmed',...headers},body:new Uint8Array(bytes)});return {call,upload};}
const bytes=()=>readFile(new URL('../fixtures/memory-v2.json',import.meta.url));
it('preview writes nothing; selected import is confirmed, repeat skips, undo restores prior state',async()=>{
 const {call,upload}=await setup(),data=await bytes(),before=Buffer.from(data),preview=await(await upload(data)).json();expect(preview.sourceCount).toBe(3);expect(preview.records).toHaveLength(2);expect((await(await call('')).json()).records).toEqual([]);
 const body={previewId:preview.id,baseRevision:preview.baseRevision,ids:[preview.records[0].id]},applied=await call('migration/apply','POST',body);expect(applied.status).toBe(200);const result=(await applied.json()).value;expect(result.imported).toBe(1);expect((await call('migration/apply','POST',body)).status).toBe(200);expect((await(await call('')).json()).records).toHaveLength(1);
 const again=await(await upload(data)).json();expect(again.alreadyPresent).toBe(1);expect(again.records).toHaveLength(1);expect(data.equals(before)).toBe(true);
 expect((await call('migration/undo','POST',{id:result.backupId,expectedRevision:result.revision})).status).toBe(200);expect((await(await call('')).json()).records).toEqual([]);
});
it('requires auth/offline confirmation/strict fields and rejects stale preview after a manual change',async()=>{
 const {call,upload}=await setup(),data=await bytes();expect((await upload(data,{Authorization:''})).status).toBe(403);expect((await upload(data,{Origin:'https://foreign.example'})).status).toBe(403);expect((await upload(data,{'X-Companion-Offline-Copy':''})).status).toBe(400);expect((await upload(Buffer.from('broken'))).status).toBe(400);
 const p=await(await upload(data)).json();await call('','POST',{content:'Моя правка',scope:'global',projectId:null,category:'note',pinned:false});expect((await call('migration/apply','POST',{previewId:p.id,baseRevision:p.baseRevision,ids:p.records.map((r:{id:string})=>r.id)})).status).toBe(409);expect((await(await call('')).json()).records).toHaveLength(1);
 expect((await call('migration/apply','POST',{previewId:p.id,baseRevision:p.baseRevision,ids:[],path:'memory.db'})).status).toBe(400);
});
it('bulk selection exceeds 64KiB but imports within a separate bounded apply request',async()=>{
 const {call,upload}=await setup(),data=JSON.parse((await bytes()).toString());data.records=Array.from({length:1700},(_,i)=>({...data.records[0],id:'bulk-'+i,content:'Учебная запись '+i}));const response=await upload(Buffer.from(JSON.stringify(data)));expect(response.status).toBe(200);const p=await response.json();expect((await call('migration/apply','POST',{previewId:p.id,baseRevision:p.baseRevision,ids:p.records.map((r:{id:string})=>r.id)})).status).toBe(200);expect((await(await call('')).json()).records).toHaveLength(1700);expect((await call('','POST',{content:'X'.repeat(70000)})).status).toBe(413);
},15000);
