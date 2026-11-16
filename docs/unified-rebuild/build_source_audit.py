#!/usr/bin/env python3
"""Index committed source only; never read production databases or environment files."""
import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path(__file__).resolve().parent


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True, help='Full committed source SHA')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.commit):
        parser.error('--commit must be a full SHA')
    commit = git('rev-parse', args.commit + '^{commit}').decode().strip()
    paths = git('ls-tree', '-r', '--name-only', commit).decode().splitlines()
    files = []
    prefixes = ('qgroup_core/', 'qgroup_bot/', 'music_site/', 'ui/', 'tests/', 'deploy/', 'tools/', 'public/')
    excluded = ('/locales/', '/ui/', '/wordlists/')
    for name in paths:
        if not (name in ('server.py', 'public_api.py', 'package.json', 'tsconfig.json', 'compose.yaml', 'Dockerfile')
                or (name.startswith(prefixes)
                    and Path(name).suffix in ('.py', '.tsx', '.ts', '.js', '.mjs', '.html', '.css', '.yaml')
                    and not any(part in name for part in excluded))):
            continue
        # Generated assets do not represent a second implementation.
        if name in ('public/ui.css', 'music_site/public/ui.css', 'qgroup_core/locales.json'):
            continue
        raw = git('show', commit + ':' + name)
        source = raw.decode()
        row = dict(path=name, sha256=hashlib.sha256(raw).hexdigest(), lines=len(source.splitlines()))
        if name.endswith('.py'):
            tree = ast.parse(source)
            definitions = []

            def walk(node, prefix=''):
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        qualified = prefix + child.name
                        definitions.append([qualified, child.lineno])
                        walk(child, qualified + '.')
                    else:
                        walk(child, prefix)

            walk(tree)
            row['definitions'] = definitions
            row['test_names'] = [[name, line] for name, line in definitions if name.split('.')[-1].startswith('test_')]
            strings = [node for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
            row['http_literal_clues'] = sorted(
                [[node.lineno, node.value] for node in strings
                 if len(node.value) < 300 and node.value.startswith(('/api/', '/auth/', '/settlement', '/attendees',
                    '/roster', '/finance', '/rooms', '/claims', '/management', '/invitations', '/attendance', '/onsite'))],
                key=lambda item: (item[0], item[1]))
            row['ddl_table_clues'] = sorted(set(
                match.group(1) for node in strings
                for match in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z_0-9]*)', node.value, re.I)))
        elif Path(name).suffix in ('.ts', '.tsx', '.js', '.mjs'):
            row['function_name_clues'] = [[match.group(1), source.count('\n', 0, match.start()) + 1]
                for match in re.finditer(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', source)]
        files.append(row)

    # Materialize only committed Python source into a temporary isolated tree.
    # Importing storage constructs an empty synthetic schema, never production data.
    with tempfile.TemporaryDirectory(prefix='qgroup-source-audit-') as folder:
        temporary = Path(folder)
        for name in paths:
            if name.startswith(('qgroup_core/', 'music_site/')) and name.endswith('.py'):
                target = temporary / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(git('show', commit + ':' + name))
        inspect_code = '''
import json, sqlite3
from pathlib import Path
from qgroup_core import storage
from music_site.identity_store import Store
root = Path.cwd()
board = root / 'synthetic-board.sqlite3'
music = root / 'synthetic-music.sqlite3'
storage.initialize(board)
storage.initialize(board)
Store(music)
def schema(path):
    with sqlite3.connect(path) as db:
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return dict(tables=[dict(name=n, columns=[dict(name=r[1], type=r[2], notnull=bool(r[3]), pk=r[5]) for r in db.execute('PRAGMA table_info("'+n+'")')]) for n in names],
            triggers=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")],
            integrity=db.execute('PRAGMA integrity_check').fetchone()[0], foreign_key_violations=list(db.execute('PRAGMA foreign_key_check')))
with storage.connect(board) as db:
    versions=[r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')]
print(json.dumps(dict(board=schema(board),music_identity=schema(music),board_migration_versions=versions)))
'''
        schema = json.loads(subprocess.check_output([sys.executable, '-c', inspect_code], cwd=temporary))

    result = dict(format_version=1, audit_date='2026-11-17', timezone='Asia/Taipei', baseline_commit=commit,
        scope='Committed source and empty synthetic schemas only; no production data or secrets.',
        limitations=['HTTP literals are lexical clues, not a proven routable endpoint list.',
                    'Inherited upstream endpoints require service.py and gateway reachability review.',
                    'Function clues for TypeScript and JavaScript are partial lexical indexes, not full symbol inventories.',
                    'Test names are inventory only, not test execution results.',
                    'Empty-schema initialization twice is not a production-data migration rehearsal.'],
        counts=dict(source_files=len(files), python_test_methods=sum(len(row.get('test_names', [])) for row in files),
                    board_tables=len(schema['board']['tables']), music_identity_tables=len(schema['music_identity']['tables'])),
        schema=schema, files=files)
    (OUTPUT / 'source-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    lines = ['# 合成空庫資料表索引', '',
             '自核准程式基線在臨時目錄建立，不含正式資料；看板初始化連續執行兩次。來源與限制見 [程式盤點](05-source-audit.md)。', '']
    for label, key in (('看板業務庫', 'board'), ('成分身分庫', 'music_identity')):
        lines.extend(['## ' + label, '', '| 表 | 欄位 |', '| --- | --- |'])
        for table in schema[key]['tables']:
            lines.append('| `' + table['name'] + '` | ' + '、'.join('`' + c['name'] + '`' for c in table['columns']) + ' |')
        lines.extend(['', '完整性：`' + schema[key]['integrity'] + '`；外鍵違規：' + str(len(schema[key]['foreign_key_violations'])) + '。', ''])
    (OUTPUT / 'schema-index.md').write_text('\n'.join(lines))
    print(json.dumps(dict(commit=commit, **result['counts']), ensure_ascii=False))


if __name__ == '__main__':
    main()
