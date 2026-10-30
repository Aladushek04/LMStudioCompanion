// D1 acceptance: only synthetic fixtures and file API. Never generate or load a model.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {LMStudioClient} from '@lmstudio/sdk';
import {createDocumentAdapter} from '../dist/documents/src/adapter.js';
import {createSdkDocumentBackend} from '../dist/documents/src/sdk-backend.js';
import {persistProbeRun} from './documents-probe-output.mjs';

assert.equal(process.argv.length,2,'Only fixed synthetic fixtures are accepted');
const root=dirname(dirname(fileURLToPath(import.meta.url))),fixtures=join(root,'tests/fixtures/documents');
const report={checkedAt:new Date().toISOString(),stage:'D1',synthetic:true,generationCalled:false,modelLoadingCalled:false};
const watchdog=setTimeout(()=>{console.error('D1 acceptance timed out');process.exit(2);},110000);
await persistProbeRun(join(root,'data/documents-d1-live.json'),report,async()=>{
 const client=new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:{debug(){},info(){},warn(){},error(){},log(){}}});
 const loaded=async()=>({llm:(await client.llm.listLoaded()).map(m=>m.identifier).sort(),embedding:(await client.embedding.listLoaded()).map(m=>m.identifier).sort()});
 try{
  report.modelsBefore=await loaded();
  const base=JSON.parse(await readFile(join(fixtures,'manifest.json'),'utf8')),extra=JSON.parse(await readFile(join(fixtures,'d1-extra.json'),'utf8'));assert(base.synthetic&&extra.synthetic);
  const manifest={files:[...base.files,...extra.files]};
  const sources=[];
  for(const entry of manifest.files){const bytes=await readFile(join(fixtures,entry.name));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);sources.push({name:entry.name,bytes});}
  const backend=createSdkDocumentBackend(client),adapter=createDocumentAdapter(backend),events=[];
  const context={turnId:'d1-synthetic-acceptance',chatScopeId:null,projectId:null,sessionId:null,mode:'auto',signal:new AbortController().signal};
  const started=Date.now(),result=await adapter.prepareDocuments(sources,context,{onState:s=>{events.push({id:s.id,state:s.state});}});
  assert(result.ok);assert.equal(result.value.length,5);
  const docs=new Map(result.value.map(doc=>[doc.name,doc]));
  assert.equal(docs.get('harbor.txt').state,'ready');assert(docs.get('harbor.txt').text.includes('ШЕЛК-482'));
  assert.equal(docs.get('text.pdf').state,'ready');assert(['MINT-482','ORBIT-936'].every(m=>docs.get('text.pdf').text.includes(m)));
  assert.equal(docs.get('scan.pdf').state,'unreadable');assert.equal(docs.get('scan.pdf').code,'NO_TEXT');
  assert.equal(docs.get('broken.pdf').state,'error');assert.equal(docs.get('broken.pdf').code,'PARSER_ERROR');
  assert(['error','unreadable'].includes(docs.get('encrypted.pdf').state));assert.equal(docs.get('encrypted.pdf').text,null);
  for(const doc of result.value){assert.equal(doc.contentHash,manifest.files.find(f=>f.name===doc.name).sha256);assert.equal(doc.retrieval.state,'not-prepared');assert(!Object.hasOwn(doc,'identifier'));assert(!Object.hasOwn(doc,'bytes'));}
  const cancelled=new AbortController();cancelled.abort();
  const cancelResult=await adapter.prepareDocuments([sources[0]],{...context,signal:cancelled.signal});assert(!cancelResult.ok&&cancelResult.code==='CANCELLED');
  report.elapsedMs=Date.now()-started;
  report.documents=result.value.map(doc=>({name:doc.name,state:doc.state,code:doc.code,sourceBytes:doc.sizeBytes,contentHash:doc.contentHash,textChars:doc.text?.length??0,textHash:doc.textHash,version:doc.version,parser:doc.parser,locators:doc.locators,retrieval:doc.retrieval.state}));
  report.eventCount=events.length;report.preAbortedRejected=true;report.expectedTextMarkersFound=true;report.modelsAfter=await loaded();assert.deepEqual(report.modelsAfter,report.modelsBefore);report.modelSetUnchanged=true;
  for(const entry of manifest.files)assert.equal(createHash('sha256').update(await readFile(join(fixtures,entry.name))).digest('hex'),entry.sha256);
  report.sourceBytesUnchanged=true;report.encryptedPdfPasswordNotProvidedToNativeParser=true;report.nativeChatTested=false;report.newRelease=false;
 }finally{await client[Symbol.asyncDispose]();}
},['documents','modelsAfter','modelSetUnchanged','sourceBytesUnchanged']);
clearTimeout(watchdog);console.log(JSON.stringify(report));if(report.outcome!=='complete')process.exitCode=1;
