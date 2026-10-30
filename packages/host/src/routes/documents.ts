import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {createDocumentWorkspaces,DocumentHttpError,type DocumentsOptions} from '../document-workspaces.js';
const empty=z.object({}).strict(),revision=z.object({revision:z.number().int().positive()}).strict();
const selection=revision.extend({selected:z.boolean()}).strict();
const uuid='[a-f0-9-]{36}';
async function readBytes(req:IncomingMessage,signal:AbortSignal,maximum:number){
 return new Promise<Buffer>((resolve,reject)=>{
  const chunks:Buffer[]=[];let size=0,failed=false;
  const fail=(error:Error)=>{if(!failed){failed=true;chunks.length=0;reject(error);}};
  const abort=()=>fail(new DocumentHttpError(499,'Загрузка отменена.'));
  signal.addEventListener('abort',abort,{once:true});
  const clean=()=>signal.removeEventListener('abort',abort);
  req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maximum)fail(new DocumentHttpError(413,'Запрос слишком большой.'));else if(!failed)chunks.push(chunk);});
  req.once('aborted',()=>{clean();abort();});req.once('error',()=>{clean();fail(new DocumentHttpError(400,'Не удалось прочитать файл.'));});
  req.once('end',()=>{clean();if(failed)return;if(signal.aborted){abort();return;}resolve(Buffer.concat(chunks));});
  if(signal.aborted)abort();
 });
}
async function json(req:IncomingMessage,signal:AbortSignal){if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json')throw new DocumentHttpError(415,'Ожидается JSON.');try{return JSON.parse((await readBytes(req,signal,1024)).toString('utf8')) as unknown;}catch(error){if(error instanceof DocumentHttpError)throw error;throw new DocumentHttpError(400,'Некорректный JSON.');}}
export function createDocumentsRoutes(options:DocumentsOptions={}){
 const owner=createDocumentWorkspaces(options);
 return {close:()=>owner.close(),async handle(req:IncomingMessage,path:string,signal:AbortSignal){
  try{
   const method=req.method;
   if(path==='/api/documents'&&method==='POST'){if(!empty.safeParse(await json(req,signal)).success)throw new DocumentHttpError(400,'Ожидается пустой объект.');return {status:201,body:owner.create()};}
   const match=new RegExp(`^/api/documents/(${uuid})(?:/(files|items/(${uuid})(?:/(text|select|cancel|retry))?))?$`).exec(path);
   if(!match)throw new DocumentHttpError(404,'Операция недоступна.');
   const id=match[1]!,part=match[2],itemId=match[3],action=match[4];
   if(!part&&method==='GET')return {status:200,body:owner.snapshot(id)};
   if(!part&&method==='DELETE'){if(!empty.safeParse(await json(req,signal)).success)throw new DocumentHttpError(400,'Ожидается пустой объект.');return {status:200,body:owner.remove(id)};}
   if(part==='files'&&method==='POST'){
    if(req.headers['content-type']!=='application/octet-stream')throw new DocumentHttpError(415,'Выберите файл через форму.');
    let name:string;try{if(typeof req.headers['x-document-name']!=='string')throw Error();name=decodeURIComponent(req.headers['x-document-name']);}catch{throw new DocumentHttpError(400,'Не указано имя файла.');}
    const length=req.headers['content-length'];if(typeof length!=='string'||!/^\d+$/.test(length))throw new DocumentHttpError(411,'Не указан размер файла.');
    const size=Number(length),reservation=owner.reserve(id,name,size);
    try{const bytes=await readBytes(req,signal,size);signal.throwIfAborted();return {status:202,body:reservation.commit(bytes)};}finally{reservation.release();}
   }
   if(itemId&&action==='text'&&method==='GET')return {status:200,body:owner.preview(id,itemId)};
   if(itemId&&((method==='POST'&&['select','cancel','retry'].includes(action??''))||(!action&&method==='DELETE'))){
    const body=(action==='select'?selection:revision).safeParse(await json(req,signal));if(!body.success)throw new DocumentHttpError(400,'Проверьте действие и версию файла.');
    return {status:200,body:owner.action(id,itemId,action??'remove',body.data)};
   }
   throw new DocumentHttpError(404,'Операция недоступна.');
  }catch(error){if(error instanceof DocumentHttpError)return {status:error.status,body:{message:error.message}};throw error;}
 }};
}
