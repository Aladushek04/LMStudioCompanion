import {afterEach,it,expect} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {startManagementServer,type ManagementServer} from '../../packages/host/src/server.js';
import type {DocumentSession} from '../../packages/host/src/document-workspaces.js';
const hosts:ManagementServer[]=[],dirs:string[]=[];
afterEach(async()=>{for(const host of hosts.splice(0))await host.close();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function start(createSession:()=>DocumentSession=()=>({backend:{async parse({bytes}){return {text:Buffer.from(bytes).toString(),parser:{library:'builtIn',version:'1'}};}},async close(){}})){
 const dir=await mkdtemp(join(tmpdir(),'companion-doc-api-'));dirs.push(dir);
 const host=await startManagementServer(dir,new AbortController().signal,{assets:new Map(),documentsOptions:{createSession}});hosts.push(host);return host;
}
async function call(h:ManagementServer,path:string,method='GET',body?:unknown,headers:Record<string,string>={}){return fetch(h.origin+path,{method,headers:{Authorization:'Bearer '+h.token,Origin:h.origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function create(h:ManagementServer){const res=await call(h,'/api/documents','POST',{});expect(res.status).toBe(201);return '/api/documents/'+(await res.json()).id;}
async function upload(h:ManagementServer,path:string,name='same.txt',body:Uint8Array=Buffer.from('Синтетический текст')){return fetch(h.origin+path+'/files',{method:'POST',headers:{Authorization:'Bearer '+h.token,Origin:h.origin,'Content-Type':'application/octet-stream','X-Document-Name':encodeURIComponent(name)},body:Buffer.from(body)});}
async function snapshot(h:ManagementServer,path:string){return (await (await call(h,path)).json());}
async function settled(h:ManagementServer,path:string){let state;for(let i=0;i<100;i++){state=await snapshot(h,path);if(state.items.every((x:{status:string})=>!['queued','processing'].includes(x.status)))return state;await new Promise(r=>setTimeout(r,10));}throw Error('job not settled');}
it('protects every route and rejects paths/unknown fields; no SDK or memory handles escape',async()=>{
 const h=await start(),path=await create(h);
 for(const headers of [{Authorization:''},{Origin:'https://foreign.example'}])expect((await call(h,path,'GET',undefined,headers)).status).toBe(403);
 expect(await new Promise(resolve=>{httpRequest(h.origin+path,{headers:{Host:'foreign.example',Authorization:'Bearer '+h.token}},res=>{res.resume();resolve(res.statusCode);}).end();})).toBe(403);
 expect((await call(h,'/api/documents','POST',{}, {Origin:''})).status).toBe(403);
 expect((await call(h,'/api/documents','POST',{path:'C:/private.txt'})).status).toBe(400);
 expect((await call(h,path+'/files','POST',{path:'C:/private.txt'})).status).toBe(415);
 expect((await upload(h,path,'../private.txt')).status).toBe(400);
 expect((await upload(h,path)).status).toBe(202);
 const state=await settled(h,path);expect(state.items[0].status).toBe('ready');expect(state.items[0].selected).toBe(false);
 const json=JSON.stringify(state);for(const field of ['bytes','identifier','text','turnId'])expect(Object.hasOwn(state.items[0],field)).toBe(false);
 expect(json).not.toContain('Синтетический текст');
});
it('isolates tab sets, preserves same-name identity, preview/version, selection and removal without changing originals',async()=>{
 const h=await start(),a=await create(h),b=await create(h),original=Buffer.from('Синтетический текст');
 await upload(h,a,'same.txt',original);await upload(h,a,'same.txt',Buffer.from('Другой текст'));
 const state=await settled(h,a);expect(state.items).toHaveLength(2);expect(state.items[0].id).not.toBe(state.items[1].id);expect((await snapshot(h,b)).items).toHaveLength(0);
 const item=state.items[0],itemPath=a+'/items/'+item.id;
 const preview=await (await call(h,itemPath+'/text')).json();expect(preview.document.text).toBe(original.toString());expect(preview.document.version).toBe(item.version);expect(preview.document.locators).toHaveLength(1);
 expect((await call(h,itemPath+'/select','POST',{revision:item.revision,selected:true})).status).toBe(200);
 expect((await call(h,itemPath,'DELETE',{revision:item.revision})).status).toBe(409);
 const latest=(await snapshot(h,a)).items[0];expect(latest.selected).toBe(true);
 expect((await call(h,itemPath,'DELETE',{revision:latest.revision})).status).toBe(200);
 expect((await call(h,itemPath+'/text')).status).toBe(404);expect(original.toString()).toBe('Синтетический текст');
});
it('cancellation excludes late data; raw backend must settle before another job; retry has new attempt',async()=>{
 let finish:(value:unknown)=>void=()=>{},calls=0,closes=0;
 const h=await start(()=>({backend:{parse(){calls++;return new Promise(r=>{finish=r;});}},async close(){closes++;}}));
 const path=await create(h);await upload(h,path);let item=(await snapshot(h,path)).items[0];
 while(!calls){await new Promise(r=>setTimeout(r,5));item=(await snapshot(h,path)).items[0];}
 expect((await call(h,path+'/items/'+item.id+'/cancel','POST',{revision:item.revision})).status).toBe(200);
 item=(await snapshot(h,path)).items[0];expect(item.status).toBe('cancelled');expect(item.selected).toBe(false);expect((await call(h,path+'/items/'+item.id+'/text')).status).toBe(409);
 expect((await call(h,path+'/items/'+item.id+'/retry','POST',{revision:item.revision})).status).toBe(200);
 await new Promise(r=>setTimeout(r,15));expect(calls).toBe(1);expect(closes).toBe(1);
 finish({text:'Поздний результат',parser:{library:'builtIn',version:'1'}});
 for(let i=0;i<100&&calls<2;i++)await new Promise(r=>setTimeout(r,5));expect(calls).toBe(2);
 finish({text:'Новая попытка',parser:{library:'builtIn',version:'1'}});
 item=(await settled(h,path)).items[0];const preview=await (await call(h,path+'/items/'+item.id+'/text')).json();expect(item.status).toBe('ready');expect(preview.document.text).toBe('Новая попытка');expect(closes).toBe(2);
});
it('shows unreadable/error honestly, retries, validates revisions and never selects failed text',async()=>{
 let fail=true;const h=await start(()=>({backend:{async parse({name}){if(name==='scan.pdf')return {text:' ',parser:{library:'builtIn',version:'1'}};if(fail)throw Error('private error');return {text:'Retry text',parser:{library:'builtIn',version:'1'}};}},async close(){}}));const path=await create(h);
 await upload(h,path,'scan.pdf',Buffer.from('%PDF-fake'));await upload(h,path,'bad.pdf',Buffer.from('%PDF-fake'));
 let state=await settled(h,path);expect(state.items.map((i:{status:string})=>i.status)).toEqual(['unreadable','error']);expect(JSON.stringify(state)).not.toContain('private error');
 const item=state.items[1],p=path+'/items/'+item.id;expect((await call(h,p+'/select','POST',{revision:item.revision,selected:true})).status).toBe(409);
 expect((await call(h,p+'/retry','POST',{revision:item.revision,path:'C:/x'})).status).toBe(400);
 fail=false;expect((await call(h,p+'/retry','POST',{revision:item.revision})).status).toBe(200);state=await settled(h,path);expect(state.items[1].status).toBe('ready');
});
it('bounds files/bytes/workspaces and releases removed sets; server shutdown closes owned session',async()=>{
 let release:()=>void=()=>{},closed=0;const h=await start(()=>({backend:{parse(){return new Promise(r=>{release=()=>r({text:'done',parser:{library:'builtIn',version:'1'}});});}},async close(){closed++;release();}}));
 const path=await create(h);for(let i=0;i<5;i++)expect((await upload(h,path)).status).toBe(202);expect((await upload(h,path)).status).toBe(413);
 for(let i=0;i<3;i++)await create(h);expect((await call(h,'/api/documents','POST',{})).status).toBe(429);
 expect((await call(h,path,'DELETE',{})).status).toBe(200);expect((await call(h,path)).status).toBe(404);await create(h);
 await h.close();expect(closed).toBe(1);
});
it('accepts fixed synthetic fixture bytes rather than paths',async()=>{
 const h=await start(),path=await create(h),bytes=await readFile(new URL('../fixtures/documents/harbor.txt',import.meta.url));
 await upload(h,path,'harbor.txt',bytes);const state=await settled(h,path);expect(state.items[0].sizeBytes).toBe(bytes.length);expect(state.items[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
});
