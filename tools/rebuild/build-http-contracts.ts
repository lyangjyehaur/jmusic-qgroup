import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs';
import { isAbsolute,join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as contracts from '@qgroup/contracts';
import { HttpResponses } from '@qgroup/contracts/http';
import { assertHttpOpenAPI,httpOpenAPI } from './http-openapi';

type SyntaxNode={type:string;[key:string]:unknown};
const node=(value:unknown):SyntaxNode|undefined=>value!==null&&typeof value==='object'&&'type' in value&&typeof value.type==='string'?value as SyntaxNode:undefined;
function walk(value:unknown,visit:(value:SyntaxNode,parents:SyntaxNode[])=>void,parents:SyntaxNode[]=[]){
 if(Array.isArray(value)){for(const item of value)walk(item,visit,parents);return;}
 const n=node(value);if(!n)return;visit(n,parents);
 for(const [key,item] of Object.entries(n))if(!['loc','start','end','extra'].includes(key))walk(item,visit,[...parents,n]);
}
function sourceNodes(value:unknown,parents:SyntaxNode[],depth=0):SyntaxNode[]{
 if(depth>64)throw Error('Static route expression exceeds capacity');
 const n=node(value);if(!n)throw Error('Unresolved static route expression');
 if(['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','ParenthesizedExpression'].includes(n.type))return sourceNodes(n.expression,parents,depth+1);
 if(n.type==='Identifier'){
  for(let i=parents.length-1;i>=0;i--){
   const scope=parents[i]!;
   if(scope.type==='ForOfStatement'){
    const left=node(scope.left),declarations=left?.declarations as unknown[]|undefined;
    for(const declaration of declarations??[]){
     const id=node(node(declaration)?.id),elements=id?.elements as unknown[]|undefined;
     const index=id?.type==='ArrayPattern'?elements?.findIndex(element=>node(element)?.name===n.name):-1;
     if(id?.name!==n.name&&(index===undefined||index<0))continue;
     const arrays=sourceNodes(scope.right,parents.slice(0,i),depth+1),values=arrays.flatMap(array=>array.type==='ArrayExpression'?array.elements as unknown[]:[]);
     return values.flatMap(value=>index!==undefined&&index>=0?sourceNodes((node(value)?.elements as unknown[])[index],parents.slice(0,i),depth+1):sourceNodes(value,parents.slice(0,i),depth+1));
    }
   }
   if(['BlockStatement','Program'].includes(scope.type))for(const statement of scope.body as unknown[]){
    const declaration=node(statement);if(declaration?.type!=='VariableDeclaration')continue;
    for(const item of declaration.declarations as unknown[]){const d=node(item);if(node(d?.id)?.name===n.name)return sourceNodes(d?.init,parents,depth+1);}
   }
  }
  throw Error('Unresolved static route variable');
 }
 if(n.type==='MemberExpression'){
  const property=node(n.property),key=property?.name??property?.value;
  return sourceNodes(n.object,parents,depth+1).flatMap(object=>{
   if(object.type!=='ObjectExpression')throw Error('Unresolved route object');
   const property=(object.properties as unknown[]).map(node).find(p=>(node(p?.key)?.name??node(p?.key)?.value)===key);
   return sourceNodes(property?.value,parents,depth+1);
  });
 }
 return [n];
}
function routeStrings(value:unknown,parents:SyntaxNode[],depth=0):string[]{
 if(depth>64)throw Error('Static route expression exceeds capacity');
 const values=sourceNodes(value,parents,depth),out:string[]=[];
 for(const n of values){
  if(n.type==='StringLiteral'){out.push(String(n.value));continue;}
  if(n.type==='ConditionalExpression'){out.push(...routeStrings(n.consequent,parents,depth+1),...routeStrings(n.alternate,parents,depth+1));continue;}
  if(n.type==='BinaryExpression'&&n.operator==='+'){
   for(const left of routeStrings(n.left,parents,depth+1))for(const right of routeStrings(n.right,parents,depth+1))out.push(left+right);
  }else if(n.type==='TemplateLiteral'){
   const quasis=n.quasis as SyntaxNode[],expressions=n.expressions as unknown[];let rows=[String((quasis[0]!.value as {cooked:string}).cooked)];
   for(let i=0;i<expressions.length;i++){const next:string[]=[];for(const left of rows)for(const right of routeStrings(expressions[i],parents,depth+1))next.push(left+right+String((quasis[i+1]!.value as {cooked:string}).cooked));rows=next;}
   out.push(...rows);
  }else throw Error('Unsupported static route expression');
  if(out.length>256)throw Error('Static route expansion exceeds capacity');
 }
 return [...new Set(out)];
}
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
const methods=new Set(['get','post','put','patch','delete']);
export type HttpResponseSource =
 | {kind:'json';status:200;schema:string}
 | {kind:'image';status:200;mediaTypes:readonly string[]}
 | {kind:'download';status:200;mediaTypes:readonly string[];disposition:'attachment';syntax:'json';schema:string};
export interface HttpOperationSource {id:string;method:string;path:string;body:string|null;query:string|null;file:string;line:number;response:HttpResponseSource}
function responseSource(id:string):HttpResponseSource{
 if(!Object.hasOwn(HttpResponses,id))throw Error('Missing fixed HTTP success response: '+id);
 const response=HttpResponses[id as keyof typeof HttpResponses];
 if(response.kind==='json')return {kind:'json',status:response.status,schema:response.schemaName};
 if(response.kind==='download')return {kind:'download',status:response.status,mediaTypes:response.mediaTypes,disposition:response.disposition,syntax:response.syntax,schema:response.schemaName};
 return {kind:'image',status:response.status,mediaTypes:response.mediaTypes};
}

function localFunction(name:string,parents:SyntaxNode[]):SyntaxNode|undefined{
 for(let i=parents.length-1;i>=0;i--){
  const scope=parents[i]!;if(!['Program','BlockStatement'].includes(scope.type))continue;
  for(const item of scope.body as unknown[]){
   const statement=node(item);
   if(statement?.type==='FunctionDeclaration'&&node(statement.id)?.name===name)return statement;
   if(statement?.type==='VariableDeclaration')for(const value of statement.declarations as unknown[]){
    const declaration=node(value),init=node(declaration?.init);
    if(node(declaration?.id)?.name===name&&init&&['ArrowFunctionExpression','FunctionExpression'].includes(init.type))return init;
   }
  }
 }
 return undefined;
}
function queryBindings(value:unknown,parents:SyntaxNode[],imports:Map<string,string>,file:string,covered:Set<SyntaxNode>,seen=new Set<SyntaxNode>()):Set<string>{
 const bindings=new Set<string>();
 if(seen.size>256)throw Error('Local query call graph exceeds capacity');
 walk(value,(child,inside)=>{
  const ancestors=[...parents,...inside];
  if(child.type==='MemberExpression'&&node(child.object)?.name==='request'&&node(child.property)?.name==='query'){
   covered.add(child);
   const parent=ancestors.at(-1),call=node(parent?.callee),schema=node(call?.object),method=node(call?.property);
   if(parent?.type!=='CallExpression'||(parent.arguments as unknown[])[0]!==child||!['parse','safeParse'].includes(String(method?.name))||schema?.type!=='Identifier'||typeof schema.name!=='string'||!imports.has(schema.name))throw Error('Query must use a named shared contract: '+file);
   const name=imports.get(schema.name)!;
   if(!(contracts[name as keyof typeof contracts] instanceof z.ZodType))throw Error('Query contract is not an exported Zod schema');
   bindings.add(name);
  }
  if(child.type==='CallExpression'){
   const callee=node(child.callee);if(callee?.type!=='Identifier'||typeof callee.name!=='string')return;
   const helper=localFunction(callee.name,ancestors);if(!helper||seen.has(helper))return;
   seen.add(helper);for(const name of queryBindings(helper.body,[...ancestors,helper],imports,file,covered,seen))bindings.add(name);
  }
 });
 return bindings;
}

/** Static source bindings only; a runtime route inventory must also agree. */
export function readHttpOperationSources(root:string):HttpOperationSource[]{
 const rows:HttpOperationSource[]=[];
 for(const file of readdirSync(join(root,'apps/api/src')).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')).sort(order)){
  const text=readFileSync(join(root,'apps/api/src',file),'utf8'),ast=parse(text,{sourceType:'module',plugins:['typescript']}),imports=new Map<string,string>(),coveredQueries=new Set<SyntaxNode>(),externalQueries=new Set<SyntaxNode>();
  for(const statement of ast.program.body)if(statement.type==='ImportDeclaration'&&statement.source.value==='@qgroup/contracts'){
   for(const spec of statement.specifiers)if(spec.type==='ImportSpecifier')imports.set(spec.local.name,spec.imported.type==='Identifier'?spec.imported.name:spec.imported.value);
  }
  walk(ast,(n,parents)=>{
   if(n.type!=='CallExpression')return;
   const callee=node(n.callee),object=node(callee?.object),property=node(callee?.property),args=n.arguments as unknown[];
   if(callee?.type!=='MemberExpression'||object?.type!=='Identifier'||object.name!=='app'||property?.type!=='Identifier'||typeof property.name!=='string'||!methods.has(property.name))return;
   const paths=routeStrings(args[0],parents).filter(path=>path.startsWith('/api/v2/'));
   if(!paths.length){
    // Non-v2 OAuth/provider handlers retain their own query protocol.
    walk(args.slice(1),child=>{if(child.type==='MemberExpression'&&node(child.object)?.name==='request'&&node(child.property)?.name==='query')externalQueries.add(child);});
    return;
   }
   const method=property.name.toUpperCase(),bindings=new Set<string>();
   walk(args.slice(1),child=>{
    if(child.type!=='CallExpression')return;
    const call=node(child.callee),property=node(call?.property),schema=node(call?.object),argument=node((child.arguments as unknown[])[0]),field=node(argument?.property);
    if(call?.type!=='MemberExpression'||property?.type!=='Identifier'||!['parse','safeParse'].includes(String(property.name))||argument?.type!=='MemberExpression'||field?.name!=='body')return;
    if(schema?.type!=='Identifier'||typeof schema.name!=='string'||!imports.has(schema.name))throw Error('Request body must use a named shared contract: '+file+' '+method);
    const name=imports.get(schema.name)!;
    if(!(contracts[name as keyof typeof contracts] instanceof z.ZodType))throw Error('Request body contract is not an exported Zod schema');
    bindings.add(name);
   });
   if(bindings.size>1||method!=='GET'&&bindings.size!==1||method==='GET'&&bindings.size!==0)throw Error('Ambiguous or missing request body binding: '+method);
   const queries=queryBindings(args.slice(1),[...parents,n],imports,file,coveredQueries);
   if(queries.size>1)throw Error('Ambiguous query contract: '+file+' '+method);
   const location=n.loc as {start:{line:number}};
   for(const path of paths){const id=method+' '+path;rows.push({id,method,path,body:[...bindings][0]??null,query:[...queries][0]??null,file:'apps/api/src/'+file,line:location.start.line,response:responseSource(id)});}
  });
  walk(ast,child=>{
   if(child.type==='MemberExpression'&&node(child.object)?.name==='request'&&node(child.property)?.name==='query'&&!coveredQueries.has(child)&&!externalQueries.has(child))throw Error('Query read is outside the audited local route graph: '+file);
  });
 }
 rows.sort((a,b)=>order(a.id,b.id));
 if(!rows.length||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Empty or duplicate HTTP operation inventory');
 for(const row of rows)for(const name of [...row.path.matchAll(/:([^/]+)/g)].map(match=>match[1]!))if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))throw Error('Unsupported parameterized route');
 return rows;
}
export function httpOperationsSource(rows:HttpOperationSource[]){
 return '// Generated by tools/rebuild/build-http-contracts.ts. Do not edit.\n'+
  "import * as contracts from '../index';\n\nexport const HttpOperations = Object.freeze({\n"+
  rows.map(row=>'  '+JSON.stringify(row.id)+': Object.freeze({ method: '+JSON.stringify(row.method)+', path: '+JSON.stringify(row.path)+(row.body?', body: contracts.'+row.body:'')+(row.query?', query: contracts.'+row.query:', query: null')+' } as const),').join('\n')+
  '\n} as const);\n';
}
export function sharedSchemaCatalog(){
 const schemas:Record<string,unknown>={};
 for(const name of Object.keys(contracts).sort(order)){
  const value=contracts[name as keyof typeof contracts];if(!(value instanceof z.ZodType))continue;
  // Input describes HTTP wire values before parsing, including stripping-mode
  // objects. Custom refinements still require Zod and server domain checks.
  schemas[name]=z.toJSONSchema(value,{io:'input',target:'draft-2020-12'});
 }
 const responseSchemas:Record<string,unknown>={};
 for(const response of Object.values(HttpResponses))if(response.kind==='json'||response.kind==='download'){
  // Validate the unmodified wire value; defaults/transforms stay with callers.
  if(Object.hasOwn(responseSchemas,response.schemaName))continue;
  responseSchemas[response.schemaName]=z.toJSONSchema(response.schema,{io:'input',target:'draft-2020-12'});
 }
 return {version:1,io:'input',schemas,responseSchemas,zodRuntimeValidationRequired:true,serverDomainValidationRequired:true,successResponsesBound:true,structuredDownloadSchemaBound:true,openapiComplete:false};
}
export function checkHttpOperations(root:string){
 const rows=readHttpOperationSources(root),generated=join(root,'packages/contracts/src/http/operations.generated.ts');
 if(Object.keys(HttpResponses).sort(order).join('\n')!==rows.map(row=>row.id).join('\n'))throw Error('Success response bindings differ from HTTP routes');
 if(readFileSync(generated,'utf8')!==httpOperationsSource(rows))throw Error('Generated HTTP request contracts are stale');
 return rows;
}
function sharedContractFiles(root:string,directory='packages/contracts/src'):string[]{
 return readdirSync(join(root,directory),{withFileTypes:true}).flatMap(entry=>{
  const path=directory+'/'+entry.name;
  return entry.isDirectory()?sharedContractFiles(root,path):entry.name.endsWith('.ts')&&!entry.name.endsWith('.test.ts')?[path]:[];
 });
}
const defaultRoot=fileURLToPath(new URL('../..',import.meta.url));
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--write'){
   const path=join(defaultRoot,'packages/contracts/src/http/operations.generated.ts');mkdirSync(join(defaultRoot,'packages/contracts/src/http'),{recursive:true});
   writeFileSync(path,httpOperationsSource(readHttpOperationSources(defaultRoot)));
  }else if(args.length===1&&args[0]==='--check'){
   const rows=checkHttpOperations(defaultRoot);await assertHttpOpenAPI(httpOpenAPI(rows,sharedSchemaCatalog()));process.stdout.write(JSON.stringify({operations:rows.length,requestBodies:rows.filter(row=>row.body).length,queryOperations:rows.filter(row=>row.query).length,querySchemasBound:true,successResponsesBound:true,structuredDownloadSchemaBound:true,openapiGenerated:true,openapiComplete:false})+'\n');
  }else if(args.length===2&&args[0]==='--output'&&isAbsolute(args[1]!)&&!existsSync(args[1]!)){
   const rows=checkHttpOperations(defaultRoot),catalog=sharedSchemaCatalog(),document=httpOpenAPI(rows,catalog),hash=(path:string)=>createHash('sha256').update(readFileSync(join(defaultRoot,path))).digest('hex');
   await assertHttpOpenAPI(document);
   mkdirSync(args[1]!,{mode:0o700});writeFileSync(join(args[1]!,'schemas.json'),JSON.stringify(catalog)+'\n',{flag:'wx'});
   writeFileSync(join(args[1]!,'openapi.json'),JSON.stringify(document)+'\n',{flag:'wx'});
   const apiFiles=readdirSync(join(defaultRoot,'apps/api/src')).filter(file=>file.endsWith('.ts')&&!file.endsWith('.test.ts')).map(file=>'apps/api/src/'+file);
   const inputPaths=[...apiFiles,...sharedContractFiles(defaultRoot),'package.json','package-lock.json','packages/contracts/package.json','packages/domain/src/legacy-timezones.json','tools/rebuild/build-http-contracts.ts','tools/rebuild/http-openapi.ts','tools/rebuild/schemas/openapi-3.1.json'];
   const inputs=[...new Set(inputPaths)].sort(order).map(path=>({path,sha256:hash(path)}));
   writeFileSync(join(args[1]!,'request-operations.json'),JSON.stringify({version:1,operations:rows,inputs,
    requestBodiesBound:true,querySchemasBound:true,queryBindingMethod:'source-local-call-graph',queryWireValues:'strings',queryZodValidationRequired:true,permissionBindingsComplete:false,responseSchemasBound:true,successTransportBound:true,structuredDownloadSchemaBound:true,openapiGenerated:true,openapiComplete:false,releaseEligible:false})+'\n',{flag:'wx'});
   process.stdout.write(JSON.stringify({operations:rows.length,requestBodies:rows.filter(row=>row.body).length,queryOperations:rows.filter(row=>row.query).length,schemas:Object.keys(catalog.schemas).length,querySchemasBound:true,openapiComplete:false,releaseEligible:false})+'\n');
  }else throw Error('Invalid arguments');
 }catch{process.stderr.write('HTTP contract generation failed; no services started or updated.\n');process.exitCode=1;}
}
