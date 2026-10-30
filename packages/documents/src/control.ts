import {DocumentFailure,abortFailure} from './errors.js';
import {performance} from 'node:perf_hooks';

const deadlineChecks=new WeakMap<AbortSignal,()=>void>();
export function deadline(parent:AbortSignal,ms:number,inherit=false){
 const controller=new AbortController();
 const expiresAt=performance.now()+ms;
 const cancel=()=>controller.abort(inherit?abortFailure(parent):new DocumentFailure('CANCELLED'));
 if(parent.aborted)cancel();else parent.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>controller.abort(new DocumentFailure('TIMEOUT')),ms);
 const check=()=>{
  if(!controller.signal.aborted&&inherit){try{throwIfAborted(parent);}catch(error){controller.abort(error instanceof DocumentFailure?error:new DocumentFailure('CANCELLED'));}}
  if(!controller.signal.aborted&&performance.now()>=expiresAt)controller.abort(new DocumentFailure('TIMEOUT'));
  if(controller.signal.aborted)throw abortFailure(controller.signal);
 };
 deadlineChecks.set(controller.signal,check);
 return {signal:controller.signal,check,close(){clearTimeout(timer);parent.removeEventListener('abort',cancel);}};
}
export function throwIfAborted(signal:AbortSignal){const check=deadlineChecks.get(signal);if(check)check();else if(signal.aborted)throw abortFailure(signal);}
export function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const cancel=()=>reject(abortFailure(signal));
  if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',cancel);if(signal.aborted)cancel();else resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(signal.aborted?abortFailure(signal):error);});
 });
}
