import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChatMessage,Chat} from '@lmstudio/sdk';
import {createMemoryRoutes} from '../../packages/host/src/routes/memory.js';
import {createMemoryChannel} from '../../packages/host/src/memory-channel.js';
import {preprocess} from '../../packages/lmstudio-plugin/src/index.js';
it('native preprocessor recalls without Python or extra generation and observes edits/deletes on next turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'companion-native-memory-')),owner=createMemoryRoutes(join(root,'memory')),channel=createMemoryChannel(join(root,'link'),owner.get),signal=new AbortController().signal;
 try{
  const saved=await owner.handle('/api/memory','POST',{content:'Код синтетического маяка РУБИН-731',scope:'global',projectId:null,category:'note',pinned:true},signal);const r=(saved.body as any).value;
  await channel.enable();const states:string[]=[];let tokenCalls=0;
  const source={getContextLength:async()=>64000,countTokens:async(t:string)=>{tokenCalls++;return t.length;},applyPromptTemplate:async(h:Chat)=>h.getMessagesArray().map(m=>m.getText()).join('\n')};
  const ctl={abortSignal:signal,getPluginConfig:()=>({get:(key:string)=>key==='useMemory'?true:'off'}),getGlobalPluginConfig:()=>({get:(key:string)=>key==='memoryLinkFile'?channel.status().file:''}),createStatus:(state:{text:string})=>{states.push(state.text);return {setState:(s:{text:string})=>states.push(s.text)};},tokenSource:async()=>source,pullHistory:async()=>Chat.empty()};
  const message=ChatMessage.create('user','Какой код маяка?');
  const first=await preprocess(ctl as never,message);expect(first.getText()).toContain('РУБИН-731');expect(tokenCalls).toBeGreaterThan(0);expect(states.at(-1)).toContain(r.id);
  await owner.handle('/api/memory/'+r.id,'PATCH',{content:'РУБИН-972',category:'note',pinned:true,expectedRevision:1},signal);
  const next=await preprocess(ctl as never,message);expect(next.getText()).toContain('РУБИН-972');expect(next.getText()).not.toContain('РУБИН-731');
  await owner.handle('/api/memory/'+r.id,'DELETE',{expectedRevision:2},signal);expect(await preprocess(ctl as never,message)).toBe(message);expect(channel.status().usage?.refs).toEqual([]);
 }finally{await channel.close();await owner.close();await rm(root,{recursive:true,force:true});}
},10000);
it('both features off returns original before tokenizer or settings access',async()=>{
 const message=ChatMessage.create('user','Сколько 2+2?');const ctl={abortSignal:new AbortController().signal,getPluginConfig:()=>({get:()=>false})};expect(await preprocess(ctl as never,message)).toBe(message);
});
