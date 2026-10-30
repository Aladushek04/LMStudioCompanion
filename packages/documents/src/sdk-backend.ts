import {FileHandle,type LMStudioClient} from '@lmstudio/sdk';
import {z} from 'zod';
import {DocumentFailure,asDocumentFailure} from './errors.js';
import {throwIfAborted} from './control.js';
import {documentLimits,parserSchema,type DocumentBackend} from './types.js';
import {selectedSnapshots,validateContent} from './text.js';

const sdkResultSchema=z.object({content:z.string(),parser:parserSchema}).strict();
const supported=(parser:{library:string;version:string})=>parser.library==='builtIn'&&parser.version==='1';
/** The caller owns this dedicated SDK client and closes it after the batch. No handles escape. */
export function createSdkDocumentBackend(client:Pick<LMStudioClient,'files'>):DocumentBackend{
 return {async parse(input){
  try{
   throwIfAborted(input.signal);
   const source=selectedSnapshots([{name:input.name,bytes:input.bytes}],documentLimits)[0]!;
   validateContent(source,documentLimits.maxTextChars);
   const files=client.files;
   if(!files||[files.prepareFileBase64,files.getDocumentParsingLibrary,files.parseDocument].some(method=>typeof method!=='function'))throw new DocumentFailure('API_UNAVAILABLE');
   throwIfAborted(input.signal);
   // Upload and parser-identification RPCs have no signal parameter in SDK1.5. Keep their raw
   // promise pending until settlement; the outer adapter bounds caller wait and holds BUSY.
   const handle=await files.prepareFileBase64(source.name,Buffer.from(source.bytes).toString('base64'));
   throwIfAborted(input.signal);
   const expectedType=source.kind==='txt'?'text/plain':'application/pdf';
   if(!(handle instanceof FileHandle)||handle.filesNamespace!==files||handle.name!==source.name||handle.sizeBytes!==source.bytes.length||handle.type!==expectedType)throw new DocumentFailure('INVALID_HANDLE');
   const candidate=await files.getDocumentParsingLibrary(handle);throwIfAborted(input.signal);
   const parser=parserSchema.safeParse(candidate);
   if(!parser.success)throw new DocumentFailure('INVALID_RESULT');
   if(!supported(parser.data))throw new DocumentFailure('UNSUPPORTED_PARSER');
   const result=await files.parseDocument(handle,{parserId:parser.data,signal:input.signal});throwIfAborted(input.signal);
   const parsed=sdkResultSchema.safeParse(result);
   if(!parsed.success)throw new DocumentFailure('INVALID_RESULT');
   if(!supported(parsed.data.parser))throw new DocumentFailure('UNSUPPORTED_PARSER');
   return {text:parsed.data.content,parser:parsed.data.parser};
  }catch(error){
   if(input.signal.aborted||error instanceof DocumentFailure)throw asDocumentFailure(error,input.signal);
   if(error instanceof Error&&/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH)\b|Unknown (?:RPC|channel)|Unsupported (?:RPC|endpoint)/i.test(error.message))throw new DocumentFailure('API_UNAVAILABLE');
   throw new DocumentFailure('PARSER_ERROR');
  }
 }};
}
