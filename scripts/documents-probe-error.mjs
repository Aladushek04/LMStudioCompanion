// Keep research reports useful without copying SDK stack traces/server file paths.
export function probeError(error){
 const text=String(error?.message??error).replace(/\x1b\[[0-9;]*m/g,'').split('\n').map(line=>line.replace(/[│┌┐└┘─]/g,'').trim()).filter(Boolean).join(' ').split('</> STACK TRACE')[0].trim();
 if(/Failed to load PDF file/.test(text))return 'Failed to load PDF file.';
 if(/\bENOENT\b/.test(text))return 'ENOENT: synthetic upload no longer exists.';
 return text.replace(/(?:file:\/\/\/)?[A-Za-z]:[\\/][^"'\r\n]+/g,'<local path>').replace(/localfile:[^\s"']+/g,'<synthetic-file>').slice(0,360);
}
