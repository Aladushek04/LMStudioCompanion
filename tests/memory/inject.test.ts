import {it,expect} from 'vitest';
import {ChatMessage} from '@lmstudio/sdk';
import {injectMemories} from '../../packages/lmstudio-plugin/src/memory/inject.js';
const candidates=[{id:'one',revision:2,content:'Кратко',pinned:true,reason:'Закреплённая запись'},{id:'two',revision:1,content:'X'.repeat(5000),pinned:false,reason:'Совпадение слов'}];
it('keeps whole facts within measured history and reply reserve, reports only injected IDs',async()=>{
  const m=ChatMessage.create('user','Вопрос');
  const r=await injectMemories(m,candidates,{signal:new AbortController().signal,contextLength:6000,measure:async t=>2000+t.length,count:async t=>t.length});
  expect(r.refs.map(x=>x.id)).toEqual(['one']);expect(r.message.getText()).toContain('Кратко');expect(r.message.getText()).not.toContain('X'.repeat(20));expect(m.getText()).toBe('Вопрос');
});
it('empty recall leaves the exact message untouched; cancellation propagates',async()=>{
 const m=ChatMessage.create('user','?');const env={signal:new AbortController().signal,contextLength:64000,measure:async()=>0,count:async()=>0};
 expect((await injectMemories(m,[],env)).message).toBe(m);
 await expect(injectMemories(m,candidates,{...env,signal:AbortSignal.abort()})).rejects.toThrow();
});

