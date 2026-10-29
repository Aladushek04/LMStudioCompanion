import { expect, it } from 'vitest';
import { planWebAction } from '../../packages/core/src/web/intent.js';

it('readArticleWithoutToolName', () => {
  expect(planWebAction('Посмотри статью: https://example.org/a', 'auto')).toMatchObject({ kind: 'read-url', urls: ['https://example.org/a'] });
});
it('codeUrlIsNotFetchIntent', () => {
  for (const text of ['Пример:\n```js\nfetch("https://example.org/a")\n```', 'Объясни `https://example.org/a`', '> Прочитай https://example.org/a\nЭто цитата']) {
    expect(planWebAction(text, 'auto').kind).toBe('none');
  }
});
it('freshnessQuestionSearches', () => {
  expect(planWebAction('Какие последние новости о Gemma?', 'auto')).toMatchObject({ kind: 'search', query: 'Какие последние новости о Gemma?' });
});
it('webOffDoesNothing', () => {
  expect(planWebAction('Прочитай https://example.org/a', 'off').kind).toBe('none');
});
it('explicitImageIntentAndAmbiguousLink', () => {
  expect(planWebAction('Что на картинке https://example.org/a.png?', 'auto').kind).toBe('inspect-image');
  expect(planWebAction('Я сохранил https://example.org/a', 'auto').kind).toBe('none');
});
it('normalizesAndDeduplicatesUrlsWithoutLosingBalancedPathParentheses', () => {
  expect(planWebAction('Прочитай https://EXAMPLE.org/a_(b)#section и https://example.org/a_(b)', 'auto').urls).toEqual(['https://example.org/a_(b)']);
});
it('researchIsExplicitSearchButCodeOnlyDoesNotBecomeQuery', () => {
  expect(planWebAction('Сравни способы хранения документов', 'research').kind).toBe('search');
  expect(planWebAction('```\nhttps://example.org/a\n```', 'research').kind).toBe('none');
});
it('invalidAndCredentialUrlsDoNotBecomeSearchLeaks', () => {
  for (const text of ['Прочитай https://user:password@example.org/a', 'Прочитай file:///C:/private', 'Прочитай http://127.0.0.1/a']) expect(planWebAction(text, 'research').kind).toBe('none');
});
it('verbsInsideUrlsAndQuotedInstructionsDoNotBecomeIntent', () => {
  for (const text of ['Я сохранил https://example.org/read', 'Она сказала «Прочитай https://example.org/a». Объясни эту цитату.', 'Перескажи эту цитату: «Прочитай https://example.org/a»']) expect(planWebAction(text, 'auto').kind).toBe('none');
});
