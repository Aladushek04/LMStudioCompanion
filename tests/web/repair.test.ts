import { expect, it } from 'vitest';
import { z } from 'zod';
import { repairToolArguments, TurnRepair, canRetry } from '../../packages/lmstudio-plugin/src/tools/repair.js';
const schema = z.object({ url: z.string().url() }).strict();
it('repairTrailingCommaOnlyWithoutChangingStringContent', () => {
  expect(repairToolArguments('{"url":"https://example.org/a,}",}', schema)).toMatchObject({ ok: true, value: { args: { url: 'https://example.org/a,}' }, changed: true } });
});
it('ambiguousArgumentsAndDuplicateKeysRejected', () => {
  for (const raw of ["{'url':'https://example.org'}", '{"url":https://example.org}', '{"url":"https://a.org","url":"https://b.org"}', '{"extra":true}', '[1,,2]']) expect(repairToolArguments(raw, schema).ok).toBe(false);
});
it('validJsonPassesWithoutSpendingRepairAndEachTurnRepairsAtMostOnce', () => {
  const turn = new TurnRepair(1);
  expect(turn.repair('{"url":"https://example.org/a"}', schema)).toMatchObject({ ok: true, value: { changed: false } });
  expect(turn.repair('{"url":"https://example.org/a",}', schema).ok).toBe(true);
  expect(turn.repair('{"url":"https://example.org/b",}', schema).ok).toBe(false);
  expect(new TurnRepair(0).repair('{"url":"https://example.org/a",}', schema).ok).toBe(false);
});
it('unknownWriteNotRetriedAndReadOnlyAllowlistIsExact', () => {
  expect(canRetry('Remember', 'unknown')).toBe(false);
  expect(canRetry('Forget', 'failed')).toBe(false);
  expect(canRetry('read_page', 'failed')).toBe(true);
  expect(canRetry('read_page', 'succeeded')).toBe(false);
  expect(canRetry('new_read_like_tool', 'failed')).toBe(false);
});
