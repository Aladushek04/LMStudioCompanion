import {randomUUID} from 'node:crypto';
import {SourceRegistry} from '../../packages/core/src/sources/registry.js';
import {hash,textVersion} from '../../packages/documents/src/text.js';
import type {DocumentState} from '../../packages/documents/src/types.js';
export function snapshot(text:string,name='same.txt'){
 const contentHash=hash(Buffer.from(text)),parser={library:'builtIn',version:'1'},textHash=hash(text);
 const document:DocumentState={id:randomUUID(),operationId:randomUUID(),turnId:'parse',name,contentHash,sizeBytes:Buffer.byteLength(text),state:'ready',code:null,reason:null,text,parser,textHash,version:textVersion(contentHash,parser,textHash),locators:[{kind:'text-range',start:0,end:text.length,label:'Текст'}],retrieval:{state:'not-prepared',reason:'Не выполнялось'}};
 return {documentId:randomUUID(),revision:3,document};
}
export const selection=(s:ReturnType<typeof snapshot>,sections:string[]|null=null)=>({documentId:s.documentId,revision:s.revision,contentHash:s.document.contentHash,version:s.document.version!,sections});
export const environment=(extra:Record<string,unknown>={})=>({turnId:'test-turn',signal:new AbortController().signal,registry:new SourceRegistry('test-turn'),contextLength:32768,measure:async(text:string)=>Math.ceil(text.length/3),...extra});
