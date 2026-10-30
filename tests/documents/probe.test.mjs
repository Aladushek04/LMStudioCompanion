import {describe,it,expect} from 'vitest';
import {probeError} from '../../scripts/documents-probe-error.mjs';

describe('D0 diagnostics',()=>{
 it('retains PDF failure but drops boxed stack traces and local paths',()=>{
  const error=Error('\x1b[31m┌ Error ──────┐\n│           │\n│ Failed to load PDF file: [object Object] │\n│ </> STACK TRACE │\n│ at file:///G:/Synthetic/Private/script.mjs:2 │\x1b[0m');
  expect(probeError(error)).toBe('Failed to load PDF file.');
 });
 it('keeps expired-upload cause without printing server filesystem locations',()=>{
  const error=Error("ENOENT: no such file or directory, open 'C:\\Synthetic\\User\\.lmstudio\\user-files\\1234.txt'");
  expect(probeError(error)).toBe('ENOENT: requested resource not found.');
 });
 it('removes path-bearing stack suffixes from other SDK failures',()=>{
  expect(probeError(Error('│ Unsupported parser │\n│ </> STACK TRACE │\n│ at file:///G:/Synthetic/Private/file.mjs │'))).toBe('Unsupported parser');
 });
});
