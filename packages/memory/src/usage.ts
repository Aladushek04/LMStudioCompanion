export interface MemoryUsage {at:number;refs:{id:string;revision:number;reason:string}[]}
/** RAM only; no query or memory content. Reset at host restart. */
export class UsageLog {
 private latest:MemoryUsage|null=null;
 record(refs:MemoryUsage['refs']){this.latest={at:Date.now(),refs:structuredClone(refs)};}
 get(){return this.latest?structuredClone(this.latest):null;}
}
