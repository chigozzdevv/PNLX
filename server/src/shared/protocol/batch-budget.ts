// Native default-budget evidence: batch-settlement::tests::measures_execution_capacity_under_default_resource_limits.
// One partial execution with both change notes is covered; two complete fills pass, three/four exceed limits.
export const MAX_BATCH_EXECUTIONS = 1;

export function assertBatchExecutionBudget(executions: number): void {
  if (!Number.isSafeInteger(executions) || executions < 1 || executions > MAX_BATCH_EXECUTIONS) {
    throw new Error(`batch relay budget supports at most ${MAX_BATCH_EXECUTIONS} matched execution`);
  }
}
