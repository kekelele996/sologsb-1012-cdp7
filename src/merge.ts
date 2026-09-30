import { cloneProject, type CourseModule, type CourseProject, type FrozenVersion, type LessonStep } from './models';

export type MergeSideId = 'A' | 'B';

export const MERGE_RECORDS_KEY = 'sologsb-1012-merge-records-v1';

export const PROJECT_FIELDS = ['title', 'teacher', 'audience'] as const;
export const MODULE_FIELDS = ['title', 'summary', 'color'] as const;
export const STEP_FIELDS = [
  'title',
  'kind',
  'duration',
  'demoTitle',
  'demoUrl',
  'handshape',
  'gestureZone',
  'caption',
  'captionPosition',
  'camera',
  'commonMistakes',
  'exercise',
  'exerciseFeedback',
  'altText',
  'prerequisiteId',
  'difficulty',
  'cuePoints',
] as const;

export const FIELD_LABELS: Record<string, string> = {
  title: '课程标题',
  teacher: '授课教师',
  audience: '适用学员',
  summary: '模块目标',
  color: '主题色',
  kind: '步骤类型',
  duration: '预计时长',
  demoTitle: '示范片段名称',
  demoUrl: '本地素材地址',
  handshape: '手形说明',
  gestureZone: '主要手形区域',
  caption: '步骤字幕',
  captionPosition: '字幕位置',
  camera: '镜头角度',
  commonMistakes: '常见错误',
  exercise: '练习任务',
  exerciseFeedback: '练习反馈',
  altText: '替代文本',
  prerequisiteId: '前置条件',
  difficulty: '难度标签',
  cuePoints: '检查点',
};

export interface MergeFieldChange {
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  aValue: unknown;
  bValue: unknown;
}

export interface MergeChangeGroup {
  scope: 'project' | 'module' | 'step';
  moduleId?: string;
  moduleTitle?: string;
  stepId?: string;
  stepTitle?: string;
  action: 'added' | 'deleted' | 'modified';
  fields: MergeFieldChange[];
}

export interface MergeConflict {
  key: string;
  kind: 'field' | 'delete-modify' | 'order';
  scope: 'project' | 'module' | 'step';
  moduleId?: string;
  stepId?: string;
  /** 冲突定位，如「模块一 · 日常问候 ＞ 步骤 …」 */
  title: string;
  field?: string;
  fieldLabel?: string;
  baseValue?: unknown;
  aValue?: unknown;
  bValue?: unknown;
  deletedBy?: MergeSideId;
  modifiedBy?: MergeSideId;
  /** 顺序冲突时的三档选项 */
  orderOptions?: { value: 'base' | 'A' | 'B'; label: string }[];
}

export interface MergeStats {
  autoMerged: number;
  fieldConflicts: number;
  deleteModify: number;
  orderConflicts: number;
  added: number;
  deleted: number;
  unchanged: number;
}

export interface MergeComputation {
  ok: boolean;
  reason?: string;
  base?: CourseProject;
  baseLabel?: string;
  a?: CourseProject;
  b?: CourseProject;
  changesA: MergeChangeGroup[];
  changesB: MergeChangeGroup[];
  conflicts: MergeConflict[];
  stats: MergeStats;
}

export interface MergeRecord {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'applied' | 'failed';
  failureReason?: string;
  rawA: string;
  rawB: string;
  sideAName: string;
  sideBName: string;
  baseId?: string;
  baseLabel?: string;
  baseSnapshot?: CourseProject;
  sideASnapshot?: CourseProject;
  sideBSnapshot?: CourseProject;
  /** key -> 'A' | 'B' | 'keep' | 'base' */
  resolutions: Record<string, string>;
  mergedSnapshot?: CourseProject;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function displayValue(value: unknown): string {
  if (isEmptyValue(value)) return '（空）';
  if (Array.isArray(value)) return value.map(String).join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function fieldKey(scope: 'project' | 'module' | 'step', moduleId: string, stepId: string, field: string): string {
  return `field::${scope}::${moduleId}::${stepId}::${field}`;
}

export function deleteKey(moduleId: string, stepId: string): string {
  return `delete::${moduleId}::${stepId}`;
}

export function orderKey(moduleId: string): string {
  return `order::${moduleId}`;
}

function moduleTitle(project: CourseProject, moduleId: string): string {
  return project.modules.find((item) => item.id === moduleId)?.title ?? moduleId;
}

function stepTitle(project: CourseProject, moduleId: string, stepId: string): string {
  return moduleTitle(project, moduleId) + ' ＞ ' + (project.modules.find((item) => item.id === moduleId)?.steps.find((item) => item.id === stepId)?.title ?? stepId);
}

/** 三方字段比对：返回自动合并项与冲突项 */
function diffFields(
  base: Record<string, unknown>,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: readonly string[],
  context: { scope: 'project' | 'module' | 'step'; moduleId: string; stepId: string; title: string },
): { changes: MergeFieldChange[]; conflicts: MergeConflict[]; autoMerged: number } {
  const changes: MergeFieldChange[] = [];
  const conflicts: MergeConflict[] = [];
  let autoMerged = 0;

  fields.forEach((field) => {
    const baseValue = base[field];
    const aValue = a[field];
    const bValue = b[field];
    if (equalValue(aValue, bValue)) return; // 两边一致（含都没改）
    const aChanged = !equalValue(aValue, baseValue);
    const bChanged = !equalValue(bValue, baseValue);
    if (!aChanged || !bChanged) {
      // 只有一边改了：自动并入
      autoMerged += 1;
      changes.push({ field, fieldLabel: FIELD_LABELS[field] ?? field, baseValue, aValue, bValue });
      return;
    }
    // 两边都改了且不一致：保留两版让老师挑
    changes.push({ field, fieldLabel: FIELD_LABELS[field] ?? field, baseValue, aValue, bValue });
    conflicts.push({
      key: fieldKey(context.scope, context.moduleId, context.stepId, field),
      kind: 'field',
      scope: context.scope,
      moduleId: context.moduleId || undefined,
      stepId: context.stepId || undefined,
      title: context.title,
      field,
      fieldLabel: FIELD_LABELS[field] ?? field,
      baseValue,
      aValue,
      bValue,
    });
  });

  return { changes, conflicts, autoMerged };
}

function stepFields(project: CourseProject, moduleId: string, stepId: string): Record<string, unknown> {
  const step = project.modules.find((m) => m.id === moduleId)?.steps.find((s) => s.id === stepId);
  return (step ?? {}) as unknown as Record<string, unknown>;
}

function moduleFields(project: CourseProject, moduleId: string): Record<string, unknown> {
  return (project.modules.find((m) => m.id === moduleId) ?? {}) as unknown as Record<string, unknown>;
}

function projectFields(project: CourseProject): Record<string, unknown> {
  return project as unknown as Record<string, unknown>;
}

function stepModifiedSince(base: CourseProject, a: CourseProject, moduleId: string, stepId: string): boolean {
  const baseStep = stepFields(base, moduleId, stepId);
  const aStep = stepFields(a, moduleId, stepId);
  if (!baseStep || !aStep) return false;
  return STEP_FIELDS.some((field) => !equalValue(baseStep[field], aStep[field]));
}

function moduleModifiedSince(base: CourseProject, a: CourseProject, moduleId: string): boolean {
  const baseModule = base.modules.find((m) => m.id === moduleId);
  const aModule = a.modules.find((m) => m.id === moduleId);
  if (!baseModule || !aModule) return false;
  if (MODULE_FIELDS.some((field) => !equalValue((baseModule as unknown as Record<string, unknown>)[field], (aModule as unknown as Record<string, unknown>)[field]))) return true;
  if (baseModule.steps.length !== aModule.steps.length) return true;
  const aStepIds = new Set(aModule.steps.map((s) => s.id));
  const baseStepIds = new Set(baseModule.steps.map((s) => s.id));
  if (baseModule.steps.some((s) => !aStepIds.has(s.id))) return true;
  if (aModule.steps.some((s) => !baseStepIds.has(s.id))) return true;
  return baseModule.steps.some((s) => {
    const other = aModule.steps.find((item) => item.id === s.id);
    if (!other) return false;
    return STEP_FIELDS.some((field) => !equalValue((s as unknown as Record<string, unknown>)[field], (other as unknown as Record<string, unknown>)[field]));
  });
}

/* ------------------------------------------------------------------ */
/* 三方合并计算                                                        */
/* ------------------------------------------------------------------ */

export function computeMerge(base: CourseProject, a: CourseProject, b: CourseProject): MergeComputation {
  const changesA: MergeChangeGroup[] = [];
  const changesB: MergeChangeGroup[] = [];
  const conflicts: MergeConflict[] = [];
  const stats: MergeStats = { autoMerged: 0, fieldConflicts: 0, deleteModify: 0, orderConflicts: 0, added: 0, deleted: 0, unchanged: 0 };

  const bump = (group: MergeChangeGroup, side: MergeSideId): void => {
    (side === 'A' ? changesA : changesB).push(group);
  };

  // 1. 课程级字段
  const projectDiff = diffFields(projectFields(base), projectFields(a), projectFields(b), PROJECT_FIELDS, {
    scope: 'project',
    moduleId: '',
    stepId: '',
    title: '课程信息',
  });
  stats.autoMerged += projectDiff.autoMerged;
  conflicts.push(...projectDiff.conflicts);
  if (projectDiff.changes.some((c) => !equalValue(c.aValue, c.baseValue))) {
    bump({ scope: 'project', action: 'modified', fields: projectDiff.changes.filter((c) => !equalValue(c.aValue, c.baseValue)) }, 'A');
  }
  if (projectDiff.changes.some((c) => !equalValue(c.bValue, c.baseValue))) {
    bump({ scope: 'project', action: 'modified', fields: projectDiff.changes.filter((c) => !equalValue(c.bValue, c.baseValue)) }, 'B');
  }

  // 2. 模块：以冻结版顺序为基准，追加两边新增
  const baseModuleIds = base.modules.map((m) => m.id);
  const aModuleIds = a.modules.map((m) => m.id);
  const bModuleIds = b.modules.map((m) => m.id);
  const allModuleIds = [
    ...baseModuleIds,
    ...aModuleIds.filter((id) => !baseModuleIds.includes(id) && !bModuleIds.includes(id)),
    ...bModuleIds.filter((id) => !baseModuleIds.includes(id)),
  ];

  const mergedModuleOrder: string[] = [];

  allModuleIds.forEach((moduleId) => {
    const inBase = baseModuleIds.includes(moduleId);
    const inA = aModuleIds.includes(moduleId);
    const inB = bModuleIds.includes(moduleId);
    const aModule = a.modules.find((m) => m.id === moduleId);
    const bModule = b.modules.find((m) => m.id === moduleId);
    const baseModule = base.modules.find((m) => m.id === moduleId);

    if (inA && inB) {
      mergedModuleOrder.push(moduleId);
      // 模块字段
      const moduleDiff = diffFields(
        moduleFields(base, moduleId),
        moduleFields(a, moduleId),
        moduleFields(b, moduleId),
        MODULE_FIELDS,
        { scope: 'module', moduleId, stepId: '', title: `模块「${moduleTitle(base, moduleId)}」` },
      );
      stats.autoMerged += moduleDiff.autoMerged;
      conflicts.push(...moduleDiff.conflicts);
      const aModuleFields = moduleDiff.changes.filter((c) => !equalValue(c.aValue, c.baseValue));
      const bModuleFields = moduleDiff.changes.filter((c) => !equalValue(c.bValue, c.baseValue));
      if (aModuleFields.length) bump({ scope: 'module', moduleId, moduleTitle: aModule?.title, action: 'modified', fields: aModuleFields }, 'A');
      if (bModuleFields.length) bump({ scope: 'module', moduleId, moduleTitle: bModule?.title, action: 'modified', fields: bModuleFields }, 'B');

      // 步骤
      const baseStepIds = baseModule?.steps.map((s) => s.id) ?? [];
      const aStepIds = aModule?.steps.map((s) => s.id) ?? [];
      const bStepIds = bModule?.steps.map((s) => s.id) ?? [];
      const allStepIds = [
        ...baseStepIds,
        ...aStepIds.filter((id) => !baseStepIds.includes(id) && !bStepIds.includes(id)),
        ...bStepIds.filter((id) => !baseStepIds.includes(id)),
      ];
      const mergedStepOrder: string[] = [];

      allStepIds.forEach((stepId) => {
        const sInBase = baseStepIds.includes(stepId);
        const sInA = aStepIds.includes(stepId);
        const sInB = bStepIds.includes(stepId);
        const aStep = aModule?.steps.find((s) => s.id === stepId);
        const bStep = bModule?.steps.find((s) => s.id === stepId);
        const baseStep = baseModule?.steps.find((s) => s.id === stepId);

        if (sInA && sInB) {
          mergedStepOrder.push(stepId);
          const stepDiff = diffFields(
            stepFields(base, moduleId, stepId),
            stepFields(a, moduleId, stepId),
            stepFields(b, moduleId, stepId),
            STEP_FIELDS,
            { scope: 'step', moduleId, stepId, title: stepTitle(base, moduleId, stepId) },
          );
          stats.autoMerged += stepDiff.autoMerged;
          conflicts.push(...stepDiff.conflicts);
          const aStepFields = stepDiff.changes.filter((c) => !equalValue(c.aValue, c.baseValue));
          const bStepFields = stepDiff.changes.filter((c) => !equalValue(c.bValue, c.baseValue));
          if (aStepFields.length) bump({ scope: 'step', moduleId, moduleTitle: aModule?.title, stepId, stepTitle: aStep?.title, action: 'modified', fields: aStepFields }, 'A');
          if (bStepFields.length) bump({ scope: 'step', moduleId, moduleTitle: bModule?.title, stepId, stepTitle: bStep?.title, action: 'modified', fields: bStepFields }, 'B');
          if (!aStepFields.length && !bStepFields.length) stats.unchanged += 1;
        } else if (sInA && !sInB) {
          if (sInBase) {
            // 乙删了步骤，甲还在改
            const modified = stepModifiedSince(base, a, moduleId, stepId);
            if (modified) {
              stats.deleteModify += 1;
              mergedStepOrder.push(stepId);
              const aStepFields = diffFields(stepFields(base, moduleId, stepId), stepFields(a, moduleId, stepId), stepFields(a, moduleId, stepId), STEP_FIELDS, {
                scope: 'step', moduleId, stepId, title: stepTitle(base, moduleId, stepId),
              }).changes.filter((c) => !equalValue(c.aValue, c.baseValue));
              bump({ scope: 'step', moduleId, moduleTitle: aModule?.title, stepId, stepTitle: aStep?.title, action: 'modified', fields: aStepFields }, 'A');
              bump({ scope: 'step', moduleId, moduleTitle: aModule?.title, stepId, stepTitle: aStep?.title, action: 'deleted', fields: [] }, 'B');
              conflicts.push({
                key: deleteKey(moduleId, stepId),
                kind: 'delete-modify',
                scope: 'step',
                moduleId,
                stepId,
                title: stepTitle(base, moduleId, stepId),
                deletedBy: 'B',
                modifiedBy: 'A',
                aValue: aStepFields,
              });
            } else {
              stats.deleted += 1;
              bump({ scope: 'step', moduleId, moduleTitle: baseModule?.title, stepId, stepTitle: baseStep?.title, action: 'deleted', fields: [] }, 'B');
            }
          } else {
            stats.added += 1;
            mergedStepOrder.push(stepId);
            bump({ scope: 'step', moduleId, moduleTitle: aModule?.title, stepId, stepTitle: aStep?.title, action: 'added', fields: [] }, 'A');
          }
        } else if (!sInA && sInB) {
          if (sInBase) {
            // 甲删了步骤，乙还在改
            const modified = stepModifiedSince(base, b, moduleId, stepId);
            if (modified) {
              stats.deleteModify += 1;
              mergedStepOrder.push(stepId);
              const bStepFields = diffFields(stepFields(base, moduleId, stepId), stepFields(b, moduleId, stepId), stepFields(b, moduleId, stepId), STEP_FIELDS, {
                scope: 'step', moduleId, stepId, title: stepTitle(base, moduleId, stepId),
              }).changes.filter((c) => !equalValue(c.bValue, c.baseValue));
              bump({ scope: 'step', moduleId, moduleTitle: bModule?.title, stepId, stepTitle: bStep?.title, action: 'modified', fields: bStepFields }, 'B');
              bump({ scope: 'step', moduleId, moduleTitle: bModule?.title, stepId, stepTitle: bStep?.title, action: 'deleted', fields: [] }, 'A');
              conflicts.push({
                key: deleteKey(moduleId, stepId),
                kind: 'delete-modify',
                scope: 'step',
                moduleId,
                stepId,
                title: stepTitle(base, moduleId, stepId),
                deletedBy: 'A',
                modifiedBy: 'B',
                aValue: bStepFields,
              });
            } else {
              stats.deleted += 1;
              bump({ scope: 'step', moduleId, moduleTitle: baseModule?.title, stepId, stepTitle: baseStep?.title, action: 'deleted', fields: [] }, 'A');
            }
          } else {
            stats.added += 1;
            mergedStepOrder.push(stepId);
            bump({ scope: 'step', moduleId, moduleTitle: bModule?.title, stepId, stepTitle: bStep?.title, action: 'added', fields: [] }, 'B');
          }
        } else {
          // 两边都没有（冻结版里有，两边都删了）
          stats.deleted += 1;
        }
      });

      // 步骤顺序：只比较冻结版中已有的步骤
      const baseOrder = baseStepIds.filter((id) => aStepIds.includes(id) && bStepIds.includes(id));
      const aOrder = aStepIds.filter((id) => baseStepIds.includes(id));
      const bOrder = bStepIds.filter((id) => baseStepIds.includes(id));
      if (!equalValue(aOrder, bOrder)) {
        if (!equalValue(aOrder, baseOrder) && !equalValue(bOrder, baseOrder)) {
          stats.orderConflicts += 1;
          conflicts.push({
            key: orderKey(moduleId),
            kind: 'order',
            scope: 'step',
            moduleId,
            title: `模块「${moduleTitle(base, moduleId)}」的步骤顺序`,
            orderOptions: [
              { value: 'base', label: '冻结版顺序' },
              { value: 'A', label: '甲的顺序' },
              { value: 'B', label: '乙的顺序' },
            ],
          });
        }
      }
      void mergedStepOrder;
    } else if (inA && !inB) {
      if (inBase) {
        // 乙删了模块，甲还在改
        if (moduleModifiedSince(base, a, moduleId)) {
          stats.deleteModify += 1;
          mergedModuleOrder.push(moduleId);
          bump({ scope: 'module', moduleId, moduleTitle: aModule?.title, action: 'modified', fields: [] }, 'A');
          bump({ scope: 'module', moduleId, moduleTitle: aModule?.title, action: 'deleted', fields: [] }, 'B');
          conflicts.push({
            key: deleteKey(moduleId, ''),
            kind: 'delete-modify',
            scope: 'module',
            moduleId,
            title: `模块「${moduleTitle(base, moduleId)}」`,
            deletedBy: 'B',
            modifiedBy: 'A',
          });
        } else {
          stats.deleted += 1;
          bump({ scope: 'module', moduleId, moduleTitle: baseModule?.title, action: 'deleted', fields: [] }, 'B');
        }
      } else {
        stats.added += 1 + (aModule?.steps.length ?? 0);
        mergedModuleOrder.push(moduleId);
        bump({ scope: 'module', moduleId, moduleTitle: aModule?.title, action: 'added', fields: [] }, 'A');
        aModule?.steps.forEach((step) => bump({ scope: 'step', moduleId, moduleTitle: aModule.title, stepId: step.id, stepTitle: step.title, action: 'added', fields: [] }, 'A'));
      }
    } else if (!inA && inB) {
      if (inBase) {
        // 甲删了模块，乙还在改
        if (moduleModifiedSince(base, b, moduleId)) {
          stats.deleteModify += 1;
          mergedModuleOrder.push(moduleId);
          bump({ scope: 'module', moduleId, moduleTitle: bModule?.title, action: 'modified', fields: [] }, 'B');
          bump({ scope: 'module', moduleId, moduleTitle: bModule?.title, action: 'deleted', fields: [] }, 'A');
          conflicts.push({
            key: deleteKey(moduleId, ''),
            kind: 'delete-modify',
            scope: 'module',
            moduleId,
            title: `模块「${moduleTitle(base, moduleId)}」`,
            deletedBy: 'A',
            modifiedBy: 'B',
          });
        } else {
          stats.deleted += 1;
          bump({ scope: 'module', moduleId, moduleTitle: baseModule?.title, action: 'deleted', fields: [] }, 'A');
        }
      } else {
        stats.added += 1 + (bModule?.steps.length ?? 0);
        mergedModuleOrder.push(moduleId);
        bump({ scope: 'module', moduleId, moduleTitle: bModule?.title, action: 'added', fields: [] }, 'B');
        bModule?.steps.forEach((step) => bump({ scope: 'step', moduleId, moduleTitle: bModule.title, stepId: step.id, stepTitle: step.title, action: 'added', fields: [] }, 'B'));
      }
    } else {
      stats.deleted += 1;
    }
  });

  // 模块顺序冲突
  const baseModOrder = baseModuleIds.filter((id) => aModuleIds.includes(id) && bModuleIds.includes(id));
  const aModOrder = aModuleIds.filter((id) => baseModuleIds.includes(id));
  const bModOrder = bModuleIds.filter((id) => baseModuleIds.includes(id));
  if (!equalValue(aModOrder, bModOrder) && !equalValue(aModOrder, baseModOrder) && !equalValue(bModOrder, baseModOrder)) {
    stats.orderConflicts += 1;
    conflicts.push({
      key: orderKey('__modules__'),
      kind: 'order',
      scope: 'module',
      title: '模块顺序',
      orderOptions: [
        { value: 'base', label: '冻结版顺序' },
        { value: 'A', label: '甲的顺序' },
        { value: 'B', label: '乙的顺序' },
      ],
    });
  }
  void mergedModuleOrder;

  stats.fieldConflicts = conflicts.filter((c) => c.kind === 'field').length;
  return { ok: true, base, a, b, changesA, changesB, conflicts, stats };
}

/* ------------------------------------------------------------------ */
/* 应用合并                                                            */
/* ------------------------------------------------------------------ */

function pickField(
  base: Record<string, unknown>,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  scope: 'project' | 'module' | 'step',
  moduleId: string,
  stepId: string,
  field: string,
  resolutions: Record<string, string>,
): unknown {
  const bv = base[field];
  const av = a[field];
  const bv2 = b[field];
  if (equalValue(av, bv2)) return av;
  if (equalValue(av, bv)) return bv2;
  if (equalValue(bv2, bv)) return av;
  const resolution = resolutions[fieldKey(scope, moduleId, stepId, field)];
  if (resolution === 'A') return av;
  if (resolution === 'B') return bv2;
  throw new Error(`字段冲突未处理：${field}`);
}

export function buildMergedProject(base: CourseProject, a: CourseProject, b: CourseProject, resolutions: Record<string, string>): CourseProject {
  const merged = cloneProject(base);

  // 课程级字段
  (PROJECT_FIELDS as readonly string[]).forEach((field) => {
    (merged as unknown as Record<string, unknown>)[field] = pickField(
      base as unknown as Record<string, unknown>,
      a as unknown as Record<string, unknown>,
      b as unknown as Record<string, unknown>,
      'project',
      '',
      '',
      field,
      resolutions,
    );
  });

  const baseModuleIds = base.modules.map((m) => m.id);
  const aModuleIds = a.modules.map((m) => m.id);
  const bModuleIds = b.modules.map((m) => m.id);
  const allModuleIds = [
    ...baseModuleIds,
    ...aModuleIds.filter((id) => !baseModuleIds.includes(id) && !bModuleIds.includes(id)),
    ...bModuleIds.filter((id) => !baseModuleIds.includes(id)),
  ];

  const moduleOrderResolution = resolutions[orderKey('__modules__')];
  let orderedBaseIds = baseModuleIds.filter((id) => aModuleIds.includes(id) && bModuleIds.includes(id));
  if (moduleOrderResolution === 'A') orderedBaseIds = aModuleIds.filter((id) => baseModuleIds.includes(id));
  else if (moduleOrderResolution === 'B') orderedBaseIds = bModuleIds.filter((id) => baseModuleIds.includes(id));
  else {
    const aOrder = aModuleIds.filter((id) => baseModuleIds.includes(id));
    const bOrder = bModuleIds.filter((id) => baseModuleIds.includes(id));
    if (equalValue(aOrder, bOrder)) orderedBaseIds = aOrder;
  }
  const addedModuleIds = allModuleIds.filter((id) => !orderedBaseIds.includes(id));
  const finalModuleIds = [...orderedBaseIds, ...addedModuleIds];

  merged.modules = finalModuleIds
    .map((moduleId) => {
      const inBase = baseModuleIds.includes(moduleId);
      const inA = aModuleIds.includes(moduleId);
      const inB = bModuleIds.includes(moduleId);
      const aModule = a.modules.find((m) => m.id === moduleId);
      const bModule = b.modules.find((m) => m.id === moduleId);
      const baseModule = base.modules.find((m) => m.id === moduleId);

      if (inA && inB) {
        const result: CourseModule = {
          ...(cloneProject(base) as CourseProject).modules.find((m) => m.id === moduleId)!,
          steps: [],
        };
        const baseFields = moduleFields(base, moduleId);
        const aFields = moduleFields(a, moduleId);
        const bFields = moduleFields(b, moduleId);
        (MODULE_FIELDS as readonly string[]).forEach((field) => {
          (result as unknown as Record<string, unknown>)[field] = pickField(baseFields, aFields, bFields, 'module', moduleId, '', field, resolutions);
        });

        const baseStepIds = baseModule?.steps.map((s) => s.id) ?? [];
        const aStepIds = aModule?.steps.map((s) => s.id) ?? [];
        const bStepIds = bModule?.steps.map((s) => s.id) ?? [];
        const allStepIds = [
          ...baseStepIds,
          ...aStepIds.filter((id) => !baseStepIds.includes(id) && !bStepIds.includes(id)),
          ...bStepIds.filter((id) => !baseStepIds.includes(id)),
        ];
        const stepOrderResolution = resolutions[orderKey(moduleId)];
        let orderedStepIds = baseStepIds.filter((id) => aStepIds.includes(id) && bStepIds.includes(id));
        if (stepOrderResolution === 'A') orderedStepIds = aStepIds.filter((id) => baseStepIds.includes(id));
        else if (stepOrderResolution === 'B') orderedStepIds = bStepIds.filter((id) => baseStepIds.includes(id));
        else {
          const aOrder = aStepIds.filter((id) => baseStepIds.includes(id));
          const bOrder = bStepIds.filter((id) => baseStepIds.includes(id));
          if (equalValue(aOrder, bOrder)) orderedStepIds = aOrder;
        }
        const addedStepIds = allStepIds.filter((id) => !orderedStepIds.includes(id));

        result.steps = [...orderedStepIds, ...addedStepIds]
          .map((stepId) => {
            const sInBase = baseStepIds.includes(stepId);
            const sInA = aStepIds.includes(stepId);
            const sInB = bStepIds.includes(stepId);
            const aStep = aModule?.steps.find((s) => s.id === stepId);
            const bStep = bModule?.steps.find((s) => s.id === stepId);
            const baseStep = baseModule?.steps.find((s) => s.id === stepId);

            if (sInA && sInB) {
              const step = { ...baseStep! } as LessonStep;
              (STEP_FIELDS as readonly string[]).forEach((field) => {
                (step as unknown as Record<string, unknown>)[field] = pickField(
                  stepFields(base, moduleId, stepId),
                  stepFields(a, moduleId, stepId),
                  stepFields(b, moduleId, stepId),
                  'step',
                  moduleId,
                  stepId,
                  field,
                  resolutions,
                );
              });
              return step;
            }
            if (sInA && !sInB) {
              if (!sInBase) return { ...aStep! };
              if (stepModifiedSince(base, a, moduleId, stepId)) {
                const choice = resolutions[deleteKey(moduleId, stepId)];
                return choice === 'base' ? { ...baseStep! } : { ...aStep! };
              }
              return undefined;
            }
            if (!sInA && sInB) {
              if (!sInBase) return { ...bStep! };
              if (stepModifiedSince(base, b, moduleId, stepId)) {
                const choice = resolutions[deleteKey(moduleId, stepId)];
                return choice === 'base' ? { ...baseStep! } : { ...bStep! };
              }
              return undefined;
            }
            return undefined;
          })
          .filter((s): s is LessonStep => Boolean(s));
        return result;
      }

      if (inA && !inB) {
        if (!inBase) return { ...cloneProject(a).modules.find((m) => m.id === moduleId)! };
        if (moduleModifiedSince(base, a, moduleId)) {
          const choice = resolutions[deleteKey(moduleId, '')];
          return choice === 'base' ? { ...cloneProject(base).modules.find((m) => m.id === moduleId)! } : { ...cloneProject(a).modules.find((m) => m.id === moduleId)! };
        }
        return undefined;
      }
      if (!inA && inB) {
        if (!inBase) return { ...cloneProject(b).modules.find((m) => m.id === moduleId)! };
        if (moduleModifiedSince(base, b, moduleId)) {
          const choice = resolutions[deleteKey(moduleId, '')];
          return choice === 'base' ? { ...cloneProject(base).modules.find((m) => m.id === moduleId)! } : { ...cloneProject(b).modules.find((m) => m.id === moduleId)! };
        }
        return undefined;
      }
      return undefined;
    })
    .filter((m): m is CourseModule => Boolean(m));

  // 冻结版本都保留（按 id 去重，冻结版在前）；注意冻结快照本身不含 frozenVersions
  const frozenMap = new Map<string, FrozenVersion>();
  [...(base.frozenVersions ?? []), ...(a.frozenVersions ?? []), ...(b.frozenVersions ?? [])].forEach((fv) => {
    if (!frozenMap.has(fv.id)) frozenMap.set(fv.id, fv);
  });
  merged.frozenVersions = [...frozenMap.values()];

  merged.status = 'draft';
  merged.lastSavedAt = new Date().toISOString();
  merged.revision = Math.max(a.revision ?? 1, b.revision ?? 1) + 1;
  if (!merged.modules.some((m) => m.id === merged.selectedModuleId)) {
    merged.selectedModuleId = merged.modules[0]?.id ?? '';
  }
  if (!merged.modules.find((m) => m.id === merged.selectedModuleId)?.steps.some((s) => s.id === merged.selectedStepId)) {
    merged.selectedStepId = merged.modules.find((m) => m.id === merged.selectedModuleId)?.steps[0]?.id ?? '';
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* 副本解析与基准匹配                                                  */
/* ------------------------------------------------------------------ */

export function parseCourseJson(text: string): { project?: CourseProject; error?: string } {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray((data as CourseProject).modules)) {
      return { error: '文件不是有效的课程副本（缺少 modules 结构）。' };
    }
    return { project: data as CourseProject };
  } catch (error) {
    return { error: `文件无法解析：${(error as Error).message}` };
  }
}

export function candidateBases(a: CourseProject, b: CourseProject): FrozenVersion[] {
  const map = new Map<string, FrozenVersion>();
  [...(a.frozenVersions ?? []), ...(b.frozenVersions ?? [])].forEach((fv) => {
    if (!map.has(fv.id)) map.set(fv.id, fv);
  });
  return [...map.values()].sort((x, y) => +new Date(y.createdAt) - +new Date(x.createdAt));
}

export function findCommonBase(a: CourseProject, b: CourseProject): FrozenVersion | undefined {
  const aIds = new Set((a.frozenVersions ?? []).map((fv) => fv.id));
  const common = (b.frozenVersions ?? []).filter((fv) => aIds.has(fv.id));
  if (!common.length) return undefined;
  return common.sort((x, y) => +new Date(y.createdAt) - +new Date(x.createdAt))[0];
}

/* ------------------------------------------------------------------ */
/* 合并记录持久化                                                      */
/* ------------------------------------------------------------------ */

export function loadMergeRecords(): MergeRecord[] {
  try {
    const raw = localStorage.getItem(MERGE_RECORDS_KEY);
    if (!raw) return [];
    const records = JSON.parse(raw) as MergeRecord[];
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

export function persistMergeRecords(records: MergeRecord[]): void {
  try {
    localStorage.setItem(MERGE_RECORDS_KEY, JSON.stringify(records));
  } catch {
    // 存储失败时静默保留在内存中，下次重试
  }
}

export function upsertMergeRecord(record: MergeRecord): MergeRecord[] {
  const records = loadMergeRecords();
  const index = records.findIndex((item) => item.id === record.id);
  const next = { ...record, updatedAt: new Date().toISOString() };
  if (index >= 0) records[index] = next;
  else records.unshift(next);
  persistMergeRecords(records);
  return records;
}

export function deleteMergeRecord(recordId: string): MergeRecord[] {
  const records = loadMergeRecords().filter((item) => item.id !== recordId);
  persistMergeRecords(records);
  return records;
}

/** 根据两份原始副本重新计算合并（用于新建与重试） */
export function recomputeRecord(record: MergeRecord, baseIdOverride?: string): MergeRecord {
  const pa = parseCourseJson(record.rawA);
  const pb = parseCourseJson(record.rawB);
  if (pa.error || pb.error) {
    return {
      ...record,
      status: 'failed',
      failureReason: pa.error ? `甲的副本：${pa.error}` : `乙的副本：${pb.error}`,
      sideASnapshot: pa.project,
      sideBSnapshot: pb.project,
      mergedSnapshot: undefined,
    };
  }
  const a = pa.project!;
  const b = pb.project!;

  let base: CourseProject | undefined;
  let baseLabel: string | undefined;
  const chosenId = baseIdOverride ?? record.baseId;
  if (chosenId) {
    const fv = candidateBases(a, b).find((item) => item.id === chosenId);
    if (fv) {
      base = fv.snapshot as CourseProject;
      baseLabel = fv.label;
    }
  }
  if (!base) {
    const common = findCommonBase(a, b);
    if (common) {
      base = common.snapshot as CourseProject;
      baseLabel = common.label;
    }
  }
  if (!base) {
    return {
      ...record,
      status: 'failed',
      failureReason: '两份副本没有共同的冻结版本，无法确定合并基准。请选择一个冻结版本作为基准后重试。',
      sideASnapshot: a,
      sideBSnapshot: b,
      baseSnapshot: undefined,
      mergedSnapshot: undefined,
    };
  }

  const computation = computeMerge(base, a, b);
  if (!computation.ok) {
    return { ...record, status: 'failed', failureReason: computation.reason, baseSnapshot: base, baseLabel, sideASnapshot: a, sideBSnapshot: b, mergedSnapshot: undefined };
  }

  let mergedSnapshot: CourseProject | undefined;
  try {
    mergedSnapshot = buildMergedProject(base, a, b, record.resolutions);
  } catch {
    // 冲突未全部处理时不生成预览，不视为失败
    mergedSnapshot = undefined;
  }

  return {
    ...record,
    status: 'pending',
    failureReason: undefined,
    baseId: chosenId ?? findCommonBase(a, b)?.id,
    baseLabel,
    baseSnapshot: base,
    sideASnapshot: a,
    sideBSnapshot: b,
    mergedSnapshot,
  };
}

export function createMergeRecord(rawA: string, rawB: string, nameA: string, nameB: string, baseId?: string): MergeRecord {
  const now = new Date().toISOString();
  const record: MergeRecord = {
    id: `merge-${Date.now().toString(36)}`,
    label: `合并记录 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date())}`,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    rawA,
    rawB,
    sideAName: nameA,
    sideBName: nameB,
    resolutions: {},
  };
  return recomputeRecord(record, baseId);
}
