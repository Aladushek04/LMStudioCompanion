import {captureMemory,type CaptureMode} from '../../../memory/src/capture.js';
import {captureReplySchema} from '../../../memory/src/channel-protocol.js';
import {memoryRequest} from './client.js';
import {planWebAction,type WebMode,type WebPlan} from '../../../core/src/web/intent.js';
export function planMemoryAwareWeb(text:string,mode:WebMode,useMemory:boolean,capture:CaptureMode):WebPlan{
 const intent=captureMemory(text,capture);
 const command=intent.kind==='save'||intent.kind==='edit'||intent.kind==='delete';
 const local=useMemory&&/(?:сейчас\s+сохран[её]н|в\s+(?:(?:моей|сохран[её]нной)\s+)?памяти|что\s+(?:ты\s+)?помнишь)/iu.test(text)&&!/(?:https?:\/\/|интернет|в сети|сайт|новост)/iu.test(text);
 return command||local?{kind:'none',urls:[],query:null,reason:'Запрос относится к локальной памяти Companion.'}:planWebAction(text,mode);
}
export function captureMode(value:unknown):CaptureMode{return value==='explicit'||value==='suggest'?value:'off';}
export function needsCapture(text:string,mode:CaptureMode){return captureMemory(text,mode).kind!=='none';}
export async function captureFromChat(text:string,mode:Exclude<CaptureMode,'off'>,file:string,signal:AbortSignal){return captureReplySchema.parse(await memoryRequest(file,{action:'capture',text,mode},signal));}
