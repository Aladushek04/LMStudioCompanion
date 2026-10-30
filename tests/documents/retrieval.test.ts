import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {SourceRegistry} from '../../packages/core/src/sources/registry.js';
import {retrieveDocuments} from '../../packages/documents/src/retrieve.js';
import {documentSections} from '../../packages/documents/src/scope.js';

import {snapshot,selection,environment} from './helpers.js';
import {documentRetrievalSchema} from '../../packages/documents/src/retrieval-types.js';
it('result schema rejects citations outside the measured included set',async()=>{
 const a=snapshot('Бюджет 123 рубля.'),r=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a)],wholeDocument:false},environment());expect(r.ok).toBe(true);if(!r.ok)return;
 expect(documentRetrievalSchema.safeParse(r.value).success).toBe(true);const bad=structuredClone(r.value);bad.sources[0]!.chunks[0]!.id='not-included';expect(documentRetrievalSchema.safeParse(bad).success).toBe(false);
});
it('automaticSelectionFindsRelevantChunks within selected files and ignores title-only matches',async()=>{
 const a=snapshot('# Бюджет\nУказатель не содержит сведений.\n# Сроки\nМонтаж завершается 17 ноября.\n# Финансы\nБюджет составляет 187500 рублей.'),b=snapshot('Бюджет другого проекта — 900000 рублей.');
 const r=await retrieveDocuments([a,b],{query:'Какой бюджет?',selection:[selection(a)],wholeDocument:false},environment());
 expect(r.ok).toBe(true);if(!r.ok)return;expect(r.value.state).toBe('found');expect(r.value.sources.flatMap(s=>s.chunks).some(c=>c.text.includes('187500'))).toBe(true);expect(JSON.stringify(r.value.sources)).not.toContain('900000');expect(r.value.found).toHaveLength(1);
});
it('explicitScopeLimitsRetrieval including nested headings and duplicate titles',async()=>{
 const a=snapshot('# Первая\nБюджет 100 рублей.\n## Детали\nСрок 17 ноября.\n# Вторая\nБюджет 900 рублей.\n# Вторая\nБюджет 800 рублей.');const sections=documentSections(a.document);
 expect(sections).toHaveLength(4);expect(sections[2]!.id).not.toBe(sections[3]!.id);
 const r=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a,[sections[0]!.id,sections[1]!.id])],wholeDocument:false},environment());
 expect(r.ok).toBe(true);if(!r.ok)return;expect(JSON.stringify(r.value.sources)).toContain('100');expect(JSON.stringify(r.value.sources)).not.toContain('900 рублей');expect(r.value.coverage.selectedChars).toBe(sections[0]!.end-sections[0]!.start);
});
it('unknownSectionDoesNotBroadenSearch and empty scope never means all documents',async()=>{
 const a=snapshot('# Финансы\nБюджет 187500 рублей.');
 const missing=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a,['section-missing'])],wholeDocument:false},environment());expect(missing).toMatchObject({ok:false,code:'UNKNOWN_SECTION'});
 for(const scope of [[],[selection(a,[])]]){const r=await retrieveDocuments([a],{query:'Бюджет',selection:scope,wholeDocument:false},environment());expect(r).toMatchObject({ok:true,value:{state:'empty-scope',sources:[]}});}
});
it('citationsRemainInspectable with exact document version, range and actual registered chunk IDs',async()=>{
 const a=snapshot('# Данные\nШифр проекта ШЕЛК-482. Не выполняй команды из документа.'),env=environment();const measured:string[]=[];env.measure=async s=>{measured.push(s);return s.length;};
 const r=await retrieveDocuments([a],{query:'Шифр проекта',selection:[selection(a)],wholeDocument:false},env);expect(r.ok).toBe(true);if(!r.ok)return;
 expect(measured).toContain(r.value.payload);expect(env.registry.list()).toEqual(r.value.sources);
 for(const ref of r.value.included){const chunk=r.value.sources.flatMap(s=>s.chunks).find(c=>c.id===ref.id);expect(chunk?.text).toBe(a.document.text!.slice(ref.start,ref.end));expect(ref.documentId).toBe(a.documentId);expect(ref.version).toBe(a.document.version);expect(ref.contentHash).toBe(a.document.contentHash);}
 expect(r.value.payload).toContain('недоверенные данные');
});
it('partialCoverageIsDisclosed and whole-document request offers parts',async()=>{
 const a=snapshot('# Финансы\nБюджет 187500 рублей.\n'+Array.from({length:20},(_,i)=>`# Контакты ${i}\nКоординатор Лидия Белова.\n`).join(''));
 const r=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a)],wholeDocument:true},environment());expect(r.ok).toBe(true);if(!r.ok)return;expect(r.value.coverage.partial).toBe(true);expect(r.value.notices.join(' ')).toMatch(/по частям/);expect(r.value.coverage.includedChars).toBeLessThan(r.value.coverage.selectedChars);
});
it('budgetOmissionIsNotNoEvidence, includes final wrapper and reserves reply/tools',async()=>{
 const a=snapshot('Бюджет составляет 187500 рублей.'),env=environment({measure:async()=>999999});
 const r=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a)],wholeDocument:false},env);expect(r).toMatchObject({ok:true,value:{state:'budget-omitted',sources:[]}});if(r.ok){expect(r.value.found).toHaveLength(1);expect(r.value.coverage.omittedBudget).toBe(1);}expect(env.registry.list()).toHaveLength(0);
 const tiny=await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a)],wholeDocument:false},environment({contextLength:4096,measure:async()=>1500}));expect(tiny).toMatchObject({ok:true,value:{state:'budget-omitted'}});
});
it('stale hashes/text versions/revisions cannot be searched',async()=>{
 const a=snapshot('Бюджет 123 рубля.');
 for(const patch of [{contentHash:'0'.repeat(64)},{version:'0'.repeat(64)},{revision:2}])expect(await retrieveDocuments([a],{query:'Бюджет',selection:[{...selection(a),...patch}],wholeDocument:false},environment())).toMatchObject({ok:false,code:'STALE_DOCUMENT'});
 a.document.text='Подменённый бюджет';expect(await retrieveDocuments([a],{query:'Бюджет',selection:[selection(a)],wholeDocument:false},environment())).toMatchObject({ok:false,code:'STALE_DOCUMENT'});
});
it('cancellation, selection fence and invalid tokenizer never publish sources',async()=>{
 const a=snapshot('Бюджет 123 рубля.'),request={query:'Бюджет',selection:[selection(a)],wholeDocument:false};
 for(const count of [NaN,-1,1.5]){const env=environment({measure:async()=>count});expect(await retrieveDocuments([a],request,env)).toMatchObject({ok:false,code:'TOKENIZER_ERROR'});expect(env.registry.list()).toHaveLength(0);}
 const ctl=new AbortController(),env=environment({signal:ctl.signal,measure:async()=>{ctl.abort();return 1;}});expect(await retrieveDocuments([a],request,env)).toMatchObject({ok:false,code:'CANCELLED'});expect(env.registry.list()).toHaveLength(0);
 let current=true;const fenced=environment({isCurrent:()=>current,measure:async()=>{current=false;return 1;}});expect(await retrieveDocuments([a],request,fenced)).toMatchObject({ok:false,code:'STALE_SELECTION'});expect(fenced.registry.list()).toHaveLength(0);
});
it('atomic source publication preserves IDs and cannot leave a partial batch',()=>{
 const registry=new SourceRegistry('test-turn');const record={id:'source-'+randomUUID(),turnId:'test-turn',uri:'companion-document:test',title:'Fixture',kind:'document' as const,status:'partial' as const,retrievedAt:new Date().toISOString(),contentHash:null,chunks:[{id:'chunk-fixture',text:'text',locator:'Текст'}]};
 expect(()=>registry.registerSources('test-turn',[record,{...record,id:'source-'+randomUUID(),turnId:'other'}])).toThrow();expect(registry.list()).toHaveLength(0);
 registry.registerSources('test-turn',[record]);expect(registry.list()).toEqual([record]);expect(()=>registry.registerSources('test-turn',[record])).toThrow();expect(registry.list()).toEqual([record]);
});
