import {it,expect,afterEach} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMemoryRoutes} from '../../packages/host/src/routes/memory.js';
import {createMemoryChannel} from '../../packages/host/src/memory-channel.js';
import {memoryRequest} from '../../packages/lmstudio-plugin/src/memory/client.js';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const c of cleanup.reverse())await c();cleanup.length=0;});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'companion-core2-channel-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
 const owner=createMemoryRoutes(join(directory,'memory'));cleanup.push(()=>owner.close());
 const channel=createMemoryChannel(join(directory,'link'),owner.get,owner.proposals);cleanup.push(()=>channel.close());await channel.enable();
 const call=(input:unknown,signal=new AbortController().signal)=>memoryRequest(channel.status().file,input as any,signal) as Promise<any>;
 return {owner,channel,call,directory};
}
it('immediate channel save is visible in the same panel and durable after owner restart',async()=>{
 const f=await fixture(),operationId=randomUUID(),content='Проверочная заметка МОСТ-947';
 const grant=await f.call({action:'begin-save',operationId,content});
 const input={action:'save',operationId,content,grant:grant.grant,expectedStoreRevision:grant.baseRevision,targetId:null,targetRevision:null};
 const receipt=await f.call(input);expect(receipt.state).toBe('saved');expect(receipt.record.content).toBe(content);
 const panel=await f.owner.handle('/api/memory','GET',undefined,new AbortController().signal);
 expect((panel.body as any).records.map((r:any)=>r.id)).toEqual([receipt.record.id]);expect(f.owner.proposals.list()).toEqual([]);
 expect(await f.call(input)).toEqual(receipt);
 expect((await f.call({...input,content:'Подмена текста'})).state).toBe('conflict');
 await f.channel.close();await f.owner.close();
 const owner=createMemoryRoutes(join(f.directory,'memory'));cleanup.push(()=>owner.close());
 const channel=createMemoryChannel(join(f.directory,'link'),owner.get);cleanup.push(()=>channel.close());await channel.restore();
 const stored=await memoryRequest(channel.status().file,{action:'operation',operationId} as any,new AbortController().signal);
 expect(stored).toEqual(receipt);
});
it('missing or mismatched authority does not save; manual change invalidates prepared revision',async()=>{
 const f=await fixture(),operationId=randomUUID(),content='Заметка для проверки разрешения';
 const grant=await f.call({action:'begin-save',operationId,content});
 const input={action:'save',operationId,content,expectedStoreRevision:grant.baseRevision,grant:randomUUID(),targetId:null,targetRevision:null};
 expect((await f.call(input)).state).toBe('denied');
 expect((await f.call({...input,grant:grant.grant,content:'Чужой текст'})).state).toBe('denied');
 await f.owner.handle('/api/memory','POST',{content:'Ручная запись',pinned:false,category:'note',scope:'global',projectId:null},new AbortController().signal);
 expect((await f.call({...input,grant:grant.grant})).state).toBe('conflict');expect(await (await f.owner.get()).listMemories()).toHaveLength(1);
});
