import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {decodeLegacy} from '../../packages/memory/src/migration.js';
const fixture=()=>readFile(new URL('../fixtures/memory-v2.json',import.meta.url));
it('preserves every original field, scopes and stable identity; never persists session records',async()=>{
 const bytes=await fixture(),original=Buffer.from(bytes),r=await decodeLegacy(bytes);expect(r.sourceCount).toBe(3);expect(r.skippedSessions).toBe(1);expect(r.records).toHaveLength(2);expect(bytes.equals(original)).toBe(true);
 const first=r.records[0]!;expect(first).toMatchObject({content:'Код учебного порта — ЛАЗУРЬ-615.',category:'fact',tags:['учебный'],confidence:.8,source:'user',scope:'global',accessCount:7,supersedes:'old-before'});expect(JSON.parse(first.metadata.legacyRaw as string)).toEqual(JSON.parse(bytes.toString()).records[0]);expect((await decodeLegacy(bytes)).records.map(r=>r.id)).toEqual(r.records.map(r=>r.id));expect(r.records[1]?.projectId).toBe('Учебный проект');
});
it('rejects malformed, ambiguous and unsupported data instead of promoting it to global',async()=>{
 for(const bytes of [Buffer.from('broken'),Buffer.from('{"format":"unknown","records":[]}'),Buffer.from(JSON.stringify({format:'persistent-memory-v2',records:[{id:'x',scope:'foreign'}]}))])await expect(decodeLegacy(bytes)).rejects.toThrow();
 const raw=JSON.parse((await fixture()).toString());raw.records[1].project=null;await expect(decodeLegacy(Buffer.from(JSON.stringify(raw)))).rejects.toThrow();
});
it('reads an actual SQLite v2 image in RAM without mutating its bytes or executing a view',async()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('PRAGMA user_version=2; CREATE TABLE memories(id TEXT,content TEXT,category TEXT,tags TEXT,confidence REAL,source TEXT,scope TEXT,project TEXT,created_at INTEGER,updated_at INTEGER,last_accessed_at INTEGER,access_count INTEGER,supersedes TEXT,unknown TEXT)');db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('sql-id','Синтетический SQL-факт','note','["a"]',1,'user','global',null,10,20,30,4,null,'keep');const bytes=Buffer.from((db as any).serialize()),copy=Buffer.from(bytes);const r=await decodeLegacy(bytes);expect(r.records[0]).toMatchObject({content:'Синтетический SQL-факт',createdAt:10,updatedAt:20,lastAccessedAt:30,accessCount:4});expect(JSON.parse(r.records[0]!.metadata.legacyRaw as string).unknown).toBe('keep');expect(bytes.equals(copy)).toBe(true);
 db.exec('ALTER TABLE memories ADD COLUMN big_extra INTEGER; UPDATE memories SET big_extra=9223372036854775807');const big=await decodeLegacy((db as any).serialize());expect(JSON.parse(big.records[0]!.metadata.legacyRaw as string).big_extra).toEqual({sqliteInteger:'9223372036854775807'});
 db.exec('DROP TABLE memories; CREATE VIEW memories AS SELECT randomblob(100000000)');await expect(decodeLegacy((db as any).serialize())).rejects.toThrow();}finally{db.close();}
});
it('stores source envelope once instead of multiplying it by the record count',async()=>{
 const data=JSON.parse((await fixture()).toString());data.extra='Z'.repeat(65536);data.records=Array.from({length:100},(_,i)=>({...data.records[0],id:'many-'+i,content:'Синтетическая запись '+i}));const bytes=Buffer.from(JSON.stringify(data)),r=await decodeLegacy(bytes);expect(Buffer.byteLength(JSON.stringify(r.records))).toBeLessThan(bytes.length*5);expect(r.records.filter(r=>r.metadata.legacyEnvelope)).toHaveLength(1);
});
it('preserves an own __proto__ field as data without prototype pollution',async()=>{
 const data=JSON.parse((await fixture()).toString());Object.defineProperty(data.records[0],'__proto__',{enumerable:true,value:{keep:'unknown'}});const r=await decodeLegacy(Buffer.from(JSON.stringify(data))),raw=JSON.parse(r.records[0]!.metadata.legacyRaw as string);expect(Object.hasOwn(raw,'__proto__')).toBe(true);expect(raw.__proto__).toEqual({keep:'unknown'});expect(({} as any).keep).toBeUndefined();
});
