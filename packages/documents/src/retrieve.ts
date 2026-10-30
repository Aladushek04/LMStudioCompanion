import type {OperationResult} from '../../core/src/contracts.js';
import {documentSearchSchema,RetrievalFailure,type DocumentSnapshot,type RetrievalEnvironment,type DocumentRetrieval} from './retrieval-types.js';
import {resolveDocumentScope} from './scope.js';
import {documentFragments} from './chunks.js';
import {rankDocumentFragments} from './lexical.js';
import {budgetDocumentFragments,retrievalCheck} from './budget.js';

export async function retrieveDocuments(snapshots:DocumentSnapshot[],raw:unknown,env:RetrievalEnvironment):Promise<OperationResult<DocumentRetrieval>>{
 try{
  retrievalCheck(env);const parsed=documentSearchSchema.safeParse(raw);if(!parsed.success)throw new RetrievalFailure('INVALID_SCOPE');
  const request=parsed.data,scoped=resolveDocumentScope(snapshots,request.selection);retrievalCheck(env);
  const chunks=documentFragments(scoped),selectedChars=scoped.reduce((sum,d)=>sum+d.ranges.reduce((n,r)=>n+r.end-r.start,0),0),found=rankDocumentFragments(chunks,request.query,request.wholeDocument);
  const value=await budgetDocumentFragments(found,chunks,request.selection,selectedChars,request.wholeDocument,env);return {ok:true,value,warnings:value.notices};
 }catch(error){const failure=env.signal.aborted?new RetrievalFailure('CANCELLED'):error instanceof RetrievalFailure?error:new RetrievalFailure('SEARCH_ERROR');return {ok:false,code:failure.code,message:failure.message,retryable:!['INVALID_SCOPE','UNKNOWN_SECTION'].includes(failure.code)};}
}
