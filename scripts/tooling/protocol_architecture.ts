import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const RETIRED_PROTOCOL_DIRECTORIES = [
  "src/protocols/openai_" + "chat",
  "src/protocols/chat_" + "completions",
  "src/protocols/" + "responses",
] as const;

const SOURCE_ROOTS = ["src", "scripts", "tests", "web"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".svelte"]);
const retiredNames = ["openai_" + "chat", "chat_" + "completions", "responses"];
const retiredReference = new RegExp(`protocols/(?:${retiredNames.join("|")})(?:/|["'])`, "u");
const inconsistentOpenaiIdentifierFragment = "Open" + "Ai";

const violations: string[] = [];
for (const directory of RETIRED_PROTOCOL_DIRECTORIES) {
  try {
    await access(directory);
    violations.push(`retired protocol directory exists: ${directory}`);
  } catch (_error: unknown) {
    // Absence is required.
  }
}

for (const root of SOURCE_ROOTS) {
  for (const file of await sourceFiles(root)) {
    const relative = file.replaceAll(path.sep, "/");
    const source = await readFile(file, "utf8");
    if (source.includes(inconsistentOpenaiIdentifierFragment)) {
      violations.push(`inconsistent Openai identifier fragment: ${relative}`);
    }
    if (retiredReference.test(source)) {
      violations.push(`retired protocol source reference: ${relative}`);
    }
    if (relative.startsWith("src/copilot/") && importsClientProtocol(source, file)) {
      violations.push(`copilot imports a client protocol module: ${relative}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(violations.join("\n"));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(current));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(current);
    }
  }
  return files;
}

function importsClientProtocol(source: string, file: string): boolean {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  let violation = false;
  const visit = (node: ts.Node): void => {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    const imported = specifier === undefined ? undefined : staticString(specifier);
    if (imported?.includes("protocols/") === true) {
      violation = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violation;
}

function staticString(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticString(expression.expression);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const interpolation = staticString(span.expression);
      if (interpolation === undefined) {
        return undefined;
      }
      value += interpolation + span.literal.text;
    }
    return value;
  }
  return undefined;
}
