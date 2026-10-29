import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,readdir,writeFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMemoryStore, type MemoryStore} from '../../packages/memory/src/store.js';

const stores: MemoryStore[]=[];
const directories:string[]=[];
async function directory(){const p=await mkdtemp(join(tmpdir(),'companion-memory-'));directories.push(p);return p;}
async function start(dir:string,options:Parameters<typeof openMemoryStore>[1]={}){const s=await openMemoryStore(dir,options);stores.push(s);return s;}
const input=(identityKey='reply.language',content='Отвечать по-русски')=>({identityKey,content,category:'preference',scope:'global' as const,projectId:null,sessionId:null,source:'user',pinned:true});
function value<T>(r:{ok:true;value:T}|{ok:false;message:string}):T{if(!r.ok)throw Error(r.message);return r.value;}
afterEach(async()=>{for(const s of stores.splice(0))await s.close(); const {rm}=await import('node:fs/promises');for(const p of directories.splice(0))await rm(p,{recursive:true,force:true});});

it('CRUD persists after restart, results cannot mutate storage',async()=>{
  const dir=await directory();let s=await start(dir);
  const saved=value(await s.saveMemory(input()));saved.content='forged';
  const actual=(await s.listMemories())[0]!;expect(actual.content).toBe('Отвечать по-русски');
  const edited=value(await s.updateMemory(actual.id,{content:'Кратко',pinned:false},actual.revision));
  expect(edited.revision).toBe(actual.revision+1);expect(edited.manualPriority).toBe(true);
  await s.close();s=await start(dir);expect((await s.getMemory(actual.id))?.content).toBe('Кратко');
  expect((await s.deleteMemory(actual.id,edited.revision)).ok).toBe(true);
  await s.close();s=await start(dir);expect(await s.listMemories()).toEqual([]);
  expect(await s.getMemory(actual.id)).toBeNull();
});
it('single writer rejects another owner and allows reopen after close',async()=>{
  const dir=await directory();const a=await start(dir);
  await expect(openMemoryStore(dir)).rejects.toThrow();
  await a.close();const b=await start(dir);expect(await b.listMemories()).toEqual([]);
});
it('serializes parallel creates and detects two stale editors',async()=>{
  const s=await start(await directory());
  const results=await Promise.all(Array.from({length:12},(_,i)=>s.saveMemory(input('key.'+i))));
  expect(results.every(r=>r.ok)).toBe(true);expect(await s.listMemories()).toHaveLength(12);
  const first=value(results[0]!);
  const edited=await Promise.all([s.updateMemory(first.id,{content:'First'},1),s.updateMemory(first.id,{content:'Second'},1)]);
  expect(edited.filter(r=>r.ok)).toHaveLength(1);expect(edited.find(r=>!r.ok)).toMatchObject({code:'CONFLICT'});
});
it('failed flush changes neither RAM nor disk and queue remains usable',async()=>{
  let fail=false;const dir=await directory();const s=await start(dir,{beforeCommit:async()=>{if(fail)throw Object.assign(Error('full'),{code:'ENOSPC'});}});
  const record=value(await s.saveMemory(input()));const before=await readFile(join(dir,'memory.json'),'utf8');
  fail=true;expect(await s.updateMemory(record.id,{content:'Lost'},record.revision)).toMatchObject({ok:false,code:'WRITE_FAILED'});
  expect((await s.getMemory(record.id))?.content).toBe(record.content);expect(await readFile(join(dir,'memory.json'),'utf8')).toBe(before);
  fail=false;expect((await s.updateMemory(record.id,{content:'Saved'},record.revision)).ok).toBe(true);
});
it('session records never enter disk or backup and disappear on restart',async()=>{
  const dir=await directory();let s=await start(dir);
  value(await s.saveMemory({...input('temporary','SECRET_SESSION_FIXTURE'),scope:'session',sessionId:'chat-session-1'}));
  value(await s.saveMemory(input('persistent')));
  expect(await s.listMemories({scope:'session',sessionId:'chat-session-1'})).toHaveLength(1);
  expect(await readFile(join(dir,'memory.json'),'utf8')).not.toContain('SECRET_SESSION_FIXTURE');
  expect(await s.exportBackup()).not.toContain('SECRET_SESSION_FIXTURE');
  await s.close();s=await start(dir);expect(await s.listMemories({scope:'session',sessionId:'chat-session-1'})).toEqual([]);
});
it('scope validation and identity uniqueness precede writes',async()=>{
  const s=await start(await directory());
  expect(await s.saveMemory({...input(),scope:'project'})).toMatchObject({ok:false,code:'INVALID_INPUT'});
  expect(await s.saveMemory({...input(),sessionId:'wrong'})).toMatchObject({ok:false,code:'INVALID_INPUT'});
  value(await s.saveMemory(input()));expect(await s.saveMemory(input())).toMatchObject({ok:false,code:'CONFLICT'});
  value(await s.saveMemory({...input(),scope:'project',projectId:'other'}));expect(await s.listMemories()).toHaveLength(2);
});
it('background result cannot overwrite manual edit, be replayed or create another record',async()=>{
  const s=await start(await directory());const record=value(await s.saveMemory(input()));
  const {token}=value(await s.beginBackgroundUpdate(record.id));
  value(await s.updateMemory(record.id,{content:'Моя правка'},record.revision));
  expect(await s.applyBackgroundResult(token,'Старый вариант')).toMatchObject({ok:false,code:'CONFLICT'});
  expect(await s.applyBackgroundResult(token,'Другой вариант')).toMatchObject({ok:false,code:'INVALID_TOKEN'});
  const fresh=value(await s.beginBackgroundUpdate(record.id));
  expect(await s.applyBackgroundResult(fresh.token,'Автоматический вариант')).toMatchObject({ok:false,code:'CONFIRMATION_REQUIRED'});
  expect(await s.listMemories()).toHaveLength(1);expect((await s.getMemory(record.id))?.content).toBe('Моя правка');
});
it('forgetting clears stored content and blocks resurrection until explicit revive',async()=>{
  const dir=await directory();let s=await start(dir);
  const record=value(await s.saveMemory({...input('key','FORGOTTEN_FIXTURE'),tags:['SECRET_TAG'],metadata:{nested:{value:'SECRET_META'}}}));
  const late=value(await s.beginBackgroundUpdate(record.id));
  value(await s.deleteMemory(record.id,record.revision));
  expect(await s.applyBackgroundResult(late.token,'FORGOTTEN_FIXTURE')).toMatchObject({ok:false,code:'CONFLICT'});
  const disk=await readFile(join(dir,'memory.json'),'utf8');for(const text of ['FORGOTTEN_FIXTURE','SECRET_TAG','SECRET_META'])expect(disk).not.toContain(text);
  await s.close();s=await start(dir);expect(await s.saveMemory(input('key','FORGOTTEN_FIXTURE'))).toMatchObject({ok:false,code:'CONFLICT'});
  const revived=value(await s.reviveMemory(record.id,'Новое явное значение',record.revision+1));
  expect(revived.id).toBe(record.id);expect(revived.manualPriority).toBe(true);expect(revived.revision).toBe(record.revision+2);
});
it('manual priority survives restart and foreign-owner background tokens fail',async()=>{
  const dir=await directory();let s=await start(dir);const record=value(await s.saveMemory(input()));
  const old=value(await s.beginBackgroundUpdate(record.id));await s.close();s=await start(dir);
  expect((await s.getMemory(record.id))?.manualPriority).toBe(true);
  expect(await s.applyBackgroundResult(old.token,'Late')).toMatchObject({ok:false,code:'INVALID_TOKEN'});
});
it('backup restore preserves extra data, advances revision, invalidates tokens and keeps rollback copy',async()=>{
  const dir=await directory();const s=await start(dir);
  const a=value(await s.saveMemory({...input(),metadata:{unknown:{array:[1,'extra',true]}},tags:['test'],confidence:0.7}));
  const backup=await s.exportBackup();value(await s.updateMemory(a.id,{content:'New'},a.revision));
  const token=value(await s.beginBackgroundUpdate(a.id));
  const before=s.getRevision();expect(await s.restoreBackup(backup,before-1)).toMatchObject({ok:false,code:'CONFLICT'});
  expect(await s.restoreBackup(backup,before)).toMatchObject({ok:true});
  const restored=(await s.getMemory(a.id))!;expect(restored.content).toBe(a.content);expect(restored.metadata).toEqual(a.metadata);
  expect(restored.revision).toBeGreaterThan(a.revision+1);expect(s.getRevision()).toBeGreaterThan(before);
  expect(await s.applyBackgroundResult(token.token,'Late')).toMatchObject({ok:false,code:'INVALID_TOKEN'});
  const file=(await readdir(dir)).find(name=>name.startsWith('before-restore-'));expect(file).toBeTruthy();
  expect(await readFile(join(dir,file!),'utf8')).toContain('New');
});
it('corrupt snapshot or backup fails closed without resetting records',async()=>{
  const dir=await directory();const s=await start(dir);value(await s.saveMemory(input()));
  expect(await s.restoreBackup('{broken',s.getRevision())).toMatchObject({ok:false,code:'INVALID_BACKUP'});
  const backup=await s.exportBackup();expect(await s.restoreBackup(backup.replace('Отвечать','Подмена'),s.getRevision())).toMatchObject({ok:false,code:'INVALID_BACKUP'});
  await s.close();await writeFile(join(dir,'memory.json'),'{broken');await expect(openMemoryStore(dir)).rejects.toThrow();
  expect(await readFile(join(dir,'memory.json'),'utf8')).toBe('{broken');
});
it('foreign files are not treated as an empty new store',async()=>{
  const dir=await directory();await writeFile(join(dir,'foreign.txt'),'unchanged');
  await expect(openMemoryStore(dir)).rejects.toThrow();expect(await readFile(join(dir,'foreign.txt'),'utf8')).toBe('unchanged');
});
it('close waits for pending commit and rejects later writes',async()=>{
  let block=false;let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const s=await start(await directory(),{beforeCommit:async()=>{if(block){entered();await new Promise<void>(r=>release=r);}}});
  block=true;const pending=s.saveMemory(input());await ready;const closed=s.close();
  expect(await s.saveMemory(input('late'))).toMatchObject({ok:false,code:'CLOSED'});
  release();expect((await pending).ok).toBe(true);await closed;
});
it('closing clears session cache and does not serve stale reads',async()=>{
  const s=await start(await directory());value(await s.saveMemory({...input('session'),scope:'session',sessionId:'session-1'}));
  await s.close();await expect(s.listMemories()).rejects.toThrow('закрыто');
});
it('snapshot aliases and invalid backup identity cannot be opened or restored',async()=>{
  const dir=await directory();const s=await start(dir);value(await s.saveMemory(input()));
  const backup=await s.exportBackup();const other=await start(await directory());expect(await other.restoreBackup(backup,other.getRevision())).toMatchObject({ok:false,code:'INVALID_BACKUP'});
  await s.close();const alias=join(dir,'alias.json');await link(join(dir,'memory.json'),alias);
  await expect(openMemoryStore(dir)).rejects.toThrow();
});
it('oversized content and unknown patch fields are refused',async()=>{
  const s=await start(await directory());expect(await s.saveMemory(input('big','x'.repeat(16001)))).toMatchObject({ok:false,code:'INVALID_INPUT'});
  const r=value(await s.saveMemory(input()));expect(await s.updateMemory(r.id,{revision:7} as never,r.revision)).toMatchObject({ok:false,code:'INVALID_INPUT'});
});
