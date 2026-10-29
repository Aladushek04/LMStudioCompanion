import { ChatMessage } from '@lmstudio/sdk';
import { expect, it, vi } from 'vitest';
import { preprocessWeb } from '../../packages/lmstudio-plugin/src/web/preprocessor.js';

const source = { id: 'source-1', turnId: 't', uri: 'https://example.org/', title: 'Example', kind: 'web_text' as const, status: 'ok' as const, retrievedAt: new Date().toISOString(), contentHash: 'a'.repeat(64), chunks: [{id:'c',text:'Actual article',locator:'chars=0:14'}] };
function fixture() {
  const read = vi.fn(async () => ({ok: true as const, value: [source], warnings: []}));
  const status = vi.fn();
  const measure = vi.fn(async (text: string) => text.length);
  return { read, status, measure, signal: new AbortController().signal, contextLength: 32000, mode: 'auto' as const, showSources: true };
}
it('reads before returning a message, preserves file parts and original input', async () => {
  const message = ChatMessage.from({role:'user',content:[{type:'text',text:'Прочитай https://example.org/'},{type:'file',identifier:'image-fixture',fileType:'image',sizeBytes:3,name:'a.png'}]} as never);
  const env = fixture();
  const result = await preprocessWeb(message, env);
  expect(env.read).toHaveBeenCalledOnce();
  expect(result.getText()).toContain('Actual article');
  expect(result.hasFiles()).toBe(true);
  expect(message.getText()).not.toContain('Actual article');
});
it('off and code URLs do not read or measure', async () => {
  for (const [text,mode] of [['Прочитай https://example.org/','off'],['```https://example.org/```','auto']] as const) {
    const env = fixture();
    const message = ChatMessage.create('user', text);
    expect(await preprocessWeb(message, {...env,mode})).toBe(message);
    expect(env.read).not.toHaveBeenCalled(); expect(env.measure).not.toHaveBeenCalled();
  }
});
it('blocked source stops preprocessing instead of asking the model to be honest', async () => {
  const env = fixture(); env.read.mockResolvedValue({ok:true,value:[{...source,status:'blocked',chunks:[]}] as never,warnings:[]});
  await expect(preprocessWeb(ChatMessage.create('user','Прочитай https://example.org/'),env)).rejects.toThrow('не прочитано');
  expect(env.status).toHaveBeenCalled();
});
it('cancelled and oversized context never inject', async () => {
  const env = fixture(); const abort = new AbortController(); abort.abort();
  await expect(preprocessWeb(ChatMessage.create('user','Прочитай https://example.org/'),{...env,signal:abort.signal})).rejects.toThrow();
  expect(env.read).not.toHaveBeenCalled();
  await expect(preprocessWeb(ChatMessage.create('user','Прочитай https://example.org/'),{...env,contextLength:100})).rejects.toThrow();
});
it('cancel during non-cooperative tokenizer stops the turn promptly',async()=>{
  const controller=new AbortController();
  const env=fixture(); env.measure.mockImplementation(()=>new Promise(()=>{}));
  const pending=preprocessWeb(ChatMessage.create('user','Прочитай https://example.org/'),{...env,signal:controller.signal});
  setTimeout(()=>controller.abort(),10);
  expect(await Promise.race([pending.then(()=> 'returned',()=> 'cancelled'),new Promise(r=>setTimeout(()=>r('hung'),100))])).toBe('cancelled');
});
