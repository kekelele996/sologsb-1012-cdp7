/**
 * 三路合并引擎：以冻结版本（base）为基准，合并两位老师各自的离线副本（A / B）。
 *
 * 合并规则：
 * - 先分别列出 A、B 相对冻结版本改了什么（项目级字段、模块、步骤）。
 * - 同一对象不同字段的改动自动并入同一结果。
 * - 同一字段两边都改且值不同 → 字段冲突，保留 A/B 两版由老师挑一个。
 * - 一边删除对象、另一边仍在编辑它 → 保留对象并生成“删除 vs 修改”冲突，不直接丢。
 * - 模块与步骤的顺序用 diff3（基于稳定 id 的 LCS）对齐，
 *   稳定段自动采用，双方在同一位置的增删互不一致时 → 顺序冲突，老师挑一边或自定义。
 */

import type { CourseModule, FrozenVersion, LessonStep } from '../models';

/** 课程快照：冻结版本与离线副本都使用这个结构（不含 frozenVersions 自身）。 */
export type CourseSnapshot = Omit<import('../models').CourseProject, 'frozenVersions'>;

export type Side = 'a' | 'b';
/** 某一侧对某个字段 / 某个对象的处置。 */
export type EntityPresence = 'unchanged' | 'modified' | 'added' | 'deleted';

export interface OfflineCopy {
  /** 导出副本的老师姓名，仅用于界面展示。 */
  teacherName: string;
  /** 导出时的备注（设备 / 时间等）。 */
  note?: string;
  exportedAt: string;
  /** 所基于的冻结版本 id；为空表示不指定（由老师在合并界面选择基准）。 */
  baseFrozenId?: string;
  snapshot: CourseSnapshot;
}

// ---------------------------------------------------------------------------
// 字段差异
// ---------------------------------------------------------------------------

export interface FieldDiff {
  key: string;
  baseValue: unknown;
  aValue: unknown;
  bValue: unknown;
  aChanged: boolean;
  bChanged: boolean;
  /** 两边都改且改成了不同的值 → 需要老师二选一。 */
  conflict: boolean;
}

export const PROJECT_FIELDS = ['title', 'teacher', 'audience'] as const;
export const MODULE_FIELDS = ['title', 'summary', 'color'] as const;
export const STEP_FIELDS = [
  'title', 'kind', 'duration', 'demoTitle', 'demoUrl', 'handshape', 'gestureZone',
  'caption', 'captionPosition', 'camera', 'commonMistakes', 'exercise',
  'exerciseFeedback', 'altText', 'prerequisiteId', 'difficulty', 'cuePoints',
] as const;

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

function diffFields(keys: readonly string[], base: Record<string, unknown> | undefined, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): FieldDiff[] {
  const result: FieldDiff[] = [];
  for (const key of keys) {
    const baseValue = base ? base[key] : undefined;
    const aValue = a ? a[key] : baseValue;
    const bValue = b ? b[key] : baseValue;
    const aChanged = a !== undefined && !deepEqual(aValue, baseValue);
    const bChanged = b !== undefined && !deepEqual(bValue, baseValue);
    if (!aChanged && !bChanged) continue;
    result.push({
      key,
      baseValue,
      aValue,
      bValue,
      aChanged,
      bChanged,
      conflict: aChanged && bChanged && !deepEqual(aValue, bValue),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 顺序合并（diff3 on stable ids）
// ---------------------------------------------------------------------------

export interface OrderHunk {
  id: string;
  /** 稳定段（双方一致）时给出 id；冲突段为 null。 */
  stableId: string | null;
  baseIds: string[];
  aIds: string[];
  bIds: string[];
  conflict: boolean;
  /** 非冲突段自动采用的 id 序列（稳定段 / 双方一致段 / 仅删除段的存活者）。 */
  autoIds: string[];
}

export type HunkResolution =
  | { kind: 'keep-a' }
  | { kind: 'keep-b' }
  | { kind: 'union' }
  | { kind: 'custom'; ids: string[] };

/** 最长公共子序列（序列中的 id 视为唯一），返回配对索引。 */
function lcsPairs(left: string[], right: string[]): Array<[number, number]> {
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * diff3：把 base 相对 A、B 的 id 序列切成稳定段 / 自动合并段 / 冲突段。
 *
 * 经典三路合并语义：
 * - 只有一方改动该段 → 自动采用改动方（包括只有一方换位、插入或删除）；
 * - 双方都没动 → 稳定段；
 * - 双方改动结果一致 → 自动收敛；
 * - 双方都改且结果不同（同位置插入不同 id、各自不同的换位等）→ 顺序冲突。
 */
export function diff3Order(baseIds: string[], aIds: string[], bIds: string[]): OrderHunk[] {
  const aPairs = lcsPairs(baseIds, aIds);
  const bPairs = lcsPairs(baseIds, bIds);
  const aPosOfBase = new Map<number, number>(aPairs.map(([x, y]) => [x, y]));
  const bPosOfBase = new Map<number, number>(bPairs.map(([x, y]) => [x, y]));

  // 同步点：base 中同时与 A、B 配对的元素；LCS 配对在各自一侧天然单调。
  const syncs: Array<{ basePos: number; aPos: number; bPos: number }> = [];
  for (let i = 0; i < baseIds.length; i += 1) {
    const aPos = aPosOfBase.get(i);
    const bPos = bPosOfBase.get(i);
    if (aPos !== undefined && bPos !== undefined) syncs.push({ basePos: i, aPos, bPos });
  }

  const hunks: OrderHunk[] = [];
  let hunkSeq = 0;

  const emit = (
    baseChunk: string[],
    aChunk: string[],
    bChunk: string[],
    stableSyncId: string | null,
  ): void => {
    if (!stableSyncId && baseChunk.length === 0 && aChunk.length === 0 && bChunk.length === 0) return;
    if (stableSyncId) {
      hunks.push({ id: `stable-${stableSyncId}`, stableId: stableSyncId, baseIds: baseChunk, aIds: aChunk, bIds: bChunk, conflict: false, autoIds: baseChunk });
      return;
    }
    hunkSeq += 1;
    const aChanged = !deepEqual(aChunk, baseChunk);
    const bChanged = !deepEqual(bChunk, baseChunk);
    let conflict = false;
    let autoIds = baseChunk;
    if (!aChanged && !bChanged) autoIds = baseChunk;
    else if (!aChanged) autoIds = bChunk;
    else if (!bChanged) autoIds = aChunk;
    else if (deepEqual(aChunk, bChunk)) autoIds = aChunk;
    else conflict = true;
    hunks.push({ id: `hunk-${hunkSeq}`, stableId: null, baseIds: baseChunk, aIds: aChunk, bIds: bChunk, conflict, autoIds });
  };

  let prevBase = -1;
  let prevA = -1;
  let prevB = -1;
  for (const sync of syncs) {
    // 上一个同步点之后、当前同步点之前的区域（端点不含）。
    emit(
      baseIds.slice(prevBase + 1, sync.basePos),
      aIds.slice(prevA + 1, sync.aPos),
      bIds.slice(prevB + 1, sync.bPos),
      null,
    );
    emit([baseIds[sync.basePos]], [aIds[sync.aPos]], [bIds[sync.bPos]], baseIds[sync.basePos]);
    prevBase = sync.basePos;
    prevA = sync.aPos;
    prevB = sync.bPos;
  }
  // 尾部区域。
  emit(baseIds.slice(prevBase + 1), aIds.slice(prevA + 1), bIds.slice(prevB + 1), null);
  return hunks;
}

// ---------------------------------------------------------------------------
// 对象级合并结构
// ---------------------------------------------------------------------------

export interface EntityRef {
  id: string;
  title: string;
}

export interface StepMerge {
  id: string;
  base: LessonStep | undefined;
  a: LessonStep | undefined;
  b: LessonStep | undefined;
  aPresence: EntityPresence;
  bPresence: EntityPresence;
  fieldDiffs: FieldDiff[];
  /** 删除 vs 修改冲突（同时也含“删除 vs 新增不同值”等形态）。 */
  presenceConflict: boolean;
}

export interface ModuleMerge {
  id: string;
  base: CourseModule | undefined;
  a: CourseModule | undefined;
  b: CourseModule | undefined;
  aPresence: EntityPresence;
  bPresence: EntityPresence;
  fieldDiffs: FieldDiff[];
  presenceConflict: boolean;
  steps: StepMerge[];
  stepOrderHunks: OrderHunk[];
}

export interface MergeReport {
  frozenId: string;
  frozenLabel: string;
  frozenCreatedAt: string;
  frozen: CourseSnapshot;
  aCopy: OfflineCopy;
  bCopy: OfflineCopy;
  projectDiffs: FieldDiff[];
  modules: ModuleMerge[];
  moduleOrderHunks: OrderHunk[];
  conflictCount: number;
  warnings: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 解析（resolution）与计算结果
// ---------------------------------------------------------------------------

export interface MergeResolutions {
  /** 字段冲突：'a' | 'b'。 */
  fields: Record<string, Side>;
  /** 对象存在性冲突（删除 vs 修改 等）：保留或删除。 */
  entities: Record<string, 'keep' | 'drop'>;
  /** 顺序冲突段。 */
  order: Record<string, HunkResolution>;
}

export function emptyResolutions(): MergeResolutions {
  return { fields: {}, entities: {}, order: {} };
}

export function fieldConflictKey(scope: string, entityId: string, fieldKey: string): string {
  return `${scope}:${entityId}:${fieldKey}`;
}

export function entityConflictKey(_scope: 'module' | 'step', moduleId: string, stepId?: string): string {
  return stepId ? `step:${moduleId}:${stepId}` : `module:${moduleId}`;
}

// ---------------------------------------------------------------------------
// 构建合并报告
// ---------------------------------------------------------------------------

function indexById<T>(list: T[] | undefined, getId: (item: T) => string): Map<string, T> {
  return new Map((list ?? []).map((item) => [getId(item), item]));
}

function presence<T>(
  id: string,
  base: Map<string, T>,
  side: Map<string, T>,
): EntityPresence {
  if (!base.has(id)) return side.has(id) ? 'added' : 'unchanged';
  return side.has(id) ? 'modified' : 'deleted';
}

function mergeSteps(
  baseSteps: LessonStep[],
  aSteps: LessonStep[] | undefined,
  bSteps: LessonStep[] | undefined,
): { steps: StepMerge[]; hunks: OrderHunk[] } {
  const baseMap = indexById(baseSteps, (item) => item.id);
  const aMap = indexById(aSteps, (item) => item.id);
  const bMap = indexById(bSteps, (item) => item.id);

  // 出现过的步骤 id（冻结版 ∪ A ∪ B），顺序冲突中出现但已被双方删除的 id 随后会被过滤。
  const allIds: string[] = [];
  for (const step of baseSteps) if (!allIds.includes(step.id)) allIds.push(step.id);
  for (const id of aMap.keys()) if (!allIds.includes(id)) allIds.push(id);
  for (const id of bMap.keys()) if (!allIds.includes(id)) allIds.push(id);

  const steps: StepMerge[] = allIds.map((id) => {
    const baseStep = baseMap.get(id);
    const aStep = aMap.get(id);
    const bStep = bMap.get(id);
    const aPresence = presence(id, baseMap, aMap);
    const bPresence = presence(id, baseMap, bMap);

    const fieldDiffs = baseStep
      ? diffFields(STEP_FIELDS, baseStep as unknown as Record<string, unknown>, aStep as unknown as Record<string, unknown>, bStep as unknown as Record<string, unknown>)
      : (aStep && bStep
        ? diffFields(STEP_FIELDS, undefined, aStep as unknown as Record<string, unknown>, bStep as unknown as Record<string, unknown>)
        : []);

    const deletedVsEdited =
      (aPresence === 'deleted' && (bPresence === 'modified' || bPresence === 'added')) ||
      (bPresence === 'deleted' && (aPresence === 'modified' || aPresence === 'added'));

    return {
      id,
      base: baseStep,
      a: aStep,
      b: bStep,
      aPresence,
      bPresence,
      fieldDiffs,
      presenceConflict: deletedVsEdited,
    };
  });

  // 顺序：模块在该侧被整体删除时按冻结版顺序参与对齐，
  // 避免“删模块”在每个步骤上制造出无意义的顺序冲突（真正的冲突在模块存在性层面记录）。
  const hunks = diff3Order(
    baseSteps.map((step) => step.id),
    (aSteps ?? baseSteps).map((step) => step.id),
    (bSteps ?? baseSteps).map((step) => step.id),
  );

  return { steps, hunks };
}

export interface BuildReportInput {
  frozen: FrozenVersion;
  aCopy: OfflineCopy;
  bCopy: OfflineCopy;
}

export function buildMergeReport(input: BuildReportInput): MergeReport {
  const { frozen, aCopy, bCopy } = input;
  const base = frozen.snapshot;
  const aSnap = aCopy.snapshot;
  const bSnap = bCopy.snapshot;
  const warnings: string[] = [];

  if (aCopy.baseFrozenId && aCopy.baseFrozenId !== frozen.id) {
    warnings.push(`甲方副本基于另一个冻结版本（${aCopy.baseFrozenId}），当前以「${frozen.label}」为基准，请人工确认。`);
  }
  if (bCopy.baseFrozenId && bCopy.baseFrozenId !== frozen.id) {
    warnings.push(`乙方副本基于另一个冻结版本（${bCopy.baseFrozenId}），当前以「${frozen.label}」为基准，请人工确认。`);
  }

  // 项目级字段。
  const projectDiffs = diffFields(
    PROJECT_FIELDS,
    base as unknown as Record<string, unknown>,
    aSnap as unknown as Record<string, unknown>,
    bSnap as unknown as Record<string, unknown>,
  );

  // 模块。
  const baseModules = indexById(base.modules, (item) => item.id);
  const aModules = indexById(aSnap.modules, (item) => item.id);
  const bModules = indexById(bSnap.modules, (item) => item.id);
  const moduleIds: string[] = [];
  for (const module of base.modules) if (!moduleIds.includes(module.id)) moduleIds.push(module.id);
  for (const id of aModules.keys()) if (!moduleIds.includes(id)) moduleIds.push(id);
  for (const id of bModules.keys()) if (!moduleIds.includes(id)) moduleIds.push(id);

  const modules: ModuleMerge[] = moduleIds.map((id) => {
    const baseModule = baseModules.get(id);
    const aModule = aModules.get(id);
    const bModule = bModules.get(id);
    const aPresence = presence(id, baseModules, aModules);
    const bPresence = presence(id, baseModules, bModules);

    const fieldDiffs = baseModule
      ? diffFields(MODULE_FIELDS, baseModule as unknown as Record<string, unknown>, aModule as unknown as Record<string, unknown>, bModule as unknown as Record<string, unknown>)
      : (aModule && bModule
        ? diffFields(MODULE_FIELDS, undefined, aModule as unknown as Record<string, unknown>, bModule as unknown as Record<string, unknown>)
        : []);

    const presenceConflict =
      (aPresence === 'deleted' && (bPresence === 'modified' || bPresence === 'added')) ||
      (bPresence === 'deleted' && (aPresence === 'modified' || aPresence === 'added'));

    // 模块被一侧删除、另一侧编辑：删除侧的步骤视为缺席（undefined），
    // 步骤的存在性/字段差异照常比对，最终是否保留由模块存在性冲突的决定统辖。
    const aStepsForMerge = aPresence === 'deleted' ? undefined : aModule?.steps;
    const bStepsForMerge = bPresence === 'deleted' ? undefined : bModule?.steps;
    const { steps, hunks } = mergeSteps(baseModule?.steps ?? [], aStepsForMerge, bStepsForMerge);

    return { id, base: baseModule, a: aModule, b: bModule, aPresence, bPresence, fieldDiffs, presenceConflict, steps, stepOrderHunks: hunks };
  });

  const moduleOrderHunks = diff3Order(
    base.modules.map((module) => module.id),
    aSnap.modules.map((module) => module.id),
    bSnap.modules.map((module) => module.id),
  );

  let conflictCount = projectDiffs.filter((diff) => diff.conflict).length;
  for (const module of modules) {
    if (module.presenceConflict) conflictCount += 1;
    conflictCount += module.fieldDiffs.filter((diff) => diff.conflict).length;
    for (const step of module.steps) {
      if (step.presenceConflict) conflictCount += 1;
      conflictCount += step.fieldDiffs.filter((diff) => diff.conflict).length;
    }
    conflictCount += module.stepOrderHunks.filter((hunk) => hunk.conflict).length;
  }
  conflictCount += moduleOrderHunks.filter((hunk) => hunk.conflict).length;

  return {
    frozenId: frozen.id,
    frozenLabel: frozen.label,
    frozenCreatedAt: frozen.createdAt,
    frozen: base,
    aCopy,
    bCopy,
    projectDiffs,
    modules,
    moduleOrderHunks,
    conflictCount,
    warnings,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 根据报告 + 解析，计算合并快照
// ---------------------------------------------------------------------------

function resolveFieldValue(diff: FieldDiff, scope: string, entityId: string, resolutions: MergeResolutions): unknown {
  if (!diff.conflict) {
    // 自动合并：谁改了取谁的；都改了且值相同取任一侧。
    return diff.aChanged ? diff.aValue : diff.bValue;
  }
  const winner = resolutions.fields[fieldConflictKey(scope, entityId, diff.key)];
  return winner === 'b' ? diff.bValue : diff.aValue;
}

function resolveHunkIds(hunk: OrderHunk, resolutions: MergeResolutions): string[] {
  if (!hunk.conflict) return hunk.autoIds;
  const resolution = resolutions.order[hunk.id] ?? { kind: 'keep-a' };
  if (resolution.kind === 'keep-a') return hunk.aIds;
  if (resolution.kind === 'keep-b') return hunk.bIds;
  if (resolution.kind === 'union') {
    const merged = [...hunk.aIds];
    for (const id of hunk.bIds) if (!merged.includes(id)) merged.push(id);
    return merged;
  }
  return resolution.ids;
}

export function isResolutionComplete(report: MergeReport, resolutions: MergeResolutions): boolean {
  for (const diff of report.projectDiffs) {
    if (diff.conflict && !resolutions.fields[fieldConflictKey('project', 'course', diff.key)]) return false;
  }
  for (const module of report.modules) {
    const moduleDropped = module.presenceConflict && resolutions.entities[entityConflictKey('module', module.id)] === 'drop';
    if (module.presenceConflict && !resolutions.entities[entityConflictKey('module', module.id)]) return false;
    if (moduleDropped) continue; // 模块确认删除后，其内部冲突不再需要裁决。
    for (const diff of module.fieldDiffs) {
      if (diff.conflict && !resolutions.fields[fieldConflictKey('module', module.id, diff.key)]) return false;
    }
    for (const step of module.steps) {
      const stepDropped = step.presenceConflict && resolutions.entities[entityConflictKey('step', module.id, step.id)] === 'drop';
      if (step.presenceConflict && !resolutions.entities[entityConflictKey('step', module.id, step.id)]) return false;
      if (stepDropped) continue; // 步骤确认删除后，其字段冲突不再需要裁决。
      for (const diff of step.fieldDiffs) {
        if (diff.conflict && !resolutions.fields[fieldConflictKey('step', step.id, diff.key)]) return false;
      }
    }
    for (const hunk of module.stepOrderHunks) {
      if (hunk.conflict && !resolutions.order[hunk.id]) return false;
    }
  }
  for (const hunk of report.moduleOrderHunks) {
    if (hunk.conflict && !resolutions.order[hunk.id]) return false;
  }
  return true;
}

export function unresolvedCount(report: MergeReport, resolutions: MergeResolutions): number {
  let total = 0;
  for (const diff of report.projectDiffs) {
    if (diff.conflict && !resolutions.fields[fieldConflictKey('project', 'course', diff.key)]) total += 1;
  }
  for (const module of report.modules) {
    const moduleDropped = module.presenceConflict && resolutions.entities[entityConflictKey('module', module.id)] === 'drop';
    if (module.presenceConflict && !resolutions.entities[entityConflictKey('module', module.id)]) total += 1;
    if (moduleDropped) continue;
    for (const diff of module.fieldDiffs) {
      if (diff.conflict && !resolutions.fields[fieldConflictKey('module', module.id, diff.key)]) total += 1;
    }
    for (const step of module.steps) {
      const stepDropped = step.presenceConflict && resolutions.entities[entityConflictKey('step', module.id, step.id)] === 'drop';
      if (step.presenceConflict && !resolutions.entities[entityConflictKey('step', module.id, step.id)]) total += 1;
      if (stepDropped) continue;
      for (const diff of step.fieldDiffs) {
        if (diff.conflict && !resolutions.fields[fieldConflictKey('step', step.id, diff.key)]) total += 1;
      }
    }
    for (const hunk of module.stepOrderHunks) {
      if (hunk.conflict && !resolutions.order[hunk.id]) total += 1;
    }
  }
  for (const hunk of report.moduleOrderHunks) {
    if (hunk.conflict && !resolutions.order[hunk.id]) total += 1;
  }
  return total;
}

function moduleKept(module: ModuleMerge, resolutions: MergeResolutions): boolean {
  if (!module.presenceConflict) {
    // 双方一致删除 → 删除；其他（修改/新增/未变）→ 保留。
    if (module.aPresence === 'deleted' && module.bPresence === 'deleted') return false;
    return true;
  }
  // 存在性冲突：老师未决定前默认保留（删除 vs 修改，先不丢）。
  return resolutions.entities[entityConflictKey('module', module.id)] !== 'drop';
}

function stepKept(step: StepMerge, moduleId: string, resolutions: MergeResolutions): boolean {
  if (!step.presenceConflict) {
    if (step.aPresence === 'deleted' && step.bPresence === 'deleted') return false;
    return true;
  }
  return resolutions.entities[entityConflictKey('step', moduleId, step.id)] !== 'drop';
}

function buildStep(step: StepMerge, resolutions: MergeResolutions): LessonStep {
  const source = (step.a ?? step.b ?? step.base) as LessonStep;
  const merged: Record<string, unknown> = { ...source };
  for (const diff of step.fieldDiffs) {
    merged[diff.key] = resolveFieldValue(diff, 'step', step.id, resolutions);
  }
  return merged as unknown as LessonStep;
}

function buildModule(module: ModuleMerge, resolutions: MergeResolutions, keptIds: Set<string>): CourseModule | undefined {
  const source = (module.a ?? module.b ?? module.base) as CourseModule;
  const merged: Record<string, unknown> = { ...source, steps: [] };
  for (const diff of module.fieldDiffs) {
    merged[diff.key] = resolveFieldValue(diff, 'module', module.id, resolutions);
  }

  const stepById = new Map(module.steps.map((step) => [step.id, step]));
  const orderedIds: string[] = [];
  for (const hunk of module.stepOrderHunks) {
    const ids = resolveHunkIds(hunk, resolutions);
    for (const id of ids) if (!orderedIds.includes(id)) orderedIds.push(id);
    // 兜底：存在性裁决为保留、但没出现在所选顺序里的步骤（如“删 vs 改”中保留乙方修改），
    // 按另一侧的次序补在本冲突段末尾，保证保留的步骤绝不因顺序选择而丢失。
    for (const id of [...hunk.aIds, ...hunk.bIds]) {
      if (keptIds.has(id) && !orderedIds.includes(id) && stepById.has(id)) orderedIds.push(id);
    }
  }
  const steps: LessonStep[] = [];
  for (const id of orderedIds) {
    if (!keptIds.has(id)) continue;
    const step = stepById.get(id);
    if (step) steps.push(buildStep(step, resolutions));
  }
  merged.steps = steps;
  return merged as unknown as CourseModule;
}

/** 计算合并后的课程快照；存在未解决冲突时未决项使用保守默认值（删除 vs 修改默认保留、字段默认取 A）。 */
export function buildMergedSnapshot(report: MergeReport, resolutions: MergeResolutions): CourseSnapshot {
  const mergedProject: Record<string, unknown> = { ...report.frozen };
  for (const diff of report.projectDiffs) {
    mergedProject[diff.key] = resolveFieldValue(diff, 'project', 'course', resolutions);
  }

  const keptModules = new Map<string, boolean>();
  const keptStepsByModule = new Map<string, Set<string>>();
  for (const module of report.modules) {
    const kept = moduleKept(module, resolutions);
    keptModules.set(module.id, kept);
    if (kept) {
      keptStepsByModule.set(module.id, new Set(module.steps.filter((step) => stepKept(step, module.id, resolutions)).map((step) => step.id)));
    }
  }

  const orderedModuleIds: string[] = [];
  for (const hunk of report.moduleOrderHunks) {
    const ids = resolveHunkIds(hunk, resolutions);
    for (const id of ids) if (!orderedModuleIds.includes(id)) orderedModuleIds.push(id);
    // 兜底：被保留但不在所选顺序里的模块补在冲突段末尾。
    for (const id of [...hunk.aIds, ...hunk.bIds]) {
      if (keptModules.get(id) && !orderedModuleIds.includes(id)) orderedModuleIds.push(id);
    }
  }
  // 兜底：顺序段里没有覆盖到的新模块（理论上不会出现）按报告顺序补在末尾。
  for (const module of report.modules) {
    if (keptModules.get(module.id) && !orderedModuleIds.includes(module.id)) orderedModuleIds.push(module.id);
  }

  const modules: CourseModule[] = [];
  for (const id of orderedModuleIds) {
    const module = report.modules.find((item) => item.id === id);
    if (!module || !keptModules.get(id)) continue;
    const built = buildModule(module, resolutions, keptStepsByModule.get(id) ?? new Set());
    if (built) modules.push(built);
  }
  mergedProject.modules = modules;

  return mergedProject as unknown as CourseSnapshot;
}

// ---------------------------------------------------------------------------
// 变更清单辅助（供界面“先列出两边各自改了什么”）
// ---------------------------------------------------------------------------

export interface ChangeEntry {
  scope: 'project' | 'module' | 'step';
  moduleId: string;
  stepId?: string;
  entityTitle: string;
  fieldLabel: string;
  side: Side;
  from: unknown;
  to: unknown;
  presence?: EntityPresence;
}

export function listSideChanges(report: MergeReport, side: Side): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  const pushField = (
    scope: 'project' | 'module' | 'step',
    moduleId: string,
    entityTitle: string,
    diff: FieldDiff,
    stepId?: string,
  ): void => {
    const changed = side === 'a' ? diff.aChanged : diff.bChanged;
    if (!changed) return;
    entries.push({
      scope,
      moduleId,
      stepId,
      entityTitle,
      fieldLabel: diff.key,
      side,
      from: diff.baseValue,
      to: side === 'a' ? diff.aValue : diff.bValue,
    });
  };

  for (const diff of report.projectDiffs) pushField('project', '', '课程信息', diff);

  for (const module of report.modules) {
    const sidePresence = side === 'a' ? module.aPresence : module.bPresence;
    const sideEntity = side === 'a' ? module.a : module.b;
    const moduleTitle = module.base?.title ?? sideEntity?.title ?? module.id;
    if (sidePresence === 'added' || sidePresence === 'deleted') {
      entries.push({ scope: 'module', moduleId: module.id, entityTitle: moduleTitle, fieldLabel: '模块', side, from: sidePresence === 'deleted' ? '存在' : undefined, to: sidePresence === 'added' ? '新增模块' : '已删除', presence: sidePresence });
    }
    for (const diff of module.fieldDiffs) pushField('module', module.id, moduleTitle, diff);

    for (const step of module.steps) {
      const stepPresence = side === 'a' ? step.aPresence : step.bPresence;
      const stepEntity = side === 'a' ? step.a : step.b;
      const stepTitle = step.base?.title ?? stepEntity?.title ?? step.id;
      if (stepPresence === 'added' || stepPresence === 'deleted') {
        entries.push({ scope: 'step', moduleId: module.id, stepId: step.id, entityTitle: stepTitle, fieldLabel: '步骤', side, from: stepPresence === 'deleted' ? '存在' : undefined, to: stepPresence === 'added' ? '新增步骤' : '已删除', presence: stepPresence });
      }
      for (const diff of step.fieldDiffs) pushField('step', module.id, stepTitle, diff, step.id);
    }
  }
  return entries;
}
