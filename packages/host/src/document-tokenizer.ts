import {Chat,LMStudioClient} from '@lmstudio/sdk';
import {throwIfAborted} from '../../documents/src/control.js';
export interface PreparedDocumentTokenizer {modelIdentifier:string;contextLength:number;measure(payload:string):Promise<number>}
export interface DocumentTokenizerSession {prepare(query:string,signal:AbortSignal):Promise<PreparedDocumentTokenizer>;close():Promise<void>}
/** listLoaded returns instance-bound LLMs. Never model()/load()/prediction/embedding. */
export function nativeDocumentTokenizer():DocumentTokenizerSession{
 const client=new LMStudioClient({baseUrl:'ws://127.0.0.1:1234',logger:{debug(){},info(){},warn(){},error(){}}});
 return {async prepare(query,signal){
  throwIfAborted(signal);const models=await client.llm.listLoaded();throwIfAborted(signal);
  if(models.length!==1)throw Error('Expected exactly one already loaded instance');const model=models[0]!;
  const contextLength=await model.getContextLength();throwIfAborted(signal);
  return {modelIdentifier:model.identifier,contextLength,async measure(payload){
   throwIfAborted(signal);const prompt=await model.applyPromptTemplate(Chat.from([{role:'user',content:query+payload}]));throwIfAborted(signal);
   const total=await model.countTokens(prompt);throwIfAborted(signal);return total;
  }};
 },close:()=>client[Symbol.asyncDispose]()};
}
