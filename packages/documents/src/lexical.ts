import type {DocumentFragment} from './retrieval-types.js';
const stop=new Set('а и в во на с со для по как какой какая какое какие какую каким каком где когда кто сколько что это ли мне нужно нужен узнать скажи расскажи пожалуйста о об у из за до или весь все текст документ проекта проект'.split(' '));
function terms(text:string){return (text.toLocaleLowerCase('ru').replaceAll('ё','е').match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>!stop.has(w)).map(w=>w.length>4?w.replace(/(ениями|иями|ами|ого|ему|ение|ения|ать|ять|ить|ов|ев|ом|ем|ах|ях|ый|ий|ая|ое|ые|ы|и|а|я|у|ю|е)$/,''):w);}
function body(text:string){return text.split('\n').filter(line=>!/^ {0,3}#{1,6}\s/.test(line)&&!/^(Глава|Раздел)\s+[0-9IVXLCDM]+(?:[.:\s—-].*)?$/i.test(line)).join('\n');}
/** TF-IDF cosine baseline, positive body-word matches only; no universal confidence threshold. */
export function rankDocumentFragments(chunks:DocumentFragment[],query:string,wholeDocument:boolean):DocumentFragment[]{
 const docs=chunks.map(c=>terms(body(c.text))),q=terms(query),df=new Map<string,number>();
 for(const doc of docs)for(const term of new Set(doc))df.set(term,(df.get(term)??0)+1);
 const vector=(words:string[])=>{const v=new Map<string,number>();for(const w of words)v.set(w,(v.get(w)??0)+1);for(const [w,n] of v)v.set(w,(1+Math.log(n))*(1+Math.log((docs.length+1)/((df.get(w)??0)+1))));return v;};
 const norm=(v:Map<string,number>)=>Math.sqrt([...v.values()].reduce((sum,n)=>sum+n*n,0)),qv=vector(q);
 return chunks.map((chunk,i)=>{const v=vector(docs[i]!);let dot=0;for(const [term,n] of qv)dot+=n*(v.get(term)??0);return {...chunk,score:dot/(norm(qv)*norm(v)||1)};}).filter(c=>wholeDocument||c.score>0).sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.start-b.start);
}
