import type {MemoryStore} from './store.js';
import type {OperationResult} from '../../core/src/contracts.js';
import type {CaptureMode} from './capture.js';
import {captureMemory,normalizeFact} from './capture.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {rankMemories} from './retrieval.js';
export interface ProposalTarget {id:string;revision:number;content:string;category:string;pinned:boolean}
export interface Proposal {id:string;kind:'save'|'edit'|'delete';origin:'explicit'|'suggested';content:string;createdAt:number;baseRevision:number;targets:ProposalTarget[]}
export type CaptureReply={state:'pending'|'ignored'|'blocked'|'duplicate'|'unresolved'|'limit';message:string;proposalId?:string};
export type Acceptance={choice:'save';content:string}|{choice:'replace';content:string;targetId:string;expectedRevision:number}|{choice:'delete';targetId:string;expectedRevision:number};
const content=z.string().trim().min(1).max(16000),target={targetId:z.string().uuid(),expectedRevision:z.number().int().positive()};
export const acceptanceSchema=z.discriminatedUnion('choice',[z.object({choice:z.literal('save'),content}).strict(),z.object({choice:z.literal('replace'),content,...target}).strict(),z.object({choice:z.literal('delete'),...target}).strict()]);
type Applied={id:string;kind:'saved'|'updated'|'deleted'};
const fail=(code:string,message:string):OperationResult<never>=>({ok:false,code,message,retryable:false});
const ok=<T>(value:T):OperationResult<T>=>({ok:true,value:structuredClone(value),warnings:[]});
const ttl=3600000;
export class ProposalQueue {
 private pending=new Map<string,Proposal>();
 private receipts=new Map<string,{signature:string;at:number;result:OperationResult<Applied>}>();
 private busy=new Map<string,{signature:string;operation:Promise<OperationResult<Applied>>}>();
 constructor(private get:()=>Promise<MemoryStore>){}
 private prune(){const now=Date.now();for(const [id,p] of this.pending)if(now-p.createdAt>ttl&&!this.busy.has(id))this.pending.delete(id);for(const [id,r] of this.receipts)if(now-r.at>ttl)this.receipts.delete(id);}
 list():Proposal[]{this.prune();return structuredClone([...this.pending.values()]);}
 private targets(records:Awaited<ReturnType<MemoryStore['listMemories']>>,text:string):ProposalTarget[]{return rankMemories(records,text).filter(r=>r.score>.15).slice(0,3).map(({id,revision,content,category,pinned})=>({id,revision,content,category,pinned}));}
 async capture(text:string,mode:CaptureMode):Promise<CaptureReply>{
  const intent=captureMemory(text,mode);if(intent.kind==='none')return {state:'ignored',message:''};if(intent.kind==='blocked')return {state:'blocked',message:intent.message};
  const store=await this.get(),view=await store.readView(),records=view.records.filter(r=>r.scope==='global');this.prune();
  const content=intent.kind==='delete'?'':intent.content;
  if(intent.kind==='save'&&records.some(r=>normalizeFact(r.content)===normalizeFact(content)))return {state:'duplicate',message:'Такая запись уже есть в общей памяти. Повтор не создавался.'};
  const matches=intent.kind==='save'?this.targets(records,content):records.filter(r=>normalizeFact(r.content)===normalizeFact(intent.selector)).map(({id,revision,content,category,pinned})=>({id,revision,content,category,pinned}));
  if(intent.kind!=='save'&&matches.length!==1)return {state:'unresolved',message:'Не найдена одна точная запись общей памяти. Уточните её полный текст или выберите запись в панели. Изменений нет.'};
  const duplicate=[...this.pending.values()].find(p=>p.kind===intent.kind&&normalizeFact(p.content)===normalizeFact(content)&&p.targets[0]?.id===matches[0]?.id&&p.origin===intent.origin);
  if(duplicate)return {state:'pending',proposalId:duplicate.id,message:'Это предложение уже ожидает подтверждения в панели «Память».'};
  if(this.pending.size>=32)return {state:'limit',message:'Очередь предложений заполнена. Откройте «Память» и примените или отклоните прежние предложения. Записи не изменены.'};
  const p:Proposal={id:randomUUID(),kind:intent.kind,origin:intent.origin,content,createdAt:Date.now(),baseRevision:view.revision,targets:matches};this.pending.set(p.id,p);
  return {state:'pending',proposalId:p.id,message:'Предложение '+(p.kind==='save'?'сохранить запись':p.kind==='edit'?'исправить запись':'забыть запись')+' подготовлено. Пока ничего не изменено. В панели «Память» нажмите «Обновить предложения», затем подтвердите или отклоните.'};
 }
 async accept(id:string,body:Acceptance):Promise<OperationResult<Applied>>{
  this.prune();const parsed=acceptanceSchema.safeParse(body);if(!parsed.success)return fail('INVALID_INPUT','Проверьте действие и текст предложения.');const signature=JSON.stringify(parsed.data),done=this.receipts.get(id),running=this.busy.get(id);
  if(done)return done.signature===signature?structuredClone(done.result):fail('CONFLICT','Это предложение уже применено с другим текстом. Обновите список.');
  if(running)return running.signature===signature?running.operation:fail('CONFLICT','Предложение уже обрабатывается.');
  const p=this.pending.get(id);if(!p)return fail('NOT_FOUND','Предложение отсутствует или истёк его срок. Обновите список.');
  const operation=(async():Promise<OperationResult<Applied>>=>{
   const store=await this.get(),b=parsed.data;let result:OperationResult<Applied>;
   if(b.choice==='save'){
    if(p.kind!=='save')return fail('INVALID_INPUT','Для этого предложения нельзя создавать новую запись.');
    const r=await store.saveMemory({identityKey:'chat.'+p.id,content:b.content,scope:'global',projectId:null,sessionId:null,source:p.origin==='explicit'?'chat-explicit':'chat-suggested'},p.baseRevision);result=r.ok?ok({id:r.value.id,kind:'saved'}):r;
   }else{
    const t=p.targets.find(t=>t.id===b.targetId);if(!t||t.revision!==b.expectedRevision)return fail('CONFLICT','Выбранная редакция не совпадает с показанным предложением. Обновите предложение.');
    if(b.choice==='delete'){
     if(p.kind!=='delete')return fail('INVALID_INPUT','Это предложение не предназначено для удаления.');const r=await store.deleteMemory(t.id,t.revision);result=r.ok?ok({id:t.id,kind:'deleted'}):r;
    }else{
     if(p.kind==='delete')return fail('INVALID_INPUT','Предложение удаления не может исправлять текст.');const r=await store.updateMemory(t.id,{content:b.content},t.revision);result=r.ok?ok({id:t.id,kind:'updated'}):r;
    }
   }
   if(result.ok){this.pending.delete(id);while(this.receipts.size>=128)this.receipts.delete(this.receipts.keys().next().value!);this.receipts.set(id,{signature,at:Date.now(),result:structuredClone(result)});}return result;
  })();this.busy.set(id,{signature,operation});try{return await operation;}finally{this.busy.delete(id);}
 }
 reject(id:string):OperationResult<void>{this.prune();if(this.busy.has(id))return fail('CONFLICT','Предложение уже обрабатывается.');if(!this.pending.delete(id))return fail('NOT_FOUND','Предложение уже закрыто или истекло.');return ok(undefined);}
 async refresh(id:string):Promise<OperationResult<Proposal>>{
  this.prune();if(this.busy.has(id))return fail('CONFLICT','Предложение уже обрабатывается.');const p=this.pending.get(id);if(!p)return fail('NOT_FOUND','Предложение уже закрыто или истекло.');
  const view=await (await this.get()).readView();if(this.pending.get(id)!==p||this.busy.has(id))return fail('CONFLICT','Состояние предложения изменилось. Обновите список.');
  const records=view.records.filter(r=>r.scope==='global'),targets=p.kind==='save'?this.targets(records,p.content):records.filter(r=>r.id===p.targets[0]?.id).map(({id,revision,content,category,pinned})=>({id,revision,content,category,pinned}));
  if(p.kind!=='save'&&targets.length!==1)return fail('NOT_FOUND','Запись уже забыта. Позднее предложение не может её восстановить.');
  const next={...p,baseRevision:view.revision,targets};this.pending.set(id,next);return ok(next);
 }
}
