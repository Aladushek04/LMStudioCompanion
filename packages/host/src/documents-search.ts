import {randomUUID} from 'node:crypto';
import {SourceRegistry} from '../../core/src/sources/registry.js';
import {documentSearchSchema,RetrievalFailure} from '../../documents/src/retrieval-types.js';
import {retrieveDocuments} from '../../documents/src/retrieve.js';
import {abortable,deadline} from '../../documents/src/control.js';
import {DocumentHttpError,type createDocumentWorkspaces,type DocumentsOptions} from './document-workspaces.js';
import {nativeDocumentTokenizer,type DocumentTokenizerSession} from './document-tokenizer.js';

export function createDocumentsSearch(owner:ReturnType<typeof createDocumentWorkspaces>,options:DocumentsOptions){
 let busy=false,disposeActive:(()=>Promise<void>)|null=null;const shutdown=new AbortController();
 return {close(){shutdown.abort();void disposeActive?.().catch(()=>{});},async search(id:string,raw:unknown,signal:AbortSignal){
  const parsed=documentSearchSchema.safeParse(raw);if(!parsed.success)return {status:400,body:{message:'Проверьте вопрос и область поиска.'}};
  if(busy)return {status:409,body:{message:'Предыдущая проверка токенизатора ещё не завершилась.'}};
  const capture=owner.capture(id,parsed.data.selection);owner.clearSearch(id);busy=true;
  const scope=deadline(AbortSignal.any([signal,shutdown.signal]),options.searchDeadlineMs??8000),pending:Promise<unknown>[]=[];
  const track=<T>(promise:Promise<T>)=>{pending.push(promise);return promise;};
  let session:DocumentTokenizerSession|undefined,closing:Promise<void>|undefined,work:Promise<Awaited<ReturnType<typeof retrieveDocuments>>>|undefined,closeFailed=false;
  const dispose=()=>closing??=(async()=>{try{await session?.close();}catch(error){closeFailed=true;throw error;}})();
  const onAbort=()=>{void dispose().catch(()=>{});};scope.signal.addEventListener('abort',onAbort,{once:true});
  try{
   scope.check();session=(options.createTokenizer??nativeDocumentTokenizer)();disposeActive=dispose;
   let modelIdentifier='';
   work=(async()=>{
    const prepared=await abortable(track(session!.prepare(parsed.data.query,scope.signal)),scope.signal);scope.check();
    if(typeof prepared.modelIdentifier!=='string'||!prepared.modelIdentifier||prepared.modelIdentifier.length>200)throw Error('Tokenizer identity');modelIdentifier=prepared.modelIdentifier;
    const turnId='preview-'+randomUUID();return retrieveDocuments(capture.snapshots,parsed.data,{turnId,signal:scope.signal,registry:new SourceRegistry(turnId),contextLength:prepared.contextLength,measure:payload=>track(prepared.measure(payload)),isCurrent:capture.isCurrent});
   })();
   const result=await abortable(work,scope.signal);scope.check();
   if(!result.ok)return {status:result.code==='STALE_SELECTION'||result.code==='STALE_DOCUMENT'?409:result.code==='UNKNOWN_SECTION'||result.code==='INVALID_SCOPE'?400:503,body:{code:result.code,message:result.message}};
   await abortable(dispose(),scope.signal);scope.check();
   const response={result:result.value,modelIdentifier,previewOnly:true as const};owner.saveSearch(id,response,capture.isCurrent);return {status:200,body:response};
  }catch(error){
   if(error instanceof DocumentHttpError)return {status:error.status,body:{message:error.message}};
   return {status:scope.signal.aborted?504:503,body:{message:scope.signal.aborted?'Проверка отменена или истекло время. Результат не опубликован.':'Токенизатор недоступен. Нужен один уже загруженный экземпляр модели; автоматическая загрузка не выполняется.'}};
  }finally{
   scope.close();scope.signal.removeEventListener('abort',onAbort);const disposed=dispose();
   // Keep the slot until raw calls AND teardown settle, even if the HTTP caller cancelled.
   void Promise.allSettled([...(work?[work]:[]),...pending,disposed]).then(()=>{if(!closeFailed){busy=false;disposeActive=null;}});
  }
 }};
}
