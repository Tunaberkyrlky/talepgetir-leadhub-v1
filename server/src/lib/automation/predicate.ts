/**
 * Safe predicate evaluation for the automation runtime (entry criteria, condition
 * branches, stop conditions). NO eval / NO code execution — a predicate is a tiny
 * declarative tree (see PredicateExpr) walked against the run context. An empty
 * object `{}` means "always true" (no gate). Unknown shapes fail CLOSED (false) so a
 * malformed predicate never accidentally fires a side-effect.
 */
import type { PredicateExpr } from './types.js';

/** Segments that could reach up the prototype chain — never traversable. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Read a dotted path (`lead.lifecycle_status`) out of a nested context object.
 *  Own-properties ONLY (no inherited/prototype access), and dangerous segments are
 *  rejected so a crafted path can never pull `__proto__`/`constructor` off an object. */
function readPath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (UNSAFE_KEYS.has(key)) return undefined;
    if (acc && typeof acc === 'object' && Object.prototype.hasOwnProperty.call(acc, key)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, ctx);
}

/** Evaluate a predicate against a context. null/undefined ⇒ true (no gate); every other
 *  malformed shape ⇒ FALSE (fail-closed) so a bad predicate never accidentally fires. */
export function evaluatePredicate(
  expr: PredicateExpr | null | undefined,
  ctx: Record<string, unknown>,
): boolean {
  // Only an explicit absence of a gate means "always true".
  if (expr === null || expr === undefined) return true;
  // Any non-object (string/number/boolean) or a bare array is malformed ⇒ fail-closed.
  if (typeof expr !== 'object' || Array.isArray(expr)) return false;
  const keys = Object.keys(expr);
  if (keys.length === 0) return true; // {} ⇒ no gate

  // Composites: the operand MUST be well-formed, else fail-closed. Malformed child
  // elements fail-close via recursion (a non-object element ⇒ false).
  if ('all' in expr) {
    return Array.isArray(expr.all) && expr.all.every((e) => evaluatePredicate(e, ctx));
  }
  if ('any' in expr) {
    return Array.isArray(expr.any) && expr.any.some((e) => evaluatePredicate(e, ctx));
  }
  if ('not' in expr) {
    return expr.not !== undefined && expr.not !== null && !evaluatePredicate(expr.not, ctx);
  }
  if ('path' in expr && typeof expr.path === 'string') {
    const actual = readPath(ctx, expr.path);
    const op = expr.op ?? 'eq';
    const expected = expr.value;
    switch (op) {
      case 'eq':
        return actual === expected;
      case 'ne':
        return actual !== expected;
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'in':
        return Array.isArray(expected) && expected.includes(actual);
      case 'gt':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      case 'lt':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      default:
        return false; // unknown op ⇒ fail closed
    }
  }
  return false; // unrecognized shape ⇒ fail closed
}
