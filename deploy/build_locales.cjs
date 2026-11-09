/* Build-time conversion of system literals. No converter runs over user data. */
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const {parse}=require('@babel/parser');
const OpenCC=require('opencc-js');
const root=path.resolve(__dirname,'..'),pub=path.join(root,'public');
const han=/[\u3400-\u9fff]/;
const toTraditional=OpenCC.Converter({from:'cn',to:'tw'});
const converters={hans:OpenCC.Converter({from:'t',to:'cn'}),hant:value=>toTraditional(value).replace(/賬/g,'帳')};
const canonical=new Set(['全部','约K','聚餐','运动','出游','游戏','其他']);
const sources=new Set();

function html(text,convert) {
  // Respect explicit non-translatable names in the generated HTML as well as browsers.
  const preserved=[];
  text=text.replace(/<([a-z][\w:-]*)\b(?=[^>]*\btranslate=("|')no\2)[^>]*>[\s\S]*?<\/\1>/gi,
    value=>`__QG_PRESERVED_${preserved.push(value)-1}__`);
  // An option without value otherwise changes its submitted value with its label.
  text=text.replace(/<option\b([^>]*)>([^<]*)<\/option>/g,(all,attrs,label)=>
    !/\bvalue\s*=/.test(attrs)&&han.test(label)&&!label.includes('__QG_EXPR_')?
      `<option${attrs} value="${label.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${label}</option>`:all);
  return text.replace(/<[^>]*>|[^<]+/g,part=>part.startsWith('<')?
    part.replace(/\b(title|placeholder|aria-label|alt|download|content)=("[^"]*"|'[^']*')/g,
      (all,key,value)=>`${key}=${value[0]}${convert(value.slice(1,-1))}${value.at(-1)}`):
    part.split(/([\u3400-\u9fff]ICP备\d+号(?:-\d+)?)/).map(piece=>/^[\u3400-\u9fff]ICP备\d+号(?:-\d+)?$/.test(piece)?piece:convert(piece)).join('')).replace(/__QG_PRESERVED_(\d+)__/g,(_,index)=>preserved[Number(index)]);
}

function javascript(source,convert,filename) {
  const tree=parse(source,{sourceType:'script'}),edits=[];
  function visit(node,parent,key) {
    if(!node||typeof node!=='object')return;
    if(node.type==='StringLiteral'&&han.test(node.value)) {
      sources.add(node.value);
      const enumValue=canonical.has(node.value)&&filename!=='i18n.js';
      const objectKey=['ObjectProperty','ObjectMethod'].includes(parent?.type)&&key==='key'&&!parent.computed;
      // Comparisons and object keys are wire values, never translated labels.
      if(!enumValue&&!objectKey&&!(parent?.type==='BinaryExpression'&&parent.operator!=='+')&&parent?.type!=='SwitchCase') {
        const value=/<\/?[a-z!]/i.test(node.value)?html(node.value,convert):convert(node.value);
        edits.push([node.start,node.end,JSON.stringify(value)]);
      }
    }
    if(node.type==='TemplateLiteral') {
      const joined=node.quasis.map(q=>q.value.raw).join('__QG_EXPR_');
      const translated=/<\/?[a-z!]/i.test(joined)?html(joined,convert):convert(joined);
      const parts=translated.split('__QG_EXPR_');
      if(parts.length!==node.quasis.length)throw new Error('Template placeholder changed');
      node.quasis.forEach((q,i)=>{sources.add(q.value.cooked||q.value.raw);edits.push([q.start,q.end,parts[i]]);});
    }
    for(const [childKey,child] of Object.entries(node)) {
      if(['loc','start','end','extra','comments','leadingComments','trailingComments','quasis'].includes(childKey))continue;
      if(Array.isArray(child))child.forEach(item=>visit(item,node,childKey));else visit(child,node,childKey);
    }
  }
  visit(tree,null,'');
  for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);
  parse(source,{sourceType:'script'});
  return source;
}

for(const [locale,convert] of Object.entries(converters)) {
  const target=path.join(pub,'locales',locale);fs.mkdirSync(target,{recursive:true});
  for(const filename of fs.readdirSync(pub).filter(name=>/\.(?:js|html)$/.test(name))) {
    const source=fs.readFileSync(path.join(pub,filename),'utf8');
    let output=filename.endsWith('.js')?javascript(source,convert,filename):html(source,convert);
    if(filename.endsWith('.html'))output=output.replace(/<html lang="[^"]*"/,`<html lang="zh-${locale==='hans'?'Hans':'Hant'}"`);
    fs.writeFileSync(path.join(target,filename),output);
  }
}

const python=cp.execFileSync('python3',['-c',`
import ast,json
from pathlib import Path
files=[Path('server.py'),*Path('qgroup_core').glob('*.py')]
values={n.value for p in files for n in ast.walk(ast.parse(p.read_text())) if isinstance(n,ast.Constant) and isinstance(n.value,str) and any('\\u3400'<=c<='\\u9fff' for c in n.value)}
print(json.dumps(sorted(values),ensure_ascii=False))
`],{cwd:root,encoding:'utf8'});
JSON.parse(python).forEach(value=>sources.add(value));
const catalog={};
for(const [locale,convert] of Object.entries(converters))catalog[locale]=Object.fromEntries([...sources].sort().map(value=>[value,convert(value)]));
fs.writeFileSync(path.join(root,'qgroup_core','locales.json'),JSON.stringify(catalog,null,2)+'\n');
console.log('Built Hans/Hant HTML and JS; message catalog:',sources.size,'source literals');
