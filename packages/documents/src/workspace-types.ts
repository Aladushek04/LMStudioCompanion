import type {DocumentFailureCode,DocumentState} from './types.js';
import type {DocumentSection,DocumentRetrieval} from './retrieval-types.js';

/** A temporary panel selection, never a chat scope or a set of injected sources. */
export interface DocumentItem {
 id:string;revision:number;name:string;sizeBytes:number;contentHash:string;
 status:'queued'|'processing'|'ready'|'unreadable'|'error'|'cancelled';
 selected:boolean;code:DocumentFailureCode|null;reason:string|null;version:string|null;
 sections:DocumentSection[];sectionNotice:string|null;
}
export interface DocumentWorkspace {id:string;items:DocumentItem[];expiresAt:string;chatConnected:false}
export interface DocumentPreviewData {item:DocumentItem;document:DocumentState}
export interface DocumentSearchResponse {result:DocumentRetrieval;modelIdentifier:string;previewOnly:true}
