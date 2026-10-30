import {documentLimits,type DocumentState} from './types.js';
import {hash,textVersion} from './text.js';
import {snapshotSchema,RetrievalFailure,type DocumentScope,type DocumentSnapshot,type ScopedDocument,type DocumentSection} from './retrieval-types.js';

export function verifyDocument(doc:DocumentState){
 if(doc.state!=='ready'||typeof doc.text!=='string'||!doc.parser||!doc.version||doc.text.length>documentLimits.maxTextChars||doc.sizeBytes>documentLimits.maxFileBytes||doc.textHash!==hash(doc.text)||doc.version!==textVersion(doc.contentHash,doc.parser,doc.textHash))throw new RetrievalFailure('STALE_DOCUMENT');
}
export function documentSections(doc:DocumentState):DocumentSection[]{
 verifyDocument(doc);const text=doc.text!,headings:{title:string;start:number;level:number}[]=[];
 for(const match of text.matchAll(/^.*$/gm)){
  const line=match[0],markdown=/^ {0,3}(#{1,6})[ \t]+(.{1,200}?)\s*#*\s*$/.exec(line),numbered=line.length<=200&&/^(Глава|Раздел)\s+[0-9IVXLCDM]+(?:[.:\s—-].*)?$/i.test(line);
  if(markdown||numbered){headings.push({title:markdown?markdown[2]!:line,start:match.index!,level:markdown?markdown[1]!.length:1});if(headings.length>100)throw new RetrievalFailure('LIMIT_EXCEEDED');}
 }
 return headings.map((h,i)=>{const end=headings.slice(i+1).find(next=>next.level<=h.level)?.start??text.length;return {...h,end,id:'section-'+hash(`${doc.version}:${h.start}:${end}`)};});
}
export function resolveDocumentScope(raw:DocumentSnapshot[],selection:DocumentScope[]):ScopedDocument[]{
 if(raw.length>5||new Set(raw.map(s=>s.documentId)).size!==raw.length)throw new RetrievalFailure('INVALID_SCOPE');
 const snapshots=raw.map(s=>{const p=snapshotSchema.safeParse(s);if(!p.success)throw new RetrievalFailure('INVALID_SCOPE');return p.data;});
 return selection.map(scope=>{
  const snapshot=snapshots.find(s=>s.documentId===scope.documentId),doc=snapshot?.document;
  if(!snapshot||!doc||snapshot.revision!==scope.revision||doc.contentHash!==scope.contentHash||doc.version!==scope.version)throw new RetrievalFailure('STALE_DOCUMENT');
  verifyDocument(doc);
  const sections=documentSections(doc),ranges=scope.sections===null?[{start:0,end:doc.text!.length}]:scope.sections.map(id=>{const section=sections.find(s=>s.id===id);if(!section)throw new RetrievalFailure('UNKNOWN_SECTION');return {start:section.start,end:section.end};});
  const merged:{start:number;end:number}[]=[];
  for(const range of ranges.sort((a,b)=>a.start-b.start||a.end-b.end)){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  return {snapshot,ranges:merged};
 });
}
