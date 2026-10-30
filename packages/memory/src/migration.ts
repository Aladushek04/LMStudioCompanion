import {memoryRecordSchema,type MemoryRecord} from './types.js';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {MAX_BYTES} from './persistence.js';
export interface DecodedMigration {records:MemoryRecord[];sourceCount:number;skippedSessions:number;envelope?:string}
const legacy=z.object({id:z.string().min(1).max(200),content:z.string().min(1).max(16000),category:z.string().min(1).max(100),tags:z.array(z.string().min(1).max(100)).max(100),confidence:z.number().min(0).max(1),source:z.string().min(1).max(200),scope:z.enum(['global','project','session']),project:z.string().min(1).max(200).nullable(),createdAt:z.number().int().nonnegative().safe(),updatedAt:z.number().int().nonnegative().safe(),lastAccessedAt:z.number().int().nonnegative().safe(),accessCount:z.number().int().nonnegative().safe(),supersedes:z.string().nullable()}).passthrough();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const mappedId=(id:string)=>{const h=hash('persistent-memory-v2:'+id).slice(0,32).split('');h[12]='5';h[16]='8';const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;};
function portable(value:unknown):unknown{if(value instanceof Uint8Array)return {sqliteBlobBase64:Buffer.from(value).toString('base64')};if(typeof value==='bigint'){const n=Number(value);return Number.isSafeInteger(n)?n:{sqliteInteger:value.toString()};}if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,portable(v)]));return value;}
export async function decodeLegacy(bytes:Uint8Array):Promise<DecodedMigration>{
 if(!bytes.length||bytes.length>MAX_BYTES)throw Error('Размер копии должен быть от 1 байта до 8 MiB.');
 let rows:unknown[],sqlite=false,envelope='';
 if(Buffer.from(bytes.subarray(0,16)).toString('binary')==='SQLite format 3\0'){
  sqlite=true;const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:',{allowExtension:false});
  try{
   const reader=db as typeof db & {deserialize:(bytes:Uint8Array)=>void;limits:{length:number;column:number;sqlLength:number}};
   if(typeof reader.deserialize!=='function')throw Error('Для SQLite-переноса нужен Node 24.16 или новее из комплекта Companion.');
   reader.deserialize(bytes);reader.limits.length=MAX_BYTES;reader.limits.column=128;reader.limits.sqlLength=65536;db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
   if(db.prepare('PRAGMA user_version').get()?.user_version!==2)throw Error('Поддерживается только SQLite-схема persistent-memory версии 2.');
   const table=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='memories'").get();
   if(table?.type!=='table'||!/^CREATE\s+TABLE\s/iu.test(String(table.sql))||db.prepare("PRAGMA table_xinfo('memories')").all().some(r=>r.hidden!==0))throw Error('Таблица памяти не является обычной таблицей версии 2.');
   const query=db.prepare('SELECT * FROM memories LIMIT 10001');query.setReadBigInts(true);rows=query.all().map(portable);
  }finally{db.close();}
 }else{
  const original=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const data=z.object({format:z.literal('persistent-memory-v2'),records:z.array(z.unknown()).max(10000)}).passthrough().parse(original);
  rows=data.records;const {records,...rest}=original as Record<string,unknown>;envelope=JSON.stringify(rest);
 }
 if(rows.length>10000)throw Error('В копии больше 10000 записей.');
 const ids=new Set<string>(),records:MemoryRecord[]=[];let skippedSessions=0;
 for(const raw of rows){
  const object=z.record(z.unknown()).parse(raw),id=z.string().min(1).max(200).parse(object.id);if(ids.has(id))throw Error('В копии повторяется ID записи.');ids.add(id);
  const scope=z.enum(['global','project','session']).parse(object.scope);if(scope==='session'){skippedSessions++;continue;}
  const input=sqlite?{...object,tags:JSON.parse(z.string().parse(object.tags)),createdAt:object.created_at,updatedAt:object.updated_at,lastAccessedAt:object.last_accessed_at,accessCount:object.access_count}:object;
  const r=legacy.parse(input);if(scope==='project'&&!r.project)throw Error('Проектная запись не имеет проекта.');
  records.push(memoryRecordSchema.parse({id:mappedId(id),identityKey:'legacy.v2.'+hash(id),content:r.content,category:r.category,tags:r.tags,confidence:r.confidence,source:r.source,scope,projectId:scope==='project'?r.project:null,sessionId:null,createdAt:r.createdAt,updatedAt:r.updatedAt,lastAccessedAt:r.lastAccessedAt,accessCount:r.accessCount,supersedes:r.supersedes,revision:1,pinned:false,manualPriority:r.source==='user',deletedAt:null,metadata:{legacyId:id,legacyRaw:JSON.stringify(raw),legacyFormat:sqlite?'sqlite-v2':'json-v2'}}));
 }
 // Preserve a usable relationship when both ends are present; raw original ID remains in metadata.
 for(const r of records)if(r.supersedes&&ids.has(r.supersedes))r.supersedes=mappedId(r.supersedes);
 if(envelope&&records[0])records[0].metadata.legacyEnvelope=envelope;
 return {records,sourceCount:rows.length,skippedSessions,...(envelope?{envelope}:{})};
}
