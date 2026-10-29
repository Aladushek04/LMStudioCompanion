import { z } from 'zod';

export const settingsSchema = z.object({
  version: z.literal(1), defaultProjectId: z.string().min(1).max(200).nullable(),
  mode: z.enum(['fast', 'auto', 'deep']), webMode: z.enum(['off', 'auto', 'research']),
  memoryMode: z.enum(['explicit', 'suggest']), activeProfileId: z.string().min(1).max(200).nullable(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = { version: 1, defaultProjectId: null, mode: 'auto', webMode: 'auto', memoryMode: 'explicit', activeProfileId: null };
