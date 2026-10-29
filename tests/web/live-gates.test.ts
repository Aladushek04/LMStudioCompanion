import {it,expect} from 'vitest';
import {acceptancePassed} from '../../scripts/web-live-gates.mjs';
it('live gate rejects transport failures and incomplete sets instead of counting them as blocked',()=>{
  const readings=Array.from({length:10},()=>({calls:1,generated:true,markerMatched:true,status:'ok',sourceHash:'a'.repeat(64)}));
  const blocked=Array.from({length:5},()=>({calls:1,generated:false,sourceStatus:'blocked'}));
  expect(acceptancePassed(readings,blocked)).toBe(true);
  expect(acceptancePassed(readings,[...blocked.slice(1),{calls:1,generated:false,sourceStatus:'error'}])).toBe(false);
  expect(acceptancePassed(readings.slice(1),blocked)).toBe(false);
});
