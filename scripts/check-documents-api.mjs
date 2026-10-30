// D0 research only: fixed synthetic fixtures, no generation/model loading/chat history.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LMStudioClient,ChatMessage,FileHandle} from '@lmstudio/sdk';
import {probeError as short} from './documents-probe-error.mjs';
import {persistProbeRun} from './documents-probe-output.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))),fixtures=join(root,'tests/fixtures/documents');
let manifest;
const silent={debug(){},info(){},warn(){},error(){},log(){}};
const createClient=()=>new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:silent});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const watchdog=setTimeout(()=>{console.error('D0 probe exceeded 60s; closing this probe process.');process.exit(2);},60000);
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' exceeded 8s')),8000);})]);}finally{clearTimeout(timer);}}
async function file(name){manifest??=JSON.parse(await readFile(join(fixtures,'manifest.json'),'utf8'));assert(manifest.synthetic&&manifest.files.some(f=>f.name===name));const bytes=await readFile(join(fixtures,name));assert(bytes.length<=65536);assert.equal(hash(bytes),manifest.files.find(f=>f.name===name).sha256);return bytes;}
async function parse(client,handle,signal=AbortSignal.timeout(8000)){
 const parser=await bounded(client.files.getDocumentParsingLibrary(handle),'parser identification');
 if(parser.library!=='builtIn')return {state:'unverified-parser',parser};
 const result=await bounded(client.files.parseDocument(handle,{parserId:parser,signal}),'parse');
 return {state:result.content.trim()?'text':'empty',parser:result.parser,keys:Object.keys(result).sort(),chars:result.content.length,text:result.content};
}
async function loaded(client){return {llm:(await client.llm.listLoaded()).map(m=>m.identifier).sort(),embedding:(await client.embedding.listLoaded()).map(m=>m.identifier).sort()};}

// A separate process creates and closes its own upload. No user handle is accepted.
if(process.argv[2]==='--lifecycle-child'){
 const client=createClient();try{const handle=await bounded(client.files.prepareFileBase64('d0-lifecycle.txt',(await file('harbor.txt')).toString('base64')),'upload');const result=await parse(client,handle);assert(result.text?.includes('ШЕЛК-482'));console.log(JSON.stringify({identifier:handle.identifier,type:handle.type,sizeBytes:handle.sizeBytes,name:handle.name}));}finally{await client[Symbol.asyncDispose]();clearTimeout(watchdog);}
}else{
 assert.equal(process.argv.length,2,'Only the fixed fixture probe is supported');
 const client=createClient(),report={checkedAt:new Date().toISOString(),sdk:JSON.parse(await readFile(join(root,'node_modules/@lmstudio/sdk/package.json'),'utf8')).version,synthetic:true,generationCalled:false,modelLoadingCalled:false,limits:{fixedFixtureFiles:4,maxFixtureBytes:65536,operationDeadlineMs:8000,probeDeadlineMs:60000},documents:[]};
 await persistProbeRun(join(root,'data/documents-d0-live.json'),report,async()=>{
 try{
  report.modelsBefore=await bounded(loaded(client),'loaded models');
  const handles=new Map();
  for(const name of ['harbor.txt','text.pdf','scan.pdf','broken.pdf']){
   const bytes=await file(name),item={name,bytes:bytes.length,contentHash:hash(bytes)};
   try{
    const handle=await bounded(client.files.prepareFile(join(fixtures,name)),'upload');handles.set(name,handle);item.fileType=handle.type;
    const result=await parse(client,handle);const {text,...summary}=result;Object.assign(item,summary);
    if(name==='harbor.txt'&&text!==undefined){item.expectedMarker=text.includes('ШЕЛК-482');assert(item.expectedMarker);}
    if(name==='text.pdf'&&text!==undefined){item.expectedMarkers=['MINT-482','ORBIT-936'].every(m=>text.includes(m));assert(item.expectedMarkers);}
    if(name==='scan.pdf'&&text!==undefined){item.emptyWithoutOcr=!text.trim();assert(item.emptyWithoutOcr);}
   }catch(error){if(error.code==='ERR_ASSERTION')throw error;Object.assign(item,{state:'error',error:short(error)});}
   report.documents.push(item);
  }
  const txt=handles.get('harbor.txt');assert(txt,'TXT upload must exist to test handles');
  const second=await bounded(client.files.prepareFileBase64('harbor.txt',Buffer.from('Synthetic replacement: shipping code SECOND-913.').toString('base64')),'second upload');
  const firstResult=await parse(client,txt),secondResult=await parse(client,second);
  report.sameName={namesEqual:txt.name===second.name,handlesDiffer:txt.identifier!==second.identifier,contentDiffers:firstResult.text!==secondResult.text};
  assert(Object.values(report.sameName).every(Boolean));
  const pre=new AbortController();pre.abort(new DOMException('D0 pre-aborted','AbortError'));
  try{await client.files.parseDocument(txt,{signal:pre.signal});throw Error('Pre-aborted parse unexpectedly resolved');}catch(error){assert.equal(error,pre.signal.reason);report.preAbortedParseRejected=true;}
  const during=new AbortController(),pending=client.files.parseDocument(txt,{parserId:firstResult.parser,signal:during.signal});during.abort(new DOMException('D0 in-flight cancellation','AbortError'));
  try{await pending;throw Error('Cancelled parse unexpectedly resolved');}catch(error){assert.equal(error,during.signal.reason);report.inFlightParsePromiseRejected=true;report.serverWorkStoppedByAbort='unknown';}
  try{await client.files.parseDocument({identifier:'not-a-handle'});throw Error('Invalid handle accepted');}catch(error){assert(/FileHandle|instance|parseDocument/i.test(String(error)));report.invalidHandleRejectedBeforeUse=true;}
  // SDK 1.5 validates embedding explicitly; this never calls embedding.model().
  try{await client.files.retrieve('shipping code',[txt],{signal:AbortSignal.timeout(8000),onFileProcessList(){}});throw Error('Missing embedding unexpectedly accepted');}catch(error){assert(/Embedding model currently is required/.test(String(error)));report.retrievalWithoutEmbedding={state:'unsupported',reason:'Embedding model currently is required.',generationOrLoadAttempted:false};}
  const pixel=await bounded(client.files.prepareImageBase64('d0-pixel.png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='),'image upload');
  const message=ChatMessage.create('user','D0 synthetic attachment test');message.appendFile(txt);message.appendFile(pixel);const original=message.getFiles(client).map(f=>f.identifier).sort();message.appendText('\nSynthetic context.');
  report.sdkMessage={filesPreserved:JSON.stringify(message.getFiles(client).map(f=>f.identifier).sort())===JSON.stringify(original),imageCount:message.getFiles(client).filter(f=>f.isImage()).length,documentCount:message.getFiles(client).filter(f=>!f.isImage()).length};
  assert(report.sdkMessage.filesPreserved&&report.sdkMessage.imageCount===1&&report.sdkMessage.documentCount===1);
  const run=promisify(execFile),child=await run(process.execPath,[fileURLToPath(import.meta.url),'--lifecycle-child'],{cwd:root,windowsHide:true,timeout:12000,maxBuffer:16384}),descriptor=JSON.parse(child.stdout);
  // Deprecated constructor is used ONLY to probe persistence of our own expired upload.
  const previous=new FileHandle(client.files,descriptor.identifier,descriptor.type,descriptor.sizeBytes,descriptor.name);
  try{const result=await parse(client,previous);report.afterCreatorProcessExit={readable:result.text?.includes('ШЕЛК-482')??false,usesDeprecatedReconstruction:true,delayMs:0};}catch(error){report.afterCreatorProcessExit={readable:false,usesDeprecatedReconstruction:true,error:short(error)};}
  report.afterLmStudioRestart='unknown: LM Studio was not restarted';
  report.nativeChatIsolationAndStrictMode='unknown: SDK-only D0, no active chat modified';
  report.modelsAfter=await bounded(loaded(client),'loaded models after');assert.deepEqual(report.modelsAfter,report.modelsBefore);report.modelSetUnchanged=true;
  for(const {name}of manifest.files)await file(name);report.sourceBytesUnchanged=true;
 }finally{await client[Symbol.asyncDispose]();clearTimeout(watchdog);}
 },['sameName','preAbortedParseRejected','inFlightParsePromiseRejected','invalidHandleRejectedBeforeUse','retrievalWithoutEmbedding','sdkMessage','afterCreatorProcessExit','modelsAfter','modelSetUnchanged','sourceBytesUnchanged']);
 console.log(JSON.stringify(report));
 if(report.outcome!=='complete')process.exitCode=1;
}
