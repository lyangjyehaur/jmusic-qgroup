import { execFileSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
import { shoutText } from './music-shouts';
describe('shout content normalization',()=>{
  it('matches Python clean_text code point whitespace behavior without stripping BOM or silently truncating',()=>{
    const inputs=['  hello\n world  ','\u001c\u0085 音樂 \u3000 同好\u2001','\ufeff保留BOM\ufeff','𠀀'.repeat(140),'👩🏽‍🎤 <script>不是 HTML</script>'];
    const expected=JSON.parse(execFileSync('python3',['-c',"import json,sys;from music_site.upstream import clean_text;print(json.dumps([clean_text(s,140) for s in json.load(sys.stdin)]))"],{input:JSON.stringify(inputs),encoding:'utf8'}));
    expect(inputs.map(shoutText)).toEqual(expected);expect(()=>shoutText('𠀀'.repeat(141))).toThrow('140');expect(()=>shoutText('\n\u0085\u001c')).toThrow('請輸入');
  });
});
