// Syntax-based (TypeScript AST) security boundary check for src/collector.
// Test-only helper: comments never count, and only real imports, calls and
// literals are inspected, so non-database code such as createHash().update()
// or searchParams.delete() is not flagged.

import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type BoundaryViolation = {
  rule: "db_import" | "server_import" | "network" | "db_query" | "sql_tag" | "domain";
  detail: string;
};

const PROJECT_ROOT = resolve(".");
const SERVER_DIR = resolve(PROJECT_ROOT, "src/server");

// Database clients and drivers (the project itself only uses @supabase/*).
const DB_MODULE = /^(@supabase\/|supabase$|pg$|pg\/|postgres$|postgres\/|postgresql$|pg-promise$|knex$|kysely$|drizzle-orm|@prisma\/client$|mysql2?$|sqlite3$|better-sqlite3$)/;
const NETWORK_MODULE = /^(node:)?(http|https|http2|net|tls|dgram)$|^undici$/;
const SERVER_ALIAS = /^@\/server(\/|$)/;
const LIFECYCLE_STATUS = new Set(["published", "pending_review", "rejected", "archived"]);
// Global constructors whose .from() is not a database call.
const NON_DB_FROM_RECEIVERS = new Set(["Array", "Buffer", "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Set", "Map"]);

function moduleSpecifierRule(specifier: string, fileName: string): BoundaryViolation | null {
  if (DB_MODULE.test(specifier)) return { rule: "db_import", detail: specifier };
  if (NETWORK_MODULE.test(specifier)) return { rule: "network", detail: specifier };
  if (SERVER_ALIAS.test(specifier)) return { rule: "server_import", detail: specifier };
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(resolve(PROJECT_ROOT, fileName)), specifier);
    const fromServer = relative(SERVER_DIR, target);
    if (fromServer === "" || (!fromServer.startsWith("..") && !fromServer.startsWith(sep))) {
      return { rule: "server_import", detail: specifier };
    }
  }
  return null;
}

function stringArgument(node: ts.CallExpression): string | null {
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : null;
}

function methodName(node: ts.CallExpression): string | null {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
}

// True for a .from()/.rpc() call that is not a known non-database global.
function isDbEntryCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  if (name === "rpc") return true;
  if (name !== "from") return false;
  const receiver = node.expression.expression;
  return !(ts.isIdentifier(receiver) && NON_DB_FROM_RECEIVERS.has(receiver.text));
}

// Walks down a call chain (a.from(x).select().update()) looking for a DB entry.
function chainHasDbEntry(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  while (true) {
    if (ts.isCallExpression(current)) {
      if (isDbEntryCall(current)) return true;
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return false;
    }
  }
}

export function findBoundaryViolations(code: string, fileName: string): BoundaryViolation[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: BoundaryViolation[] = [];
  const report = (violation: BoundaryViolation | null) => {
    if (violation) violations.push(violation);
  };

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      report(moduleSpecifierRule(node.moduleSpecifier.text, fileName));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      report(moduleSpecifierRule(node.moduleReference.expression.text, fileName));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const specifier = stringArgument(node);
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) && specifier !== null) {
        report(moduleSpecifierRule(specifier, fileName));
      }
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        report({ rule: "network", detail: "fetch()" });
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch" && ts.isIdentifier(callee.expression) && ["globalThis", "window", "self", "global"].includes(callee.expression.text)) {
        report({ rule: "network", detail: `${callee.expression.text}.fetch()` });
      }
      const name = methodName(node);
      if (name !== null && isDbEntryCall(node)) {
        report({ rule: "db_query", detail: `.${name}()` });
      } else if (name === "insert" || name === "upsert") {
        report({ rule: "db_query", detail: `.${name}()` });
      } else if ((name === "update" || name === "delete") && ts.isPropertyAccessExpression(callee) && chainHasDbEntry(callee.expression)) {
        report({ rule: "db_query", detail: `.${name}() on a query chain` });
      }
    } else if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "sql") {
      report({ rule: "sql_tag", detail: "sql`...`" });
    } else if (ts.isStringLiteralLike(node) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
      if (LIFECYCLE_STATUS.has(node.text)) report({ rule: "domain", detail: `"${node.text}"` });
      if (node.text.includes("sale_events")) report({ rule: "domain", detail: "sale_events" });
    } else if (ts.isIdentifier(node) && node.text.includes("sale_events")) {
      report({ rule: "domain", detail: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}
