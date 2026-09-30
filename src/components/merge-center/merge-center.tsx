import { Component, Event, EventEmitter, Host, Prop, State, Watch, h } from '@stencil/core';
import type { CourseModule, CourseProject, FrozenVersion } from '../../models';
import { fieldLabel, formatValue, isColorValue } from '../../merge/field-labels';
import {
  buildMergedSnapshot,
  entityConflictKey,
  fieldConflictKey,
  isResolutionComplete,
  listSideChanges,
  unresolvedCount,
  type FieldDiff,
  type HunkResolution,
  type MergeReport,
  type ModuleMerge,
  type OrderHunk,
  type Side,
  type StepMerge,
} from '../../merge/merge-engine';
import {
  addImportedCopy,
  completeSession,
  createOfflineCopy,
  createSession,
  deleteSession,
  downloadJson,
  loadImportedCopies,
  loadSessions,
  parseOfflineCopy,
  removeImportedCopy,
  sessionReport,
  upsertSession,
  type MergeSession,
  type OfflineCopy,
} from '../../merge/merge-store';

type Tab = 'conflicts' | 'changes' | 'preview' | 'sessions' | 'copies';

@Component({
  tag: 'merge-center',
  styleUrl: 'merge-center.css',
  scoped: true,
})
export class MergeCenter {
  /** 弹窗是否打开。 */
  @Prop({ mutable: true }) open = false;
  @Prop() project!: CourseProject;
  @Prop() activeSessionId?: string;

  @Event() mergeClosed!: EventEmitter;
  @Event() applyMerged!: EventEmitter<{ snapshot: unknown }>;

  @State() tab: Tab = 'conflicts';
  @State() sessions: MergeSession[] = [];
  @State() copies: OfflineCopy[] = [];
  @State() currentSessionId?: string;
  /** 当前会话的报告（缓存；会话或裁决变化时重建）。 */
  @State() report?: MergeReport;
  @State() draftBaseId?: string;
  @State() draftACopyKey?: string;
  @State() draftBCopyKey?: string;
  @State() notice?: { kind: 'error' | 'success'; message: string };
  @State() showNewSession = false;
  @State() showAutoMerge = false;

  private fileInput?: HTMLInputElement;
  private fileSlot: 'a' | 'b' | 'library' = 'library';

  componentWillLoad(): void {
    this.reload();
    if (this.activeSessionId) this.currentSessionId = this.activeSessionId;
  }

  @Watch('open')
  handleOpenChanged(open: boolean): void {
    if (open) this.reload();
  }

  @Watch('activeSessionId')
  handleSessionIdChanged(id?: string): void {
    if (id) this.activateSession(id);
  }

  private reload(): void {
    this.sessions = loadSessions();
    this.copies = loadImportedCopies();
    if (this.currentSessionId && !this.sessions.some((session) => session.id === this.currentSessionId)) {
      this.currentSessionId = undefined;
      this.report = undefined;
    } else if (this.currentSessionId) {
      this.report = sessionReport(this.requireSession());
    }
  }

  private get currentSession(): MergeSession | undefined {
    return this.sessions.find((session) => session.id === this.currentSessionId);
  }

  private requireSession(): MergeSession {
    const session = this.currentSession;
    if (!session) throw new Error('当前没有打开的合并会话。');
    return session;
  }

  private showNotice(kind: 'error' | 'success', message: string): void {
    this.notice = { kind, message };
    window.setTimeout(() => {
      if (this.notice?.message === message) this.notice = undefined;
    }, 4_000);
  }

  private close(): void {
    this.mergeClosed.emit();
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
  }

  // ------------------------------------------------------------------
  // 副本导入 / 导出
  // ------------------------------------------------------------------

  private exportCurrentCopy(): void {
    // frozenVersions[0] 即最近一次冻结点：冻结视图对应它；草稿/复核视图也以它为共同祖先。
    const currentFrozen = this.project.frozenVersions[0];
    const copy = createOfflineCopy(
      this.project,
      this.project.teacher || '未署名老师',
      `导出自 ${this.project.title}（${this.project.status === 'frozen' ? '冻结版本' : '当前草稿'}）`,
      currentFrozen?.id,
    );
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadJson(`offline-copy-${stamp}.json`, copy);
    this.showNotice('success', `已导出 ${copy.teacherName} 的离线副本，可交给另一位老师离线编辑。`);
  }

  private exportFromFrozen(version: FrozenVersion): void {
    // 直接以冻结快照构造一份“干净”的离线副本，适合从历史版本开新修订。
    const copy: OfflineCopy = {
      teacherName: this.project.teacher,
      note: `基于「${version.label}」导出的干净离线副本`,
      exportedAt: new Date().toISOString(),
      baseFrozenId: version.id,
      snapshot: structuredClone(version.snapshot),
    };
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadJson(`offline-copy-${version.label}-${stamp}.json`, copy);
    this.showNotice('success', `已按「${version.label}」导出离线副本。`);
  }

  private triggerImport(slot: 'a' | 'b' | 'library'): void {
    this.fileSlot = slot;
    this.fileInput?.click();
  }

  private async handleFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const copy = parseOfflineCopy(text);
      this.copies = addImportedCopy(copy);
      this.showNotice('success', `已导入 ${copy.teacherName} 的离线副本（${this.formatDate(copy.exportedAt)}）。`);
      if (this.fileSlot === 'a') this.draftACopyKey = this.copyKey(copy);
      if (this.fileSlot === 'b') this.draftBCopyKey = this.copyKey(copy);
    } catch (error) {
      this.showNotice('error', error instanceof Error ? error.message : '导入失败，请检查文件。');
    }
  }

  private copyKey(copy: OfflineCopy): string {
    return `${copy.teacherName}|${copy.exportedAt}|${copy.snapshot.title}`;
  }

  private findCopy(key?: string): OfflineCopy | undefined {
    if (!key) return undefined;
    return this.copies.find((copy) => this.copyKey(copy) === key);
  }

  private setDraftCopy(side: Side, key: string): void {
    if (side === 'a') this.draftACopyKey = key;
    else this.draftBCopyKey = key;
  }

  private getDraftCopy(side: Side): string | undefined {
    return side === 'a' ? this.draftACopyKey : this.draftBCopyKey;
  }

  private removeCopyAt(index: number): void {
    this.copies = removeImportedCopy(index);
  }

  /** 把某份副本的快照装进当前编辑器（单机演示两位老师接力：导出 → 装载 → 修改 → 再导出）。 */
  private loadCopyIntoEditor(copy: OfflineCopy): void {
    if (!window.confirm(`将把编辑器内容替换为「${copy.teacherName}」的离线副本快照，当前未冻结的修改请先保存。是否继续？`)) return;
    this.applyMerged.emit({ snapshot: copy.snapshot });
    this.showNotice('success', '已把该副本装入编辑器，修改后用“导出我的离线副本”再交回。');
  }

  // ------------------------------------------------------------------
  // 会话
  // ------------------------------------------------------------------

  private activateSession(id: string): void {
    this.currentSessionId = id;
    const session = this.sessions.find((item) => item.id === id);
    if (session) {
      this.report = sessionReport(session);
      this.tab = session.status === 'pending' ? 'conflicts' : session.status === 'completed' ? 'preview' : 'sessions';
    }
  }

  private get sessionReadonly(): boolean {
    return this.currentSession?.status !== 'pending';
  }

  private startNewSession(): void {
    this.showNewSession = true;
    this.draftBaseId = this.project.frozenVersions[0]?.id;
    this.draftACopyKey = this.copies[0] ? this.copyKey(this.copies[0]) : undefined;
    this.draftBCopyKey = this.copies[1] ? this.copyKey(this.copies[1]) : undefined;
  }

  private cancelNewSession(): void {
    this.showNewSession = false;
  }

  private confirmCreateSession(): void {
    const frozen = this.project.frozenVersions.find((version) => version.id === this.draftBaseId);
    const a = this.findCopy(this.draftACopyKey);
    const b = this.findCopy(this.draftBCopyKey);
    if (!frozen) return this.showNotice('error', '请先选择一个冻结版本作为合并基准。');
    if (!a || !b) return this.showNotice('error', '请分别选择甲、乙两份离线副本。');
    if (this.copyKey(a) === this.copyKey(b)) return this.showNotice('error', '甲、乙不能选择同一份副本。');
    const session = createSession(frozen, a, b);
    this.reload();
    this.currentSessionId = session.id;
    this.showNewSession = false;
    this.report = sessionReport(session);
    this.tab = 'conflicts';
    this.showNotice('success', '合并会话已创建，所有内容已保存在本机，可随时关闭后继续。');
  }

  private persistResolutions(): void {
    const session = this.currentSession;
    if (!session || !this.report) return;
    upsertSession({ ...session, resolutions: structuredClone(session.resolutions) });
    this.sessions = loadSessions();
  }

  private setFieldResolution(scope: string, entityId: string, diff: FieldDiff, side: Side): void {
    if (this.sessionReadonly) return;
    const session = this.requireSession();
    session.resolutions.fields[fieldConflictKey(scope, entityId, diff.key)] = side;
    this.persistResolutions();
  }

  private setEntityResolution(scope: 'module' | 'step', moduleId: string, stepId: string | undefined, decision: 'keep' | 'drop'): void {
    if (this.sessionReadonly) return;
    const session = this.requireSession();
    session.resolutions.entities[entityConflictKey(scope, moduleId, stepId)] = decision;
    this.persistResolutions();
  }

  private setOrderResolution(hunk: OrderHunk, resolution: HunkResolution): void {
    if (this.sessionReadonly) return;
    const session = this.requireSession();
    session.resolutions.order[hunk.id] = resolution;
    this.persistResolutions();
  }

  private resolveAllWith(side: Side): void {
    if (this.sessionReadonly) return;
    const session = this.requireSession();
    if (!this.report) return;
    const walk = (diffs: FieldDiff[], scope: string, entityId: string): void => {
      for (const diff of diffs) {
        if (diff.conflict) session.resolutions.fields[fieldConflictKey(scope, entityId, diff.key)] = side;
      }
    };
    walk(this.report.projectDiffs, 'project', 'course');
    for (const module of this.report.modules) {
      walk(module.fieldDiffs, 'module', module.id);
      for (const step of module.steps) walk(step.fieldDiffs, 'step', step.id);
    }
    this.persistResolutions();
    this.showNotice('success', `剩余字段冲突已统一选择${side === 'a' ? '甲' : '乙'}方版本。`);
  }

  private completeMerge(): void {
    const session = this.requireSession();
    if (!this.report) return;
    if (!isResolutionComplete(this.report, session.resolutions)) {
      const remaining = unresolvedCount(this.report, session.resolutions);
      this.showNotice('error', `还有 ${remaining} 个冲突未裁决，全部处理完才能完成合并；会话已自动保存。`);
      return;
    }
    const completed = completeSession(session, session.resolutions);
    this.reload();
    this.currentSessionId = completed.id;
    this.report = sessionReport(completed);
    this.tab = 'preview';
    this.showNotice('success', '合并完成，结果与完整处理记录均已保存在本机。');
  }

  private discardSession(): void {
    const session = this.currentSession;
    if (!session || session.status !== 'pending') return;
    if (!window.confirm('标记为“已放弃”后，该会话与全部裁决记录仍会保留在本机，可随时查看。确认放弃？')) return;
    const discarded: MergeSession = { ...session, status: 'discarded' };
    upsertSession(discarded);
    this.reload();
    this.tab = 'sessions';
  }

  private purgeSession(id: string): void {
    if (!window.confirm('彻底删除该会话记录？（冻结版本与两份离线副本仍会保留）')) return;
    deleteSession(id);
    if (this.currentSessionId === id) {
      this.currentSessionId = undefined;
      this.report = undefined;
    }
    this.reload();
  }

  private applyMerge(): void {
    const session = this.currentSession;
    if (!session?.resultSnapshot) return;
    this.applyMerged.emit({ snapshot: session.resultSnapshot });
    this.showNotice('success', '合并结果已装入编辑器，可检查后保存草稿或提交复核。');
  }

  // ------------------------------------------------------------------
  // 渲染辅助
  // ------------------------------------------------------------------

  private formatDate(value: string): string {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderFieldConflict(diff: FieldDiff, scope: string, entityId: string, prerequisiteTitle?: (id: unknown) => string) {
    const session = this.currentSession;
    const choice = session?.resolutions.fields[fieldConflictKey(scope, entityId, diff.key)];
    const display = (value: unknown) => {
      if (diff.key === 'prerequisiteId' && prerequisiteTitle) return formatValue(value ? prerequisiteTitle(value) : value);
      if (isColorValue(value)) return <span class="value-color"><i style={{ background: String(value) }} />{formatValue(value)}</span>;
      return formatValue(value);
    };
    return (
      <div class="conflict-card field-conflict">
        <div class="conflict-head">
          <span class="conflict-tag">字段冲突</span>
          <strong>{fieldLabel(scope, diff.key)}</strong>
          <span class="conflict-base">冻结版本：{display(diff.baseValue)}</span>
        </div>
        <div class="conflict-options">
          {(['a', 'b'] as Side[]).map((side) => {
            const copy = side === 'a' ? this.report?.aCopy : this.report?.bCopy;
            const value = side === 'a' ? diff.aValue : diff.bValue;
            return (
              <button class={`option-card ${choice === side ? 'selected' : ''}`} onClick={() => this.setFieldResolution(scope, entityId, diff, side)}>
                <span class="option-side">{side === 'a' ? '甲' : '乙'}方</span>
                <span class="option-teacher">{copy?.teacherName}</span>
                <span class="option-value">{display(value)}</span>
                <span class="option-radio">{choice === side ? '●' : '○'}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  private renderPresenceConflict(
    title: string,
    scope: 'module' | 'step',
    moduleId: string,
    stepId: string | undefined,
    deletedSide: Side,
    editedSide: Side,
    editedSummary: string,
  ) {
    const session = this.currentSession;
    const key = entityConflictKey(scope, moduleId, stepId);
    const decision = session?.resolutions.entities[key];
    return (
      <div class="conflict-card presence-conflict">
        <div class="conflict-head">
          <span class="conflict-tag danger">删除 vs 修改</span>
          <strong>{title}</strong>
        </div>
        <p class="presence-detail">
          {deletedSide === 'a' ? '甲' : '乙'}方删除了这个{scope === 'module' ? '模块' : '步骤'}，
          而{editedSide === 'a' ? '甲' : '乙'}方仍在修改它（{editedSummary}）。
          按约定默认保留，需要老师明确确认是否真的删除。
        </p>
        <div class="presence-actions">
          <button class={decision === 'keep' || !decision ? 'selected' : ''} onClick={() => this.setEntityResolution(scope, moduleId, stepId, 'keep')}>保留{scope === 'module' ? '模块' : '步骤'}（采用修改方内容）</button>
          <button class={decision === 'drop' ? 'selected danger' : ''} onClick={() => this.setEntityResolution(scope, moduleId, stepId, 'drop')}>确认删除</button>
        </div>
      </div>
    );
  }

  private renderOrderConflict(hunk: OrderHunk, titleById: Map<string, string>, level: 'module' | 'step') {
    const session = this.currentSession;
    const choice = session?.resolutions.order[hunk.id];
    const kind = choice?.kind ?? 'keep-a';
    const optionClass = (value: string) => `order-option ${kind === value ? 'selected' : ''}`;
    const renderChain = (ids: string[]) => (
      <span class="order-chain">
        {ids.length === 0 && <em>（空）</em>}
        {ids.map((id, index) => (
          <span class="order-pill">{index > 0 && <i>→</i>}{titleById.get(id) ?? id}</span>
        ))}
      </span>
    );
    return (
      <div class="conflict-card order-conflict">
        <div class="conflict-head">
          <span class="conflict-tag warning">{level === 'module' ? '模块' : '步骤'}顺序冲突</span>
          <strong>同一位置两边排法不同</strong>
        </div>
        <div class="order-sides">
          <div class="order-side"><span>甲方排列</span>{renderChain(hunk.aIds)}</div>
          <div class="order-side"><span>乙方排列</span>{renderChain(hunk.bIds)}</div>
        </div>
        <div class="order-actions">
          <button class={optionClass('keep-a')} onClick={() => this.setOrderResolution(hunk, { kind: 'keep-a' })}>采用甲序</button>
          <button class={optionClass('keep-b')} onClick={() => this.setOrderResolution(hunk, { kind: 'keep-b' })}>采用乙序</button>
          <button class={optionClass('union')} onClick={() => this.setOrderResolution(hunk, { kind: 'union' })}>两边都保留（甲先乙后）</button>
        </div>
      </div>
    );
  }

  private renderStepConflicts(module: ModuleMerge, step: StepMerge) {
    const prereqTitle = (id: unknown) => module.steps.find((item) => item.id === id)?.base?.title
      ?? module.a?.steps.find((item) => item.id === id)?.title
      ?? module.b?.steps.find((item) => item.id === id)?.title
      ?? String(id);
    const elements: any[] = [];
    const stepTitle = step.base?.title ?? step.a?.title ?? step.b?.title ?? step.id;
    if (step.presenceConflict) {
      const deletedSide: Side = step.aPresence === 'deleted' ? 'a' : 'b';
      const editedSide: Side = deletedSide === 'a' ? 'b' : 'a';
      const editedFields = step.fieldDiffs.filter((diff) => (editedSide === 'a' ? diff.aChanged : diff.bChanged)).map((diff) => fieldLabel('step', diff.key)).join('、');
      elements.push(this.renderPresenceConflict(stepTitle, 'step', module.id, step.id, deletedSide, editedSide, editedFields || '步骤内容'));
    }
    for (const diff of step.fieldDiffs) {
      if (diff.conflict) elements.push(this.renderFieldConflict(diff, 'step', step.id, prereqTitle));
    }
    return elements;
  }

  private collectAutoMerges(report: MergeReport): Array<{ location: string; side: string; label: string; value: unknown }> {
    const result: Array<{ location: string; side: string; label: string; value: unknown }> = [];
    const collect = (diffs: FieldDiff[], location: string, prereqTitle?: (id: unknown) => string): void => {
      for (const diff of diffs) {
        if (diff.conflict) continue;
        if (diff.aChanged && !diff.bChanged) result.push({ location, side: '甲', label: fieldLabel('step', diff.key), value: diff.key === 'prerequisiteId' && prereqTitle ? (diff.aValue ? prereqTitle(diff.aValue) : diff.aValue) : diff.aValue });
        else if (diff.bChanged && !diff.aChanged) result.push({ location, side: '乙', label: fieldLabel('step', diff.key), value: diff.key === 'prerequisiteId' && prereqTitle ? (diff.bValue ? prereqTitle(diff.bValue) : diff.bValue) : diff.bValue });
      }
    };
    collect(report.projectDiffs, '课程信息');
    for (const module of report.modules) {
      const moduleTitle = module.base?.title ?? module.a?.title ?? module.b?.title ?? module.id;
      if (!module.presenceConflict || module.aPresence !== 'deleted') collect(module.fieldDiffs, moduleTitle);
      for (const step of module.steps) {
        if (step.presenceConflict) continue; // 删除 vs 修改由老师裁决，不算自动项。
        const stepTitle = step.base?.title ?? step.a?.title ?? step.b?.title ?? step.id;
        const prereqTitle = (id: unknown) => module.steps.find((item) => item.id === id)?.base?.title
          ?? module.a?.steps.find((item) => item.id === id)?.title
          ?? module.b?.steps.find((item) => item.id === id)?.title
          ?? String(id);
        collect(step.fieldDiffs, `${moduleTitle} · ${stepTitle}`, prereqTitle);
      }
    }
    return result;
  }

  private renderAutoMergeSummary(report: MergeReport) {
    const items = this.collectAutoMerges(report);
    const additions: Array<{ side: string; location: string }> = [];
    for (const module of report.modules) {
      const moduleTitle = module.base?.title ?? module.a?.title ?? module.b?.title ?? module.id;
      if (module.aPresence === 'added' && module.bPresence === 'added') additions.push({ side: '甲乙', location: `新模块 ${moduleTitle}` });
      else if (module.aPresence === 'added') additions.push({ side: '甲', location: `新模块 ${moduleTitle}` });
      else if (module.bPresence === 'added') additions.push({ side: '乙', location: `新模块 ${moduleTitle}` });
      for (const step of module.steps) {
        const stepTitle = step.base?.title ?? step.a?.title ?? step.b?.title ?? step.id;
        if (step.aPresence === 'added' && step.bPresence === 'added') additions.push({ side: '甲乙', location: `${moduleTitle} · 新步骤 ${stepTitle}` });
        else if (step.aPresence === 'added') additions.push({ side: '甲', location: `${moduleTitle} · 新步骤 ${stepTitle}` });
        else if (step.bPresence === 'added') additions.push({ side: '乙', location: `${moduleTitle} · 新步骤 ${stepTitle}` });
      }
    }
    const total = items.length + additions.length;
    return (
      <section class={`auto-merge-panel ${this.showAutoMerge ? 'open' : ''}`}>
        <button class="auto-merge-head" onClick={() => { this.showAutoMerge = !this.showAutoMerge; }}>
          <span class="auto-merge-icon">✓</span>
          <strong>{total} 处改动已自动合并（不同字段各取各方、双方一致的新增自动并入）</strong>
          <span class="auto-merge-toggle">{this.showAutoMerge ? '收起 ▲' : '展开查看 ▼'}</span>
        </button>
        {this.showAutoMerge && (
          <div class="auto-merge-body">
            {items.map((item) => (
              <div class="auto-merge-row">
                <span class={`auto-side-tag ${item.side === '甲' ? 'a' : 'b'}`}>{item.side}</span>
                <span class="auto-location">{item.location}</span>
                <span class="auto-label">{item.label}</span>
                <span class="auto-value">{isColorValue(item.value) ? <span class="value-color"><i style={{ background: String(item.value) }} />{formatValue(item.value)}</span> : formatValue(item.value)}</span>
              </div>
            ))}
            {additions.map((item) => (
              <div class="auto-merge-row">
                <span class={`auto-side-tag ${item.side === '甲乙' ? 'both' : item.side === '甲' ? 'a' : 'b'}`}>{item.side}</span>
                <span class="auto-location">{item.location}</span>
                <span class="auto-label">新增</span>
                <span class="auto-value">自动并入</span>
              </div>
            ))}
            {total === 0 && <p class="no-change">没有需要自动合并的非冲突改动。</p>}
          </div>
        )}
      </section>
    );
  }

  private renderConflictsTab() {
    const report = this.report;
    const session = this.currentSession;
    if (!report || !session) {
      return <div class="merge-empty">从左侧选择一个进行中的合并会话，或新建三方合并。</div>;
    }
    const remaining = unresolvedCount(report, session.resolutions);
    const blocks: any[] = [];

    if (report.warnings.length) {
      blocks.push(
        <div class="merge-warnings">
          {report.warnings.map((warning) => <p>⚠ {warning}</p>)}
        </div>,
      );
    }

    const projectConflicts = report.projectDiffs.filter((diff) => diff.conflict);
    if (projectConflicts.length) {
      blocks.push(
        <section class="conflict-section">
          <h3>课程信息</h3>
          {projectConflicts.map((diff) => this.renderFieldConflict(diff, 'project', 'course'))}
        </section>,
      );
    }

    for (const module of report.modules) {
      const moduleTitle = module.base?.title ?? module.a?.title ?? module.b?.title ?? module.id;
      const moduleConflictElements: any[] = [];
      if (module.presenceConflict) {
        const deletedSide: Side = module.aPresence === 'deleted' ? 'a' : 'b';
        const editedSide: Side = deletedSide === 'a' ? 'b' : 'a';
        const changedFields = module.fieldDiffs.filter((diff) => (editedSide === 'a' ? diff.aChanged : diff.bChanged)).map((diff) => fieldLabel('module', diff.key)).join('、');
        const editedSteps = module.steps.filter((step) => (editedSide === 'a' ? step.aPresence !== 'deleted' : step.bPresence !== 'deleted') && step.fieldDiffs.some((diff) => (editedSide === 'a' ? diff.aChanged : diff.bChanged))).length;
        moduleConflictElements.push(this.renderPresenceConflict(moduleTitle, 'module', module.id, undefined, deletedSide, editedSide, [changedFields, editedSteps ? `${editedSteps} 个步骤的内容` : ''].filter(Boolean).join('、') || '模块内容'));
      }
      for (const diff of module.fieldDiffs) {
        if (diff.conflict) moduleConflictElements.push(this.renderFieldConflict(diff, 'module', module.id));
      }
      for (const step of module.steps) {
        const stepConflicts = this.renderStepConflicts(module, step);
        if (stepConflicts.length) {
          const stepTitle = step.base?.title ?? step.a?.title ?? step.b?.title ?? step.id;
          moduleConflictElements.push(
            <div class="step-conflict-wrap">
              <div class="step-conflict-title">步骤 · {stepTitle}</div>
              {stepConflicts}
            </div>,
          );
        }
      }
      const orderConflicts = module.stepOrderHunks.filter((hunk) => hunk.conflict);
      if (orderConflicts.length) {
        const titleById = new Map<string, string>();
        for (const step of module.steps) titleById.set(step.id, step.base?.title ?? step.a?.title ?? step.b?.title ?? step.id);
        moduleConflictElements.push(...orderConflicts.map((hunk) => this.renderOrderConflict(hunk, titleById, 'step')));
      }
      if (moduleConflictElements.length) {
        blocks.push(
          <section class="conflict-section">
            <h3>模块 · {moduleTitle}</h3>
            {moduleConflictElements}
          </section>,
        );
      }
    }

    const moduleOrderConflicts = report.moduleOrderHunks.filter((hunk) => hunk.conflict);
    if (moduleOrderConflicts.length) {
      const titleById = new Map<string, string>();
      for (const module of report.modules) titleById.set(module.id, module.base?.title ?? module.a?.title ?? module.b?.title ?? module.id);
      blocks.push(
        <section class="conflict-section">
          <h3>模块顺序</h3>
          {moduleOrderConflicts.map((hunk) => this.renderOrderConflict(hunk, titleById, 'module'))}
        </section>,
      );
    }

    if (session.status === 'completed') {
      return (
        <div class="conflicts-tab">
          <div class="merge-warnings">
            <p>该会话已完成合并，以下为当时的裁决结果（只读）；合并结果可在「合并预览」装入编辑器，完整记录可在「会话记录」追溯。</p>
          </div>
          {this.renderAutoMergeSummary(report)}
          {blocks}
        </div>
      );
    }
    return (
      <div class="conflicts-tab">
        {this.sessionReadonly && (
          <div class="merge-warnings">
            <p>该会话已放弃，以下裁决记录仅供查阅；冻结版本与两份副本均仍保留，可随时新建合并。</p>
          </div>
        )}
        {this.renderAutoMergeSummary(report)}
        <div class={`conflict-toolbar ${this.sessionReadonly ? 'readonly' : ''}`}>
          <div class="conflict-countdown">
            {this.sessionReadonly
              ? <strong>会话已放弃 · 共记录 {report.conflictCount} 项冲突</strong>
              : remaining === 0
                ? <strong class="all-done">全部冲突已裁决，可以完成合并</strong>
                : <strong>剩余 {remaining} 个冲突待处理</strong>}
            <span>共 {report.conflictCount} 个冲突 · 裁决会实时保存在本机</span>
          </div>
          {!this.sessionReadonly && (
            <div class="toolbar-buttons">
              <button class="ghost" onClick={() => this.resolveAllWith('a')}>全部选甲</button>
              <button class="ghost" onClick={() => this.resolveAllWith('b')}>全部选乙</button>
              <button class="primary" disabled={remaining > 0} onClick={() => this.completeMerge()}>完成合并</button>
            </div>
          )}
        </div>
        {blocks.length === 0
          ? <div class="merge-empty good">没有需要裁决的冲突——两边改动已全部自动合并{this.sessionReadonly ? '。' : '，直接点击“完成合并”即可。'}</div>
          : blocks}
      </div>
    );
  }

  private renderChangesTab() {
    const report = this.report;
    if (!report) return <div class="merge-empty">请先选择合并会话。</div>;
    const renderSide = (side: Side) => {
      const copy = side === 'a' ? report.aCopy : report.bCopy;
      const changes = listSideChanges(report, side);
      const groups: Record<string, typeof changes> = {};
      for (const change of changes) {
        const key = change.scope === 'project' ? '课程信息' : `模块 · ${report.modules.find((module) => module.id === change.moduleId)?.base?.title ?? copy.snapshot.modules.find((module) => module.id === change.moduleId)?.title ?? change.moduleId}`;
        (groups[key] ??= []).push(change);
      }
      return (
        <div class="changes-side">
          <div class={`changes-side-head ${side}`}>
            <strong>{side === 'a' ? '甲' : '乙'}方 · {copy.teacherName}</strong>
            <span>{this.formatDate(copy.exportedAt)} 导出 · {changes.length} 处改动{copy.note ? ` · ${copy.note}` : ''}</span>
          </div>
          <div class="changes-groups">
            {Object.entries(groups).map(([group, items]) => (
              <div class="changes-group">
                <h4>{group}</h4>
                <ul>
                  {items.map((change) => (
                    <li>
                      <span class={`presence-pill ${change.presence ?? 'modified'}`}>{change.presence === 'added' ? '新增' : change.presence === 'deleted' ? '删除' : '改'}</span>
                      <span class="change-entity">{change.scope === 'step' || change.scope === 'module' ? `${change.entityTitle} · ` : ''}{fieldLabel(change.scope, change.fieldLabel)}</span>
                      {!change.presence && <span class="change-values">{formatValue(change.from)} <i>→</i> {formatValue(change.to)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {changes.length === 0 && <p class="no-change">相对冻结版本没有改动。</p>}
          </div>
        </div>
      );
    };
    return (
      <div class="changes-tab">
        <div class="changes-base">基准：{report.frozenLabel}（{this.formatDate(report.frozenCreatedAt)} 冻结）</div>
        <div class="changes-grid">{renderSide('a')}{renderSide('b')}</div>
      </div>
    );
  }

  private renderPreviewTab() {
    const session = this.currentSession;
    const report = this.report;
    if (!session || !report) return <div class="merge-empty">请先选择合并会话。</div>;
    // 已完成 → 用最终快照；进行中 → 用当前裁决实时计算。
    const snapshot: any = session.resultSnapshot ?? buildMergedSnapshot(report, session.resolutions);
    const stats = {
      modules: snapshot.modules.length,
      steps: snapshot.modules.reduce((sum: number, module: any) => sum + module.steps.length, 0),
      minutes: Math.max(1, Math.round(snapshot.modules.reduce((sum: number, module: any) => sum + module.steps.reduce((total: number, step: any) => total + step.duration, 0), 0) / 60)),
    };
    return (
      <div class="preview-tab">
        <div class="preview-banner">
          <div>
            <strong>{snapshot.title}</strong>
            <span>{snapshot.teacher} · {snapshot.audience}</span>
          </div>
          <div class="preview-stats">
            <div><strong>{stats.modules}</strong><span>模块</span></div>
            <div><strong>{stats.steps}</strong><span>步骤</span></div>
            <div><strong>{stats.minutes}</strong><span>分钟</span></div>
          </div>
          {session.status === 'completed'
            ? <button class="primary" onClick={() => this.applyMerge()}>装入编辑器</button>
            : <span class="preview-hint">以下为按当前裁决实时计算的预览，完成合并后才能装入编辑器。</span>}
        </div>
        {snapshot.modules.map((module: any) => (
          <section class="preview-module">
            <header><i style={{ background: module.color }} /><strong>{module.title}</strong><span>{module.steps.length} 步 · {module.summary}</span></header>
            <ol>
              {module.steps.map((step: any, index: number) => (
                <li>
                  <span class="preview-index">{String(index + 1).padStart(2, '0')}</span>
                  <span class="preview-step-title">{step.title}</span>
                  <span class="preview-step-meta">{step.kind} · {step.duration}s · {step.difficulty}{step.prerequisiteId ? ' · 有前置' : ''}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    );
  }

  private renderSessionsTab() {
    return (
      <div class="sessions-tab">
        <button class="primary new-session" onClick={() => this.startNewSession()}>＋ 新建三方合并</button>
        {this.sessions.length === 0 && <div class="merge-empty">还没有合并会话。先在「离线副本」页导入两位老师交回的副本，再新建合并。</div>}
        <div class="session-list">
          {this.sessions.map((session) => (
            <div class={`session-card-wrap ${session.id === this.currentSessionId ? 'active' : ''}`}>
              <button class="session-card" onClick={() => this.activateSession(session.id)}>
                <div class="session-card-head">
                  <span class={`session-status ${session.status}`}>{session.status === 'completed' ? '已完成' : session.status === 'discarded' ? '已放弃' : '待裁决'}</span>
                  <strong>{session.frozenLabel}</strong>
                  <span class="session-date">{this.formatDate(session.updatedAt)}</span>
                </div>
                <p>甲：{session.aCopy.teacherName} ｜ 乙：{session.bCopy.teacherName}</p>
                <small>创建于 {this.formatDate(session.createdAt)}{session.completedAt ? ` · 完成于 ${this.formatDate(session.completedAt)}` : ''}</small>
              </button>
              <button class="session-purge" title="彻底删除该会话记录" onClick={() => this.purgeSession(session.id)}>×</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  private renderCopiesTab() {
    return (
      <div class="copies-tab">
        <section class="copies-export">
          <h3>导出离线副本</h3>
          <p>两位老师各自基于同一个冻结版本导出副本，离线编辑后再交回导入。单机演示时可导出后“装入编辑器”，改完再次导出。</p>
          <div class="export-actions">
            <button class="primary" onClick={() => this.exportCurrentCopy()}>导出当前课程为离线副本</button>
            <button class="ghost" onClick={() => this.triggerImport('library')}>导入交回的副本文件</button>
          </div>
          {this.project.frozenVersions.length > 0 && (
            <div class="frozen-export-list">
              <h4>按冻结版本导出干净副本</h4>
              {this.project.frozenVersions.map((version) => (
                <div class="frozen-export-row">
                  <span><strong>{version.label}</strong><i>{this.formatDate(version.createdAt)}</i></span>
                  <button class="ghost small" onClick={() => this.exportFromFrozen(version)}>导出此版本副本</button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section class="copies-library">
          <h3>本机副本（{this.copies.length}）</h3>
          {this.copies.length === 0 && <p class="no-change">本机还没有导入的副本，导入两位老师交回的 JSON 文件后即可发起合并。</p>}
          <div class="copy-list">
            {this.copies.map((copy, index) => (
              <div class="copy-card">
                <div class="copy-card-head">
                  <strong>{copy.teacherName}</strong>
                  <span>{this.formatDate(copy.exportedAt)}</span>
                </div>
                <p>{copy.snapshot.title}{copy.baseFrozenId ? ` · 基准 ${copy.baseFrozenId}` : ' · 未标注基准版本'}</p>
                <small>{copy.snapshot.modules.length} 模块 / {copy.snapshot.modules.reduce((sum: number, module: CourseModule) => sum + module.steps.length, 0)} 步骤{copy.note ? ` · ${copy.note}` : ''}</small>
                <div class="copy-card-actions">
                  <button class="ghost small" onClick={() => this.loadCopyIntoEditor(copy)}>装入编辑器</button>
                  <button class="ghost small danger" onClick={() => this.removeCopyAt(index)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  private renderNewSession() {
    if (!this.showNewSession) return null;
    const frozenVersions = this.project.frozenVersions;
    return (
      <div class="modal-overlay" onClick={() => this.cancelNewSession()}>
        <div class="new-session-dialog" onClick={(event) => event.stopPropagation()}>
          <h3>新建三方合并</h3>
          <p class="dialog-hint">先选冻结版本（共同祖先），再选甲、乙两份离线副本。合并会话会立刻保存在本机。</p>
          <label>
            冻结版本（基准）
            <select onChange={(event) => { this.draftBaseId = (event.target as HTMLSelectElement).value; }}>
              {frozenVersions.length === 0 && <option value="">（还没有冻结版本，请先在主界面冻结）</option>}
              {frozenVersions.map((version) => <option value={version.id} selected={version.id === this.draftBaseId}>{version.label} · {this.formatDate(version.createdAt)}</option>)}
            </select>
          </label>
          {[
            { side: 'a' as const, key: 'draftACopyKey' as const, label: '甲方离线副本' },
            { side: 'b' as const, key: 'draftBCopyKey' as const, label: '乙方离线副本' },
          ].map((row) => (
            <label>
              {`${row.side === 'a' ? '甲' : '乙'} · ${row.label}`}
              <div class="copy-select-row">
                <select onChange={(event) => { this.setDraftCopy(row.side, (event.target as HTMLSelectElement).value); }}>
                  <option value="">请选择已导入的副本…</option>
                  {this.copies.map((copy) => <option value={this.copyKey(copy)} selected={this.copyKey(copy) === this.getDraftCopy(row.side)}>{copy.teacherName} · {this.formatDate(copy.exportedAt)} · {copy.snapshot.title}</option>)}
                </select>
                <button class="ghost small" onClick={() => this.triggerImport(row.side)}>导入文件</button>
              </div>
            </label>
          ))}
          <div class="dialog-actions">
            <button class="ghost" onClick={() => this.cancelNewSession()}>取消</button>
            <button class="primary" onClick={() => this.confirmCreateSession()}>创建合并会话</button>
          </div>
        </div>
      </div>
    );
  }

  render() {
    if (!this.open) return <Host hidden />;
    const session = this.currentSession;
    const pendingCount = this.sessions.filter((item) => item.status === 'pending').length;
    return (
      <Host>
        <div class="merge-backdrop" onClick={() => this.close()} />
        <div class="merge-modal" role="dialog" aria-modal="true">
          <header class="merge-header">
            <div class="merge-title">
              <span class="merge-glyph">并</span>
              <div>
                <strong>离线副本合并中心</strong>
                <span>{this.report ? `基准 ${this.report.frozenLabel} · 甲 ${this.report.aCopy.teacherName} × 乙 ${this.report.bCopy.teacherName}` : '以冻结版本为基准的三方合并'}</span>
              </div>
            </div>
            <button class="close-button" onClick={() => this.close()}>×</button>
          </header>
          <nav class="merge-tabs">
            {([
              ['conflicts', '冲突裁决', session?.status === 'pending' && this.report ? unresolvedCount(this.report, session.resolutions) : 0],
              ['changes', '两边改动', null],
              ['preview', '合并预览', null],
              ['sessions', `会话记录${pendingCount ? `（${pendingCount} 待处理）` : ''}`, null],
              ['copies', '离线副本', null],
            ] as Array<[Tab, string, number | null]>).map(([key, label, count]) => (
              <button class={this.tab === key ? 'active' : ''} onClick={() => this.setTab(key)}>
                {label}
                {count ? <span class="tab-count">{count}</span> : null}
              </button>
            ))}
          </nav>
          {this.notice && <div class={`merge-notice ${this.notice.kind}`}>{this.notice.message}</div>}
          <div class="merge-body">
            {this.tab === 'conflicts' && this.renderConflictsTab()}
            {this.tab === 'changes' && this.renderChangesTab()}
            {this.tab === 'preview' && this.renderPreviewTab()}
            {this.tab === 'sessions' && this.renderSessionsTab()}
            {this.tab === 'copies' && this.renderCopiesTab()}
          </div>
          {session && this.tab === 'conflicts' && (
            <footer class="merge-footer">
              {session.status === 'pending'
                ? <button class="ghost danger" onClick={() => this.discardSession()}>放弃会话（记录仍保留可追溯）</button>
                : <span class="footer-placeholder">只读视图 · 处理记录已存档</span>}
              <span>裁决实时保存到本机 localStorage，关闭或刷新页面后可在「会话记录」继续。</span>
            </footer>
          )}
          <input type="file" accept="application/json,.json" hidden ref={(el) => { this.fileInput = el as HTMLInputElement; }} onChange={(event) => this.handleFile(event)} />
          {this.renderNewSession()}
        </div>
      </Host>
    );
  }
}
