import type {MemoryRecord} from './types.js';
export interface RecallScope {chatScopeId:string|null;projectId:string|null;sessionId:string|null}
export type RecallRecord=MemoryRecord & {score:number;reason:string};
// Lexical baseline: Unicode words, light Russian suffix normalization, TF-IDF cosine.
// This does not claim semantic retrieval and does not invoke a model.
const stop=new Set('в во на и с со для по как какой какую каком чем что это ли мне нужно нужен где'.split(' '));
function words(text:string):string[]{return (text.toLowerCase().replaceAll('ё','е').match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>!stop.has(w)).map(w=>w.length>4?w.replace(/(ировать|ирования|ировать|ением|иями|ами|ого|ему|ать|ять|ить|ов|ев|ом|ем|ах|ях|ы|и|а|я|у|ю|е)$/,''):w);}
export function rankMemories(records:MemoryRecord[],query:string,scope:RecallScope={chatScopeId:null,projectId:null,sessionId:null}):RecallRecord[]{
  const allowed=records.filter(r=>r.deletedAt===null&&(r.scope==='global'||!!scope.chatScopeId&&(r.scope==='project'?!!scope.projectId&&r.projectId===scope.projectId:!!scope.sessionId&&r.sessionId===scope.sessionId&&r.projectId===scope.projectId)));
  const docs=allowed.map(r=>words(r.content+' '+r.tags.join(' '))),q=words(query.slice(0,4096));
  const df=new Map<string,number>();for(const doc of docs)for(const w of new Set(doc))df.set(w,(df.get(w)??0)+1);
  const vector=(terms:string[])=>{const v=new Map<string,number>();for(const w of terms)v.set(w,(v.get(w)??0)+1);for(const [w,n] of v)v.set(w,(1+Math.log(n))*(1+Math.log((docs.length+1)/((df.get(w)??0)+1))));return v;};
  const qv=vector(q),norm=(v:Map<string,number>)=>Math.sqrt([...v.values()].reduce((a,n)=>a+n*n,0));
  return allowed.map((r,i)=>{const v=vector(docs[i]!);let dot=0;for(const [w,n] of qv)dot+=n*(v.get(w)??0);const score=dot/(norm(qv)*norm(v)||1);return {...r,score,reason:r.pinned?'Закреплённая запись':'Совпадение слов запроса'};})
    .filter(r=>r.pinned||r.score>0).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.score-a.score||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).slice(0,20);
}
