import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {decodeLegacy} from '../../memory/src/migration.js';
import type {MemoryStore} from '../../memory/src/store.js';
import type {MemoryRecord} from '../../memory/src/types.js';
const applySchema=z.object({previewId:z.string().uuid(),baseRevision:z.number().int().nonnegative(),ids:z.array(z.string().uuid()).min(1).max(10000)}).strict();
const undoSchema=z.object({id:z.string().uuid(),expectedRevision:z.number().int().nonnegative()}).strict();
export interface MigrationPreview {id:string;baseRevision:number;sourceCount:number;skippedSessions:number;alreadyPresent:number;records:Pick<MemoryRecord,'id'|'content'|'scope'|'projectId'|'category'|'source'>[]}
type Response={status:number;body:unknown};
const fail=(status:number,message:string):Response=>({status,body:{message}});
export function createMigrationService(get:()=>Promise<MemoryStore>){
 const previews=new Map<string,{at:number;view:MigrationPreview;records:MemoryRecord[];envelope?:string}>(),receipts=new Map<string,{at:number;signature:string;response:Response}>(),busy=new Set<string>();
 const prune=()=>{for(const [id,p] of previews)if(Date.now()-p.at>600000&&!busy.has(id))previews.delete(id);for(const [id,r] of receipts)if(Date.now()-r.at>600000)receipts.delete(id);};
 return {
  async preview(bytes:Uint8Array,signal:AbortSignal):Promise<Response>{
   signal.throwIfAborted();let decoded:Awaited<ReturnType<typeof decodeLegacy>>;try{decoded=await decodeLegacy(bytes);}catch{return fail(400,'Копия повреждена или имеет неподдерживаемые поля/версию. Нужна offline-копия persistent-memory v2 до 8 MiB. Исходник и память не изменены.');}
   const state=await(await get()).migrationState();signal.throwIfAborted();prune();if(previews.size>=2)return fail(409,'Уже подготовлены два просмотра. Закройте ненужный просмотр или дождитесь 10 минут.');
   const known=new Map(state.known.map(r=>[r.id,r.identityKey]));if(decoded.records.some(r=>known.has(r.id)&&known.get(r.id)!==r.identityKey))return fail(409,'ID источника совпадает с другой записью. Перенос остановлен.');
   const records=decoded.records.filter(r=>!known.has(r.id)),view:MigrationPreview={id:randomUUID(),baseRevision:state.revision,sourceCount:decoded.sourceCount,skippedSessions:decoded.skippedSessions,alreadyPresent:decoded.records.length-records.length,records:records.map(({id,content,scope,projectId,category,source})=>({id,content,scope,projectId,category,source}))};
   previews.set(view.id,{at:Date.now(),view,records,...(decoded.envelope?{envelope:decoded.envelope}:{})});return {status:200,body:view};
  },
  async handle(path:string,method:string,body:unknown,signal:AbortSignal):Promise<Response>{
   signal.throwIfAborted();prune();
   if(path==='/api/memory/migration/status'&&method==='GET'){const {revision,undo}=await(await get()).migrationState();return {status:200,body:{revision,undo}};}
   if(path==='/api/memory/migration/discard'&&method==='POST'){const p=z.object({previewId:z.string().uuid()}).strict().safeParse(body);if(!p.success)return fail(400,'Некорректный просмотр.');if(busy.has(p.data.previewId))return fail(409,'Перенос уже выполняется.');previews.delete(p.data.previewId);return {status:200,body:{ok:true}};}
   if(path==='/api/memory/migration/apply'&&method==='POST'){
    const parsed=applySchema.safeParse(body);if(!parsed.success)return fail(400,'Проверьте выбранные записи и версию просмотра.');const b=parsed.data,signature=createHash('sha256').update(JSON.stringify(b)).digest('hex'),done=receipts.get(b.previewId);if(done)return done.signature===signature?structuredClone(done.response):fail(409,'Этот просмотр уже применён с другим выбором.');
    const p=previews.get(b.previewId);if(!p)return fail(404,'Просмотр закрыт или устарел. Выберите копию заново.');if(busy.has(b.previewId))return fail(409,'Перенос уже выполняется.');
    const selected=new Set(b.ids);if(b.baseRevision!==p.view.baseRevision||selected.size!==b.ids.length||b.ids.some(id=>!p.records.some(r=>r.id===id)))return fail(409,'Выбор или версия не совпадает с показанным просмотром.');
    busy.add(b.previewId);try{const store=await get();signal.throwIfAborted();const records=p.records.filter(r=>selected.has(r.id)).map((r,i)=>i===0&&p.envelope?{...r,metadata:{...r.metadata,legacyEnvelope:p.envelope}}:r);const result=await store.importRecords(records,b.baseRevision,signal);const response={status:result.ok?200:result.code==='CONFLICT'?409:500,body:result};if(result.ok){previews.delete(b.previewId);while(receipts.size>=16)receipts.delete(receipts.keys().next().value!);receipts.set(b.previewId,{at:Date.now(),signature,response:structuredClone(response)});}return response;}finally{busy.delete(b.previewId);}
   }
   if(path==='/api/memory/migration/undo'&&method==='POST'){const p=undoSchema.safeParse(body);if(!p.success)return fail(400,'Некорректное подтверждение отката.');const r=await(await get()).undoImport(p.data.id,p.data.expectedRevision);return {status:r.ok?200:r.code==='CONFLICT'?409:500,body:r};}
   return fail(404,'Операция переноса недоступна.');
  },
  close(){previews.clear();receipts.clear();},
 };
}
