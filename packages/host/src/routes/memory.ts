import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {openMemoryStore,type MemoryStore,type StoreOptions} from '../../../memory/src/store.js';
import type {OperationResult} from '../../../core/src/contracts.js';
import {ProposalQueue,acceptanceSchema} from '../../../memory/src/proposals.js';
import {createMigrationService} from '../memory-migration.js';
const create=z.object({content:z.string().trim().min(1).max(16000),category:z.string().trim().min(1).max(100),pinned:z.boolean(),scope:z.enum(['global','project']),projectId:z.string().trim().min(1).max(200).nullable()}).strict().refine(r=>r.scope==='project'?r.projectId!==null:r.projectId===null);
const edit=z.object({content:z.string().trim().min(1).max(16000),category:z.string().trim().min(1).max(100),pinned:z.boolean(),expectedRevision:z.number().int().positive()}).strict();
const remove=z.object({expectedRevision:z.number().int().positive()}).strict();
interface Response {status:number;body:unknown;download?:boolean}
const bad=(status:number,code:string,message:string):Response=>({status,body:{ok:false,code,message,retryable:false}});
function result<T>(r:OperationResult<T>):Response{return {status:r.ok?200:r.code==='CONFLICT'?409:r.code==='NOT_FOUND'?404:r.code==='INVALID_INPUT'?400:500,body:r};}

export function createMemoryRoutes(directory:string,options:StoreOptions={}){
  let pending:Promise<MemoryStore>|null=null;let closing=false;
  const get=()=>{
    if(closing)throw new Error('Память закрывается.');
    if(!pending)pending=openMemoryStore(directory,options).catch(e=>{pending=null;throw e;});
    return pending;
  };
  const proposals=new ProposalQueue(get);
  const migration=createMigrationService(get);
  return {
    get,proposals,migration,
    async handle(path:string,method:string,body:unknown,signal:AbortSignal):Promise<Response>{
      signal.throwIfAborted();
      if(path.startsWith('/api/memory/migration/'))return migration.handle(path,method,body,signal);
      if(path==='/api/memory/proposals'&&method==='GET')return {status:200,body:{proposals:proposals.list()}};
      const proposal=/^\/api\/memory\/proposals\/([a-f0-9-]{36})\/(accept|reject|refresh)$/.exec(path);
      if(proposal&&method==='POST'){
        const id=z.string().uuid().safeParse(proposal[1]);if(!id.success)return bad(400,'INVALID_INPUT','Некорректное предложение.');
        if(proposal[2]==='accept'){const parsed=acceptanceSchema.safeParse(body);if(!parsed.success)return bad(400,'INVALID_INPUT','Проверьте текст и поля подтверждения.');return result(await proposals.accept(id.data,parsed.data));}
        if(!z.object({}).strict().safeParse(body).success)return bad(400,'INVALID_INPUT','Ожидается пустой объект.');
        if(proposal[2]==='reject')return result(proposals.reject(id.data));
        return result(await proposals.refresh(id.data));
      }
      const id=path.slice('/api/memory/'.length);
      const recordPath=z.string().uuid().safeParse(id).success;
      if(!((path==='/api/memory'&&['GET','POST'].includes(method))||(path==='/api/memory/export'&&method==='GET')||(recordPath&&['PATCH','DELETE'].includes(method))))return bad(404,'NOT_FOUND','Операция памяти недоступна.');
      const parsed=method==='POST'?create.safeParse(body):method==='PATCH'?edit.safeParse(body):method==='DELETE'?remove.safeParse(body):null;
      if(parsed&&!parsed.success)return bad(400,'INVALID_INPUT','Проверьте текст, область и поля записи памяти.');
      let store:MemoryStore;
      try{store=await get();}catch{return bad(503,'MEMORY_UNAVAILABLE','Хранилище памяти недоступно. Проверьте, не открыто ли оно другим процессом. Остальные разделы панели доступны.');}
      signal.throwIfAborted();
      if(path==='/api/memory/export')return {status:200,body:JSON.parse(await store.exportBackup()),download:true};
      if(method==='GET')return {status:200,body:{records:await store.listMemories(),revision:store.getRevision()}};
      if(method==='POST'){const input=create.parse(body);return result(await store.saveMemory({...input,identityKey:'manual.'+randomUUID(),sessionId:null,source:'user'}));}
      if(method==='PATCH'){const {expectedRevision,...patch}=edit.parse(body);return result(await store.updateMemory(id,patch,expectedRevision));}
      return result(await store.deleteMemory(id,remove.parse(body).expectedRevision));
    },
    async close(){closing=true;migration.close();const store=await pending?.catch(()=>null);await store?.close();},
  };
}
