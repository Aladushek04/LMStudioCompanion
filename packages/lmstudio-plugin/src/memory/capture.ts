import {captureMemory,type CaptureMode} from '../../../memory/src/capture.js';
import {captureReplySchema} from '../../../memory/src/channel-protocol.js';
import {memoryRequest} from './client.js';
export function captureMode(value:unknown):CaptureMode{return value==='explicit'||value==='suggest'?value:'off';}
export function needsCapture(text:string,mode:CaptureMode){return captureMemory(text,mode).kind!=='none';}
export async function captureFromChat(text:string,mode:Exclude<CaptureMode,'off'>,file:string,signal:AbortSignal){return captureReplySchema.parse(await memoryRequest(file,{action:'capture',text,mode},signal));}
