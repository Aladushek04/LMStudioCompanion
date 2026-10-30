import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startManagementServer,type ManagementServer} from '../../packages/host/src/server.js';
import type {DocumentTokenizerSession} from '../../packages/host/src/document-tokenizer.js';
const hosts:ManagementServer[]=[],dirs:string[]=[];
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function start(createTokenizer:()=>DocumentTokenizerSession=()=>({async prepare(){return {modelIdentifier:'synthetic',contextLength:32768,measure:async(text:string)=>text.length};},async close(){}}),searchDeadlineMs=8000){
 const dir=await mkdtemp(join(tmpdir(),'companion-d3-api-'));dirs.push(dir);const h=await startManagementServer(dir,new AbortController().signal,{assets:new Map(),documentsOptions:{createTokenizer,searchDeadlineMs,createSession:()=>({backend:{async parse({bytes}){return {text:Buffer.from(bytes).toString(),parser:{library:'builtIn',version:'1'}};}},async close(){}})}});hosts.push(h);return h;
}
async function call(h:ManagementServer,path:string,method='GET',body?:unknown,extra:Record<string,string>={}){return fetch(h.origin+path,{method,headers:{Authorization:'Bearer '+h.token,Origin:h.origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function ready(h:ManagementServer){const path='/api/documents/'+(await (await call(h,'/api/documents','POST',{})).json()).id;const bytes=Buffer.from('# Финансы\nБюджет 187500 рублей.\n# Контакты\nКоординатор Лидия Белова.');await fetch(h.origin+path+'/files',{method:'POST',headers:{Authorization:'Bearer '+h.token,Origin:h.origin,'Content-Type':'application/octet-stream','X-Document-Name':'fixture.txt'},body:bytes});
 let item;for(let i=0;i<100;i++){item=(await (await call(h,path)).json()).items[0];if(item.status==='ready')break;await new Promise(r=>setTimeout(r,5));}expect(item.status).toBe('ready');await call(h,path+'/items/'+item.id+'/select','POST',{revision:item.revision,selected:true});item=(await (await call(h,path)).json()).items[0];return {path,item,body:{query:'Бюджет',wholeDocument:false,selection:[{documentId:item.id,revision:item.revision,contentHash:item.contentHash,version:item.version,sections:null}]}};
}
it('searches only selected version and opens exactly the included source fragment; deselect invalidates citation',async()=>{
 const h=await start(),{path,item,body}=await ready(h);expect(item.sections).toHaveLength(2);
 const response=await call(h,path+'/search','POST',body);expect(response.status).toBe(200);const out=await response.json();expect(out.previewOnly).toBe(true);expect(out.modelIdentifier).toBe('synthetic');expect(out.result.state).toBe('found');
 const source=out.result.sources[0],chunk=source.chunks[0],citation=path+`/searches/${out.result.searchId}/sources/${source.id}/chunks/${chunk.id}`;
 const opened=await (await call(h,citation)).json();expect(opened.chunk.text).toBe(chunk.text);expect(opened.version).toBe(item.version);
 expect((await call(h,citation,'GET',undefined,{Authorization:''})).status).toBe(403);
 await call(h,path+'/items/'+item.id+'/select','POST',{revision:item.revision,selected:false});expect([404,409]).toContain((await call(h,citation)).status);
 expect((await call(h,path+'/search','POST',body)).status).toBe(409);
});
it('protects search, validates strict scope, distinguishes unknown section and no-match',async()=>{
 const h=await start(),{path,body}=await ready(h);
 expect((await call(h,path+'/search','POST',body,{Origin:'https://foreign.example'})).status).toBe(403);
 expect((await call(h,path+'/search','POST',{...body,path:'C:/private.txt'})).status).toBe(400);
 expect((await call(h,path+'/search','POST',{...body,selection:[{...body.selection[0],sections:['unknown']}]})).status).toBe(400);
 const empty=await (await call(h,path+'/search','POST',{...body,query:'Аэропорт'})).json();expect(empty.result.state).toBe('no-matches');expect(empty.result.sources).toEqual([]);
});
it('a selection change during tokenizer wait prevents result publication',async()=>{
 let resolveCount:(n:number)=>void=()=>{},started:()=>void=()=>{};const waiting=new Promise<void>(r=>{started=r;});
 const h=await start(()=>({async prepare(){return {modelIdentifier:'synthetic',contextLength:32768,measure:()=>new Promise<number>(r=>{resolveCount=r;started();})};},async close(){}}));const {path,item,body}=await ready(h);
 const query=call(h,path+'/search','POST',body);await waiting;await call(h,path+'/items/'+item.id+'/select','POST',{revision:item.revision,selected:false});resolveCount(1);expect((await query).status).toBe(409);
});
it('raw tokenizer work and disposal keep one slot even after caller cancellation',async()=>{
 let resolveCount:(n:number)=>void=()=>{},started:()=>void=()=>{},closed=0;const waiting=new Promise<void>(r=>{started=r;});
 const h=await start(()=>({async prepare(){return {modelIdentifier:'synthetic',contextLength:32768,measure:()=>new Promise<number>(r=>{resolveCount=r;started();})};},async close(){closed++;}}));const {path,body}=await ready(h),controller=new AbortController();
 const query=fetch(h.origin+path+'/search',{method:'POST',headers:{Authorization:'Bearer '+h.token,Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}).catch(()=>null);await waiting;controller.abort();await query;await new Promise(r=>setTimeout(r,20));
 expect((await call(h,path+'/search','POST',body)).status).toBe(409);expect(closed).toBe(1);resolveCount(1);
});
it('tokenizer failure is an error, not no-match; no raw stack or private path leaks',async()=>{
 const h=await start(()=>({async prepare(){throw Error('C:/private/token.txt');},async close(){}}));const {path,body}=await ready(h);const r=await call(h,path+'/search','POST',body);expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain('private');
});
it('deadline during non-cooperative preparation returns failure and holds raw slot',async()=>{
 let release:()=>void=()=>{},measured=0,closed=0;
 const h=await start(()=>({prepare(){return new Promise(resolve=>{release=()=>resolve({modelIdentifier:'synthetic',contextLength:32768,measure:async()=>{measured++;return 1;}});});},async close(){closed++;}}),20),{path,body}=await ready(h);
 const response=await call(h,path+'/search','POST',body);expect(response.status).toBe(504);expect((await call(h,path+'/search','POST',body)).status).toBe(409);expect(closed).toBe(1);release();await new Promise(r=>setTimeout(r,0));expect(measured).toBe(0);
});
