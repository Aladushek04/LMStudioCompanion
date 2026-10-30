import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {retrieveDocuments} from '../../packages/documents/src/retrieve.js';
import {snapshot,selection,environment} from './helpers.js';
it('measures the lexical baseline on 10 answerable/5 unanswerable Russian questions',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../fixtures/documents/retrieval.json',import.meta.url),'utf8'));expect(fixture.synthetic).toBe(true);const doc=snapshot(fixture.text);
 let hits=0,negativeEmpty=0;const falseRetrievals:string[]=[];
 for(const question of fixture.questions){const r=await retrieveDocuments([doc],{query:question.query,selection:[selection(doc)],wholeDocument:false},environment());expect(r.ok).toBe(true);if(!r.ok)continue;
  if(question.answerable){if(r.value.sources.some(s=>s.chunks.some(c=>c.text.includes(question.marker))))hits++;}
  else if(r.value.state==='no-matches')negativeEmpty++;else falseRetrievals.push(question.query);
 }
 console.log(JSON.stringify({answerableHits:hits,answerableTotal:10,negativeEmpty,negativeTotal:5,falseRetrievals}));
 expect(hits).toBe(10);expect(negativeEmpty).toBeGreaterThanOrEqual(4);expect(falseRetrievals.length).toBeLessThanOrEqual(1);
});
