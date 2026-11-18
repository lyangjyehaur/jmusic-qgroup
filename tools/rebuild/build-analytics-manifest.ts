import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function analyticsManifest(root: string) {
  const routes = new Set(['/','/auth/qq/callback']), operations = new Set<string>(), controls = new Set<string>();
  function files(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []); }
  for (const file of [...files(join(root,'apps/web/src')), ...files(join(root,'apps/api/src'))]) {
    if (file.endsWith('analytics-manifest.ts')) continue;
    const tree = ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    function visit(node: ts.Node) {
      if (file.endsWith('/web/src/main.tsx') && ts.isPropertyAssignment(node) && node.name.getText(tree)==='path' && ts.isStringLiteral(node.initializer)) routes.add('/'+node.initializer.text);
      if (ts.isJsxAttribute(node) && ['id','name'].includes(node.name.getText(tree)) && node.initializer && ts.isStringLiteral(node.initializer) && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(node.initializer.text)) controls.add(node.initializer.text);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['get','post','put','patch','delete'].includes(node.expression.name.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('/api/v2/')) operations.add(node.arguments[0].text.replace(/:[A-Za-z][A-Za-z0-9_]*/g,':id'));
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  return { routes:[...routes].sort(), operations:[...operations].sort(), controls:[...controls].sort() };
}
export function analyticsManifestSource(root: string) { return '// Generated from static route and control declarations; never from the live DOM.\nexport const analyticsManifest = '+JSON.stringify(analyticsManifest(root),null,2)+' as const;\n'; }
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) writeFileSync('apps/web/src/analytics-manifest.ts',analyticsManifestSource(resolve('.')));
