export interface BudgetLimits { maxTurns: number; maxCalls: number }
export interface BudgetUsage { turns: number; calls: number }
export const DEFAULT_BUDGET: Readonly<BudgetLimits> = { maxTurns: 32, maxCalls: 128 };
export const MAX_BUDGET: Readonly<BudgetLimits> = { maxTurns: 128, maxCalls: 512 };

export function validateBudget(limits: BudgetLimits): BudgetLimits {
  for (const [key, name] of [["maxTurns", "模型请求上限"], ["maxCalls", "工具调用上限"]] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > MAX_BUDGET[key]) {
      throw new Error(`${name}需要填写1–${MAX_BUDGET[key]}的整数`);
    }
  }
  return { maxTurns: limits.maxTurns, maxCalls: limits.maxCalls };
}
export function parseBudget(turns: string, calls: string): BudgetLimits {
  if (!turns.trim() || !calls.trim()) throw new Error("请填写两项预算上限");
  return validateBudget({ maxTurns: Number(turns), maxCalls: Number(calls) });
}
export function remainingBudget(limits: BudgetLimits, usage: BudgetUsage): { turns: number; calls: number } {
  return { turns: Math.max(0, limits.maxTurns - usage.turns), calls: Math.max(0, limits.maxCalls - usage.calls) };
}
export function canContinue(limits: BudgetLimits, usage: BudgetUsage): boolean {
  const remaining = remainingBudget(limits, usage);
  return remaining.turns > 0 && remaining.calls > 0;
}
export function appendBudget(limits: BudgetLimits, usage: BudgetUsage, turns: string, calls: string): BudgetLimits {
  const additions = { turns: Number(turns.trim() || "0"), calls: Number(calls.trim() || "0") };
  if (![additions.turns, additions.calls].every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error("追加额度需要填写0或正整数");
  }
  if (!additions.turns && !additions.calls) throw new Error("请明确填写要追加的额度");
  const next = validateBudget({ maxTurns: limits.maxTurns + additions.turns, maxCalls: limits.maxCalls + additions.calls });
  if (!canContinue(next, usage)) throw new Error("追加后仍有一项预算已耗尽，请检查两项已用次数与新上限");
  return next;
}
export function budgetText(limits: BudgetLimits, usage?: BudgetUsage): string {
  if (!usage) return `预算上限：${limits.maxTurns}次模型请求／${limits.maxCalls}次工具调用。`;
  const remaining = remainingBudget(limits, usage);
  return `模型请求：已用${usage.turns}／上限${limits.maxTurns}（剩余${remaining.turns}）；工具调用：已用${usage.calls}／上限${limits.maxCalls}（剩余${remaining.calls}）。累计次数不清零。`;
}

export class SessionGate {
  private owner: symbol | null = null;
  get busy(): boolean { return this.owner !== null; }
  acquire(): (() => void) | null {
    if (this.owner !== null) return null;
    const owner = Symbol("session-operation"); this.owner = owner;
    return () => { if (this.owner === owner) this.owner = null; };
  }
}
