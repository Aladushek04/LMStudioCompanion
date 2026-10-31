import {z} from 'zod';
export const explicitSaveSchema=z.object({
 action:z.literal('save'),operationId:z.string().uuid(),content:z.string().trim().min(1).max(16000),
 expectedStoreRevision:z.number().int().nonnegative(),targetId:z.null(),targetRevision:z.null(),
}).strict();
export type ExplicitSave=z.infer<typeof explicitSaveSchema>;
export const storedOperationSchema=z.object({
 operationId:z.string().uuid(),signature:z.string().regex(/^[a-f0-9]{64}$/),
 state:z.enum(['saved','duplicate']),recordId:z.string().uuid(),recordRevision:z.number().int().positive(),
}).strict();
export type StoredOperation=z.infer<typeof storedOperationSchema>;
export const memoryReceiptSchema=z.object({
 action:z.literal('save'),operationId:z.string().uuid(),
 state:z.enum(['saved','duplicate','conflict','cancelled','failed','unknown','denied','limit']),
 record:z.object({id:z.string().uuid(),revision:z.number().int().positive(),content:z.string().min(1).max(16000)}).strict().nullable(),
 message:z.string().max(1000),
}).strict().superRefine((r,ctx)=>{if((r.state==='saved'||r.state==='duplicate')!==(r.record!==null))ctx.addIssue({code:'custom',message:'Квитанция не соответствует результату.'});});
export type MemoryReceipt=z.infer<typeof memoryReceiptSchema>;
export const receipt=(operationId:string,state:MemoryReceipt['state'],message:string):MemoryReceipt=>({action:'save',operationId,state,record:null,message});
