/** Hepburn keys require supplied kana. Kanji readings are never guessed. */
const rows:Record<string,string> = {
  あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',
  さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',
  な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',
  ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',を:'o',ん:'n',ゔ:'vu',ゐ:'i',ゑ:'e',
  ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o',ゃ:'ya',ゅ:'yu',ょ:'yo',ゎ:'wa',
};
const pairs:Record<string,string>={しゃ:'sha',しゅ:'shu',しょ:'sho',ちゃ:'cha',ちゅ:'chu',ちょ:'cho',じゃ:'ja',じゅ:'ju',じょ:'jo',ぢゃ:'ja',ぢゅ:'ju',ぢょ:'jo',しぇ:'she',ちぇ:'che',じぇ:'je',てぃ:'ti',でぃ:'di',とぅ:'tu',どぅ:'du',つぁ:'tsa',つぃ:'tsi',つぇ:'tse',つぉ:'tso',ふぁ:'fa',ふぃ:'fi',ふぇ:'fe',ふぉ:'fo',ゔぁ:'va',ゔぃ:'vi',ゔぇ:'ve',ゔぉ:'vo',うぃ:'wi',うぇ:'we',うぉ:'wo'};
for(const [kana,base] of Object.entries({き:'k',ぎ:'g',に:'n',ひ:'h',び:'b',ぴ:'p',み:'m',り:'r'}))for(const [small,suffix] of Object.entries({ゃ:'ya',ゅ:'yu',ょ:'yo'}))pairs[kana+small]=base+suffix;
export const musicKanaKey=(value:string)=>value.normalize('NFKC').replace(/[\u30a1-\u30f6]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
export function musicKanaRomaji(value:string) {
  const text=Array.from(musicKanaKey(value));let result='',geminate=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i]!;
    if(char==='っ'){geminate=true;continue;}
    if(char==='ー'){result+=result.match(/[aeiou]$/)?.[0]??'';continue;}
    const pair=pairs[char+(text[i+1]??'')],syllable=pair??rows[char]??char;
    if(pair)i++;
    result+=(geminate&&/^[bcdfghjklmnpqrstvwxyz]/.test(syllable)?syllable.startsWith('ch')?'t':syllable[0]:'')+syllable;
    geminate=false;
  }
  return result;
}
export function musicLatinKey(value:string) {
  // Fold common long vowels and separators for search only; labels stay untouched.
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/ou|oo/g,'o').replace(/uu/g,'u');
}
