/** 合并界面用到的字段中文名与值展示格式化。 */

export const FIELD_LABELS: Record<string, string> = {
  // 项目级
  title: '标题',
  teacher: '授课教师',
  audience: '目标学习者',
  // 模块级
  summary: '模块目标',
  color: '主题色',
  // 步骤级
  kind: '步骤类型',
  duration: '预计时长',
  demoTitle: '示范片段名称',
  demoUrl: '本地素材地址',
  handshape: '手形说明',
  gestureZone: '主要手形区域',
  caption: '字幕',
  captionPosition: '字幕位置',
  camera: '镜头角度',
  commonMistakes: '常见错误',
  exercise: '练习任务',
  exerciseFeedback: '练习反馈',
  altText: '替代文本',
  prerequisiteId: '前置步骤',
  difficulty: '难度标签',
  cuePoints: '检查点',
};

export function fieldLabel(_scope: string, key: string): string {
  return FIELD_LABELS[key] ?? key;
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) {
    if (value.length === 0) return '（空列表）';
    if (typeof value[0] === 'number') return value.map((item) => `${item}s`).join('、');
    return value.map((item) => String(item)).join('、');
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export function isColorValue(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);
}
