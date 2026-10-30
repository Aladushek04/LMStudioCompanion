// Native D3 acceptance: fixed synthetic sources, already-loaded tokenizer, no generation/loading.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Chat,LMStudioClient} from '@lmstudio/sdk';
import {startManagementServer} from '../dist/host/src/server.js';
import {persistProbeRun} from './documents-probe-output.mjs';
assert.equal(process.argv.length,2,'Only fixed synthetic fixtures');
const report={stage:'D3',checkedAt:new Date().toISOString(),synthetic:true,generationCalled:false,modelLoadingCalled:false,nativeChatTested:false,newRelease:false};
const watchdog=setTimeout(()=>{console.error('D3 native acceptance timed out');process.exit(2);},100000);
await persistProbeRun(resolve('data/documents-d3-live.json'),report,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'companion-d3-native-')),client=new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:{debug(){},info(){},warn(){},error(){}}});let host;
 const loaded=async()=>({llm:(await client.llm.listLoaded()).map(m=>m.identifier).sort(),embedding:(await client.embedding.listLoaded()).map(m=>m.identifier).sort()}),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 try{
  report.modelsBefore=await loaded();const models=await client.llm.listLoaded();assert.equal(models.length,1,'Only use one already loaded model');const model=models[0];host=await startManagementServer(directory,new AbortController().signal,{assets:new Map()});
  const call=async(path,method='GET',body)=>{const res=await fetch(host.origin+path,{method,headers:{Authorization:'Bearer '+host.token,Origin:host.origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert(res.ok,`HTTP ${res.status}`);return res.json();};
  const path='/api/documents/'+(await call('/api/documents','POST',{})).id;
  const manifest=JSON.parse(await readFile(resolve('tests/fixtures/documents/manifest.json'),'utf8')),evaluation=JSON.parse(await readFile(resolve('tests/fixtures/documents/retrieval.json'),'utf8'));assert(manifest.synthetic&&evaluation.synthetic);const entries=manifest.files.filter(e=>['harbor.txt','text.pdf'].includes(e.name)),inputs=[];
  for(const e of entries){const bytes=await readFile(resolve('tests/fixtures/documents',e.name));assert.equal(hash(bytes),e.sha256);inputs.push({name:e.name,bytes,sha256:e.sha256});}inputs.push({name:'retrieval-fixture.txt',bytes:Buffer.from(evaluation.text),sha256:hash(evaluation.text)});
  for(const input of inputs){const res=await fetch(host.origin+path+'/files',{method:'POST',headers:{Authorization:'Bearer '+host.token,Origin:host.origin,'Content-Type':'application/octet-stream','X-Document-Name':encodeURIComponent(input.name)},body:input.bytes});assert.equal(res.status,202);}
  let state;for(let i=0;i<900;i++){state=await call(path);if(state.items.length===3&&state.items.every(i=>i.status==='ready'))break;await new Promise(r=>setTimeout(r,100));}assert(state.items.every(i=>i.status==='ready'));
  report.checks=[];let previous=null;
  for(const [name,query,marker,sectionTitle] of [['harbor.txt','ШЕЛК-482','ШЕЛК-482',null],['text.pdf','MINT-482','MINT-482',null],['retrieval-fixture.txt','Бюджет','187500','Финансы'],['retrieval-fixture.txt','Бюджет',null,'Управление']]){
   for(const item of state.items.filter(i=>i.selected))await call(path+'/items/'+item.id+'/select','POST',{revision:item.revision,selected:false});state=await call(path);
   let item=state.items.find(i=>i.name===name);await call(path+'/items/'+item.id+'/select','POST',{revision:item.revision,selected:true});state=await call(path);item=state.items.find(i=>i.id===item.id);
   const sections=sectionTitle?[item.sections.find(s=>s.title===sectionTitle)?.id]:null;if(sections)assert(sections[0]);
   const out=await call(path+'/search','POST',{query,wholeDocument:false,selection:[{documentId:item.id,revision:item.revision,contentHash:item.contentHash,version:item.version,sections}]});assert(out.previewOnly);assert.equal(out.modelIdentifier,model.identifier);
   if(marker){assert.equal(out.result.state,'found');const source=out.result.sources.find(s=>s.chunks.some(c=>c.text.includes(marker))),chunk=source?.chunks.find(c=>c.text.includes(marker));assert(chunk);const sourcePath=path+`/searches/${out.result.searchId}/sources/${source.id}/chunks/${chunk.id}`,opened=await call(sourcePath);assert.equal(opened.chunk.text,chunk.text);assert.equal(opened.version,item.version);
    const measured=await model.countTokens(await model.applyPromptTemplate(Chat.from([{role:'user',content:query+out.result.payload}])));assert.equal(out.result.budget.totalTokens,measured);assert(measured<=out.result.budget.limit);report.checks.push({name,section:sectionTitle,state:out.result.state,totalTokens:measured,limit:out.result.budget.limit,exactCitation:true});previous=sourcePath;
   }else{assert.equal(out.result.state,'no-matches');assert.deepEqual(out.result.sources,[]);report.checks.push({name,section:sectionTitle,state:out.result.state});}
  }
  assert.equal((await fetch(host.origin+previous,{headers:{Authorization:'Bearer '+host.token}})).status,404);report.oldCitationRejected=true;
  for(const e of entries)assert.equal(hash(await readFile(resolve('tests/fixtures/documents',e.name))),e.sha256);report.sourceBytesUnchanged=true;
  report.modelsAfter=await loaded();assert.deepEqual(report.modelsAfter,report.modelsBefore);report.modelSetUnchanged=true;report.exactTokenizerTotalsVerified=true;
 }finally{await host?.close();await client[Symbol.asyncDispose]();await rm(directory,{recursive:true,force:true});}
},['checks','oldCitationRejected','sourceBytesUnchanged','modelSetUnchanged','exactTokenizerTotalsVerified']);
clearTimeout(watchdog);console.log(JSON.stringify(report));if(report.outcome!=='complete')process.exitCode=1;
