import {z} from 'zod';
import {sourceRecordSchema} from '../../core/src/contracts.js';
import type {SourceRecord} from '../../core/src/contracts.js';
import type {SourceRegistry} from '../../core/src/sources/registry.js';
import {documentStateSchema} from './types.js';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const scopeEntrySchema=z.object({documentId:z.string().uuid(),revision:z.number().int().positive(),contentHash:digest,version:digest,sections:z.array(z.string().min(1).max(100)).max(100).nullable()}).strict();
export const documentSearchSchema=z.object({query:z.string().trim().min(1).max(4096),selection:z.array(scopeEntrySchema).max(5),wholeDocument:z.boolean()}).strict().refine(r=>new Set(r.selection.map(s=>s.documentId)).size===r.selection.length,'Повторный ID документа.');
export const snapshotSchema=z.object({documentId:z.string().uuid(),revision:z.number().int().positive(),document:documentStateSchema}).strict();
export type DocumentScope=z.infer<typeof scopeEntrySchema>;
export type DocumentSearchRequest=z.infer<typeof documentSearchSchema>;
export type DocumentSnapshot=z.infer<typeof snapshotSchema>;
export interface DocumentSection {id:string;title:string;start:number;end:number;level:number}
export interface ScopedDocument {snapshot:DocumentSnapshot;ranges:{start:number;end:number}[]}
export interface FragmentRef {id:string;documentId:string;contentHash:string;version:string;start:number;end:number;score:number}
export interface DocumentFragment extends FragmentRef {text:string;searchText:string;name:string}
export interface RetrievalCoverage {selectedChars:number;includedChars:number;totalChunks:number;foundChunks:number;includedChunks:number;omittedBudget:number;omittedLimit:number;partial:boolean}
export interface DocumentRetrieval {
 searchId:string;turnId:string;state:'found'|'no-matches'|'budget-omitted'|'empty-scope';scope:DocumentScope[];
 found:FragmentRef[];included:FragmentRef[];sources:SourceRecord[];payload:string;coverage:RetrievalCoverage;
 budget:{totalTokens:number|null;limit:number;reservedReply:number;reservedTools:number};notices:string[];
}
const fragmentRefSchema=z.object({id:z.string().min(1),documentId:z.string().uuid(),contentHash:digest,version:digest,start:z.number().int().nonnegative(),end:z.number().int().positive(),score:z.number().finite().nonnegative()}).strict().refine(r=>r.end>r.start);
const amount=z.number().int().nonnegative();
export const documentRetrievalSchema=z.object({
 searchId:z.string().uuid(),turnId:z.string().min(1),state:z.enum(['found','no-matches','budget-omitted','empty-scope']),scope:z.array(scopeEntrySchema).max(5),
 found:z.array(fragmentRefSchema).max(2500),included:z.array(fragmentRefSchema).max(12),sources:z.array(sourceRecordSchema).max(5),payload:z.string(),
 coverage:z.object({selectedChars:amount,includedChars:amount,totalChunks:amount,foundChunks:amount,includedChunks:amount,omittedBudget:amount,omittedLimit:amount,partial:z.boolean()}).strict(),
 budget:z.object({totalTokens:amount.nullable(),limit:amount,reservedReply:amount,reservedTools:amount}).strict(),notices:z.array(z.string()),
}).strict().superRefine((r,ctx)=>{
 const actual=r.sources.flatMap(s=>s.chunks),ids=new Set(actual.map(c=>c.id));
 if(actual.length!==r.included.length||ids.size!==actual.length||r.included.some(ref=>!ids.has(ref.id)||!r.found.some(found=>found.id===ref.id)||actual.find(c=>c.id===ref.id)?.text.length!==ref.end-ref.start))ctx.addIssue({code:'custom',message:'Цитаты не соответствуют включённым фрагментам.'});
});
export interface RetrievalEnvironment {turnId:string;signal:AbortSignal;registry:SourceRegistry;contextLength:number;measure(payload:string):Promise<number>;isCurrent?:()=>boolean}
export interface DocumentCitation {searchId:string;sourceId:string;documentId:string;contentHash:string;version:string;title:string;chunk:{id:string;text:string;locator:string}}
const messages={INVALID_SCOPE:'Проверьте вопрос и выбранные материалы.',STALE_DOCUMENT:'Документ или его версия изменились. Обновите выбор.',UNKNOWN_SECTION:'Выбранный раздел не найден в этой версии текста. Уточните область.',LIMIT_EXCEEDED:'Документ превышает предел обработки разделов или фрагментов.',TOKENIZER_ERROR:'Не удалось измерить полный запрос токенизатором загруженной модели.',STALE_SELECTION:'Выбор материалов изменился. Повторите поиск.',CANCELLED:'Поиск отменён.',SEARCH_ERROR:'Не удалось подобрать фрагменты. Результат не опубликован.'} as const;
export class RetrievalFailure extends Error {constructor(readonly code:keyof typeof messages){super(messages[code]);}}
