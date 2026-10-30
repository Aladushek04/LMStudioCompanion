import {expect,it,vi} from 'vitest';
import {FileHandle,type LMStudioClient} from '@lmstudio/sdk';
import {performance} from 'node:perf_hooks';
import {createSdkDocumentBackend} from '../../packages/documents/src/sdk-backend.js';
import {createDocumentAdapter} from '../../packages/documents/src/adapter.js';
import type {TurnContext} from '../../packages/core/src/contracts.js';

const source=()=>({name:'test.txt',bytes:new TextEncoder().encode('Пример'),signal:new AbortController().signal});
const parser={library:'builtIn',version:'1'};
function setup(){
 const files={prepareFileBase64:vi.fn(),getDocumentParsingLibrary:vi.fn(async()=>parser),parseDocument:vi.fn(async()=>({content:'Пример',parser}))};
 const client={files:files as unknown as LMStudioClient['files'],get embedding(){throw Error('Embedding must not be accessed');},get llm(){throw Error('LLM must not be accessed');}};
 files.prepareFileBase64.mockImplementation(async(name:string,base64:string)=>new FileHandle(client.files,'local:d1-test.txt','text/plain',Buffer.from(base64,'base64').length,name));
 return {client,files,backend:createSdkDocumentBackend(client)};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

it('uses only own upload, verified builtIn/1 parser and the provided signal',async()=>{
 const {backend,files}=setup(),input=source();
 expect(await backend.parse(input)).toEqual({text:'Пример',parser});
 expect(files.prepareFileBase64).toHaveBeenCalledWith(input.name,Buffer.from(input.bytes).toString('base64'));
 expect(files.parseDocument).toHaveBeenCalledWith(expect.any(FileHandle),{parserId:parser,signal:input.signal});
});

it.each(['fake','foreign','name','size','type'])('invalidHandleRejected before parser calls: %s',async variant=>{
 const {client,files,backend}=setup();
 files.prepareFileBase64.mockResolvedValue(variant==='fake'?{}:new FileHandle(variant==='foreign'?{} as LMStudioClient['files']:client.files,'local:d1-test.txt',variant==='type'?'image':'text/plain',variant==='size'?1:source().bytes.length,variant==='name'?'other.txt':'test.txt'));
 await expect(backend.parse(source())).rejects.toMatchObject({code:'INVALID_HANDLE'});
 expect(files.getDocumentParsingLibrary).not.toHaveBeenCalled();expect(files.parseDocument).not.toHaveBeenCalled();
});

it.each([{library:'unknown',version:'1'},{library:'builtIn',version:'2'}])('unknown parser does not trigger parsing or auto-loading: %j',async unsupported=>{
 const {files,backend}=setup();files.getDocumentParsingLibrary.mockResolvedValue(unsupported);
 await expect(backend.parse(source())).rejects.toMatchObject({code:'UNSUPPORTED_PARSER'});
 expect(files.parseDocument).not.toHaveBeenCalled();
});

it('missing API and malformed results never become successful text',async()=>{
 await expect(createSdkDocumentBackend({files:{} as LMStudioClient['files']}).parse(source())).rejects.toMatchObject({code:'API_UNAVAILABLE'});
 const {files,backend}=setup();files.parseDocument.mockResolvedValue({content:undefined} as unknown as {content:string;parser:typeof parser});
 await expect(backend.parse(source())).rejects.toMatchObject({code:'INVALID_RESULT'});
});

it('API unavailable and parser errors use safe reasons without SDK paths or tokens',async()=>{
 const {files,backend}=setup();
 files.getDocumentParsingLibrary.mockRejectedValue(Error('ECONNREFUSED C:\\private\\token'));
 await expect(backend.parse(source())).rejects.toMatchObject({code:'API_UNAVAILABLE'});
 files.getDocumentParsingLibrary.mockResolvedValue(parser);files.parseDocument.mockRejectedValue(Error('password=private C:\\secret.pdf'));
 try{await backend.parse(source());throw Error('Expected failure');}catch(error){expect(error).toMatchObject({code:'PARSER_ERROR'});expect(String(error)).not.toMatch(/password=|secret\.pdf/);}
});

it('unsupported PDF encryption is a file parsing error, not a claim that the API is unavailable',async()=>{
 const {files,backend}=setup();files.parseDocument.mockRejectedValue(Error('PDF encryption not supported; password private'));
 await expect(backend.parse(source())).rejects.toMatchObject({code:'PARSER_ERROR'});
});

it('cancelled upload is fenced before any later parser RPC and remains BUSY until upload settles',async()=>{
 const {files,client,backend}=setup(),pending=deferred<FileHandle>(),started=deferred<void>(),c=new AbortController();
 files.prepareFileBase64.mockImplementationOnce(()=>{started.resolve();return pending.promise;});
 const adapter=createDocumentAdapter(backend),input=source(),ctx:TurnContext={turnId:'d1-sdk',chatScopeId:null,projectId:null,sessionId:null,mode:'auto',signal:c.signal};
 const reading=adapter.prepareDocuments([{name:input.name,bytes:input.bytes}],ctx);
 await started.promise;c.abort();expect(await reading).toMatchObject({ok:false,code:'CANCELLED'});
 expect(await adapter.prepareDocuments([{name:input.name,bytes:input.bytes}],{...ctx,signal:new AbortController().signal})).toMatchObject({ok:false,code:'BUSY'});
 pending.resolve(new FileHandle(client.files,'local:d1-test.txt','text/plain',input.bytes.length,input.name));
 await pending.promise;
 await vi.waitFor(async()=>expect((await adapter.prepareDocuments([{name:input.name,bytes:input.bytes}],{...ctx,signal:new AbortController().signal})).ok).toBe(true));
 expect(files.getDocumentParsingLibrary).toHaveBeenCalledTimes(1);
 expect(files.parseDocument).toHaveBeenCalledTimes(1);
});

it.each([{perFileTimeoutMs:10,batchTimeoutMs:1000},{perFileTimeoutMs:1000,batchTimeoutMs:10}])('a late upload cannot start later SDK RPCs when timers are delayed: %j',async limits=>{
 const {client,files,backend}=setup(),input=source();
 files.prepareFileBase64.mockImplementationOnce(async()=>{
  const end=performance.now()+35;while(performance.now()<end){/* Simulate synchronous SDK work. */}
  return new FileHandle(client.files,'local:d1-test.txt','text/plain',input.bytes.length,input.name);
 });
 const ctx:TurnContext={turnId:'d1-sdk-deadline',chatScopeId:null,projectId:null,sessionId:null,mode:'auto',signal:input.signal};
 expect(await createDocumentAdapter(backend,limits).prepareDocuments([{name:input.name,bytes:input.bytes}],ctx)).toMatchObject({ok:false,code:'TIMEOUT'});
 expect(files.getDocumentParsingLibrary).not.toHaveBeenCalled();expect(files.parseDocument).not.toHaveBeenCalled();
});
