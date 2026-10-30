import {randomUUID} from 'node:crypto';
import type {OperationResult,TurnContext} from '../../core/src/contracts.js';
import {turnContextSchema} from '../../core/src/contracts.js';
import {DocumentFailure,asDocumentFailure} from './errors.js';
import {deadline,abortable,throwIfAborted} from './control.js';
import {documentLimits,parsedTextSchema,type DocumentBackend,type DocumentLimits,type DocumentReadOptions,type DocumentState} from './types.js';
import {selectedSnapshots,validateContent,normalizeText,hash,textVersion} from './text.js';

const failed=(error:DocumentFailure):OperationResult<never>=>({ok:false,code:error.code,message:error.message,retryable:error.retryable});
export function createDocumentAdapter(backend:DocumentBackend,overrides:Partial<DocumentLimits>={}){
 const limits:DocumentLimits={...documentLimits,...overrides};
 if(Object.keys(limits).length!==Object.keys(documentLimits).length||Object.entries(limits).some(([key,value])=>!Number.isSafeInteger(value)||value<=0||value>documentLimits[key as keyof DocumentLimits]))throw new RangeError('Лимиты документов можно только уменьшать.');
 if(typeof backend?.parse!=='function')throw new TypeError('Нужен backend чтения документов.');
 let busy=false;
 return {async prepareDocuments(inputs:unknown[],ctx:TurnContext,options:DocumentReadOptions={}):Promise<OperationResult<DocumentState[]>>{
  if(busy)return failed(new DocumentFailure('BUSY'));
  let sources:ReturnType<typeof selectedSnapshots>;
  try{if(!turnContextSchema.safeParse(ctx).success)throw new DocumentFailure('INVALID_INPUT');throwIfAborted(ctx.signal);sources=selectedSnapshots(inputs,limits);}catch(error){return failed(asDocumentFailure(error));}
  busy=true;
  const scope=deadline(ctx.signal,limits.batchTimeoutMs),operationId=randomUUID(),warnings:string[]=[];
  let active:Promise<unknown>|undefined,settled=true;
  const states:DocumentState[]=sources.map(source=>({id:randomUUID(),operationId,turnId:ctx.turnId,name:source.name,contentHash:source.contentHash,sizeBytes:source.bytes.length,state:'processing',code:null,reason:null,text:null,parser:null,textHash:null,version:null,locators:[],retrieval:{state:'not-prepared',reason:'Подбор фрагментов не выполнялся.'}}));
  const notify=(state:DocumentState)=>{
   try{const result=options.onState?.(structuredClone(state));if(result)void Promise.resolve(result).catch(()=>{warnings.push('Не удалось обновить отображение статуса.');});}
   catch{warnings.push('Не удалось обновить отображение статуса.');}
  };
  const checkCurrent=(signal:AbortSignal)=>{throwIfAborted(signal);try{if(options.isCurrent&&!options.isCurrent())throw new DocumentFailure('STALE');}catch{throw new DocumentFailure('STALE');}};
  const finishError=(state:DocumentState,error:DocumentFailure,unreadable=false)=>{state.state=error.code==='STALE'?'stale':unreadable?'unreadable':'error';state.code=error.code;state.reason=error.message;state.text=null;state.locators=[];state.version=null;state.textHash=null;notify(state);};
  try{
   for(let index=0;index<sources.length;index++){
    const source=sources[index]!,state=states[index]!;checkCurrent(scope.signal);notify(state);checkCurrent(scope.signal);
    try{validateContent(source,limits.maxTextChars);}catch(error){finishError(state,asDocumentFailure(error),true);continue;}
    const fileScope=deadline(scope.signal,limits.perFileTimeoutMs,true);
    try{
     checkCurrent(fileScope.signal);
     active=Promise.resolve().then(()=>{checkCurrent(fileScope.signal);return backend.parse({name:source.name,bytes:source.bytes,signal:fileScope.signal});});settled=false;
     active.then(()=>{settled=true;},()=>{settled=true;});
     const raw=await abortable(active,fileScope.signal);checkCurrent(fileScope.signal);
     const parsed=parsedTextSchema.safeParse(raw);if(!parsed.success)throw new DocumentFailure('INVALID_RESULT');
     if(parsed.data.parser.library!=='builtIn'||parsed.data.parser.version!=='1')throw new DocumentFailure('UNSUPPORTED_PARSER');
     const text=normalizeText(parsed.data.text,limits.maxTextChars);state.parser=parsed.data.parser;
     if(!text.trim()){finishError(state,new DocumentFailure('NO_TEXT'),true);continue;}
     checkCurrent(fileScope.signal);state.state='ready';state.text=text;state.textHash=hash(text);state.version=textVersion(state.contentHash,state.parser,state.textHash);
     state.locators=[{kind:'text-range',start:0,end:text.length,label:state.name+' · извлечённый текст'}];notify(state);
    }catch(error){
     const failure=asDocumentFailure(error,fileScope.signal);
     if(['CANCELLED','TIMEOUT','STALE'].includes(failure.code))throw failure;
     finishError(state,failure);
    }finally{fileScope.close();}
   }
   checkCurrent(scope.signal);
   if(states.some(state=>state.state!=='ready'))warnings.push('Не все документы прочитаны; причины указаны у файлов.');
   return {ok:true,value:structuredClone(states),warnings:[...new Set(warnings)]};
  }catch(error){
   const failure=asDocumentFailure(error,scope.signal);
   for(const state of states)if(state.state==='processing')finishError(state,failure);
   return failed(failure);
  }finally{
   scope.close();
   if(!settled&&active)active.then(()=>{busy=false;},()=>{busy=false;});else busy=false;
  }
 }};
}
