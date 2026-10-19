import { stripTypeScriptTypes } from 'node:module';
import { posix } from 'node:path';
import { parse } from 'acorn';
import type { Node } from 'acorn';

type Syntax = Node & {
  readonly name?: string;
  readonly source?: { readonly value?: unknown } | null;
  readonly computed?: boolean;
  readonly id?: Syntax | null;
  readonly callee?: Syntax;
  readonly object?: Syntax;
  readonly property?: Syntax;
  readonly specifiers?: readonly { readonly local: { readonly name: string } }[];
};

/** Only modules without external inputs are eligible in the first adapter. */
const UNSUPPORTED = new Set([
  'ImportExpression',
  'MetaProperty',
  'ThisExpression',
  'Super',
  'NewExpression',
  'WithStatement',
  'TaggedTemplateExpression',
]);
const EXTERNAL_NAMES = new Set([
  'process',
  'global',
  'globalThis',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'constructor',
  '__proto__',
  'prototype',
  'Reflect',
  'Proxy',
  'WebAssembly',
  'fetch',
  'WebSocket',
  'Worker',
  'Date',
  'performance',
  'crypto',
  'random',
  'setTimeout',
  'setInterval',
  'setImmediate',
]);
const BUILTINS = new Set(['node:test', 'node:assert', 'node:assert/strict']);

export type Graph = {
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly reason: string | null;
};

/** Parse every source, including currently unimported modules; uncertainty widens to full. */
export function dependencyGraph(files: Readonly<Record<string, string>>): Graph {
  const dependencies: Record<string, string[]> = {};
  try {
    for (const [path, text] of Object.entries(files)) {
      if (!isSource(path)) continue;
      const source = /\.(ts|mts)$/.test(path) ? stripTypeScriptTypes(text) : text;
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      const imports = new Set<string>();
      const calls = callBindings(ast);
      visit(ast, (node) => inspect(node, { path, files, imports }));
      visit(ast, (node) => inspectCall(node, calls));
      dependencies[path] = [...imports].toSorted();
    }
    return { dependencies, reason: null };
  } catch {
    return { dependencies: {}, reason: 'unsupported-dependency-or-syntax' };
  }
}

/** Restrict calls as well as imports: aliases and reflection cannot hide access to resources. */
function callBindings(ast: Syntax): { direct: Set<string>; assertions: Set<string> } {
  const direct = new Set([
    'String',
    'Number',
    'Boolean',
    'BigInt',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
  ]);
  const assertions = new Set<string>();
  visit(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name !== undefined)
      direct.add(node.id.name);
    if (node.type !== 'ImportDeclaration') return;
    for (const binding of node.specifiers ?? []) {
      direct.add(binding.local.name);
      if (node.source?.value === 'node:assert' || node.source?.value === 'node:assert/strict')
        assertions.add(binding.local.name);
    }
  });
  return { direct, assertions };
}

function inspectCall(node: Syntax, calls: ReturnType<typeof callBindings>): void {
  if (node.type !== 'CallExpression') return;
  const callee = node.callee;
  if (callee?.type === 'Identifier' && callee.name !== undefined && calls.direct.has(callee.name))
    return;
  if (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object?.type === 'Identifier'
  ) {
    const name = callee.object.name;
    if (name !== undefined && (calls.assertions.has(name) || name === 'Math')) return;
  }
  throw new Error('Unsupported call target');
}

export function isSource(path: string): boolean {
  return /\.(js|mjs|ts|mts)$/.test(path);
}

function inspect(
  node: Syntax,
  context: {
    readonly path: string;
    readonly files: Readonly<Record<string, string>>;
    readonly imports: Set<string>;
  },
): void {
  if (
    UNSUPPORTED.has(node.type) ||
    (node.type === 'MemberExpression' && node.computed) ||
    (node.type === 'Identifier' && node.name !== undefined && EXTERNAL_NAMES.has(node.name))
  ) {
    throw new Error('Untracked input or reflection');
  }
  if (
    !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) ||
    node.source === null ||
    node.source === undefined
  )
    return;
  const specifier = node.source.value;
  if (typeof specifier !== 'string') throw new Error('Unknown import');
  if (BUILTINS.has(specifier)) return;
  // Node resolves imports as URLs; these could name a different file or module instance.
  if (/[%?#\\]/u.test(specifier) || specifier.includes('\0'))
    throw new Error('Unsupported module URL');
  const target = posix.normalize(posix.join(posix.dirname(context.path), specifier));
  if (
    !specifier.startsWith('.') ||
    target.startsWith('../') ||
    !isSource(target) ||
    !Object.hasOwn(context.files, target)
  )
    throw new Error('Unresolved local import');
  context.imports.add(target);
}

function isNode(value: unknown): value is Syntax {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'start' in value &&
    'end' in value
  );
}

function visit(node: Syntax, inspectNode: (node: Syntax) => void): void {
  inspectNode(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) visit(child, inspectNode);
    } else if (isNode(value)) visit(value, inspectNode);
  }
}

export function closure(root: string, graph: Graph): string[] {
  const seen = new Set([root]);
  for (const path of seen) {
    for (const dependency of graph.dependencies[path] ?? []) seen.add(dependency);
  }
  return [...seen].toSorted();
}
