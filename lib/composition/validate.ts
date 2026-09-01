import type { Piece } from "../types";
import { buildRuleContext, SCENE_RULES } from "./rules";
import type { EnvironmentSpec } from "./types";

/**
 * Scene validation — the rule engine run as a checklist.
 *
 * A scene is not complete because tool calls succeeded; it is complete when
 * every applicable world-building law holds (lib/composition/rules.ts).
 * Each failed check names the WebMCP tool that repairs it, so an agent can
 * loop INSPECT → VALIDATE → REPAIR until the world is real.
 */

export type ValidationCheck = {
  id: string;
  ok: boolean;
  note: string;
  fix?: string;
};

export type ValidationReport = {
  complete: boolean;
  completion: number;
  checks: ValidationCheck[];
  missing: string[];
};

export function validateScene(
  env: EnvironmentSpec | null,
  pieces: Record<string, Piece>,
  theme?: string,
): ValidationReport {
  const ctx = buildRuleContext(env, pieces, theme);
  const checks: ValidationCheck[] = SCENE_RULES.filter((rule) => rule.when(ctx)).map((rule) => {
    const result = rule.check(ctx);
    return { id: rule.id, ok: result.ok, note: result.note, fix: result.ok ? undefined : result.fix };
  });
  const okCount = checks.filter((c) => c.ok).length;
  const completion = checks.length ? Math.round((okCount / checks.length) * 100) : 0;
  return {
    complete: checks.length > 0 && okCount === checks.length,
    completion,
    checks,
    missing: checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.note}`),
  };
}
