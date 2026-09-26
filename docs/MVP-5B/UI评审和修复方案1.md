# UI 评审 + 修复方案

## 一、诊断：3 类问题

| # | 问题 | 表现 | 根因 |
|---|---|---|---|
| **1** | **节点编辑浮层布局崩坏** | "仅 .md" / "需用户审批" 竖排；checkbox 撑满整行 | `.field input { width: 100%; padding; border }` 把 checkbox 也套上了 |
| **2** | **画布节点竖排一行** | R1→R2→R4→R6 全部 x=0 竖直排 | `layoutNodes` 无 edges 时把所有节点 level 归 0，x 相同 |
| **3** | **画布没撑满高度** | 画布区域高度小，下方空一大截 | `CanvasEditor` 根 div `minHeight: 260` 不能撑满父容器 |

另外还有 1 个语法错误（`CanvasEditor` 里的 `return () => {...}` 内部块作用域错误）。

---

## 二、修复 1：CSS checkbox 被 input 撑开（最紧急）

### 问题

```css
/* board-styles.ts 现状 */
.weave-modal .field input,
.weave-modal .field select,
.weave-modal .field textarea {
  padding: 8px 11px;
  border: 1px solid var(--w-border);
  width: 100%;       /* ← 把 checkbox 也设了 100% 宽 */
}
```

`<label class="checkbox"><input type="checkbox" /> 仅 .md</label>` 里：
- `label` 是 `.field label` → `display: flex`
- `input` 是 `.field input` → `width: 100%; padding: 8px 11px; border`

**结果**：checkbox 撑满整行 → 文字被挤到下方 → 竖排。

### 修复

在 `board-styles.ts` 的 `.weave-modal` 段追加：

```css
/* 修正：checkbox 需要重置样式，不继承 input 的 100% 宽 */
.weave-modal .field input[type="checkbox"],
.weave-modal .checkbox input[type="checkbox"] {
  width: auto !important;
  padding: 0 !important;
  border: none !important;
  background: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  accent-color: var(--w-brand);
  cursor: pointer;
  flex: 0 0 auto;
}
```

**为什么用 `!important`**：`.field input` 选择器优先级是 `(0,0,2,0)`，`.field input[type=checkbox]` 是 `(0,0,2,1)`——已经更高。但为了保险（避免其他 `.field input` 覆盖），加 `!important`。

---

## 三、修复 2：layoutNodes 无连线时竖排

### 问题

```typescript
// canvas-model.ts 现状
if (nodes.length > 0) assign(nodes[0]?.id ?? '', 0)
for (const n of nodes) if (!level.has(n.id)) assign(n.id, 0)
```

**没有 edges 时**：
- `assign(nodes[0].id, 0)` → 只给第一个节点设 level 0
- `for (const n of nodes) if (!level.has(n.id)) assign(n.id, 0)` → 其他节点也都 level 0
- 结果：所有节点 `x = 0 * (NODE_W + COL_X) = 0`，`y = idx * (NODE_H + ROW_Y)` → 竖排

### 修复

`layoutNodes` 顶部加快速分支：

```typescript
// canvas-model.ts
export function layoutNodes(nodes: EditorNode[], edges: Array<{ from: string; to: string }>): EditorNode[] {
  // ★ 无连线：保持节点原有 x/y（不清算 level）
  if (edges.length === 0) return nodes

  // 有连线：按 seq 边分层（原逻辑）
  const out = new Map<string, Array<{ from: string; to: string }>>()
  // ... 原逻辑不变
}
```

同时，`CanvasEditor` 初始化节点时的 x/y 生成逻辑需要保证**网格铺开**（当前 `(i%3) * (NODE_W+COL_X)` 已经可以，但 counter 生成的节点 x/y 都是 0）：

```typescript
// CanvasEditor.tsx：addRoleByName / onDrop 时给 x/y 合理初始值
const addRoleByName = async (roleRef: string, sourceId: string): Promise<void> => {
  // ...
  const idx = nodes.length
  const id = `${role.id}-${counter + 1}`
  const ns = [...nodes, {
    id, roleRef: role.id, roleName: role.name,
    x: (idx % 3) * (NODE_W + COL_X),      // ★ 网格铺开
    y: Math.floor(idx / 3) * (NODE_H + ROW_Y),
  }]
  // ...
}
```

**效果**：无连线时节点按 3 列网格铺开，不堆在一起。

---

## 四、修复 3：画布没撑满

### 问题

`CanvasEditor` 根 div：
```tsx
<div style={{ position: 'relative', width: '100%', minHeight: 260, ... }}>
```

`minHeight: 260` 只保证**最小**高度，不会撑满父容器。

父容器 `.canvas-area` 是 flex column：
```css
.canvas-area { display: flex; flex-direction: column; }
.canvas-area > *:first-child { flex: 1; min-height: 0; }
```

但 `flex: 1` 要求子元素有正确的 flex 上下文——`CanvasEditor` 根 div 没有设 `height: 100%`，所以撑不满。

### 修复

**方案 A（推荐）**：`CanvasEditor` 根 div 加 `height: '100%'`

```tsx
// CanvasEditor.tsx
<div style={{
  position: 'relative',
  width: '100%',
  height: '100%',      // ★ 从 minHeight 改为 height
  border: '1px dashed #ccc',
  borderRadius: 8,
  background: '#fafafa',
  overflow: 'hidden',
}}>
```

同时保留 `min-height` 作为兜底（用 flex 时会被忽略）：

```tsx
style={{
  position: 'relative',
  width: '100%',
  minHeight: 260,      // 保留兜底
  height: '100%',      // ★ 新增
  // ...
}}
```

---

## 五、修复 4：语法错误（CanvasEditor 内 useEffect）

### 问题代码

```tsx
return () => {
  window.removeEventListener('weave:node-saved', onNodeSaved)
  window.removeEventListener('weave:node-deleted', onNodeDeleted)
{ /* eslint-disable-next-line react-hooks/exhaustive-deps */ }   // ← 块作用域语法错误
}
```

### 修复

```tsx
return () => {
  window.removeEventListener('weave:node-saved', onNodeSaved)
  window.removeEventListener('weave:node-deleted', onNodeDeleted)
}
```

（`eslint-disable-next-line` 应该放在 `useEffect(() => {` 上一行，作为注释——不是放在函数体里。）

正确写法：

```tsx
// eslint-disable-next-line react-hooks/exhaustive-deps
useEffect(() => {
  // ...
}, [nodes, edges])
```

---

## 六、修复 5：配置条拥挤（节点选中时底部）

### 问题

```tsx
// CanvasEditor.tsx 底部配置条
{selected && !readonly && (
  <div style={{ position: 'absolute', left: 8, bottom: 8, right: 8, ... }}>
    <strong>{selected.roleRef}</strong>
    <input placeholder="模型覆盖（可选）" ... />
    <input placeholder="输入门禁 requires（逗号分隔）" ... />
    <label>...需用户审批</label>
    <label>...仅 .md</label>
    <button>⚙ 配置</button>
  </div>
)}
```

所有元素 `display: flex` 但不换行 → 窄容器挤压。

### 修复

```tsx
<div style={{
  position: 'absolute',
  left: 8, right: 8, bottom: 8,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 8,
  fontSize: 12,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',           // ★ 允许换行
  alignItems: 'center',
}}>
  {/* 同内容 */}
</div>
```

或更紧凑：把小配置项折叠到"⚙ 配置"按钮（双击节点/点配置按钮统一走浮层）。

**推荐**：底部配置条**只显示一个"⚙ 编辑配置"按钮**，所有编辑都走 `NodeEditorModal` 浮层——彻底解决拥挤。

```tsx
{selected && !readonly && (
  <div style={{
    position: 'absolute', left: 8, right: 8, bottom: 8,
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
    padding: '6px 10px', fontSize: 12,
    display: 'flex', alignItems: 'center', gap: 8,
  }}>
    <strong>{selected.roleName}</strong>
    <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{selected.id}</span>
    <button
      onClick={() => openNodeEditor(selected.id)}
      style={{ marginLeft: 'auto', padding: '4px 12px', cursor: 'pointer' }}
    >
      ⚙ 编辑配置
    </button>
    <button
      onClick={() => setSelectedId(null)}
      style={{ padding: '4px 8px', cursor: 'pointer' }}
    >
      ×
    </button>
  </div>
)}
```

---

## 七、修复 6：角色库侧栏高度问题

看截图左侧角色列表似乎滚动受限。检查 `RoleLibraryPanel` 的 `maxHeight: 320`：

```tsx
<div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
```

**问题**：写死 320px，不管侧栏实际多高。

### 修复

把 `maxHeight` 改为 `flex: 1; min-height: 0`，让父容器控制：

```tsx
<div style={{
  display: 'flex', flexDirection: 'column', gap: 4,
  flex: 1, minHeight: 0, overflowY: 'auto',
}}>
```

同时，`RoleLibraryPanel` 根 div 需要 `height: 100%`：

```tsx
<div className="role-library-panel" style={{
  height: '100%',
  display: 'flex', flexDirection: 'column',
  padding: 12, gap: 8,
}}>
```

---

## 八、修复 7：编排 Tab 角色库侧栏画布宽度

看截图，画布很窄，左侧角色库占了很多。

```css
.role-sidebar { width: 240px; flex: 0 0 240px; }
```

240px 是合理的，但可以调整：

```css
.role-sidebar {
  width: 220px; flex: 0 0 220px;  /* 缩到 220 */
  border-right: 1px solid var(--w-border);
  background: var(--w-bg-soft);
  overflow-y: auto;
  padding: 12px;
  display: flex;         /* ★ 让内部组件撑满 */
  flex-direction: column;
  min-height: 0;
}
```

---

## 九、完整修改清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `board-styles.ts` | 追加 `.field input[type="checkbox"]` 重置；`.role-sidebar` 加 flex column |
| 2 | `canvas-model.ts` | `layoutNodes` 顶部加 `if (edges.length === 0) return nodes` |
| 3 | `CanvasEditor.tsx` | 根 div `height: 100%`；`addRoleByName`/`onDrop` 生成网格 x/y；修语法错误；底部配置条改单按钮 |
| 4 | `RoleLibraryPanel.tsx` | 根 div `height: 100%`；列表 `flex: 1; minHeight: 0` 替代 `maxHeight: 320` |
| 5 | `CanvasPane.tsx` | 无改动（结构正确） |

---

## 十、验证清单

| 场景 | 期望 |
|---|---|
| 双击节点打开浮层 | checkbox 横向排列（不竖排） |
| 新建任务（空图） | 无节点 → 空态提示 |
| 从角色库拖入 4 个角色 | 节点按 3 列网格铺开（不竖排） |
| 连上 R1→R2 | 两节点横向分层（R2 在 R1 右边） |
| 画布占满 | 画布高度撑满到角色库底部 |
| 选中节点 | 底部只显示「⚙ 编辑配置」按钮（不拥挤） |
| 角色列表 | 撑满左侧栏高度（无固定 320px） |

---

## 十一、一句话

**4 个 bug（checkbox 样式冲突 / 无连线竖排 / 画布不撑满 / 语法错误）+ 3 个布局优化（配置条简化为单按钮 / 角色库撑满 / 角色库侧栏 flex）**。不动架构，只修 bug 和布局。