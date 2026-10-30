import {it,expect,afterEach,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMemoryStore,type MemoryStore} from '../../packages/memory/src/store.js';
import {ProposalQueue} from '../../packages/memory/src/proposals.js';
const clean:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of clean.reverse())await fn();clean.length=0;});
async function setup(options:Parameters<typeof openMemoryStore>[1]={}){const dir=await mkdtemp(join(tmpdir(),'companion-proposals-'));clean.push(()=>rm(dir,{recursive:true,force:true}));let store=await openMemoryStore(dir,options);clean.push(()=>store.close());return {dir,get store(){return store;},queue:new ProposalQueue(async()=>store),restart:async()=>{await store.close();store=await openMemoryStore(dir);return new ProposalQueue(async()=>store);}};}
function value<T>(r:{ok:true;value:T}|{ok:false;message:string}):T{if(!r.ok)throw Error(r.message);return r.value;}
const input=(content:string)=>({identityKey:'manual.fixture',content,scope:'global' as const,projectId:null,sessionId:null,source:'user'});
it('proposing never writes; accept is explicit, idempotent, editable and persists after restart',async()=>{
 const s=await setup();const p=await s.queue.capture('Запомни: Синтетический маяк МЕДЬ-731','explicit');expect(p.state).toBe('pending');expect(await s.store.listMemories()).toEqual([]);
 const body={choice:'save' as const,baseRevision:0,content:'Синтетический маяк МЕДЬ-972'};
 const first=await s.queue.accept(p.proposalId!,body);expect(first.ok).toBe(true);expect(await s.queue.accept(p.proposalId!,body)).toEqual(first);expect(await s.store.listMemories()).toHaveLength(1);
 const q=await s.restart();expect(q.list()).toEqual([]);expect((await s.store.listMemories())[0]?.content).toBe(body.content);
});
it('rejecting a conflicting edit preserves the manual fact; accepting requires the current revision',async()=>{
 const s=await setup(),r=value(await s.store.saveMemory(input('Предпочитаю кратко')));
 const p=await s.queue.capture('Исправь в памяти «Предпочитаю кратко» на «Предпочитаю подробно»','explicit');expect(p.state).toBe('pending');expect(s.queue.list()[0]?.targets[0]?.id).toBe(r.id);
 expect(s.queue.reject(p.proposalId!).ok).toBe(true);expect((await s.store.getMemory(r.id))?.content).toBe(r.content);
 const next=await s.queue.capture('Исправь в памяти «Предпочитаю кратко» на «Предпочитаю подробно»','explicit');
 value(await s.store.updateMemory(r.id,{content:'Моя ручная правка'},1));
 expect(await s.queue.accept(next.proposalId!,{choice:'replace',targetId:r.id,expectedRevision:1,content:'Предпочитаю подробно'})).toMatchObject({ok:false,code:'CONFLICT'});
 expect((await s.store.getMemory(r.id))?.content).toBe('Моя ручная правка');
 expect((await s.queue.refresh(next.proposalId!)).ok).toBe(true);expect(s.queue.list()[0]?.targets[0]).toMatchObject({content:'Моя ручная правка',revision:2});
 expect((await s.queue.accept(next.proposalId!,{choice:'replace',targetId:r.id,expectedRevision:2,content:'Подтверждённое исправление'})).ok).toBe(true);
 await s.restart();expect((await s.store.getMemory(r.id))?.content).toBe('Подтверждённое исправление');
});
it('late deletion/edit cannot revive a forgotten record and chat targets never cross into projects',async()=>{
 const s=await setup(),r=value(await s.store.saveMemory(input('Код маяка')));
 value(await s.store.saveMemory({...input('Проектный секрет'),identityKey:'project',scope:'project',projectId:'A'}));
 expect((await s.queue.capture('Забудь в памяти «Проектный секрет»','explicit')).state).toBe('unresolved');
 const p=await s.queue.capture('Забудь в памяти «Код маяка»','explicit');value(await s.store.deleteMemory(r.id,1));
 expect(await s.queue.accept(p.proposalId!,{choice:'delete',targetId:r.id,expectedRevision:1})).toMatchObject({ok:false,code:'CONFLICT'});
 expect((await s.queue.refresh(p.proposalId!)).ok).toBe(false);expect(await s.store.getMemory(r.id)).toBeNull();
});
it('new save is stale after a manual write; disk failure and retry never claim an unsaved result',async()=>{
 let fail=false;const s=await setup({beforeCommit:async()=>{if(fail)throw Error('ENOSPC');}}),p=await s.queue.capture('Запомни: Проверка диска','explicit');
 value(await s.store.saveMemory(input('Ручная запись')));
 expect(await s.queue.accept(p.proposalId!,{choice:'save',baseRevision:0,content:'Проверка диска'})).toMatchObject({ok:false,code:'CONFLICT'});
 value(await s.queue.refresh(p.proposalId!));fail=true;
 expect(await s.queue.accept(p.proposalId!,{choice:'save',baseRevision:1,content:'Проверка диска'})).toMatchObject({ok:false,code:'WRITE_FAILED'});expect(s.queue.list()).toHaveLength(1);expect(await s.store.listMemories()).toHaveLength(1);
 fail=false;expect((await s.queue.accept(p.proposalId!,{choice:'save',baseRevision:1,content:'Проверка диска'})).ok).toBe(true);
});
it('veto/quotes do not create proposals; duplicates and queue growth are bounded',async()=>{
 const s=await setup();expect((await s.queue.capture('Не сохраняй: я люблю чай','suggest')).state).toBe('blocked');expect((await s.queue.capture('«Я предпочитаю чай»','suggest')).state).toBe('ignored');expect(s.queue.list()).toEqual([]);
 const a=await s.queue.capture('Запомни: Факт 0','explicit');expect((await s.queue.capture('Запомни: Факт 0','explicit')).proposalId).toBe(a.proposalId);
 for(let i=1;i<32;i++)expect((await s.queue.capture('Запомни: Факт '+i,'explicit')).state).toBe('pending');expect((await s.queue.capture('Запомни: Факт 33','explicit')).state).toBe('limit');expect(s.queue.list()).toHaveLength(32);expect(await s.store.listMemories()).toEqual([]);
});
it('accepted deletion removes recall; repeated acceptance is safe and expired proposals never apply',async()=>{
 const s=await setup(),r=value(await s.store.saveMemory(input('Удаляемый маяк'))),p=await s.queue.capture('Забудь в памяти «Удаляемый маяк»','explicit');const body={choice:'delete' as const,targetId:r.id,expectedRevision:1};
 expect((await s.queue.accept(p.proposalId!,body)).ok).toBe(true);expect((await s.queue.accept(p.proposalId!,body)).ok).toBe(true);expect(await s.store.getMemory(r.id)).toBeNull();
 const late=await s.queue.capture('Запомни: Поздний результат','explicit');const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+3600001);expect(s.queue.list()).toEqual([]);expect((await s.queue.accept(late.proposalId!,{choice:'save',baseRevision:0,content:'Поздний результат'})).ok).toBe(false);
});
it('parallel repeated accepts commit once and a different confirmation cannot overwrite it',async()=>{
 const s=await setup(),p=await s.queue.capture('Запомни: Одна запись','explicit');const results=await Promise.all([s.queue.accept(p.proposalId!,{choice:'save',baseRevision:0,content:'Одна запись'}),s.queue.accept(p.proposalId!,{choice:'save',baseRevision:0,content:'Одна запись'})]);expect(results[0]).toEqual(results[1]);expect(await s.store.listMemories()).toHaveLength(1);expect(await s.queue.accept(p.proposalId!,{choice:'save',baseRevision:0,content:'Чужой поздний текст'})).toMatchObject({ok:false,code:'CONFLICT'});
});
it('refresh in window B must not authorize a stale save from window A',async()=>{
 const s=await setup(),reply=await s.queue.capture('Запомни: Отвечай кратко','explicit'),windowA=s.queue.list()[0]!;
 value(await s.store.saveMemory(input('Ручное уточнение: отвечай подробно')));
 value(await s.queue.refresh(reply.proposalId!));expect(s.queue.list()[0]!.baseRevision).not.toBe(windowA.baseRevision);
 expect(await s.queue.accept(windowA.id,{choice:'save',baseRevision:windowA.baseRevision,content:windowA.content})).toMatchObject({ok:false,code:'CONFLICT'});
 expect(await s.store.listMemories()).toHaveLength(1);
});
