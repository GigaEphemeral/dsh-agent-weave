/**
 * Weave 看板样式（MVP-5B UI 重构）。
 *
 * 以 TS 模块导出 CSS 字符串，由 WeaveBoard 注入 <style> 标签
 * （esbuild 单产物打包不支持 .css 入口，项目现状用内联 style）。
 */
export const BOARD_CSS = `
/* ══════════════════════════════════════════════════════════
   设计令牌
   ══════════════════════════════════════════════════════════ */
.weave-board {
  --w-bg: #ffffff;
  --w-bg-soft: #fafbfc;
  --w-bg-mute: #f4f6f8;
  --w-border: #e5e7eb;
  --w-border-strong: #d1d5db;
  --w-text: #0f172a;
  --w-text-2: #475569;
  --w-text-3: #94a3b8;
  --w-brand: #4f46e5;
  --w-brand-hover: #4338ca;
  --w-brand-soft: #eef2ff;
  --w-brand-border: #c7d2fe;
  --w-success: #10b981;
  --w-success-soft: #ecfdf5;
  --w-warn: #f59e0b;
  --w-warn-soft: #fffbeb;
  --w-danger: #ef4444;
  --w-danger-soft: #fef2f2;
  --w-shadow-sm: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04);
  --w-shadow-md: 0 4px 12px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.04);
  --w-ease: cubic-bezier(0.4, 0, 0.2, 1);

  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--w-bg);
  color: var(--w-text);
  font-size: 13.5px;
  line-height: 1.5;
}

.weave-board button { font-family: inherit; }

/* ══════════════════════════════════════════════════════════
   工具栏
   ══════════════════════════════════════════════════════════ */
.board-toolbar {
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg);
}
.toolbar-left { display: flex; align-items: center; gap: 12px; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #cbd5e1; flex: 0 0 8px; position: relative;
}
.status-dot.running { background: var(--w-success); }
.status-dot.running::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: var(--w-success); opacity: .3;
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.status-dot.paused, .status-dot.awaiting { background: var(--w-warn); }
.status-dot.paused::after, .status-dot.awaiting::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  background: var(--w-warn); opacity: .3;
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.status-dot.completed { background: var(--w-success); }
.status-dot.failed { background: var(--w-danger); }
.status-dot.stopped { background: #94a3b8; }
@keyframes w-pulsering {
  0% { transform: scale(1); opacity: .4; }
  100% { transform: scale(1.6); opacity: 0; }
}

.board-title { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.task-chip {
  font-size: 11.5px; font-family: ui-monospace, Menlo, Consolas, monospace;
  padding: 3px 9px; border-radius: 5px;
  background: var(--w-bg-mute); border: 1px solid var(--w-border);
  color: var(--w-text-2);
}

/* 按钮 */
.btn {
  padding: 7px 14px; border: 1px solid var(--w-border-strong); border-radius: 7px;
  background: var(--w-bg); font-size: 12.5px; font-weight: 500;
  cursor: pointer; color: var(--w-text);
  transition: all .15s var(--w-ease); white-space: nowrap;
}
.btn:hover { background: var(--w-bg-mute); border-color: var(--w-text-3); }
.btn.primary {
  background: var(--w-brand); border-color: var(--w-brand); color: #fff;
  box-shadow: 0 1px 2px rgba(79,70,229,.2);
}
.btn.primary:hover { background: var(--w-brand-hover); border-color: var(--w-brand-hover); }
.btn.danger { color: #b91c1c; border-color: #fecaca; background: var(--w-danger-soft); }
.btn.danger:hover { background: #fee2e2; }
.btn.small { padding: 4px 10px; font-size: 11.5px; }
.btn:disabled { opacity: .4; cursor: not-allowed; }

/* ══════════════════════════════════════════════════════════
   Tab 栏
   ══════════════════════════════════════════════════════════ */
.board-tabs {
  height: 44px; flex: 0 0 44px;
  display: flex; gap: 2px; padding: 0 16px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg);
}
.tab {
  border: none; background: none; padding: 0 16px;
  font-size: 13px; font-weight: 500; color: var(--w-text-3);
  cursor: pointer; transition: all .15s var(--w-ease);
  border-bottom: 2px solid transparent;
  display: flex; align-items: center; gap: 6px;
  margin-bottom: -1px;
}
.tab:hover:not(:disabled) { color: var(--w-text-2); }
.tab.active {
  color: var(--w-brand); border-bottom-color: var(--w-brand); font-weight: 600;
}
.tab:disabled { opacity: .35; cursor: not-allowed; }
.tab .count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; color: var(--w-text-3);
  font-weight: 500;
}
.tab.active .count { background: var(--w-brand-soft); color: var(--w-brand); }

/* ══════════════════════════════════════════════════════════
   内容区
   ══════════════════════════════════════════════════════════ */
.board-content {
  flex: 1; position: relative; overflow: hidden; min-height: 0;
}
.pane {
  position: absolute; inset: 0; display: none; overflow: hidden;
}
.pane.active { display: flex; }

.pane-empty {
  padding: 40px 20px; text-align: center;
  color: var(--w-text-3); font-size: 13px;
}

/* ══════════════════════════════════════════════════════════
   编排 Tab
   ══════════════════════════════════════════════════════════ */
.canvas-pane { flex: 1; display: flex; min-height: 0; }

.role-sidebar {
  width: 240px; flex: 0 0 240px;
  border-right: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  overflow-y: auto;
  padding: 12px;
}
.role-sidebar::-webkit-scrollbar { width: 6px; }
.role-sidebar::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 3px; }

.canvas-area {
  flex: 1; position: relative; min-width: 0;
  display: flex; flex-direction: column;
  background: var(--w-bg-soft);
  background-image: radial-gradient(circle, #d1d5db 1px, transparent 1px);
  background-size: 20px 20px;
}
.canvas-area > *:first-child { flex: 1; min-height: 0; }

.readonly-banner {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  background: var(--w-warn); color: #fff;
  padding: 6px 16px; border-radius: 16px;
  font-size: 12px; font-weight: 500;
  box-shadow: 0 4px 12px rgba(245,158,11,.3);
  pointer-events: none;
}

/* ══════════════════════════════════════════════════════════
   运行 Tab
   ══════════════════════════════════════════════════════════ */
.runtime-pane {
  flex: 1; display: flex; flex-direction: column;
  padding: 16px; gap: 12px;
  overflow: hidden; min-height: 0;
}
.runtime-cards {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 12px; flex: 0 0 auto;
}
@media (max-width: 900px) { .runtime-cards { grid-template-columns: 1fr; } }

.runtime-details {
  flex: 0 0 auto;
  border: 1px solid var(--w-border); border-radius: 10px;
  background: var(--w-bg-soft);
}
.runtime-details > summary {
  padding: 10px 14px; cursor: pointer; user-select: none;
  font-size: 12px; font-weight: 600; color: var(--w-text-2);
}
.runtime-details[open] > summary { border-bottom: 1px solid var(--w-border); }
.detail-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 12px; padding: 12px;
}

.complete-banner {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-radius: 10px;
  background: var(--w-success-soft);
  border: 1px solid #a7f3d0;
  color: #065f46; font-size: 13px; font-weight: 500;
  animation: w-slidedown .3s var(--w-ease);
}
@keyframes w-slidedown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: none; }
}
.complete-banner .btn { margin-left: auto; }
.banner-close {
  border: none; background: none; cursor: pointer;
  color: #065f46; font-size: 16px; padding: 2px 8px;
}

/* 通用卡片 */
.card {
  background: var(--w-bg); border: 1px solid var(--w-border);
  border-radius: 10px; overflow: hidden; box-shadow: 0 1px 2px rgba(15,23,42,.04);
}
.card-head {
  padding: 10px 14px; border-bottom: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; align-items: center; justify-content: space-between;
}
.card-title { font-size: 12.5px; font-weight: 600; color: var(--w-text); }
.card-sub {
  font-size: 11px; color: var(--w-text-3);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.card-body { padding: 12px 14px; }

.status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.status-cell { display: flex; flex-direction: column; gap: 3px; }
.status-cell .label {
  font-size: 10.5px; color: var(--w-text-3);
  text-transform: uppercase; letter-spacing: .05em; font-weight: 500;
}
.status-cell .value {
  font-size: 15px; font-weight: 600;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: -.02em;
}
.status-cell .value.brand { color: var(--w-brand); }

/* ══════════════════════════════════════════════════════════
   活动流
   ══════════════════════════════════════════════════════════ */
.activity-stream {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--w-bg); border: 1px solid var(--w-border);
  border-radius: 10px; overflow: hidden;
}
.stream-head {
  flex: 0 0 auto; padding: 10px 14px;
  border-bottom: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; align-items: center; justify-content: space-between;
}
.stream-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--w-text);
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--w-success);
  animation: w-pulsering 1.6s var(--w-ease) infinite;
}
.stream-count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; color: var(--w-text-3);
  font-weight: 500;
}
.stream-actions { display: flex; gap: 6px; }

.stream-body {
  flex: 1; overflow-y: auto; min-height: 0;
  padding: 6px 14px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.stream-body::-webkit-scrollbar { width: 6px; }
.stream-body::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 3px; }

.act {
  display: flex; gap: 10px; padding: 5px 0; line-height: 1.55;
  border-bottom: 1px solid transparent;
}
.act:hover { background: var(--w-bg-soft); margin: 0 -14px; padding: 5px 14px; }
.act .t { color: var(--w-text-3); flex: 0 0 62px; font-size: 11px; }
.act .n {
  color: var(--w-brand); flex: 0 0 108px; font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.act .m { flex: 1; color: var(--w-text-2); word-break: break-word; font-size: 12px; }
.act.done .m { color: #047857; }
.act.warn .m { color: #b45309; }
.act.err .m { color: #b91c1c; }

/* ══════════════════════════════════════════════════════════
   产物 Tab
   ══════════════════════════════════════════════════════════ */
.artifacts-pane { flex: 1; display: flex; min-height: 0; }

.artifacts-list {
  width: 320px; flex: 0 0 320px;
  border-right: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  padding: 16px 14px;
  overflow-y: auto;
}
.handoff-view {
  flex: 1; padding: 16px 20px; overflow-y: auto;
  background: var(--w-bg);
}
.handoff-view::-webkit-scrollbar { width: 8px; }
.handoff-view::-webkit-scrollbar-thumb { background: var(--w-border); border-radius: 4px; }

.section-title {
  font-size: 11px; font-weight: 600; color: var(--w-text-3);
  text-transform: uppercase; letter-spacing: .06em;
  margin: 0 0 10px 0;
  display: flex; align-items: center; justify-content: space-between;
}
.section-title .count {
  font-size: 10.5px; background: var(--w-bg-mute);
  border-radius: 10px; padding: 1px 7px; font-weight: 500;
}

.artifact-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 7px;
  background: var(--w-bg); border: 1px solid var(--w-border);
  margin-bottom: 5px; cursor: pointer;
  transition: all .15s var(--w-ease);
  font-size: 12px;
}
.artifact-item:hover { border-color: var(--w-border-strong); }
.artifact-item.active { border-color: var(--w-brand); background: var(--w-brand-soft); }
.artifact-item .kind { color: var(--w-text-3); font-size: 10.5px; }
.artifact-item .name {
  flex: 1; font-family: ui-monospace, Menlo, Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.artifact-item .size { color: var(--w-text-3); font-size: 11px; }

/* ══════════════════════════════════════════════════════════
   历史 Tab
   ══════════════════════════════════════════════════════════ */
.history-pane {
  flex: 1; padding: 20px 24px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 24px;
}
.history-pane section { display: flex; flex-direction: column; gap: 8px; }

.history-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border: 1px solid var(--w-border);
  border-radius: 9px; background: var(--w-bg);
  cursor: pointer; transition: all .15s var(--w-ease);
}
.history-item:hover {
  border-color: var(--w-brand-border);
  box-shadow: 0 1px 3px rgba(79,70,229,.08);
}
.history-item.active { border-color: var(--w-brand); background: var(--w-brand-soft); }
.history-item .gid {
  flex: 1; font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px; font-weight: 500;
}
.history-item .when { font-size: 11.5px; color: var(--w-text-3); }
.history-item .status {
  font-size: 10.5px; font-weight: 600;
  padding: 3px 9px; border-radius: 5px;
}
.history-item .status.completed { background: var(--w-success-soft); color: #047857; }
.history-item .status.failed { background: var(--w-danger-soft); color: #b91c1c; }
.history-item .status.running { background: var(--w-brand-soft); color: var(--w-brand); }
.history-item .status.paused { background: var(--w-warn-soft); color: #b45309; }

/* ══════════════════════════════════════════════════════════
   浮层（UserQuestionModal / RoleEditor / NodeEditorModal）
   ══════════════════════════════════════════════════════════ */
.weave-modal-mask {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(15,23,42,.44); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  animation: w-fadein .18s var(--w-ease);
  padding: 24px;
}
@keyframes w-fadein { from { opacity: 0; } to { opacity: 1; } }

.weave-modal {
  background: var(--w-bg); border-radius: 16px;
  width: 540px; max-width: 100%; max-height: calc(100vh - 48px);
  box-shadow: 0 24px 56px rgba(15,23,42,.18);
  overflow: hidden; display: flex; flex-direction: column;
  animation: w-modalin .25s var(--w-ease);
}
@keyframes w-modalin {
  from { opacity: 0; transform: translateY(16px) scale(.97); }
  to { opacity: 1; transform: none; }
}
.weave-modal .modal-head {
  padding: 18px 22px 14px; border-bottom: 1px solid var(--w-border);
  display: flex; justify-content: space-between; align-items: flex-start;
}
.weave-modal .modal-kicker {
  font-size: 11px; color: var(--w-text-3); margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: .05em; font-weight: 500;
}
.weave-modal .modal-title {
  font-size: 15.5px; font-weight: 600; letter-spacing: -.01em;
}
.weave-modal .modal-close {
  border: none; background: none; font-size: 20px;
  color: var(--w-text-3); cursor: pointer;
  width: 28px; height: 28px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
}
.weave-modal .modal-close:hover { background: var(--w-bg-mute); }
.weave-modal .modal-body {
  padding: 18px 22px; overflow-y: auto; flex: 1;
}
.weave-modal .modal-foot {
  padding: 14px 22px; border-top: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  display: flex; gap: 8px; justify-content: flex-end;
}

/* 表单（浮层内） */
.weave-modal .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.weave-modal .field label {
  font-size: 11.5px; font-weight: 600; color: var(--w-text-2);
  display: flex; align-items: center; gap: 6px;
}
.weave-modal .field input,
.weave-modal .field select,
.weave-modal .field textarea {
  padding: 8px 11px; border: 1px solid var(--w-border);
  border-radius: 8px; font-size: 13px; outline: none;
  background: var(--w-bg); width: 100%;
  transition: all .15s var(--w-ease);
  font-family: inherit;
}
.weave-modal .field input:focus,
.weave-modal .field select:focus,
.weave-modal .field textarea:focus {
  border-color: var(--w-brand);
  box-shadow: 0 0 0 3px var(--w-brand-soft);
}
.weave-modal .field-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
}
.weave-modal .checkbox {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 0; font-size: 12.5px; cursor: pointer;
}
.weave-modal .checkbox input { accent-color: var(--w-brand); }
`
