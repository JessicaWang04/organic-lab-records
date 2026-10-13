import { Chemistry } from "./chemistry";
import { ExperimentStep, FileStore, StepArtifacts } from "./domain";
import { parseFrontmatter } from "./records";
import { checkEvidence } from "./quality";
import type { SessionState } from "./runner";

export interface DeliveryIssue { step: number; code: string; message: string }
export interface DeliveryReport {
  policy: "organic-lab-delivery/0.1.2"; complete: boolean; requiredSteps: number;
  verifiedReactionImages: number; verifiedEditableCdxml: number; verifiedRecords: number;
  issues: DeliveryIssue[];
}
export function requireStructures(step: ExperimentStep): void {
  if (!step.reactants.length || !step.products.length || [...step.reactants, ...step.products].some(s => typeof s !== "string" || !s.trim())) {
    throw new Error("structure_missing: 必须补齐本步反应物与产物结构；用局部来源图核对后调用set_step_structures。来源图片不能替代反应PNG或CDXML。");
  }
}
type NativeResult = { order: number; ok: boolean; error?: string; verification?: { editableGraph: string; stereoRoundtrip: string; reactionImage: { kind: string } } };

// Re-read actual bytes on every boundary. A quality.json flag or old receipt is never acceptance evidence.
export async function auditDelivery(state: SessionState, store: FileStore, chemistry: Chemistry, steps = state.plan?.steps ?? [], requireRecords = true): Promise<DeliveryReport> {
  const report: DeliveryReport = { policy: "organic-lab-delivery/0.1.2", complete: false, requiredSteps: steps.length,
    verifiedReactionImages: 0, verifiedEditableCdxml: 0, verifiedRecords: 0, issues: [] };
  const requests: Record<string, unknown>[] = [];
  const add = (step: number, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    report.issues.push({ step, code: message.split(":", 1)[0], message });
  };
  if (!steps.length) add(0, "plan_missing: 请先record_route");
  for (const step of steps) {
    try {
      requireStructures(step);
      const artifacts: StepArtifacts | undefined = state.rendered[step.order];
      if (!artifacts?.image || !artifacts.cdxml) throw new Error("editable_artifacts_missing: 请render_step生成单反应PNG及非空CDXML");
      if (!artifacts.image.endsWith(".png") || !artifacts.cdxml.endsWith(".cdxml")) throw new Error("artifact_type_invalid: 需要PNG和CDXML");
      for (const path of [artifacts.image, artifacts.cdxml, artifacts.quality, ...(artifacts.referenceSpectra ?? [])]) {
        if (!path || !await store.exists(path)) throw new Error(`artifact_missing: ${path}`);
      }
      const errors = checkEvidence(step, state.sources).filter(issue => issue.severity === "error");
      if (errors.length) throw new Error(`evidence_invalid: ${JSON.stringify(errors)}`);
      requests.push({ order: step.order, reactants: step.reactants, products: step.products, aboveArrow: step.aboveArrow, belowArrow: step.belowArrow,
        cdxml: await store.read(artifacts.cdxml), png: Buffer.from(await store.readBinary(artifacts.image)).toString("base64") });
      if (requireRecords) {
        const path = state.written[step.order];
        if (!path || !await store.exists(path)) throw new Error(`missing_step_records: ${step.order}，请write_step`);
        const note = await store.read(path), properties = parseFrontmatter(note);
        if (properties.image !== `[[${artifacts.image}]]` || !note.includes(`![[${artifacts.image}]]`) ||
          properties.cdxml !== `[[${artifacts.cdxml}]]` || !note.includes(`可编辑结构：[[${artifacts.cdxml}]]`) ||
          properties.step_number !== step.order || properties.route_id !== state.id) {
          throw new Error("record_artifact_mismatch: 笔记YAML与正文必须链接本步PNG和CDXML，并具有正确路线及步骤编号");
        }
        report.verifiedRecords++;
      }
    } catch (error) { add(step.order, error); }
  }
  if (requests.length) {
    try {
      // One Python process checks the route, reducing repeated interpreter startup costs.
      const native = await chemistry.call<{ results: NativeResult[] }>({ op: "verify_delivery", steps: requests });
      if (!Array.isArray(native.results) || native.results.length !== requests.length || new Set(native.results.map(r => r.order)).size !== requests.length) {
        throw new Error("delivery_verifier_invalid: 缺少唯一的逐步验收回执");
      }
      for (const request of requests) {
        const result = native.results.find(r => r.order === request.order);
        if (!result || !result.ok) { add(Number(request.order), result?.error ?? "delivery_verifier_invalid"); continue; }
        if (result.verification?.editableGraph !== "passed" || result.verification.stereoRoundtrip !== "passed" || result.verification.reactionImage?.kind !== "single-reaction") {
          add(Number(request.order), "delivery_verifier_invalid: 缺少结构、立体或单反应图片验收"); continue;
        }
        report.verifiedReactionImages++; report.verifiedEditableCdxml++;
      }
    } catch (error) { for (const request of requests) add(Number(request.order), error); }
  }
  report.complete = steps.length > 0 && !report.issues.length && report.verifiedEditableCdxml === steps.length && (!requireRecords || report.verifiedRecords === steps.length);
  return report;
}

export function assertDelivery(report: DeliveryReport): void {
  if (!report.complete) throw new Error(`delivery_incomplete: ${JSON.stringify(report)}`);
}
