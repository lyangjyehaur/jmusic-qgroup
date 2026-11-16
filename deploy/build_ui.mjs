import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {build} from 'esbuild';
import postcss from 'postcss';
import {reactControllers} from './react_controllers.mjs';
import {localizeReact} from './localize_react.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const check=process.argv.includes('--check');
let stale=false;
function output(name,value) {
  const data=Buffer.from(value);
  if(fs.existsSync(path.join(root,name)) && fs.readFileSync(path.join(root,name)).equals(data))return;
  if(check){console.error('Stale UI asset:',name);stale=true;return;}
  fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),data);
}
const board=['i18n','storage','client'];
const music=['initials','member-id','link','app'];
const groups=[
  {dir:'public',locales:['hans','hant'],entries:{board,admin:[],static:[]},styles:['style.css'],custom:'board'},
  {dir:'music_site/public',locales:[''],entries:{music,'music-admin':['member-id','admin'],static:[]},styles:['style.css','extra.css','music.css'],custom:'music'},
];
const upstream=read('node_modules/yahha-ui/dist/style.css');
const license=read('node_modules/yahha-ui/LICENSE');
for(const group of groups) {
  const legacy=postcss.parse(group.styles.map(n=>read(`${group.dir}/${n}`)).join('\n'),{from:undefined});
  legacy.walkAtRules('charset',rule=>rule.remove());
  legacy.walkDecls(decl=>{if(/^(?:background(?:-.+)?|border(?:-.+)?|color|box-shadow|text-shadow|filter|backdrop-filter|-webkit-backdrop-filter)$/.test(decl.prop))decl.important=false;});
  const css=`/*! Yahha UI 0.2.0, MIT. See /${group.dir==='public'?'':'music/'}ui/YAHHA-LICENSE.txt */\n@layer legacy,yahha,site;\n@layer legacy {\n${legacy}\n}\n@layer yahha {\n${upstream}\n}\n@layer site {\n${read('ui/shared.css')}\n${read(`ui/${group.custom}.css`)}\n}\n`;
  output(`${group.dir}/ui.css`,css);
  output(`${group.dir}/ui/YAHHA-LICENSE.txt`,license);
  output(`${group.dir}/ui/THIRD_PARTY_NOTICES.md`,read('node_modules/yahha-ui/THIRD_PARTY_NOTICES.md'));
  for(const locale of group.locales) {
    const outdir=path.join(root,group.dir,'ui',locale);
    const entryPoints=Object.entries(group.entries).map(([name,scripts])=>({in:`controllers:${name}`,out:name}));
    const result=await build({absWorkingDir:root,entryPoints,outdir,bundle:true,splitting:true,format:'esm',target:['es2022'],minify:true,write:false,legalComments:'linked',entryNames:'[name]',chunkNames:'shared-[hash]',outExtension:{'.js':'.mjs'},alias:{'@qgroup':path.join(root,'ui')},define:{'process.env.NODE_ENV':'"production"'},plugins:[{
      name:'existing-controllers',setup(builder){
        builder.onLoad({filter:/[\\/]ui[\\/]board[\\/].*\.(?:tsx|ts)$/},args=>({contents:localizeReact(fs.readFileSync(args.path,'utf8'),locale),loader:args.path.endsWith('.tsx')?'tsx':'ts'}));
        builder.onResolve({filter:/^controllers:/},args=>({path:args.path,namespace:'controllers'}));
        builder.onLoad({filter:/.*/,namespace:'controllers'},args=>{
          const name=args.path.slice('controllers:'.length),scripts=group.entries[name];
          if(name==='admin'&&group.dir==='public')return {contents:`import {mountAdmin} from './ui/board/AdminApp.tsx'; mountAdmin();`,resolveDir:root,loader:'jsx'};
          const contents=scripts.map(script=>{const source=read(`${group.dir}/${locale?`locales/${locale}/`:''}${script}.js`);return name==='board'?source:reactControllers(source);}).join('\n;\n');
          if(name==='board')return {contents:`import {mountBoard} from './ui/board/BoardApp.tsx';\n${contents}\nmountBoard({client:BoardClient,storage:BoardStore,i18n:BoardI18n});`,resolveDir:root,loader:'jsx'};
          const features=name==='music' ? `import {SelectionPanel,MusicTools} from './ui/music/SelectionPanel.tsx';\nUI.boot({features:{'music-selection':SelectionPanel,'music-tools':MusicTools}});` : 'UI.boot();';
          return {contents:`import {UI} from './ui/react-view.tsx';\n${features}\n${contents}`,resolveDir:root,loader:'jsx'};
        });
      }
    }]});
    const expected=new Set();
    for(const file of result.outputFiles){const relative=path.relative(root,file.path);expected.add(relative);output(relative,file.contents);}
    if(fs.existsSync(outdir))for(const name of fs.readdirSync(outdir))if(/\.(?:mjs|txt)$/.test(name) && name!=='YAHHA-LICENSE.txt' && !expected.has(path.relative(root,path.join(outdir,name)))) {
      if(check){console.error('Obsolete UI asset:',name);stale=true;}else fs.unlinkSync(path.join(outdir,name));
    }
  }
  // Content versions invalidate old HTML/worker caches after every UI build.
  const hash=crypto.createHash('sha256').update(css).digest('hex').slice(0,12);
  for(const name of group.dir==='public'?['index','admin','guide','privacy','contact']:['index','admin','privacy']) {
    const file=`${group.dir}/${name}.html`,html=read(file);
    output(file,html.replace(/(href="\/?ui\.css\?v=)[^"]+/g,`$1${hash}`));
  }
  if(group.dir==='music_site/public') {
    const files=fs.readdirSync(path.join(root,group.dir,'ui')).filter(name=>name.endsWith('.mjs')).sort();
    const assets=['./','./index.html','./ui.css','./initials.js','./member-id.js','./manifest.json','./icon.svg',...files.map(name=>`./ui/${name}`)];
    const version=crypto.createHash('sha256').update(css+files.map(name=>read(`${group.dir}/ui/${name}`)).join('')).digest('hex').slice(0,12);
    const worker=read(`${group.dir}/sw.js`).replace(/const CACHE = '[^']+';/,`const CACHE = 'qgroup-music-react-${version}';`).replace(/const ASSETS = \[[\s\S]*?\];/,`const ASSETS = ${JSON.stringify(assets,null,2)};`);
    output(`${group.dir}/sw.js`,worker);
  }
}
if(stale)process.exitCode=1;
console.log(check?'Checked React UI assets':'Built React + Yahha UI for both sites');
