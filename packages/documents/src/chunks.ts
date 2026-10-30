import {hash} from './text.js';
import {documentSections} from './scope.js';
import {headingLines,bodyInRange} from './headings.js';
import {RetrievalFailure,type ScopedDocument,type DocumentFragment} from './retrieval-types.js';
/** Non-overlapping ranges. Headings are boundaries, not search evidence. */
export function documentFragments(scoped:ScopedDocument[]):DocumentFragment[]{
 const chunks:DocumentFragment[]=[];
 for(const {snapshot,ranges} of scoped){const doc=snapshot.document,text=doc.text!,headings=documentSections(doc),lines=headingLines(text);
  for(const range of ranges){const cuts=[range.start,...headings.map(h=>h.start).filter(n=>n>range.start&&n<range.end),range.end];
   for(let i=0;i<cuts.length-1;i++){let start=cuts[i]!,stop=cuts[i+1]!;
    while(start<stop){let end=Math.min(start+1200,stop);if(end<stop){const space=text.lastIndexOf(' ',end);if(space>start+600)end=space;if(/[\uD800-\uDBFF]/.test(text[end-1]!))end--;}
     const body=text.slice(start,end);if(body.trim())chunks.push({id:'chunk-'+hash(`${snapshot.documentId}:${doc.version}:${start}:${end}`),documentId:snapshot.documentId,contentHash:doc.contentHash,version:doc.version!,start,end,score:0,text:body,searchText:bodyInRange(text,start,end,lines),name:doc.name});
     start=end;if(chunks.length>2500)throw new RetrievalFailure('LIMIT_EXCEEDED');
    }
   }
  }
 }
 return chunks;
}
