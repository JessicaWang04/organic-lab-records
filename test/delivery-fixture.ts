// Journal/intent unit tests use a fake verifier; real files have separate integration tests.
export function fixtureDeliveryVerification(request: Record<string, unknown>): unknown {
  if (request.op !== "verify_delivery") throw new Error(`unexpected fixture operation: ${request.op}`);
  return { results: (request.steps as { order: number }[]).map(step => ({ order: step.order, ok: true,
    verification: { editableGraph: "passed", stereoRoundtrip: "passed", reactionImage: { kind: "single-reaction" } } })) };
}
