import path from 'node:path';
import ts from 'typescript';

export const RULES = {
  core: [],
  memory: ['core'],
  documents: ['core'],
  host: ['core', 'memory', 'documents'],
  'control-panel': ['core', 'memory', 'documents'],
  'lmstudio-plugin': ['core', 'memory'],
  'conversation-engine': ['core', 'memory'],
};

const TYPE_ONLY_TARGETS = new Set(['memory', 'documents']);

export function packageOf(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  return /(?:^|\/)packages\/([^/]+)\//.exec(normalized)?.[1] ?? null;
}

export function targetPackage(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const normalized = fromFile.replaceAll('\\', '/');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), specifier));
  return packageOf(resolved);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

export function parseImports(source, fileName = 'file.ts') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const imports = [];

  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = clause?.isTypeOnly === true;
      if (!typeOnly && clause?.name) {
        typeOnly = false;
      } else if (!typeOnly && clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          typeOnly = false;
        } else {
          const elements = clause.namedBindings.elements;
          typeOnly = elements.length > 0 && elements.every(element => element.isTypeOnly);
        }
      } else if (!typeOnly) {
        typeOnly = false;
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly,
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let typeOnly = node.isTypeOnly;
      if (!typeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const elements = node.exportClause.elements;
        typeOnly = elements.length > 0 && elements.every(element => element.isTypeOnly);
      } else if (!typeOnly) {
        typeOnly = false;
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly,
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({
        specifier: node.moduleReference.expression.text,
        typeOnly: node.isTypeOnly === true,
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        typeOnly: false,
        line: lineOf(sourceFile, node),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

export function findViolations(files) {
  const violations = [];
  for (const file of files) {
    const from = packageOf(file.path);
    if (!from || !(from in RULES)) continue;
    for (const imported of parseImports(file.source, file.path)) {
      const to = targetPackage(file.path, imported.specifier);
      if (!to || to === from) continue;
      if (!RULES[from].includes(to)) {
        violations.push({
          from,
          to,
          specifier: imported.specifier,
          line: imported.line,
          path: file.path,
        });
        continue;
      }
      if (from === 'control-panel' && TYPE_ONLY_TARGETS.has(to) && !imported.typeOnly) {
        violations.push({
          from,
          to,
          specifier: imported.specifier,
          line: imported.line,
          path: file.path,
        });
      }
    }
  }
  return violations;
}
