import {RetrievalFailure} from './retrieval-types.js';

export interface TextHeading {title:string;start:number;end:number;level:number}
/** Bounded text headings, excluding fenced code. Offsets refer to the original UTF-16 text. */
export function headingLines(text:string):TextHeading[]{
 const headings:TextHeading[]=[];let fence:{marker:string;length:number}|null=null;
 for(const match of text.matchAll(/^.*$/gm)){
  const line=match[0],marker=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if(fence){if(marker&&marker[1]![0]===fence.marker&&marker[1]!.length>=fence.length&&!marker[2]!.trim())fence=null;continue;}
  if(marker&&(marker[1]![0]==='~'||!marker[2]!.includes('`'))){fence={marker:marker[1]![0]!,length:marker[1]!.length};continue;}
  const markdown=line.length<=210?/^ {0,3}(#{1,6})[ \t]+(.{1,200})$/.exec(line):null;
  const numbered=line.length<=200&&/^(Глава|Раздел)\s+[0-9IVXLCDM]+(?:[.:\s—-].*)?$/i.test(line);
  const title=markdown?markdown[2]!.trim().replace(/[ \t]+#+[ \t]*$/,'').trim():numbered?line.trim():'';
  if(title){const start=match.index!,end=start+line.length+(text[start+line.length]==='\n'?1:0);headings.push({title,start,end,level:markdown?markdown[1]!.length:1});if(headings.length>100)throw new RetrievalFailure('LIMIT_EXCEEDED');}
 }
 return headings;
}

/** Remove only confirmed heading ranges from the search index; citation text stays intact. */
export function bodyInRange(text:string,start:number,end:number,headings:TextHeading[]):string{
 const pieces:string[]=[];let position=start;
 for(const h of headings){if(h.end<=start||h.start>=end)continue;pieces.push(text.slice(position,Math.max(position,h.start)));position=Math.min(end,h.end);}
 pieces.push(text.slice(position,end));return pieces.join('\n');
}
