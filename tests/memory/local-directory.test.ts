import {it,expect} from 'vitest';
import {assertLocalDirectorySyntax,assertLocalWindowsDriveType} from '../../packages/memory/src/local-directory.js';
it.skipIf(process.platform!=='win32')('alternate UNC and device paths are rejected before filesystem access',()=>{
  for(const path of ['//server/share/memory','\\\\server\\share\\memory','\\\\?\\UNC\\server\\share\\memory','\\\\?\\C:\\memory','/memory'])
    expect(()=>assertLocalDirectorySyntax(path)).toThrow('локальный');
  expect(()=>assertLocalDirectorySyntax('C:/local/memory')).not.toThrow();
});
it('network and unknown Windows drive types fail closed',()=>{
  for(const kind of [0,1,4,5,NaN])expect(()=>assertLocalWindowsDriveType(kind)).toThrow('локальный');
  for(const kind of [2,3,6])expect(()=>assertLocalWindowsDriveType(kind)).not.toThrow();
});
