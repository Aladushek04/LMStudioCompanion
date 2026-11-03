import type { MemoryRecord } from './types.js';

export interface MigrationPreview {
  id: string;
  baseRevision: number;
  sourceCount: number;
  skippedSessions: number;
  alreadyPresent: number;
  records: Pick<MemoryRecord, 'id' | 'content' | 'scope' | 'projectId' | 'category' | 'source'>[];
}
