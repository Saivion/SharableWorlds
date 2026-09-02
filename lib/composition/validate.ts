import type { Piece } from "../types";
import type { ComposedPlan } from "./compose";
import { buildRuleContext, SCENE_RULES, type Repair, type ScoreDimension } from "./rules";
import type { EnvironmentSpec } from "./types";

/**
 * Scene validation — the rule engine run as a scored checklist.
 *
 * A scene is not complete because tool calls succeeded; it is complete when
 * the world-building laws hold AND the request's intent is covered. The
 * completeness model rolls every rule into six dimensions:
 *
 *   intentCoverage     the things the request asked for exist, in place
 *   composition        the scene reads as a place (zones, focal, people)
 *   spatialCoherence   things sit where they belong, facing what they are for
 *   environment        themed ground, a framed edge
 *   navigation         you can enter, walk, and climb
 *   placementValidity  grounded, un-overlapped, where the plan put them
 *
 * `complete` needs the overall score past the threshold AND every critical
 * rule passing. Each failed check carries structured repairs — a WebMCP
 * tool plus arguments — so the loop INSPECT → VALIDATE → REPAIR never has
 * to guess.
 */

export const COMPLETE_THRESHOLD = 0.85;

const DIMENSION_WEIGHT: Record<ScoreDimension, number> = {
  intentCoverage: 0.3,
  composition: 0.2,
  spatialCoherence: 0.15,
  environment: 0.1,
  navigation: 0.15,
  placementValidity: 0.1,
};

export type ValidationCheck = {
  id: string;
  kind: string;
  dimension: ScoreDimension;
  ok: boolean;
  score: number;
  critical: boolean;
  note: string;
  fix?: string;
  repairs: Repair[];
};

export type ValidationReport = {
  complete: boolean;
  /** Overall completeness 0-100. */
  completion: number;
  score: { overall: number } & Record<ScoreDimension, number>;
  checks: ValidationCheck[];
  missing: string[];
  /** Every prescribed repair, most important first. */
  repairs: Repair[];
  /** Why the scene is not complete, in one line. */
  verdict: string;
};

export function validateScene(
  env: EnvironmentSpec | null,
  pieces: Record<string, Piece>,
  theme?: string,
  plan: ComposedPlan | null = null,
  sceneSeed?: string,
): ValidationReport {
  const ctx = buildRuleContext(env, pieces, theme, plan, sceneSeed);
  const checks: ValidationCheck[] = SCENE_RULES.filter((rule) => rule.when(ctx)).map((rule) => {
    const result = rule.check(ctx);
    const score = Math.max(0, Math.min(1, result.ok ? 1 : (result.score ?? 0)));
    return {
      id: rule.id,
      kind: rule.kind,
      dimension: rule.dimension,
      ok: result.ok,
      score,
      critical: Boolean(rule.critical),
      note: result.note,
      fix: result.ok ? undefined : result.fix,
      repairs: result.ok ? [] : (result.repairs ?? []),
    };
  });

  const dims = {} as Record<ScoreDimension, number>;
  for (const dim of Object.keys(DIMENSION_WEIGHT) as ScoreDimension[]) {
    const rules = SCENE_RULES.filter((r) => r.dimension === dim && r.when(ctx));
    const total = rules.reduce((s, r) => s + r.weight, 0);
    if (!total) {
      dims[dim] = 1;
      continue;
    }
    dims[dim] = rules.reduce((s, r) => s + r.weight * (checks.find((c) => c.id === r.id)?.score ?? 0), 0) / total;
  }
  const overall = (Object.keys(DIMENSION_WEIGHT) as ScoreDimension[]).reduce((s, dim) => s + DIMENSION_WEIGHT[dim] * dims[dim], 0);
  const criticalFailures = checks.filter((c) => c.critical && !c.ok);
  const complete = checks.length > 0 && overall >= COMPLETE_THRESHOLD && criticalFailures.length === 0;
  const failed = checks.filter((c) => !c.ok);
  const repairs = [...failed]
    .sort((a, b) => Number(b.critical) - Number(a.critical) || dimensionRank(a.dimension) - dimensionRank(b.dimension))
    .flatMap((c) => c.repairs);
  const verdict = complete
    ? "the scene reads as the place that was asked for"
    : criticalFailures.length
      ? `not yet: ${criticalFailures.map((c) => c.note).join("; ")}`
      : `${Math.round(overall * 100)}% — ${failed.slice(0, 2).map((c) => c.note).join("; ")}`;
  return {
    complete,
    completion: Math.round(overall * 100),
    score: { overall: round(overall), ...(Object.fromEntries((Object.keys(dims) as ScoreDimension[]).map((d) => [d, round(dims[d])])) as Record<ScoreDimension, number>) },
    checks,
    missing: failed.map((c) => `${c.id}: ${c.note}`),
    repairs,
    verdict,
  };
}

function dimensionRank(dim: ScoreDimension): number {
  return ["intentCoverage", "placementValidity", "navigation", "composition", "spatialCoherence", "environment"].indexOf(dim);
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
