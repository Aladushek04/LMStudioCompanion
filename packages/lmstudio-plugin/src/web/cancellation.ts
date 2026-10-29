/** Stop awaiting non-cooperative SDK operations; late completion cannot resume injection. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop!:()=>void;
  const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(signal.reason ?? new Error('Отменено'));signal.addEventListener('abort',stop,{once:true});});
  try{return await Promise.race([work,cancelled]);}
  finally{signal.removeEventListener('abort',stop);}
}
