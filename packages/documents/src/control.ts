import {DocumentFailure,abortFailure} from './errors.js';

export function deadline(parent:AbortSignal,ms:number,inherit=false){
 const controller=new AbortController();
 const cancel=()=>controller.abort(inherit?abortFailure(parent):new DocumentFailure('CANCELLED'));
 if(parent.aborted)cancel();else parent.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>controller.abort(new DocumentFailure('TIMEOUT')),ms);
 return {signal:controller.signal,close(){clearTimeout(timer);parent.removeEventListener('abort',cancel);}};
}
export function throwIfAborted(signal:AbortSignal){if(signal.aborted)throw abortFailure(signal);}
export function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise<T>((resolve,reject)=>{
  const cancel=()=>reject(abortFailure(signal));
  if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',cancel);if(signal.aborted)cancel();else resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(signal.aborted?abortFailure(signal):error);});
 });
}
