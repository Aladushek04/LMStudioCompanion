import {z} from 'zod';
export type JsonValue = null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
const json: z.ZodType<JsonValue> = z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
const text=z.string().trim().min(1);
const timestamp=z.number().int().nonnegative();
export const memoryRecordSchema=z.object({
  id:z.string().uuid(),identityKey:z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,127}$/),
  content:z.string().max(16000),category:text.max(100),scope:z.enum(['global','project','session']),
  projectId:text.max(200).nullable(),sessionId:text.max(200).nullable(),source:text.max(200),
  createdAt:timestamp,updatedAt:timestamp,revision:z.number().int().positive(),pinned:z.boolean(),manualPriority:z.boolean(),deletedAt:timestamp.nullable(),
  tags:z.array(text.max(100)).max(100),confidence:z.number().min(0).max(1),lastAccessedAt:timestamp,
  accessCount:z.number().int().nonnegative(),supersedes:z.string().nullable(),metadata:z.record(json),
}).strict().superRefine((r,ctx)=>{
  if(r.scope==='global'&&(r.projectId!==null||r.sessionId!==null)||r.scope==='project'&&(r.projectId===null||r.sessionId!==null)||r.scope==='session'&&r.sessionId===null)
    ctx.addIssue({code:'custom',message:'Область и идентификаторы не согласованы.'});
  if(r.deletedAt===null&&!r.content.trim())ctx.addIssue({code:'custom',message:'Пустой факт.'});
  if(r.deletedAt!==null&&(r.content!==''||r.tags.length||Object.keys(r.metadata).length))ctx.addIssue({code:'custom',message:'Забытый факт содержит данные.'});
});
export type MemoryRecord=z.infer<typeof memoryRecordSchema>;
export const memoryInputSchema=z.object({
  identityKey:z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,127}$/),content:text.max(16000),category:text.max(100).default('note'),
  scope:z.enum(['global','project','session']),projectId:text.max(200).nullable(),sessionId:text.max(200).nullable(),source:text.max(200),pinned:z.boolean().default(false),
  tags:z.array(text.max(100)).max(100).default([]),confidence:z.number().min(0).max(1).default(1),
  supersedes:z.string().nullable().default(null),metadata:z.record(json).default({}),
}).strict();
export type MemoryInput=z.input<typeof memoryInputSchema>;
export const memoryPatchSchema=z.object({content:text.max(16000).optional(),category:text.max(100).optional(),pinned:z.boolean().optional(),tags:z.array(text.max(100)).max(100).optional()}).strict().refine(p=>Object.keys(p).length>0);
export type MemoryPatch=z.infer<typeof memoryPatchSchema>;
export const filterSchema=z.object({scope:z.enum(['global','project','session']).optional(),projectId:text.max(200).optional(),sessionId:text.max(200).optional(),query:z.string().max(500).optional()}).strict();
export type MemoryFilter=z.infer<typeof filterSchema>;
export const identity=(r:Pick<MemoryRecord,'scope'|'projectId'|'sessionId'|'identityKey'>)=>JSON.stringify([r.scope,r.projectId,r.sessionId,r.identityKey]);
export const snapshotSchema=z.object({format:z.literal('companion-memory-v1'),storeId:z.string().uuid(),revision:z.number().int().nonnegative(),records:z.array(memoryRecordSchema).max(10000)}).strict().superRefine((s,ctx)=>{
  const ids=new Set<string>(),keys=new Set<string>();
  for(const r of s.records){const key=identity(r);if(r.scope==='session'||ids.has(r.id)||keys.has(key))ctx.addIssue({code:'custom',message:'Некорректная постоянная запись или дубликат.'});ids.add(r.id);keys.add(key);}
});
export type Snapshot=z.infer<typeof snapshotSchema>;
