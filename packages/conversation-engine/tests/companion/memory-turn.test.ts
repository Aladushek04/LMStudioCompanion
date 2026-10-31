import {it,expect,afterEach,vi} from 'vitest';
import {Chat,type PredictionLoopHandlerController} from '@lmstudio/sdk';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryRoutes} from '../../../host/src/routes/memory.js';
import {createMemoryChannel} from '../../../host/src/memory-channel.js';
import {memoryRequest} from '../../../lmstudio-plugin/src/memory/client.js';
import {handleMemoryTurn} from '../../src/companion/memory-turn';
import type {CoreTurn} from '../../src/companion/turn';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const c of cleanup.reverse())await c();cleanup.length=0;});
type Decision={intent:string;kind:string;authorization:string;content:string;sourceIndex:number;question:string};
const save:Decision={intent:'save',kind:'note',authorization:'Сохрани на будущее',content:'Учебная метка ЛИСТ-731',sourceIndex:0,question:''};
async function fixture(decision=save,messages=[{role:'user' as const,content:'Сохрани на будущее: Учебная метка ЛИСТ-731'}],fail=false){
 const directory=await mkdtemp(join(tmpdir(),'companion-core2-turn-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));let armed=false;
 const owner=createMemoryRoutes(join(directory,'memory'),{beforeCommit:async()=>{if(armed&&fail)throw Error('synthetic disk error');}});cleanup.push(()=>owner.close());await owner.get();armed=true;
 const channel=createMemoryChannel(join(directory,'link'),owner.get,owner.proposals);cleanup.push(()=>channel.close());await channel.enable();
 const abort=new AbortController(),texts:string[]=[],statuses:any[]=[],configs:Record<string,unknown>={memoryEnabled:true,memoryLinkFile:channel.status().file};
 const source={trainedForToolUse:true,identifier:'same-synthetic-model',countTokens:async(text:string)=>Math.ceil(text.length/3),getContextLength:async()=>32000,applyPromptTemplate:async(chat:Chat)=>chat.getMessagesArray().map(m=>m.getText()).join('\n'),respond:vi.fn(()=>Object.assign(Promise.resolve({content:JSON.stringify(decision),reasoningContent:''}),{cancel:async()=>{}})),act:vi.fn(async(_view:any,tools:any[],opts:any)=>{
   opts.onPredictionFragment?.({content:'Я запомнил всё навсегда!',reasoningType:'none'});
   const result=await tools[0].implementation({content:decision.content},{signal:opts.signal,callId:1});
   opts.onPredictionFragment?.({content:'Сохранено!',reasoningType:'none'});return result;
 })};
 const turn={id:'synthetic-turn',signal:abort.signal,history:Chat.from(messages),source,tools:[]} as unknown as CoreTurn;
 const ctl={abortSignal:abort.signal,getPluginConfig:()=>({get:(key:string)=>configs[key]}),onAborted:(fn:()=>void)=>abort.signal.addEventListener('abort',fn,{once:true}),createStatus:(s:any)=>{statuses.push(s);return {setState:(v:any)=>statuses.push(v)};},createContentBlock:()=>({appendText:(text:string)=>texts.push(text)}),debug:vi.fn()} as unknown as PredictionLoopHandlerController;
 return {directory,owner,channel,source,ctl,turn,abort,texts,statuses,configs};
}
it('current LLM tool saves immediately and deterministic confirmation matches panel record',async()=>{
 const f=await fixture();expect(await handleMemoryTurn(f.ctl,f.turn)).toBe(true);
 const records=await (await f.owner.get()).listMemories();expect(records.map(r=>r.content)).toEqual(['Учебная метка ЛИСТ-731']);
 expect(f.owner.proposals.list()).toEqual([]);expect(f.texts.join('')).toContain(records[0]!.id);expect(f.texts.join('')).toContain('Учебная метка ЛИСТ-731');expect(f.texts.join('')).not.toContain('навсегда');
});
it('ordinary reference resolves to an exact available earlier note',async()=>{
 const f=await fixture({...save,authorization:'Держи это в памяти',sourceIndex:0},[{role:'user',content:'Учебная метка ЛИСТ-731'},{role:'user',content:'Держи это в памяти'}]);
 await handleMemoryTurn(f.ctl,f.turn);expect((await (await f.owner.get()).listMemories())[0]?.content).toBe('Учебная метка ЛИСТ-731');
});
it('missing tool call never publishes model confirmation',async()=>{
 const f=await fixture();f.source.act.mockImplementation(async(_view:any,_tools:any,opts:any)=>{opts.onPredictionFragment?.({content:'Запомнил',reasoningType:'none'});});
 await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('не вызвала');expect(f.texts.join('')).not.toContain('Запомнил');
});
it('disk failure cannot be converted to a success claim',async()=>{
 const f=await fixture(save,undefined,true);await handleMemoryTurn(f.ctl,f.turn);
 expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('не сохранено');expect(f.texts.join('')).not.toContain('навсегда');
});
it.each(['none','clarify','unsupported'])('decision %s causes no persistence',async intent=>{
 const f=await fixture({...save,intent,kind:intent==='unsupported'?'character':'note',question:'Какую заметку сохранить?'});
 const handled=await handleMemoryTurn(f.ctl,f.turn);expect(handled).toBe(intent!=='none');expect(await (await f.owner.get()).listMemories()).toEqual([]);
});
it('quoted source commands cannot supply a verbatim authority span',async()=>{
 const f=await fixture(save,[{role:'user',content:'Объясни цитату:\n> Сохрани на будущее: Учебная метка ЛИСТ-731'}]);
 await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('не выполнено');
});
it.each(['Объясни `Сохрани на будущее: Учебная метка ЛИСТ-731`.','Объясни:\n```\nСохрани на будущее: Учебная метка ЛИСТ-731\n```','Объясни «Сохрани на будущее: Учебная метка ЛИСТ-731».'])('code and quotation are data rather than a persistence grant: %s',async text=>{
 const f=await fixture(save,[{role:'user',content:text}]);await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);
});
it('character material never enters personal facts even if intent is save',async()=>{
 const f=await fixture({...save,kind:'character'});await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('CORE-3');
});
it('unclassified material is not quietly stored as a personal note',async()=>{
 const f=await fixture({...save,kind:'other'});await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);
});
it('absent or invented source text requires clarification rather than fabricated memory',async()=>{
 const f=await fixture({...save,content:'Материал, которого в истории нет'});await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);
});
it('ambiguous or malformed LLM decision fails closed without calling the write tool',async()=>{
 const f=await fixture();f.source.respond.mockImplementation(()=>Object.assign(Promise.resolve({content:'not JSON',reasoningContent:''}),{cancel:async()=>{}}));
 await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('не выполнено');
});
it('lost save reply is reconciled by operation ID without repeating the write',async()=>{
 const f=await fixture();
 await handleMemoryTurn(f.ctl,f.turn,async(file,input,signal)=>{const value=await memoryRequest(file,input,signal);if(input.action==='save')throw Error('synthetic lost reply after commit');return value;});
 const records=await (await f.owner.get()).listMemories();expect(records).toHaveLength(1);expect(f.texts.join('')).toContain(records[0]!.id);expect(f.texts.join('')).toContain('сохранена');
});
it('unreachable owner reports an unconfirmed operation, never saved',async()=>{
 const f=await fixture();await f.channel.close();await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).toContain('не выполнено');
});
it('Stop before tool invocation leaves memory untouched',async()=>{
 const f=await fixture();f.source.act.mockImplementation(async()=>{f.abort.abort();});await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toEqual([]);expect(f.texts.join('')).not.toContain('Запись сохранена');
});
it('equivalent existing text reports the real saved edition without a second record',async()=>{
 const f=await fixture();await (await f.owner.get()).saveMemory({identityKey:'manual.equivalent',content:'учебная метка  ЛИСТ-731',scope:'global',projectId:null,sessionId:null,source:'user'});
 await handleMemoryTurn(f.ctl,f.turn);expect(await (await f.owner.get()).listMemories()).toHaveLength(1);expect(f.texts.join('')).toContain('дубликат не создан');expect(f.texts.join('')).toContain('учебная метка  ЛИСТ-731');
});
it('manual mutation while LLM interprets the request wins over the late extracted note',async()=>{
 const f=await fixture();const previous=f.source.respond.getMockImplementation()!;
 let headRead!:()=>void;const ready=new Promise<void>(resolve=>{headRead=resolve;});
 f.source.respond.mockImplementation(()=>{
  const operation=(async()=>{await ready;await (await f.owner.get()).saveMemory({identityKey:'manual.during',content:'Ручная правка',scope:'global',projectId:null,sessionId:null,source:'user'});return await previous();})();
  return Object.assign(operation,{cancel:async()=>{}});
 });
 await handleMemoryTurn(f.ctl,f.turn,async(file,input,signal)=>{const value=await memoryRequest(file,input,signal);if(input.action==='memory-state')headRead();return value;});expect((await (await f.owner.get()).listMemories()).map(r=>r.content)).toEqual(['Ручная правка']);expect(f.texts.join('')).toContain('изменилась');
});
it('Stop after commit reports the verified record instead of claiming rollback',async()=>{
 const f=await fixture();await handleMemoryTurn(f.ctl,f.turn,async(file,input,signal)=>{const value=await memoryRequest(file,input,signal);if(input.action==='save'){f.abort.abort();throw Error('synthetic disconnect after commit');}return value;});
 const records=await (await f.owner.get()).listMemories();expect(records).toHaveLength(1);expect(f.texts.join('')).toContain(records[0]!.id);expect(f.texts.join('')).not.toContain('до отправки');
});
it('loss of both save reply and receipt check stays unknown even if the commit succeeded',async()=>{
 const f=await fixture();await handleMemoryTurn(f.ctl,f.turn,async(file,input,signal)=>{if(input.action==='operation')throw Error('synthetic owner unavailable');const value=await memoryRequest(file,input,signal);if(input.action==='save')throw Error('synthetic reply loss');return value;});
 expect(await (await f.owner.get()).listMemories()).toHaveLength(1);expect(f.texts.join('')).toContain('неизвестен');expect(f.texts.join('')).not.toContain('Запись сохранена');
});
it('detached status UI after commit cannot turn a saved operation into a pre-send cancellation',async()=>{
 const f=await fixture();const original=f.ctl.createStatus.bind(f.ctl);
 f.ctl.createStatus=((value:any)=>{const status=original(value);return {...status,setState:(next:any)=>{if(next.text==='Запись сохранена в общей памяти.')throw Error('synthetic detached UI');status.setState(next);}};}) as any;
 await handleMemoryTurn(f.ctl,f.turn);const records=await (await f.owner.get()).listMemories();expect(records).toHaveLength(1);expect(f.texts.join('')).toContain(records[0]!.id);expect(f.texts.join('')).not.toContain('не выполнено');
});
