import {createHash} from 'node:crypto';
import {z} from 'zod';
import {DocumentFailure} from './errors.js';
import type {DocumentLimits,ParserIdentity} from './types.js';

const selectedSchema=z.object({name:z.string().trim().min(1).max(200).refine(name=>!/[\\/:\x00-\x1f\x7f]/.test(name)&&name!=='.'&&name!=='..'),bytes:z.instanceof(Uint8Array)}).strict();
export type SelectedSnapshot={name:string;bytes:Uint8Array;kind:'txt'|'pdf'|'unsupported';contentHash:string};
export const hash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
export function selectedSnapshots(inputs:unknown[],limits:DocumentLimits):SelectedSnapshot[]{
 if(!Array.isArray(inputs)||!inputs.length)throw new DocumentFailure('INVALID_INPUT');
 if(inputs.length>limits.maxFiles)throw new DocumentFailure('LIMIT_EXCEEDED');
 const parsed=selectedSchema.array().safeParse(inputs);if(!parsed.success)throw new DocumentFailure('INVALID_INPUT');
 if(parsed.data.some(f=>f.bytes.byteLength>limits.maxFileBytes)||parsed.data.reduce((sum,f)=>sum+f.bytes.byteLength,0)>limits.maxBatchBytes)throw new DocumentFailure('LIMIT_EXCEEDED');
 return parsed.data.map(input=>{
  const bytes=Uint8Array.from(input.bytes),name=input.name.normalize('NFC'),extension=name.toLowerCase().split('.').at(-1);
  return {name,bytes,kind:extension==='txt'?'txt':extension==='pdf'?'pdf':'unsupported',contentHash:hash(bytes)};
 });
}
export function normalizeText(text:string,maximum:number):string{
 if(text.length>maximum*2+1)throw new DocumentFailure('TEXT_LIMIT');
 const normalized=text.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n');
 if(normalized.length>maximum)throw new DocumentFailure('TEXT_LIMIT');
 return normalized;
}
export function validateContent(source:SelectedSnapshot,maximum:number):void{
 if(!source.bytes.length)throw new DocumentFailure('EMPTY_FILE');
 if(source.kind==='unsupported')throw new DocumentFailure('UNSUPPORTED_FORMAT');
 if(source.kind==='pdf'){
  if(Buffer.from(source.bytes.subarray(0,5)).toString('ascii')!=='%PDF-')throw new DocumentFailure('INVALID_PDF');
 }else{
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes);}catch{throw new DocumentFailure('INVALID_ENCODING');}
  if(text.includes('\0'))throw new DocumentFailure('BINARY_TEXT');
  normalizeText(text,maximum);
 }
}
export function textVersion(contentHash:string,parser:ParserIdentity,textHash:string){return hash(JSON.stringify({contentHash,parser,normalizer:'bom-crlf-v1',textHash}));}
