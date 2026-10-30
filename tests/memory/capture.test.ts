import {it,expect} from 'vitest';
import {captureMemory} from '../../packages/memory/src/capture.js';
it('recognizes direct save/edit/forget commands without guessing a target',()=>{
 expect(captureMemory('Запомни: Я предпочитаю краткие ответы.','explicit')).toMatchObject({kind:'save',content:'Я предпочитаю краткие ответы.',origin:'explicit'});
 expect(captureMemory('Исправь в памяти «Я предпочитаю краткие ответы.» на «Я предпочитаю подробные ответы.»','explicit')).toMatchObject({kind:'edit',selector:'Я предпочитаю краткие ответы.',content:'Я предпочитаю подробные ответы.'});
 expect(captureMemory('Забудь в памяти «Я предпочитаю краткие ответы.»','explicit')).toMatchObject({kind:'delete',selector:'Я предпочитаю краткие ответы.'});
 expect(captureMemory('Исправь память','explicit').kind).toBe('blocked');
});
it('doNotRememberWins before every capture mode',()=>{
 for(const mode of ['explicit','suggest'] as const)for(const t of ['Запомни: Я люблю синий. Но не сохраняй это.','Не запоминай: я предпочитаю чай.','Я предпочитаю чай, не записывай это в память.'])expect(captureMemory(t,mode).kind).toBe('blocked');
});
it('quotedWebTextNotPersonal: quotes, code, websites and fictional examples are data',()=>{
 for(const text of ['«Запомни: я люблю чай»','> Запомни: я люблю чай','```\nЗапомни: я люблю чай\n```','Запомни: «Я люблю чай»','Запомни: в статье https://example.org/ сказано, что я люблю чай.','Запомни: вымышленный пример — я люблю чай.','Я предпочитаю чай — говорит персонаж.','Я предпочитаю чай. Вот цитата: «я люблю кофе»'])expect(['none','blocked']).toContain(captureMemory(text,'suggest').kind);
});
it('suggestions require opt-in and a direct first-person statement; never mine other prose',()=>{
 expect(captureMemory('Я предпочитаю чай.','off')).toEqual({kind:'none'});
 expect(captureMemory('Я предпочитаю чай.','explicit')).toEqual({kind:'none'});
 expect(captureMemory('Я предпочитаю чай.','suggest')).toMatchObject({kind:'save',origin:'suggested'});
 for(const t of ['Какой чай выбрать?','Пользователь предпочитает чай','Найди сайт о чае','Я предпочитаю чай. Найди новости.','Запомни для проекта А: цвет синий','Запомни временно: цвет синий'])expect(['none','blocked']).toContain(captureMemory(t,'suggest').kind);
});
