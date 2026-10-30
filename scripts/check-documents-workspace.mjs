// Native D2 API acceptance: fixed synthetic TXT/PDF only, no generation or model loading.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {LMStudioClient} from '@lmstudio/sdk';
import {startManagementServer} from '../dist/host/src/server.js';
import {persistProbeRun} from './documents-probe-output.mjs';
assert.equal(process.argv.length,2,'Only fixed synthetic fixtures are accepted');
const report={stage:'D2',checkedAt:new Date().toISOString(),synthetic:true,generationCalled:false,modelLoadingCalled:false,nativeChatTested:false,newRelease:false};
const watchdog=setTimeout(()=>{console.error('Native D2 check timed out');process.exit(2);},100000);
await persistProbeRun(resolve('data/documents-d2-live.json'),report,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'companion-doc-native-'));
 const client=new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:{debug(){},info(){},warn(){},error(){}}});let host;
 const loaded=async()=>({llm:(await client.llm.listLoaded()).map(m=>m.identifier).sort(),embedding:(await client.embedding.listLoaded()).map(m=>m.identifier).sort()});
 try{
  report.modelsBefore=await loaded();host=await startManagementServer(directory,new AbortController().signal,{assets:new Map()});
  const api=async(path,method='GET',body)=>{const response=await fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert(response.ok);return response.json();};
  const workspace=await api('/api/documents','POST',{}),path='/api/documents/'+workspace.id;
  const manifest=JSON.parse(await readFile(resolve('tests/fixtures/documents/manifest.json'),'utf8'));assert(manifest.synthetic);const entries=manifest.files.filter(f=>['harbor.txt','text.pdf'].includes(f.name));assert.equal(entries.length,2);
  for(const entry of entries){const bytes=await readFile(resolve('tests/fixtures/documents',entry.name));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);const response=await fetch(host.origin+path+'/files',{method:'POST',headers:{Authorization:'Bearer '+host.token,Origin:host.origin,'Content-Type':'application/octet-stream','X-Document-Name':encodeURIComponent(entry.name)},body:bytes});assert.equal(response.status,202);}
  let state;for(let i=0;i<900;i++){state=await api(path);if(state.items.every(item=>!['queued','processing'].includes(item.status)))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(state.items.length,2);assert(state.items.every(item=>item.status==='ready'&&!item.selected));
  report.documents=[];
  for(const item of state.items){const preview=await api(path+'/items/'+item.id+'/text');assert.equal(preview.document.version,item.version);assert.equal(preview.document.contentHash,entries.find(f=>f.name===item.name).sha256);assert(preview.document.text.includes(item.name==='harbor.txt'?'ШЕЛК-482':'MINT-482'));report.documents.push({name:item.name,state:item.status,chars:preview.document.text.length,contentHash:item.contentHash,version:item.version});}
  const first=state.items[0];await api(path+'/items/'+first.id+'/select','POST',{revision:first.revision,selected:true});state=await api(path);assert(state.items[0].selected);assert.equal(state.chatConnected,false);
  await api(path,'DELETE',{});assert.equal((await fetch(host.origin+path,{headers:{Authorization:'Bearer '+host.token}})).status,404);report.selectionAndRemovalVerified=true;
  for(const entry of entries)assert.equal(createHash('sha256').update(await readFile(resolve('tests/fixtures/documents',entry.name))).digest('hex'),entry.sha256);
  report.sourceBytesUnchanged=true;report.modelsAfter=await loaded();assert.deepEqual(report.modelsAfter,report.modelsBefore);report.modelSetUnchanged=true;
 }finally{await host?.close();await client[Symbol.asyncDispose]();await rm(directory,{recursive:true,force:true});}
},['documents','selectionAndRemovalVerified','sourceBytesUnchanged','modelSetUnchanged']);
clearTimeout(watchdog);console.log(JSON.stringify(report));if(report.outcome!=='complete')process.exitCode=1;
