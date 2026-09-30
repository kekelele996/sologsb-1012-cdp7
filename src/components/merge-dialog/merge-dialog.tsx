import { Component, Event, EventEmitter, Host, Prop, State, Watch, h } from '@stencil/core';
import {
  buildMergedProject,
  candidateBases,
  computeMerge,
  createMergeRecord,
  deleteMergeRecord,
  displayValue,
  loadMergeRecords,
  recomputeRecord,
  upsertMergeRecord,
  type MergeChangeGroup,
  type MergeConflict,
  type MergeRecord,
} from '../../merge';
import { STORAGE_KEY, type CourseProject } from '../../models';

type Tab = 'new' | 'records';

@Component({
  tag: 'merge-dialog',
  styleUrl: 'merge-dialog.css',
  scoped: true,
})
export class MergeDialog {
  @Prop() open = false;
  @Event() close!: EventEmitter;
  @Event() applied!: EventEmitter;

  @State() tab: Tab = 'new';
  @State() records: MergeRecord[] = [];
  @State() activeId?: string;
  @State() rawA = '';
  @State() rawB = '';
  @State() fileNameA = '';
  @State() fileNameB = '';
  @State() nameA = '老师甲';
  @State() nameB = '老师乙';
  @State() baseOverride = '';
  @State() loadError = '';

  componentWillLoad(): void {
    this.records = loadMergeRecords();
  }

  @Watch('open')
  handleOpenChange(value: boolean): void {
    if (value) {
      this.records = loadMergeRecords();
      if (this.activeId && !this.records.some((r) => r.id === this.activeId)) this.activeId = undefined;
    }
  }

  private get activeRecord(): MergeRecord | undefined {
    return this.records.find((record) => record.id === this.activeId);
  }

  private activeComputation() {
    const record = this.activeRecord;
    if (!record?.baseSnapshot || !record.sideASnapshot || !record.sideBSnapshot) return undefined;
    // 实时重算，保证 resolutions 变化后统计与冲突同步
    return computeMerge(record.baseSnapshot, record.sideASnapshot, record.sideBSnapshot);
  }

  private async readFile(file: File, side: 'A' | 'B'): Promise<void> {
    const text = await file.text();
    if (side === 'A') {
      this.rawA = text;
      this.fileNameA = file.name;
    } else {
      this.rawB = text;
      this.fileNameB = file.name;
    }
    this.loadError = '';
  }

  private createSession(): void {
    if (!this.rawA || !this.rawB) {
      this.loadError = '请先选择两位老师的离线副本文件。';
      return;
    }
    const record = createMergeRecord(this.rawA, this.rawB, this.nameA.trim() || '老师甲', this.nameB.trim() || '老师乙', this.baseOverride || undefined);
    this.records = upsertMergeRecord(record);
    this.activeId = record.id;
    this.tab = 'records';
  }

  private retrySession(record: MergeRecord): void {
    const updated = recomputeRecord(record, this.baseOverride || record.baseId);
    this.records = upsertMergeRecord(updated);
    this.activeId = updated.id;
  }

  private resolveConflict(record: MergeRecord, key: string, value: string): void {
    const resolutions = { ...record.resolutions, [key]: value };
    const updated = recomputeRecord({ ...record, resolutions }, record.baseId);
    this.records = upsertMergeRecord(updated);
  }

  private applyMerge(record: MergeRecord): void {
    if (!record.baseSnapshot || !record.sideASnapshot || !record.sideBSnapshot) return;
    let merged: CourseProject;
    try {
      merged = buildMergedProject(record.baseSnapshot, record.sideASnapshot, record.sideBSnapshot, record.resolutions);
    } catch (error) {
      this.loadError = `还有冲突没有处理完：${(error as Error).message}`;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (error) {
      this.loadError = `合并结果写入本机失败：${(error as Error).message}`;
      return;
    }
    const applied: MergeRecord = { ...record, status: 'applied', mergedSnapshot: merged, failureReason: undefined };
    this.records = upsertMergeRecord(applied);
    this.applied.emit();
    this.close.emit();
  }

  private removeRecord(recordId: string): void {
    this.records = deleteMergeRecord(recordId);
    if (this.activeId === recordId) this.activeId = undefined;
  }

  private exportCurrentCopy(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.loadError = '本机还没有课程数据。';
        return;
      }
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `signcourse-copy-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.loadError = `导出失败：${(error as Error).message}`;
    }
  }

  private formatTime(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：导入新区                                                    */
  /* ---------------------------------------------------------------- */

  private renderNewTab() {
    const baseCandidates = this.rawA && this.rawB ? candidateBases(
      (() => { try { return JSON.parse(this.rawA); } catch { return undefined; } })(),
      (() => { try { return JSON.parse(this.rawB); } catch { return undefined; } })(),
    ) : [];
    return (
      <div class="merge-new">
        <p class="merge-hint">
          两位老师各自导出离线副本、改完交回后，在这里导入两份 JSON。系统会以<strong>冻结版本</strong>为基准做三方合并：
          同一步骤的不同字段改动自动并到一起；同一字段两边都改过的会保留两版供挑选；一边删除、另一边仍在修改的步骤会先保留。
          合并记录保存在本机，关掉页面再打开也能继续处理。
        </p>

        <div class="merge-import-grid">
          <label class="import-card">
            <span class="import-side">甲</span>
            <span class="import-name">
              <input value={this.nameA} onInput={(event) => { this.nameA = (event.target as HTMLInputElement).value; }} />
            </span>
            <span class="import-file">{this.fileNameA || '点击选择老师甲的副本 JSON'}</span>
            <input type="file" accept="application/json,.json" onChange={(event) => {
              const file = (event.target as HTMLInputElement).files?.[0];
              if (file) void this.readFile(file, 'A');
            }} />
          </label>

          <label class="import-card">
            <span class="import-side">乙</span>
            <span class="import-name">
              <input value={this.nameB} onInput={(event) => { this.nameB = (event.target as HTMLInputElement).value; }} />
            </span>
            <span class="import-file">{this.fileNameB || '点击选择老师乙的副本 JSON'}</span>
            <input type="file" accept="application/json,.json" onChange={(event) => {
              const file = (event.target as HTMLInputElement).files?.[0];
              if (file) void this.readFile(file, 'B');
            }} />
          </label>
        </div>

        {baseCandidates.length > 0 && (
          <div class="base-picker">
            <span>合并基准（冻结版本）：</span>
            <select onChange={(event) => { this.baseOverride = (event.target as HTMLSelectElement).value; }}>
              <option value="" selected={this.baseOverride === ''}>自动选择共同的最新冻结版本</option>
              {baseCandidates.map((fv) => <option value={fv.id} selected={this.baseOverride === fv.id}>{fv.label} · {this.formatTime(fv.createdAt)}</option>)}
            </select>
          </div>
        )}

        {this.loadError && <div class="merge-error">{this.loadError}</div>}

        <div class="merge-actions">
          <button class="merge-btn primary" onClick={() => this.createSession()}>开始合并</button>
          <button class="merge-btn" onClick={() => this.exportCurrentCopy()}>导出当前课程副本</button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：改动清单                                                    */
  /* ---------------------------------------------------------------- */

  private renderChangeGroup(group: MergeChangeGroup, side: 'A' | 'B') {
    const actionLabel = group.action === 'added' ? '新增' : group.action === 'deleted' ? '删除' : '修改';
    const actionClass = `action-${group.action}`;
    const scopeLabel = group.scope === 'project' ? '课程' : group.scope === 'module' ? '模块' : '步骤';
    const title = group.scope === 'project'
      ? '课程信息（标题 / 教师 / 学员）'
      : group.scope === 'module'
        ? `模块「${group.moduleTitle ?? group.moduleId}」`
        : `步骤「${group.stepTitle ?? group.stepId}」`;
    return (
      <div class={`change-group ${actionClass}`} key={`${side}-${group.scope}-${group.moduleId ?? ''}-${group.stepId ?? ''}-${group.action}`}>
        <div class="change-head">
          <span class={`change-badge ${actionClass}`}>{actionLabel}</span>
          <span class="change-scope">{scopeLabel}</span>
          <strong class="change-title">{title}</strong>
        </div>
        {group.fields.length > 0 && (
          <ul class="change-fields">
            {group.fields.map((field) => {
              const value = side === 'A' ? field.aValue : field.bValue;
              return (
                <li>
                  <span class="field-name">{field.fieldLabel}</span>
                  <span class="field-arrow">{displayValue(field.baseValue)} →</span>
                  <span class="field-new">{displayValue(value)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  private renderChanges(record: MergeRecord) {
    const computation = this.activeComputation();
    if (!computation) return null;
    return (
      <div class="merge-changes">
        <div class="changes-column">
          <h4>{record.sideAName}的改动 <small>相对冻结版本</small></h4>
          {computation.changesA.length === 0 && <p class="changes-empty">没有改动。</p>}
          {computation.changesA.map((group) => this.renderChangeGroup(group, 'A'))}
        </div>
        <div class="changes-column">
          <h4>{record.sideBName}的改动 <small>相对冻结版本</small></h4>
          {computation.changesB.length === 0 && <p class="changes-empty">没有改动。</p>}
          {computation.changesB.map((group) => this.renderChangeGroup(group, 'B'))}
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：冲突处理                                                    */
  /* ---------------------------------------------------------------- */

  private renderFieldConflict(record: MergeRecord, conflict: MergeConflict) {
    const resolution = record.resolutions[conflict.key];
    return (
      <div class="conflict-card field-conflict" key={conflict.key}>
        <div class="conflict-head">
          <span class="conflict-kind">同字段两版</span>
          <strong>{conflict.title}</strong>
          <span class="conflict-field">{conflict.fieldLabel}</span>
        </div>
        <div class="conflict-base">冻结版：{displayValue(conflict.baseValue)}</div>
        <div class="conflict-choices">
          <button class={`choice-card ${resolution === 'A' ? 'selected' : ''}`} onClick={() => this.resolveConflict(record, conflict.key, 'A')}>
            <span class="choice-side">甲 · {record.sideAName}</span>
            <span class="choice-value">{displayValue(conflict.aValue)}</span>
            <span class="choice-pick">{resolution === 'A' ? '✓ 已选这版' : '保留这版'}</span>
          </button>
          <button class={`choice-card ${resolution === 'B' ? 'selected' : ''}`} onClick={() => this.resolveConflict(record, conflict.key, 'B')}>
            <span class="choice-side">乙 · {record.sideBName}</span>
            <span class="choice-value">{displayValue(conflict.bValue)}</span>
            <span class="choice-pick">{resolution === 'B' ? '✓ 已选这版' : '保留这版'}</span>
          </button>
        </div>
      </div>
    );
  }

  private renderDeleteConflict(record: MergeRecord, conflict: MergeConflict) {
    const resolution = record.resolutions[conflict.key] ?? 'keep';
    const deletedByName = conflict.deletedBy === 'A' ? record.sideAName : record.sideBName;
    const modifiedByName = conflict.modifiedBy === 'A' ? record.sideAName : record.sideBName;
    const fields = (conflict.aValue as { fieldLabel: string; baseValue: unknown; aValue: unknown }[] | undefined) ?? [];
    return (
      <div class="conflict-card delete-conflict" key={conflict.key}>
        <div class="conflict-head">
          <span class="conflict-kind delete">删除 vs 仍在修改</span>
          <strong>{conflict.title}</strong>
        </div>
        <p class="delete-note">
          {deletedByName}已删除{conflict.scope === 'module' ? '模块' : '步骤'}，{modifiedByName}仍在修改并补充了内容。
          按约定先保留，不直接丢弃；合并后可在课程中继续处理。
        </p>
        {fields.length > 0 && (
          <ul class="change-fields">
            {fields.map((field) => (
              <li>
                <span class="field-name">{field.fieldLabel}</span>
                <span class="field-arrow">{displayValue(field.baseValue)} →</span>
                <span class="field-new">{displayValue(field.aValue)}</span>
              </li>
            ))}
          </ul>
        )}
        <div class="conflict-choices two">
          <button class={`choice-card ${resolution === 'keep' ? 'selected' : ''}`} onClick={() => this.resolveConflict(record, conflict.key, 'keep')}>
            <span class="choice-side">保留{conflict.scope === 'module' ? '模块' : '步骤'}</span>
            <span class="choice-value">保留{modifiedByName}的修改内容</span>
            <span class="choice-pick">{resolution === 'keep' ? '✓ 已选' : '先留着'}</span>
          </button>
          <button class={`choice-card ${resolution === 'base' ? 'selected' : ''}`} onClick={() => this.resolveConflict(record, conflict.key, 'base')}>
            <span class="choice-side">恢复冻结版</span>
            <span class="choice-value">丢弃修改，恢复为冻结版原样</span>
            <span class="choice-pick">{resolution === 'base' ? '✓ 已选' : '恢复冻结版'}</span>
          </button>
        </div>
      </div>
    );
  }

  private renderOrderConflict(record: MergeRecord, conflict: MergeConflict) {
    const resolution = record.resolutions[conflict.key] ?? 'base';
    const orderLabels = (ids: string[], project?: CourseProject): string => {
      if (!project) return ids.join(' → ');
      if (conflict.scope === 'module') return ids.map((id) => project.modules.find((m) => m.id === id)?.title ?? id).join(' → ');
      const mod = project.modules.find((m) => m.id === conflict.moduleId);
      return ids.map((id) => mod?.steps.find((s) => s.id === id)?.title ?? id).join(' → ');
    };
    const aOrder = conflict.scope === 'module'
      ? (record.sideASnapshot?.modules.map((m) => m.id) ?? [])
      : (record.sideASnapshot?.modules.find((m) => m.id === conflict.moduleId)?.steps.map((s) => s.id) ?? []);
    const bOrder = conflict.scope === 'module'
      ? (record.sideBSnapshot?.modules.map((m) => m.id) ?? [])
      : (record.sideBSnapshot?.modules.find((m) => m.id === conflict.moduleId)?.steps.map((s) => s.id) ?? []);
    const baseOrder = conflict.scope === 'module'
      ? (record.baseSnapshot?.modules.map((m) => m.id) ?? [])
      : (record.baseSnapshot?.modules.find((m) => m.id === conflict.moduleId)?.steps.map((s) => s.id) ?? []);
    return (
      <div class="conflict-card order-conflict" key={conflict.key}>
        <div class="conflict-head">
          <span class="conflict-kind order">顺序冲突</span>
          <strong>{conflict.title}</strong>
        </div>
        <div class="conflict-choices three">
          {conflict.orderOptions?.map((option) => {
            const order = option.value === 'A' ? aOrder : option.value === 'B' ? bOrder : baseOrder;
            return (
              <button class={`choice-card ${resolution === option.value ? 'selected' : ''}`} onClick={() => this.resolveConflict(record, conflict.key, option.value)}>
                <span class="choice-side">{option.label}</span>
                <span class="choice-value order-value">{orderLabels(order, option.value === 'A' ? record.sideASnapshot : option.value === 'B' ? record.sideBSnapshot : record.baseSnapshot)}</span>
                <span class="choice-pick">{resolution === option.value ? '✓ 已选' : '按此顺序'}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  private renderConflicts(record: MergeRecord) {
    const computation = this.activeComputation();
    if (!computation) return null;
    const fieldConflicts = computation.conflicts.filter((c) => c.kind === 'field');
    const deleteConflicts = computation.conflicts.filter((c) => c.kind === 'delete-modify');
    const orderConflicts = computation.conflicts.filter((c) => c.kind === 'order');
    const unresolved = computation.conflicts.filter((c) => {
      if (c.kind === 'field') return !record.resolutions[c.key];
      return false;
    }).length;

    return (
      <div class="merge-conflicts">
        <div class="conflicts-summary">
          <span>自动合并 <strong>{computation.stats.autoMerged}</strong> 处</span>
          <span class={fieldConflicts.length ? 'has-pending' : ''}>同字段冲突 <strong>{fieldConflicts.length}</strong> 处{unresolved > 0 && `（${unresolved} 处待选）`}</span>
          <span>保留待删 <strong>{deleteConflicts.length}</strong> 处</span>
          <span>顺序冲突 <strong>{orderConflicts.length}</strong> 处</span>
          <span>新增 <strong>{computation.stats.added}</strong> · 纯删除 <strong>{computation.stats.deleted}</strong></span>
        </div>

        {computation.conflicts.length === 0 && (
          <div class="all-clear">✓ 没有冲突：两边的改动互不重叠，可直接应用合并。</div>
        )}

        {orderConflicts.map((conflict) => this.renderOrderConflict(record, conflict))}
        {deleteConflicts.map((conflict) => this.renderDeleteConflict(record, conflict))}
        {fieldConflicts.map((conflict) => this.renderFieldConflict(record, conflict))}
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：会话头部                                                    */
  /* ---------------------------------------------------------------- */

  private renderSession() {
    const record = this.activeRecord;
    if (!record) return null;
    const failed = record.status === 'failed';
    const computation = this.activeComputation();
    const unresolvedCount = computation?.conflicts.filter((c) => c.kind === 'field' && !record.resolutions[c.key]).length ?? 0;

    return (
      <div class="merge-session">
        <div class="session-head">
          <button class="back-btn" onClick={() => { this.activeId = undefined; this.tab = 'records'; }}>← 全部记录</button>
          <div class="session-meta">
            <strong>{record.label}</strong>
            <span>冻结基准：{record.baseLabel ?? '—'} · {record.baseSnapshot ? this.formatTime(record.baseSnapshot.lastSavedAt) : ''}</span>
            <span>{record.sideAName} ↔ {record.sideBName} · 创建于 {this.formatTime(record.createdAt)}</span>
          </div>
        </div>

        {failed && (
          <div class="merge-error session-error">
            <strong>这次合并没能进行：</strong>{record.failureReason}
            {record.sideASnapshot && record.sideBSnapshot && (
              <div class="base-picker">
                <span>重新选择冻结基准：</span>
                <select onChange={(event) => { this.baseOverride = (event.target as HTMLSelectElement).value; }}>
                  <option value="" selected={this.baseOverride === ''}>自动选择共同的最新冻结版本</option>
                  {candidateBases(record.sideASnapshot, record.sideBSnapshot).map((fv) => (
                    <option value={fv.id} selected={this.baseOverride === fv.id}>{fv.label} · {this.formatTime(fv.createdAt)}</option>
                  ))}
                </select>
                <button class="merge-btn small" onClick={() => this.retrySession(record)}>重试合并</button>
              </div>
            )}
            {(!record.sideASnapshot || !record.sideBSnapshot) && (
              <div class="base-picker">
                <button class="merge-btn small" onClick={() => { this.activeId = undefined; this.tab = 'new'; }}>重新导入副本</button>
              </div>
            )}
          </div>
        )}

        {!failed && (
          <div class="session-body">
            {this.renderChanges(record)}
            {this.renderConflicts(record)}
            {this.loadError && <div class="merge-error">{this.loadError}</div>}
            <div class="merge-actions">
              <button class="merge-btn primary" disabled={unresolvedCount > 0} onClick={() => this.applyMerge(record)}>
                {unresolvedCount > 0 ? `还有 ${unresolvedCount} 处同字段冲突待选择` : '应用合并结果'}
              </button>
              <button class="merge-btn" onClick={() => { this.records = loadMergeRecords(); this.activeId = undefined; }}>保存并稍后处理</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* 渲染：记录列表                                                    */
  /* ---------------------------------------------------------------- */

  private renderRecordsTab() {
    return (
      <div class="merge-records">
        <div class="merge-actions top">
          <button class="merge-btn primary" onClick={() => { this.tab = 'new'; }}>＋ 导入两份新副本</button>
          <button class="merge-btn" onClick={() => this.exportCurrentCopy()}>导出当前课程副本</button>
        </div>
        {this.records.length === 0 && <p class="records-empty">还没有合并记录。导入两份离线副本开始吧。</p>}
        <ul class="record-list">
          {this.records.map((record) => (
            <li class={`record-item status-${record.status}`} key={record.id}>
              <div class="record-info">
                <strong>{record.label}</strong>
                <span>{record.sideAName} ↔ {record.sideBName} · {this.formatTime(record.createdAt)}</span>
                <span class="record-status">
                  {record.status === 'pending' && '● 待处理'}
                  {record.status === 'applied' && '✓ 已应用'}
                  {record.status === 'failed' && '✕ 合并失败（可重试）'}
                </span>
                {record.status === 'failed' && <span class="record-reason">{record.failureReason}</span>}
              </div>
              <div class="record-actions">
                {record.status === 'pending' && <button class="merge-btn small primary" onClick={() => { this.activeId = record.id; }}>继续处理</button>}
                {record.status === 'failed' && record.sideASnapshot && record.sideBSnapshot && (
                  <button class="merge-btn small primary" onClick={() => { this.baseOverride = ''; this.retrySession(record); }}>重试</button>
                )}
                {record.status === 'applied' && <button class="merge-btn small" onClick={() => { this.activeId = record.id; }}>查看</button>}
                <button class="merge-btn small danger" onClick={() => this.removeRecord(record.id)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  render() {
    if (!this.open) return null;
    return (
      <Host>
        <div class="merge-backdrop" onClick={() => this.close.emit()}>
          <div class="merge-modal" onClick={(event) => event.stopPropagation()}>
            <header class="merge-modal-head">
              <h3>离线副本合并</h3>
              <button class="merge-close" onClick={() => this.close.emit()}>×</button>
            </header>
            <div class="merge-tabs">
              <button class={this.tab === 'new' && !this.activeId ? 'active' : ''} onClick={() => { this.tab = 'new'; this.activeId = undefined; }}>导入副本</button>
              <button class={this.tab === 'records' ? 'active' : ''} onClick={() => { this.tab = 'records'; this.activeId = undefined; }}>
                合并记录{this.records.filter((r) => r.status === 'pending').length > 0 && <em>{this.records.filter((r) => r.status === 'pending').length}</em>}
              </button>
            </div>
            <div class="merge-modal-body">
              {this.activeId ? this.renderSession() : this.tab === 'new' ? this.renderNewTab() : this.renderRecordsTab()}
            </div>
          </div>
        </div>
      </Host>
    );
  }
}
