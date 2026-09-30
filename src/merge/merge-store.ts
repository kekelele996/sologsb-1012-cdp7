/**
 * 合并会话的本地持久化：
 * - 离线副本的导出 / 导入（JSON 文件，离线可流转）。
 * - 合并会话（基准冻结版本 + 甲乙副本 + 老师的逐项裁决）始终保存在 localStorage，
 *   即使中途关闭页面、合并未完成，重开后仍可继续处理，不会丢任何一份记录。
 */

import type { CourseProject, FrozenVersion } from '../models';
import {
  buildMergeReport,
  buildMergedSnapshot,
  emptyResolutions,
  type MergeReport,
  type MergeResolutions,
  type OfflineCopy,
} from './merge-engine';

export type { OfflineCopy } from './merge-engine';

const SESSIONS_KEY = 'sologsb-1012-merge-sessions-v1';
const COPIES_KEY = 'sologsb-1012-offline-copies-v1';

export type SessionStatus = 'pending' | 'completed' | 'discarded';

export interface MergeSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  frozenId: string;
  frozenLabel: string;
  /** 冻结版本快照（完整留底，不依赖课程后续编辑）。 */
  frozen: FrozenVersion;
  aCopy: OfflineCopy;
  bCopy: OfflineCopy;
  /** 老师在冲突项上的裁决，随时保存。 */
  resolutions: MergeResolutions;
  /** 完成合并后生成的课程快照；未完成时为 undefined。 */
  resultSnapshot?: unknown;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// 离线副本
// ---------------------------------------------------------------------------

export type SnapshotSource = Omit<CourseProject, 'frozenVersions'>;

export function createOfflineCopy(project: CourseProject, teacherName: string, note: string, baseFrozenId?: string): OfflineCopy {
  const { frozenVersions: _ignored, ...snapshot } = project;
  return {
    teacherName: teacherName.trim() || '未署名老师',
    note: note.trim() || undefined,
    exportedAt: new Date().toISOString(),
    baseFrozenId,
    snapshot: structuredClone(snapshot),
  };
}

/** 校验导入的 JSON 是否是一份结构完整的离线副本。 */
export function parseOfflineCopy(text: string): OfflineCopy {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，请确认导出的副本没有损坏。');
  }
  const copy = data as Partial<OfflineCopy>;
  if (!copy || typeof copy !== 'object' || !copy.snapshot || typeof copy.snapshot !== 'object') {
    throw new Error('副本内容缺少课程快照（snapshot）字段。');
  }
  const snapshot = copy.snapshot as Partial<SnapshotSource>;
  if (!Array.isArray(snapshot.modules) || typeof snapshot.title !== 'string') {
    throw new Error('副本快照结构不完整，缺少 modules 或 title。');
  }
  for (const module of snapshot.modules) {
    if (!module || typeof module.id !== 'string' || !Array.isArray(module.steps)) {
      throw new Error('副本中存在结构异常的模块，无法安全导入。');
    }
    for (const step of module.steps) {
      if (!step || typeof step.id !== 'string') throw new Error('副本中存在缺少 id 的学习步骤，无法安全导入。');
    }
  }
  return {
    teacherName: typeof copy.teacherName === 'string' && copy.teacherName.trim() ? copy.teacherName : '未署名老师',
    note: typeof copy.note === 'string' ? copy.note : undefined,
    exportedAt: typeof copy.exportedAt === 'string' ? copy.exportedAt : new Date(0).toISOString(),
    baseFrozenId: typeof copy.baseFrozenId === 'string' ? copy.baseFrozenId : undefined,
    snapshot: snapshot as OfflineCopy['snapshot'],
  };
}

export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 本机暂存的已导入副本（方便重开后再次发起合并）。 */
export function loadImportedCopies(): OfflineCopy[] {
  try {
    const raw = localStorage.getItem(COPIES_KEY);
    return raw ? (JSON.parse(raw) as OfflineCopy[]) : [];
  } catch {
    return [];
  }
}

export function saveImportedCopies(copies: OfflineCopy[]): void {
  localStorage.setItem(COPIES_KEY, JSON.stringify(copies));
}

/** 加入一份副本（按 老师+导出时间+基准版本 去重），返回更新后的列表。 */
export function addImportedCopy(copy: OfflineCopy): OfflineCopy[] {
  const copies = loadImportedCopies();
  const duplicate = copies.some(
    (item) => item.teacherName === copy.teacherName &&
      item.exportedAt === copy.exportedAt &&
      item.baseFrozenId === copy.baseFrozenId &&
      JSON.stringify(item.snapshot) === JSON.stringify(copy.snapshot),
  );
  if (!duplicate) copies.unshift(copy);
  saveImportedCopies(copies);
  return copies;
}

export function removeImportedCopy(index: number): OfflineCopy[] {
  const copies = loadImportedCopies();
  copies.splice(index, 1);
  saveImportedCopies(copies);
  return copies;
}

// ---------------------------------------------------------------------------
// 合并会话
// ---------------------------------------------------------------------------

export function loadSessions(): MergeSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const list = raw ? (JSON.parse(raw) as MergeSession[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persistSessions(sessions: MergeSession[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function upsertSession(session: MergeSession): void {
  const sessions = loadSessions();
  const index = sessions.findIndex((item) => item.id === session.id);
  session.updatedAt = new Date().toISOString();
  if (index >= 0) sessions[index] = session;
  else sessions.unshift(session);
  persistSessions(sessions);
}

export function deleteSession(sessionId: string): void {
  persistSessions(loadSessions().filter((item) => item.id !== sessionId));
}

export function createSession(frozen: FrozenVersion, aCopy: OfflineCopy, bCopy: OfflineCopy): MergeSession {
  const session: MergeSession = {
    id: `merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending',
    frozenId: frozen.id,
    frozenLabel: frozen.label,
    frozen: structuredClone(frozen),
    aCopy: structuredClone(aCopy),
    bCopy: structuredClone(bCopy),
    resolutions: emptyResolutions(),
  };
  upsertSession(session);
  return session;
}

export function sessionReport(session: MergeSession): MergeReport {
  return buildMergeReport({ frozen: session.frozen, aCopy: session.aCopy, bCopy: session.bCopy });
}

export function completeSession(session: MergeSession, resolutions: MergeResolutions): MergeSession {
  const report = sessionReport(session);
  const resultSnapshot = buildMergedSnapshot(report, resolutions);
  const completed: MergeSession = {
    ...session,
    resolutions: structuredClone(resolutions),
    status: 'completed',
    resultSnapshot,
    completedAt: new Date().toISOString(),
  };
  upsertSession(completed);
  return completed;
}
