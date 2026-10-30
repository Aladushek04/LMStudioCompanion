import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMemoryStore} from '../../packages/memory/src/store.js';
import {decodeLegacy} from '../../packages/memory/src/migration.js';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const f of cleanup.reverse())await f();cleanup.length=0;});
const values=async()=>(await decodeLegacy(await readFile(new URL('../fixtures/memory-v2.json',import.meta.url)))).records;
function ok<T>(r:{ok:true;value:T}|{ok:false;message:string}):T{if(!r.ok)throw Error(r.message);return r.value;}
async function setup(beforeCommit?:()=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'companion-import-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));let store=await openMemoryStore(dir,beforeCommit?{beforeCommit}:{});cleanup.push(()=>store.close());return {dir,get store(){return store;},restart:async()=>{await store.close();store=await openMemoryStore(dir);}};}
it('imports atomically, backs up first, preserves fields and idempotency through manual edits/deletes/restart',async()=>{
 const s=await setup(),records=await values(),result=ok(await s.store.importRecords(records,0));expect(result.imported).toBe(2);expect(result.backupId).toBeTruthy();expect((await s.store.listMemories())[0]?.metadata.legacyRaw).toBe(records[0]?.metadata.legacyRaw);
 expect(ok(await s.store.importRecords(records,1)).imported).toBe(0);const r=records[0]!;ok(await s.store.updateMemory(r.id,{content:'Моя ручная правка'},1));await s.restart();expect(ok(await s.store.importRecords(records,s.store.getRevision())).imported).toBe(0);expect((await s.store.getMemory(r.id))?.content).toBe('Моя ручная правка');ok(await s.store.deleteMemory(r.id,2));expect(ok(await s.store.importRecords(records,s.store.getRevision())).imported).toBe(0);expect(await s.store.getMemory(r.id)).toBeNull();
 const files=await readdir(s.dir);expect(files.filter(f=>f.startsWith('before-import-'))).toHaveLength(1);for(const f of files.filter(f=>f.endsWith('.json')))expect(await readFile(join(s.dir,f),'utf8')).not.toContain('SECRET_SESSION_FIXTURE');
});
it('undo survives restart, preserves session RAM and permits explicit fresh import afterwards',async()=>{
 const s=await setup(),records=await values(),r=ok(await s.store.importRecords(records,0));await s.restart();ok(await s.store.saveMemory({identityKey:'session',content:'RAM only',scope:'session',projectId:null,sessionId:'S',source:'user'}));
 expect((await s.store.migrationState()).undo?.id).toBe(r.backupId);ok(await s.store.undoImport(r.backupId!,1));expect(await s.store.listMemories({scope:'global'})).toEqual([]);expect(await s.store.listMemories({scope:'session'})).toHaveLength(1);expect(ok(await s.store.importRecords(records,s.store.getRevision())).imported).toBe(2);
});
it('later manual changes forbid undo, and stale preview cannot import',async()=>{
 const s=await setup(),records=await values(),r=ok(await s.store.importRecords(records,0));ok(await s.store.updateMemory(records[0]!.id,{content:'Ручная правка'},1));expect(await s.store.undoImport(r.backupId!,s.store.getRevision())).toMatchObject({ok:false,code:'CONFLICT'});expect(await s.store.importRecords(records,0)).toMatchObject({ok:false,code:'CONFLICT'});expect((await s.store.getMemory(records[0]!.id))?.content).toBe('Ручная правка');
});
it('failure between backup and commit changes neither disk nor RAM and cannot enable a false undo',async()=>{
 let fail=false;const s=await setup(async()=>{if(fail)throw Error('ENOSPC');}),before=await readFile(join(s.dir,'memory.json'),'utf8');fail=true;expect(await s.store.importRecords(await values(),0)).toMatchObject({ok:false,code:'WRITE_FAILED'});expect(await readFile(join(s.dir,'memory.json'),'utf8')).toBe(before);expect(await s.store.listMemories()).toEqual([]);fail=false;ok(await s.store.saveMemory({identityKey:'manual',content:'Сохранить меня',scope:'global',projectId:null,sessionId:null,source:'user'}));expect((await s.store.migrationState()).undo).toBeNull();
});
it('invalid batch or corrupt backup never partially applies or restores',async()=>{
 const s=await setup(),records=await values();expect((await s.store.importRecords([...records,{...records[0]!,scope:'session',sessionId:'S'}],0)).ok).toBe(false);expect(await s.store.listMemories()).toEqual([]);
 const r=ok(await s.store.importRecords(records,0));await writeFile(join(s.dir,'before-import-'+r.backupId+'.json'),'broken');expect((await s.store.undoImport(r.backupId!,1)).ok).toBe(false);expect(await s.store.listMemories()).toHaveLength(2);
});
it('abort before commit leaves the batch unapplied',async()=>{
 const s=await setup();expect((await s.store.importRecords(await values(),0,AbortSignal.abort())).ok).toBe(false);expect(await s.store.listMemories()).toEqual([]);
});
it('migration keeps the v1 snapshot root compatible with previous Companion releases',async()=>{
 const s=await setup();ok(await s.store.importRecords(await values(),0));expect(Object.keys(JSON.parse(await readFile(join(s.dir,'memory.json'),'utf8')).payload).sort()).toEqual(['format','records','revision','storeId']);
});
it('undo and reimport cannot reuse a revision and validate an old pending edit',async()=>{
 const s=await setup(),records=await values(),first=ok(await s.store.importRecords(records,0)),old=(await s.store.getMemory(records[0]!.id))!;ok(await s.store.undoImport(first.backupId!,first.revision));ok(await s.store.importRecords(records,s.store.getRevision()));expect((await s.store.getMemory(old.id))!.revision).toBeGreaterThan(old.revision);expect(await s.store.updateMemory(old.id,{content:'Поздняя старая правка'},old.revision)).toMatchObject({ok:false,code:'CONFLICT'});
});
