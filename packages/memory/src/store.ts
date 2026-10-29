import {randomUUID} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import type {OperationResult} from '../../core/src/contracts.js';
import {acquireMemoryOwnership} from './ownership.js';
import {decodeSnapshot,encodeSnapshot,readSnapshot,writeRollback,writeSnapshot} from './persistence.js';
import {identity,memoryInputSchema,memoryPatchSchema,memoryRecordSchema,filterSchema,type MemoryRecord,type MemoryInput,type MemoryPatch,type MemoryFilter,type Snapshot} from './types.js';
export type {MemoryRecord} from './types.js';
export interface StoreOptions {beforeCommit?:()=>Promise<void>}
const failure=(code:string,message:string):OperationResult<never>=>({ok:false,code,message,retryable:false});
const success=<T>(value:T):OperationResult<T>=>({ok:true,value:structuredClone(value),warnings:[]});
const forgotten=(r:MemoryRecord,revision=r.revision+1):MemoryRecord=>({...r,revision,content:'',tags:[],metadata:{},source:'user',category:'note',pinned:false,confidence:1,lastAccessedAt:0,accessCount:0,supersedes:null,manualPriority:true,deletedAt:Date.now(),updatedAt:Date.now()});

export class MemoryStore {
  private records:Map<string,MemoryRecord>;
  private tail:Promise<void>=Promise.resolve();
  private accepting=true;
  private closed:Promise<void>|undefined;
  private tokens=new Map<string,{id:string;revision:number}>();
  constructor(private readonly directory:string,private snapshot:Snapshot,private readonly release:()=>Promise<void>,private readonly options:StoreOptions){this.records=new Map(snapshot.records.map(r=>[r.id,r]));}
  private enqueue<T>(run:()=>Promise<OperationResult<T>>):Promise<OperationResult<T>>{
    if(!this.accepting)return Promise.resolve(failure('CLOSED','Хранилище памяти закрыто.'));
    const pending=this.tail.then(async()=>{try{return await run();}catch{return failure('WRITE_FAILED','Изменение памяти не сохранено. Прежнее состояние оставлено без изменений.');}});
    this.tail=pending.then(()=>undefined,()=>undefined);return pending;
  }
  private async commit(next:Map<string,MemoryRecord>,persistent:boolean):Promise<void>{
    if(next.size>10000)throw new Error('Лимит записей.');
    if(persistent){const snapshot:Snapshot={...this.snapshot,revision:this.snapshot.revision+1,records:[...next.values()].filter(r=>r.scope!=='session')};await writeSnapshot(this.directory,snapshot,this.options.beforeCommit);this.snapshot=snapshot;}
    this.records=next;
  }
  getRevision():number{return this.snapshot.revision;}
  async listMemories(filter:MemoryFilter={}):Promise<MemoryRecord[]>{
    const f=filterSchema.parse(filter);await this.tail;if(!this.accepting)throw new Error('Хранилище памяти закрыто.');
    return structuredClone([...this.records.values()].filter(r=>r.deletedAt===null&&(!f.scope||r.scope===f.scope)&&(!f.projectId||r.projectId===f.projectId)&&(!f.sessionId||r.sessionId===f.sessionId)&&(!f.query||r.content.toLocaleLowerCase('ru').includes(f.query.toLocaleLowerCase('ru')))));
  }
  async getMemory(id:string):Promise<MemoryRecord|null>{await this.tail;if(!this.accepting)throw new Error('Хранилище памяти закрыто.');const r=this.records.get(id);return r&&r.deletedAt===null?structuredClone(r):null;}
  saveMemory(input:MemoryInput):Promise<OperationResult<MemoryRecord>>{
    return this.enqueue(async()=>{
      const parsed=memoryInputSchema.safeParse(input);if(!parsed.success)return failure('INVALID_INPUT','Неверные поля записи памяти.');
      const now=Date.now();const checked=memoryRecordSchema.safeParse({...parsed.data,id:randomUUID(),createdAt:now,updatedAt:now,revision:1,manualPriority:true,deletedAt:null,lastAccessedAt:0,accessCount:0});
      if(!checked.success)return failure('INVALID_INPUT','Область памяти и её идентификаторы не согласованы.');
      const record=checked.data;
      if([...this.records.values()].some(r=>identity(r)===identity(record)))return failure('CONFLICT','Факт с таким ключом уже существует или был забыт. Используйте явное исправление или восстановление.');
      const next=new Map(this.records);next.set(record.id,record);await this.commit(next,record.scope!=='session');return success(record);
    });
  }
  private change(id:string,expectedRevision:number,run:(r:MemoryRecord)=>MemoryRecord,deleted=false):Promise<OperationResult<MemoryRecord>>{
    return this.enqueue(async()=>{
      const r=this.records.get(id);if(!r)return failure('NOT_FOUND','Запись памяти не найдена.');
      if(!Number.isSafeInteger(expectedRevision)||r.revision!==expectedRevision)return failure('CONFLICT','Запись уже изменена. Обновите её перед сохранением.');
      if((r.deletedAt!==null)!==deleted)return failure('CONFLICT','Состояние записи изменилось.');
      const checked=memoryRecordSchema.safeParse(run(r));if(!checked.success)return failure('INVALID_INPUT','Неверное изменение памяти.');
      const next=new Map(this.records);next.set(id,checked.data);await this.commit(next,r.scope!=='session');return success(checked.data);
    });
  }
  updateMemory(id:string,patch:MemoryPatch,expectedRevision:number):Promise<OperationResult<MemoryRecord>>{
    const parsed=memoryPatchSchema.safeParse(patch);if(!parsed.success)return Promise.resolve(failure('INVALID_INPUT','Неверное изменение памяти.'));
    return this.change(id,expectedRevision,r=>({...r,content:parsed.data.content??r.content,category:parsed.data.category??r.category,pinned:parsed.data.pinned??r.pinned,tags:parsed.data.tags??r.tags,revision:r.revision+1,updatedAt:Date.now(),manualPriority:true}));
  }
  async deleteMemory(id:string,expectedRevision:number):Promise<OperationResult<void>>{
    const result=await this.change(id,expectedRevision,r=>forgotten(r));return result.ok?success(undefined):result;
  }
  reviveMemory(id:string,content:string,expectedRevision:number):Promise<OperationResult<MemoryRecord>>{
    return this.change(id,expectedRevision,r=>({...r,content,revision:r.revision+1,updatedAt:Date.now(),deletedAt:null,manualPriority:true}),true);
  }
  beginBackgroundUpdate(id:string):Promise<OperationResult<{token:string}>>{
    return this.enqueue(async()=>{
      const r=this.records.get(id);if(!r||r.deletedAt!==null)return failure('NOT_FOUND','Активная запись не найдена.');
      if(this.tokens.size>=1024)return failure('LIMIT','Слишком много ожидающих операций памяти.');
      const token=randomUUID();this.tokens.set(token,{id,revision:r.revision});return success({token});
    });
  }
  applyBackgroundResult(token:string,_content:string):Promise<OperationResult<MemoryRecord>>{
    return this.enqueue(async()=>{
      const pending=this.tokens.get(token);this.tokens.delete(token);if(!pending)return failure('INVALID_TOKEN','Фоновая операция устарела или уже обработана.');
      const r=this.records.get(pending.id);if(!r||r.deletedAt!==null||r.revision!==pending.revision)return failure('CONFLICT','Факт изменён или забыт; фоновый результат не применён.');
      return failure('CONFIRMATION_REQUIRED','Изменение памяти требует явного подтверждения пользователя.');
    });
  }
  async exportBackup():Promise<string>{await this.tail;if(!this.accepting)throw new Error('Хранилище памяти закрыто.');return encodeSnapshot(this.snapshot);}
  restoreBackup(serialized:string,expectedRevision:number):Promise<OperationResult<void>>{
    return this.enqueue(async()=>{
      if(expectedRevision!==this.snapshot.revision)return failure('CONFLICT','Хранилище изменилось; обновите состояние перед восстановлением.');
      let backup:Snapshot;try{backup=decodeSnapshot(serialized);}catch{return failure('INVALID_BACKUP','Резервная копия повреждена или имеет неподдерживаемый формат.');}
      if(backup.storeId!==this.snapshot.storeId)return failure('INVALID_BACKUP','Копия принадлежит другому хранилищу.');
      const next=new Map<string,MemoryRecord>();
      // Restore is explicit; preserve a monotonic revision even for identities absent from backup.
      for(const r of backup.records){const current=this.records.get(r.id);next.set(r.id,{...r,revision:Math.max(current?.revision??0,r.revision)+1,manualPriority:r.manualPriority||Boolean(current?.manualPriority),updatedAt:Date.now()});}
      for(const r of this.records.values())if(r.scope!=='session'&&!next.has(r.id))next.set(r.id,forgotten(r));
      await writeRollback(this.directory,this.snapshot);
      await this.commit(next,true);this.tokens.clear();return success(undefined);
    });
  }
  close():Promise<void>{
    if(!this.closed){this.accepting=false;this.closed=this.tail.then(async()=>{this.tokens.clear();this.records.clear();await this.release();});}return this.closed;
  }
}
export async function openMemoryStore(directory:string,options:StoreOptions={}):Promise<MemoryStore>{
  if(!isAbsolute(directory)||directory.startsWith('\\\\'))throw new Error('Нужен отдельный абсолютный локальный каталог памяти.');
  await mkdir(directory,{recursive:true});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Каталог памяти не должен быть ссылкой.');
  const canonical=await realpath(directory);const release=await acquireMemoryOwnership(canonical);
  try{
    let snapshot:Snapshot;
    try{snapshot=await readSnapshot(join(canonical,'memory.json'));}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Не удалось проверить снимок памяти. Исходный файл не изменён.');
      if((await readdir(canonical)).some(name=>name!=='.memory-lock'))throw new Error('Новый каталог памяти должен быть пустым.');
      snapshot={format:'companion-memory-v1',storeId:randomUUID(),revision:0,records:[]};await writeSnapshot(canonical,snapshot,options.beforeCommit);
    }
    return new MemoryStore(canonical,snapshot,release,options);
  }catch(error){await release();throw error;}
}
