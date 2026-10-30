import {it,expect} from 'vitest';
import {planMemoryAwareWeb} from '../../packages/lmstudio-plugin/src/memory/capture.js';
it('local memory questions and explicit memory commands do not trigger freshness search',()=>{
 expect(planMemoryAwareWeb('Какой код учебного маяка сейчас сохранён? Ответь только кодом.','auto',true,'explicit').kind).toBe('none');
 expect(planMemoryAwareWeb('Запомни: Сейчас я использую редактор VS Code.','auto',false,'explicit').kind).toBe('none');
});
it('preserves explicit internet requests, URL reads and ordinary freshness searches',()=>{
 expect(planMemoryAwareWeb('Найди в интернете свежие новости о памяти','auto',true,'explicit').kind).toBe('search');
 expect(planMemoryAwareWeb('Прочитай https://example.org/ и сравни с записью в моей памяти','auto',true,'explicit').kind).toBe('read-url');
 expect(planMemoryAwareWeb('Что нового в LM Studio сейчас?','auto',true,'explicit').kind).toBe('search');
 expect(planMemoryAwareWeb('Что сейчас сохранено?','off',true,'off').kind).toBe('none');
});
