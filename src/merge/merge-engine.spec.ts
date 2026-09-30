import {
  buildMergeReport,
  buildMergedSnapshot,
  diff3Order,
  emptyResolutions,
  entityConflictKey,
  fieldConflictKey,
  isResolutionComplete,
  listSideChanges,
  type OfflineCopy,
} from './merge-engine';
import type { CourseModule, CourseSnapshot, FrozenVersion, LessonStep } from '../models';

function makeStep(id: string, patch: Partial<LessonStep> = {}): LessonStep {  return {
    id,
    title: `步骤 ${id}`,
    kind: '示范',
    duration: 40,
    demoTitle: '',
    demoUrl: '',
    handshape: '',
    gestureZone: '中央',
    caption: '',
    captionPosition: '下方安全区',
    camera: '正面',
    commonMistakes: [],
    exercise: '',
    exerciseFeedback: '',
    altText: '替代文本',
    prerequisiteId: '',
    difficulty: '入门',
    cuePoints: [],
    ...patch,
  };
}

function makeSnapshot(steps: Record<string, LessonStep[]> = {}, moduleTitles: Record<string, string> = {}): CourseSnapshot {
  const moduleIds = Object.keys(steps).length ? Object.keys(steps) : ['m1'];
  return {
    id: 'course',
    title: '课程',
    teacher: '教研组',
    audience: '学习者',
    status: 'frozen',
    selectedModuleId: moduleIds[0] ?? '',
    selectedStepId: '',
    modules: moduleIds.map((id) => ({
      id,
      title: moduleTitles[id] ?? `模块 ${id}`,
      summary: '目标',
      color: '#000',
      steps: steps[id] ?? [],
    })),
    lastSavedAt: '2026-09-01T00:00:00.000Z',
    revision: 1,
  };
}

function makeFrozen(snapshot: CourseSnapshot): FrozenVersion {
  return { id: 'frozen-1', label: '冻结版本 v1', createdAt: '2026-09-01T00:00:00.000Z', snapshot };
}

function makeCopy(snapshot: CourseSnapshot, teacherName: string, baseFrozenId = 'frozen-1'): OfflineCopy {
  return { teacherName, exportedAt: '2026-09-02T00:00:00.000Z', baseFrozenId, snapshot: structuredClone(snapshot) };
}

describe('三路合并引擎', () => {
  it('同一步骤不同字段的改动自动并入', () => {
    const base = makeSnapshot({ m1: [makeStep('s1', { title: '原始标题', caption: '原始字幕' })] });
    const a = structuredClone(base);
    a.modules[0].steps[0].title = '甲方改标题';
    const b = structuredClone(base);
    b.modules[0].steps[0].caption = '乙方改字幕';

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    expect(report.conflictCount).toBe(0);
    const merged = buildMergedSnapshot(report, emptyResolutions());
    expect(merged.modules[0].steps[0].title).toBe('甲方改标题');
    expect(merged.modules[0].steps[0].caption).toBe('乙方改字幕');
  });

  it('同一字段两边都改成不同值时保留两版并要求裁决', () => {
    const base = makeSnapshot({ m1: [makeStep('s1', { duration: 40 })] });
    const a = structuredClone(base);
    a.modules[0].steps[0].duration = 50;
    const b = structuredClone(base);
    b.modules[0].steps[0].duration = 60;

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const stepMerge = report.modules[0].steps[0];
    const diff = stepMerge.fieldDiffs.find((item) => item.key === 'duration');
    expect(diff?.conflict).toBe(true);
    expect(report.conflictCount).toBe(1);

    const resolutions = emptyResolutions();
    expect(isResolutionComplete(report, resolutions)).toBe(false);
    resolutions.fields[fieldConflictKey('step', 's1', 'duration')] = 'b';
    expect(isResolutionComplete(report, resolutions)).toBe(true);
    expect(buildMergedSnapshot(report, resolutions).modules[0].steps[0].duration).toBe(60);
  });

  it('一边删除步骤、另一边修改步骤时保留步骤并生成存在性冲突', () => {
    const base = makeSnapshot({ m1: [makeStep('s1'), makeStep('s2')] });
    const a = structuredClone(base);
    a.modules[0].steps = a.modules[0].steps.filter((step: LessonStep) => step.id !== 's2');
    const b = structuredClone(base);
    b.modules[0].steps[1].caption = '乙方给 s2 加字幕';

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const stepMerge = report.modules[0].steps.find((step) => step.id === 's2');
    expect(stepMerge?.presenceConflict).toBe(true);
    expect(stepMerge?.aPresence).toBe('deleted');
    expect(stepMerge?.bPresence).toBe('modified');

    // 未裁决时默认保留，不直接丢。
    let merged = buildMergedSnapshot(report, emptyResolutions());
    expect(merged.modules[0].steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(merged.modules[0].steps[1].caption).toBe('乙方给 s2 加字幕');

    // 裁决为删除后才真正移除。
    const resolutions = emptyResolutions();
    resolutions.entities[entityConflictKey('step', 'm1', 's2')] = 'drop';
    merged = buildMergedSnapshot(report, resolutions);
    expect(merged.modules[0].steps.map((step) => step.id)).toEqual(['s1']);
  });

  it('双方都删除的步骤自动消失', () => {
    const base = makeSnapshot({ m1: [makeStep('s1'), makeStep('s2')] });
    const a = structuredClone(base);
    a.modules[0].steps = a.modules[0].steps.filter((step: LessonStep) => step.id !== 's2');
    const b = structuredClone(base);
    b.modules[0].steps = b.modules[0].steps.filter((step) => step.id !== 's2');

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const merged = buildMergedSnapshot(report, emptyResolutions());
    expect(merged.modules[0].steps.map((step) => step.id)).toEqual(['s1']);
    expect(report.conflictCount).toBe(0);
  });

  it('双方各自新增步骤自动并列保留且顺序对齐', () => {
    const base = makeSnapshot({ m1: [makeStep('s1')] });
    const a = structuredClone(base);
    a.modules[0].steps.push(makeStep('s-a-new'));
    const b = structuredClone(base);
    b.modules[0].steps.push(makeStep('s-b-new'));

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    // 同一尾部位置两人各加各的 → 顺序冲突，默认取 A；两个新步骤都必须能通过 union 保住。
    const hunk = report.modules[0].stepOrderHunks.find((item) => item.conflict);
    expect(hunk).toBeDefined();
    expect(hunk?.aIds).toEqual(['s-a-new']);
    expect(hunk?.bIds).toEqual(['s-b-new']);
    const resolutions = emptyResolutions();
    resolutions.order[hunk!.id] = { kind: 'union' };
    const resolved = buildMergedSnapshot(report, resolutions);
    expect(resolved.modules[0].steps.map((step) => step.id)).toEqual(['s1', 's-a-new', 's-b-new']);
  });

  it('只有一边换位时自动采用该边，稳定步骤对齐', () => {
    const hunks = diff3Order(['s1', 's2', 's3', 's4'], ['s1', 's3', 's2', 's4'], ['s1', 's2', 's3', 's4']);
    expect(hunks.some((hunk) => hunk.conflict)).toBe(false);
    const merged = hunks.flatMap((hunk) => (hunk.stableId ? [hunk.stableId] : hunk.autoIds));
    expect(merged).toEqual(['s1', 's3', 's2', 's4']);
  });

  it('两边各做不同换位时产生顺序冲突', () => {
    const hunks = diff3Order(['s1', 's2', 's3', 's4'], ['s2', 's1', 's3', 's4'], ['s1', 's2', 's4', 's3']);
    expect(hunks.some((hunk) => hunk.conflict)).toBe(true);
  });

  it('一边删除模块、另一边仍改其中步骤时保留整个模块', () => {
    const base = makeSnapshot({ m1: [makeStep('s1')], m2: [makeStep('s2', { caption: '原字幕' })] });
    const a = structuredClone(base);
    a.modules = a.modules.filter((module: CourseModule) => module.id !== 'm2');
    const b = structuredClone(base);
    b.modules[1].steps[0].caption = '乙方更新字幕';
    b.modules[1].summary = '乙方更新模块目标';

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const moduleMerge = report.modules.find((module) => module.id === 'm2');
    expect(moduleMerge?.presenceConflict).toBe(true);
    const merged = buildMergedSnapshot(report, emptyResolutions());
    expect(merged.modules.map((module) => module.id)).toEqual(['m1', 'm2']);
    expect(merged.modules[1].summary).toBe('乙方更新模块目标');
    expect(merged.modules[1].steps[0].caption).toBe('乙方更新字幕');
  });

  it('变更清单分别列出两边各自的改动', () => {
    const base = makeSnapshot({ m1: [makeStep('s1', { title: '原标题' })] });
    const a = structuredClone(base);
    a.modules[0].steps[0].title = '甲改';
    const b = structuredClone(base);
    b.modules[0].steps[0].duration = 99;

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const aChanges = listSideChanges(report, 'a');
    const bChanges = listSideChanges(report, 'b');
    expect(aChanges.some((entry) => entry.fieldLabel === 'title')).toBe(true);
    expect(aChanges.some((entry) => entry.fieldLabel === 'duration')).toBe(false);
    expect(bChanges.some((entry) => entry.fieldLabel === 'duration')).toBe(true);
    expect(bChanges.some((entry) => entry.fieldLabel === 'title')).toBe(false);
  });

  it('数组字段（常见错误）按整体比对，双方追加不同条目时产生冲突', () => {
    const base = makeSnapshot({ m1: [makeStep('s1', { commonMistakes: ['错误一'] })] });
    const a = structuredClone(base);
    a.modules[0].steps[0].commonMistakes = ['错误一', '甲方补充'];
    const b = structuredClone(base);
    b.modules[0].steps[0].commonMistakes = ['错误一', '乙方补充'];

    const report = buildMergeReport({ frozen: makeFrozen(base), aCopy: makeCopy(a, '甲'), bCopy: makeCopy(b, '乙') });
    const diff = report.modules[0].steps[0].fieldDiffs.find((item) => item.key === 'commonMistakes');
    expect(diff?.conflict).toBe(true);
  });
});
