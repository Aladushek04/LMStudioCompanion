import {z} from 'zod';

export const documentLimits=Object.freeze({maxFiles:5,maxFileBytes:8*1024*1024,maxBatchBytes:20*1024*1024,maxTextChars:250000,perFileTimeoutMs:30000,batchTimeoutMs:90000});
export type DocumentLimits={ [K in keyof typeof documentLimits]:number };
export const failureCodes=['INVALID_INPUT','LIMIT_EXCEEDED','EMPTY_FILE','INVALID_ENCODING','BINARY_TEXT','UNSUPPORTED_FORMAT','INVALID_PDF','NO_TEXT','TEXT_LIMIT','INVALID_RESULT','UNSUPPORTED_PARSER','INVALID_HANDLE','API_UNAVAILABLE','PARSER_ERROR','CANCELLED','TIMEOUT','STALE','BUSY'] as const;
export type DocumentFailureCode=typeof failureCodes[number];
export const parserSchema=z.object({library:z.string().min(1),version:z.string().min(1)}).strict();
export const parsedTextSchema=z.object({text:z.string(),parser:parserSchema}).strict();
export type ParserIdentity=z.infer<typeof parserSchema>;
export interface DocumentBackend {parse(input:{name:string;bytes:Uint8Array;signal:AbortSignal}):Promise<unknown>}
export const documentStateSchema=z.object({
 id:z.string().uuid(),operationId:z.string().uuid(),turnId:z.string().min(1),name:z.string().min(1),contentHash:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().nonnegative(),
 state:z.enum(['processing','ready','unreadable','stale','error']),code:z.enum(failureCodes).nullable(),reason:z.string().nullable(),
 text:z.string().nullable(),parser:parserSchema.nullable(),textHash:z.string().nullable(),version:z.string().nullable(),
 locators:z.array(z.object({kind:z.literal('text-range'),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),label:z.string().min(1)}).strict()),
 retrieval:z.object({state:z.literal('not-prepared'),reason:z.string().min(1)}).strict(),
}).strict();
export type DocumentState=z.infer<typeof documentStateSchema>;
export interface DocumentReadOptions {onState?:(state:DocumentState)=>void|Promise<void>;isCurrent?:()=>boolean}
