/**
 * DB-free runtime selector for aiWorker decision explainability.
 *
 * The caller may pass only evidence that was already computed by the shared
 * readiness generation. A missing bundle preserves the existing SHADOW/Risk
 * projection and never starts a read to fill the gap.
 */
import {
  buildStrategyDecisionExplainabilityWorkerAdvisory,
  buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream,
  type StrategyDecisionExplainabilityWorkerAdvisory,
  type StrategyDecisionExplainabilityWorkerDownstreamInput,
  type StrategyDecisionExplainabilityWorkerInput,
} from './strategyDecisionExplainabilityWorkerBridgeV2';

export const STRATEGY_DECISION_EXPLAINABILITY_RUNTIME_VERSION =
  'strategy-decision-explainability-runtime/v1' as const;

export type StrategyDecisionExplainabilityRuntimeDownstreamEvidence = Omit<
  StrategyDecisionExplainabilityWorkerDownstreamInput,
  keyof StrategyDecisionExplainabilityWorkerInput
>;

export interface StrategyDecisionExplainabilityRuntimeInput
  extends StrategyDecisionExplainabilityWorkerInput {
  /** Null is an explicit fail-closed marker; it is never hydrated here. */
  downstreamEvidence: StrategyDecisionExplainabilityRuntimeDownstreamEvidence | null;
}

export function buildStrategyDecisionExplainabilityRuntimeAdvisory(
  input: StrategyDecisionExplainabilityRuntimeInput,
): StrategyDecisionExplainabilityWorkerAdvisory {
  const { shadowEnvelope, riskAdvisory, downstreamEvidence } = input;
  if (downstreamEvidence === null) {
    return buildStrategyDecisionExplainabilityWorkerAdvisory({
      shadowEnvelope,
      riskAdvisory,
    });
  }
  return buildStrategyDecisionExplainabilityWorkerAdvisoryWithDownstream({
    shadowEnvelope,
    riskAdvisory,
    ...downstreamEvidence,
  });
}
