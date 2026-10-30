export type CaptureMode='off'|'explicit'|'suggest';
export type CaptureIntent={kind:'none'}|{kind:'blocked';message:string}|{kind:'save';content:string;origin:'explicit'|'suggested'}|{kind:'edit';selector:string;content:string;origin:'explicit'}|{kind:'delete';selector:string;origin:'explicit'};
export const normalizeFact=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');
const sourceMaterial=(text:string)=>/[«»“”"`]|^\s*>|https?:\/\/|\bwww\.|(?:цитат|вымышлен|для примера|персонаж|ролевая игра|в статье|на сайте|по сценарию|пример\s*:)/imu.test(text);
export function captureMemory(text:string,mode:CaptureMode):CaptureIntent{
 const none:CaptureIntent={kind:'none'},blocked=(message:string):CaptureIntent=>({kind:'blocked',message});
 if(mode==='off')return none;
 if(/не\s+(?:(?:надо|нужно|следует)\s+)?(?:сохраня[йт]|сохран[яи]ть|запомина[йт]|запоминать|записыва[йт]|записывать)/iu.test(text))return blocked('Запрет сохранения учтён. Предложение не создавалось.');
 const t=text.trim();if(!t||t.length>4096)return none;
 const scope=/^(?:запомни|сохрани|исправь|измени|забудь).{0,45}(?:для проекта|в проект|временно|для этого чата|на этот чат)/iu.test(t);
 if(scope)return blocked('В чате пока доступна только общая память. Проектные и временные изменения не подготовлены.');
 const edit=/^(?:исправь|измени|замени)\s+в\s+(?:общей\s+)?памяти\s*:?\s*(?:«([^»]+)»|"([^"]+)")\s+на\s+(?:«([^»]+)»|"([^"]+)")[.!]?$/iu.exec(t);
 if(edit){const selector=(edit[1]??edit[2]!).trim(),content=(edit[3]??edit[4]!).trim();if(!content||content.length>2000||sourceMaterial(content))return blocked('Материал источника или слишком длинный текст не предлагается как личный факт.');return {kind:'edit',selector,content,origin:'explicit'};}
 const forget=/^забудь\s+(?:в\s+)?(?:общей\s+)?памяти\s*:?\s*(?:«([^»]+)»|"([^"]+)")[.!]?$/iu.exec(t);
 if(forget)return {kind:'delete',selector:(forget[1]??forget[2]!).trim(),origin:'explicit'};
 const save=/^(?:запомни|сохрани\s+в\s+память)(?:\s+в\s+(?:общей\s+)?памяти)?\s*:\s*([\s\S]+)$/iu.exec(t);
 if(save){const content=save[1]!.trim();if(!content||content.length>2000||sourceMaterial(content))return blocked('Цитаты, веб-материалы и примеры не записываются как личные факты. При необходимости добавьте запись вручную в панели.');return {kind:'save',content,origin:'explicit'};}
 if(/^(?:запомни|сохрани\s+в\s+память|(?:исправь|измени|замени|забудь).{0,20}памят)/iu.test(t))return blocked('Уточните команду: «Запомни: текст»; «Исправь в памяти «старый текст» на «новый текст»»; «Забудь в памяти «точный текст»». Изменений нет.');
 if(mode==='suggest'&&t.length<=500&&!sourceMaterial(t)&&!/\n|\?|[.!]\s+\S/.test(t)&&/^(?:я\s+(?:предпочитаю|использую|люблю|работаю)|мне\s+(?:удобнее|нравится)|мой\s+(?:редактор|браузер|язык))\s+\S/iu.test(t))return {kind:'save',content:t,origin:'suggested'};
 return none;
}
