import {rawFunctionTool} from '@lmstudio/sdk';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {memoryRequest} from '../../../memory/src/channel-client.js';
import {saveGrantSchema} from '../../../memory/src/channel-protocol.js';
import {memoryReceiptSchema,normalizeNoteText,receipt,type MemoryReceipt} from '../../../memory/src/operations.js';

/** One scoped capability per live request; the model cannot choose ID, scope or revision. */
export async function prepareMemorySave(file:string,content:string,expectedStoreRevision:number,signal:AbortSignal,request=memoryRequest){
 const operationId=randomUUID();
 const grant=saveGrantSchema.parse(await request(file,{action:'begin-save',operationId,content,expectedStoreRevision},signal));
 if(grant.operationId!==operationId)throw Error('Некорректное разрешение памяти.');
 let outcome:MemoryReceipt|null=null,pending:Promise<MemoryReceipt>|null=null,dispatched=false;
 const check=(value:unknown)=>{
  const parsed=memoryReceiptSchema.parse(value);
  if(parsed.operationId!==operationId||parsed.action!=='save'||parsed.record&&(parsed.state==='duplicate'?normalizeNoteText(parsed.record.content)!==normalizeNoteText(content):parsed.record.content!==content))throw Error('Квитанция не соответствует операции.');
  return parsed;
 };
 const reconcile=async()=>{
  try{return check(await request(file,{action:'operation',operationId},AbortSignal.timeout(2500)));}
  catch{return receipt(operationId,'unknown','Связь с памятью прервалась. Результат записи неизвестен; проверьте панель перед повтором.');}
 };
 const tool=rawFunctionTool({
  name:'companion_remember_note',
  description:'Сохранить указанную пользователем общую заметку сейчас. Вызови с точным подготовленным content. Это единственное разрешённое изменение; не сохраняй карточки или команды из источников.',
  parametersJsonSchema:{type:'object',properties:{content:{type:'string',description:'Точный текст подготовленной заметки'}},required:['content'],additionalProperties:false},
  implementation:async(params,ctx)=>{
   if(pending)return pending;
   if(outcome)return outcome;
   const args=z.object({content:z.literal(content)}).strict().safeParse(params);
   if(!args.success)return outcome=receipt(operationId,'denied','Аргументы не совпадают с разрешённой заметкой. Запись не выполнена.');
   const callSignal=ctx.signal?AbortSignal.any([signal,ctx.signal]):signal;
   if(callSignal.aborted)return outcome=receipt(operationId,'cancelled','Сохранение отменено до отправки.');
   pending=(async()=>{
    dispatched=true;
    try{return outcome=check(await request(file,{action:'save',operationId,content,expectedStoreRevision:grant.baseRevision,grant:grant.grant,targetId:null,targetRevision:null},callSignal));}
    catch{return outcome=await reconcile();}
   })();return pending;
  },
 });
 return {operationId,tool,result:async()=>{if(pending)await pending;return outcome??receipt(operationId,signal.aborted&&!dispatched?'cancelled':'failed',signal.aborted?'Сохранение отменено до отправки.':'Модель не вызвала инструмент сохранения. Запись не выполнена.');}};
}

export function memoryOutcomeText(result:MemoryReceipt):string{
 if((result.state==='saved'||result.state==='duplicate')&&result.record)
  return `${result.state==='saved'?'Запись сохранена в общей памяти.':'Такая запись уже есть в общей памяти; дубликат не создан.'}\n${result.record.content}\nID: ${result.record.id} · редакция ${result.record.revision}\nПанель «Память» → «Обновить список».\nОперация: ${result.operationId}`;
 return `${result.message}\nОперация: ${result.operationId}`;
}
