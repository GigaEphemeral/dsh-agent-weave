/**
 * dsh-state-graph 浏览器 half：Graph Studio 全屏抽屉（shell.overlay）。
 *
 * 由 scripts/build-client.mjs 组装为 lib/client.js：tsc 把 src/engine.ts
 * 编译为 CJS 后内联到下方 GraphKit IIFE 的注入标记处，
 * 因此浏览器里跑的是与宿主同一份 StateGraph 引擎 + Studio DSL。
 * 本文件必须是零依赖、无 JSX、无模块导入的普通 JS（React 经 require 注入）。
 */
window.__ModuleLoader__.load({
  id: "dsh-state-graph",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var GraphKit = (function () {
      var module = { exports: {} };
      var exports = module.exports;
//__GRAPH_KIT_INJECT__
      return module.exports;
    })();

    var END = GraphKit.END;
    // 条件算子的白话标签（option 显示用，值仍为引擎约定的英文 op）。
    var OP_LABEL = {
      eq: "等于",
      ne: "不等于",
      gt: "大于",
      gte: "≥（大于等于）",
      lt: "小于",
      lte: "≤（小于等于）",
      exists: "存在",
    };
    var STORAGE_KEY = "dsh.graph-studio.workspace.v2";
    var LEGACY_STORAGE_KEY = "dsh.graph-studio.spec.v1";

    // ---- 工具 ----

    function el(tag, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      var flat = [];
      function push(list) {
        list.forEach(function (item) {
          if (Array.isArray(item)) push(item);
          else if (item !== null && item !== undefined && item !== false) flat.push(item);
        });
      }
      push(children);
      // void 元素（input 等）不接受 children：空数组也不能传（React #137）。
      if (flat.length === 0) return React.createElement(tag, props || {});
      return React.createElement(tag, props || {}, flat);
    }

    function trapFocus(event, container) {
      if (event.key !== "Tab" || !container) return;
      var focusable = Array.prototype.slice.call(container.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function pretty(value) {
      return JSON.stringify(value, null, 2) ?? "";
    }

    function tryParseJson(text) {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }

    /** 值输入智能解析：先按 JSON（true/3/"x"），失败则按原始字符串。 */
    function parseValueText(text) {
      var trimmed = text.trim();
      if (trimmed === "") return "";
      var parsed = tryParseJson(trimmed);
      return parsed.ok ? parsed.value : text;
    }

    function valueToText(value) {
      if (typeof value === "string") return value;
      return JSON.stringify(value) ?? "";
    }

    function blankSpec() {
      return { entryPoint: "", nodes: [], edges: [], conditionalEdges: [], maxIterations: 25, initialState: {} };
    }

    /** 导入/示例载入后的最小规整：保证三个数组存在、入口有默认值。 */
    function normalizeSpec(spec) {
      var out = Object.assign(blankSpec(), spec || {});
      out.nodes = Array.isArray(out.nodes) ? out.nodes : [];
      out.edges = Array.isArray(out.edges) ? out.edges : [];
      out.conditionalEdges = Array.isArray(out.conditionalEdges) ? out.conditionalEdges : [];
      var names = out.nodes.map(function (n) { return n && n.name; }).filter(Boolean);
      if (!names.includes(out.entryPoint)) out.entryPoint = names[0] ?? "";
      return out;
    }

    function graphId() {
      return "graph-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }

    function newGraph(name, spec) {
      return { id: graphId(), name: name, spec: normalizeSpec(spec), updatedAt: Date.now() };
    }

    function loadStoredWorkspace() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed.graphs) && parsed.graphs.length > 0) {
            var graphs = parsed.graphs.map(function (graph, index) {
              return {
                id: typeof graph.id === "string" ? graph.id : graphId(),
                name: typeof graph.name === "string" && graph.name.trim() ? graph.name : "图 " + (index + 1),
                spec: normalizeSpec(graph.spec),
                updatedAt: Number(graph.updatedAt) || Date.now(),
              };
            });
            return { activeId: graphs.some(function (graph) { return graph.id === parsed.activeId; }) ? parsed.activeId : graphs[0].id, graphs: graphs };
          }
        }
        var legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) return { activeId: "legacy", graphs: [{ id: "legacy", name: "未命名图", spec: normalizeSpec(JSON.parse(legacy)), updatedAt: Date.now() }] };
      } catch (err) {
        /* 隐私模式或旧数据损坏时回退到内置示例 */
      }
      return null;
    }

    function storeWorkspace(workspace) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
      } catch (err) {
        /* 隐私模式等场景下静默放弃持久化 */
      }
    }

    // 简约模式偏好：默认开启，隐藏导入/导出 JSON、校验面板、初始状态 JSON 编辑等高级控件。
    var SIMPLE_MODE_KEY = "dsh.graph-studio.simple-mode";
    function loadSimpleMode() {
      try {
        var raw = window.localStorage.getItem(SIMPLE_MODE_KEY);
        if (raw === null) return true;
        return raw !== "0";
      } catch (err) { return true; }
    }
    function saveSimpleMode(value) {
      try { window.localStorage.setItem(SIMPLE_MODE_KEY, value ? "1" : "0"); } catch (err) { /* noop */ }
    }

    /** 节点改名：改节点自身并同步所有边/条件边/规则目标/入口引用，避免悬空。 */
    function renameNodeRef(copy, oldName, newName) {
      copy.nodes.forEach(function (n) {
        if (n.name === oldName) n.name = newName;
      });
      if (copy.entryPoint === oldName) copy.entryPoint = newName;
      copy.edges.forEach(function (e) {
        if (e.from === oldName) e.from = newName;
        if (e.to === oldName) e.to = newName;
      });
      copy.conditionalEdges.forEach(function (ce) {
        if (ce.from === oldName) ce.from = newName;
        if (ce.fallback === oldName) ce.fallback = newName;
        (ce.rules || []).forEach(function (r) {
          if (Array.isArray(r.to)) r.to = r.to.map(function (t) { return t === oldName ? newName : t; });
          else if (r.to === oldName) r.to = newName;
        });
      });
    }

    /** 删除节点：连带删除自己的出边/条件边；他处指向该节点的目标置空待补。 */
    function deleteNodeRef(copy, name) {
      copy.nodes = copy.nodes.filter(function (n) { return n.name !== name; });
      copy.edges = copy.edges.filter(function (e) { return e.from !== name && e.to !== name; });
      copy.conditionalEdges = copy.conditionalEdges.filter(function (ce) { return ce.from !== name; });
      copy.conditionalEdges.forEach(function (ce) {
        if (ce.fallback === name) ce.fallback = END;
        (ce.rules || []).forEach(function (r) {
          if (Array.isArray(r.to)) r.to = r.to.map(function (t) { return t === name ? "" : t; });
          else if (r.to === name) r.to = "";
        });
      });
      if (copy.entryPoint === name) {
        copy.entryPoint = (copy.nodes[0] && copy.nodes[0].name) ?? "";
      }
    }

    // ---- DAG 布局（入口 BFS 分层，环安全） ----

    var NODE_W = 132;
    var NODE_H = 46;
    var COL_GAP = 84;
    var ROW_GAP = 30;

    function dagEdges(spec) {
      var edges = [];
        (spec.edges || []).forEach(function (edge) {
        edges.push({ from: edge.from, to: edge.to, kind: "static" });
      });
      (spec.conditionalEdges || []).forEach(function (ce) {
        var targets = [];
        (ce.rules || []).forEach(function (rule) {
          (Array.isArray(rule.to) ? rule.to : [rule.to]).forEach(function (t) {
            if (!targets.includes(t)) targets.push(t);
          });
        });
        if (ce.fallback && !targets.includes(ce.fallback)) targets.push(ce.fallback);
        targets.forEach(function (t) {
          edges.push({ from: ce.from, to: t, kind: "cond" });
        });
      });
      return edges;
    }

    function computeLayout(spec) {
      var names = (spec.nodes || []).map(function (n) { return n.name; });
      var layerOf = {};
      names.forEach(function (n) { layerOf[n] = -1; });
      var edges = dagEdges(spec);
      var adjacency = {};
      names.forEach(function (n) { adjacency[n] = []; });
      edges.forEach(function (e) {
        if (adjacency[e.from] && names.includes(e.to)) adjacency[e.from].push(e.to);
      });
      if (names.includes(spec.entryPoint)) {
        layerOf[spec.entryPoint] = 0;
        var queue = [spec.entryPoint];
        while (queue.length > 0) {
          var current = queue.shift();
          adjacency[current].forEach(function (next) {
            if (layerOf[next] === -1) {
              layerOf[next] = layerOf[current] + 1;
              queue.push(next);
            }
          });
        }
      }
      // 不可达节点排到最右侧独立列
      var maxLayer = 0;
      names.forEach(function (n) {
        if (layerOf[n] > maxLayer) maxLayer = layerOf[n];
        if (layerOf[n] === -1) layerOf[n] = maxLayer + 1;
      });
      var columns = {};
      names.forEach(function (n) {
        (columns[layerOf[n]] ??= []).push(n);
      });
      var positions = {};
      var maxRows = 1;
      Object.keys(columns).forEach(function (layerKey) {
        var col = Number(layerKey);
        var rows = columns[layerKey];
        if (rows.length > maxRows) maxRows = rows.length;
        rows.forEach(function (name, index) {
          positions[name] = {
            x: 28 + col * (NODE_W + COL_GAP),
            y: 28 + index * (NODE_H + ROW_GAP),
          };
        });
      });
      var savedPositions = spec.positions && typeof spec.positions === "object" ? spec.positions : {};
      names.forEach(function (name) {
        var saved = savedPositions[name];
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          positions[name] = { x: Math.max(12, saved.x), y: Math.max(12, saved.y) };
        }
      });
      Object.keys(positions).forEach(function (name) {
        maxLayer = Math.max(maxLayer, Math.ceil((positions[name].x - 28) / (NODE_W + COL_GAP)));
        maxRows = Math.max(maxRows, Math.ceil((positions[name].y - 28) / (NODE_H + ROW_GAP)) + 1);
      });
      var width = 28 + (maxLayer + 2) * (NODE_W + COL_GAP);
      var height = 28 + maxRows * (NODE_H + ROW_GAP);
      return { positions: positions, edges: edges, width: width, height: height };
    }

    // ---- 事件 → 轨迹行 / 节点状态 ----

    function buildTimeline(events) {
      var rows = [];
      var openByNode = {};
      events.forEach(function (ev) {
        var payload = ev.payload || {};
        if (ev.name === "graph/start") {
          rows.push({ kind: "start", entryPoint: payload.entryPoint, at: Date.now() });
        } else if (ev.name === "graph/node-start") {
          var row = { kind: "node", node: payload.node, iteration: payload.iteration };
          rows.push(row);
          (openByNode[payload.node] ??= []).push(row);
        } else if (ev.name === "graph/node-end") {
          var open = openByNode[payload.node];
          var target = open && open.shift();
          if (target) {
            target.durationMs = payload.durationMs;
            target.patch = payload.patch;
            target.state = payload.state;
          }
        } else if (ev.name === "graph/node-error") {
          var openErr = openByNode[payload.node];
          var targetErr = openErr && openErr.shift();
          var message = payload.error && payload.error.message ? payload.error.message : String(payload.error);
          if (targetErr) targetErr.error = message;
          else rows.push({ kind: "node-error", node: payload.node, error: message });
        } else if (ev.name === "graph/error") {
          rows.push({
            kind: "graph-error",
            node: payload.lastNode,
            error: payload.error && payload.error.message ? payload.error.message : String(payload.error),
          });
        } else if (ev.name === "graph/end") {
          rows.push({ kind: "end", iterations: payload.iterations, trajectory: payload.trajectory });
        }
      });
      return rows;
    }

    function nodeStatuses(events) {
      var statuses = {};
      events.forEach(function (ev) {
        var payload = ev.payload || {};
        var node = payload.node || payload.lastNode;
        if (!node) return;
        var status = (statuses[node] ??= { runs: 0, state: "idle" });
        if (ev.name === "graph/node-start") {
          status.runs += 1;
          status.state = "running";
        } else if (ev.name === "graph/node-end") {
          status.state = "done";
        } else if (ev.name === "graph/node-error") {
          status.state = "error";
        } else if (ev.name === "graph/error" && payload.lastNode === node) {
          status.state = "error";
        }
      });
      return statuses;
    }

    // ---- 视图组件 ----

    var hostCtx = null;

    /** 全屏抽屉：以 iframe 承载独立 Studio，隔离其他插件的全局 CSS。 */
    function FullscreenStudio(props) {
      var openState = React.useState(
        typeof window !== "undefined" &&
          typeof window.location !== "undefined" &&
          window.location.hash === "#graph-studio-open",
      );
      var open = openState[0];
      var setOpen = openState[1];
      var dialogRef = React.useRef(null);
      var closeButtonRef = React.useRef(null);
      var priorFocusRef = React.useRef(null);

      React.useEffect(function () {
        if (!window.location) return;
        var onHash = function () {
          setOpen(window.location.hash === "#graph-studio-open");
        };
        window.addEventListener("hashchange", onHash);
        return function () {
          window.removeEventListener("hashchange", onHash);
        };
      }, []);

      React.useEffect(function () {
        if (!open) return;
        priorFocusRef.current = document.activeElement;
        if (closeButtonRef.current) closeButtonRef.current.focus();
        function onKeyDown(event) { trapFocus(event, dialogRef.current); }
        window.addEventListener("keydown", onKeyDown);
        return function () {
          window.removeEventListener("keydown", onKeyDown);
          if (priorFocusRef.current && priorFocusRef.current.focus) priorFocusRef.current.focus();
        };
      }, [open]);

      React.useEffect(function () {
        function onKeyDown(event) {
          if (event.key === "Escape") close();
        }
        window.addEventListener("keydown", onKeyDown);
        return function () { window.removeEventListener("keydown", onKeyDown); };
      }, []);

      function close() {
        setOpen(false);
        if (window.location && window.location.hash === "#graph-studio-open") {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }

      if (!open) return null;
      return el(
        "div",
        { className: "dshgs-fullscreen", ref: dialogRef, role: "dialog", "aria-modal": true, "aria-label": "Graph Studio" },
        el(
          "div",
          { className: "dshgs-fullscreen-bar" },
          el("button", { className: "dshgs-btn", onClick: close }, "← 返回"),
          el("span", { className: "dshgs-title" }, "Graph Studio"),
          el("button", { className: "dshgs-btn dshgs-btn-primary", ref: closeButtonRef, onClick: close }, "✕ 关闭"),
        ),
        el("iframe", {
          className: "dshgs-frame",
          src: "/graph-studio",
          title: "Graph Studio",
        }),
      );
    }

    /** UI 侧补充校验：控件层约定（空字段名等），与引擎侧 studioValidate 合并展示。 */
    function uiValidate(spec) {
      var errors = [];
      (spec.nodes || []).forEach(function (node) {
        if (!node || !node.name) return;
        var sources = [];
        if (node.kind === "patch") sources.push(node.patch);
        if (node.kind === "counter" && node.counter && node.counter.then) sources.push(node.counter.then);
        sources.forEach(function (fields) {
          Object.keys(fields ?? {}).forEach(function (key) {
            if (key === "") {
              errors.push('节点 "' + node.name + '"：有字段名为空的行，请补全字段名或删除该行。');
            }
          });
        });
      });
      return errors;
    }

    function StudioView(props) {
      var workspaceState = React.useState(function () {
        var stored = loadStoredWorkspace();
        if (stored) return stored;
        var first = newGraph("代码生成质量门", GraphKit.studioExamples[0].spec);
        return { activeId: first.id, graphs: [first] };
      });
      var workspace = workspaceState[0];
      var setWorkspace = workspaceState[1];
      var activeGraphIdState = React.useState(workspace.activeId);
      var activeGraphId = activeGraphIdState[0];
      var setActiveGraphId = activeGraphIdState[1];
      var activeGraph = workspace.graphs.find(function (graph) { return graph.id === activeGraphId; }) ?? workspace.graphs[0];
      var specState = React.useState(function () {
        return activeGraph.spec;
      });
      var spec = specState[0];
      var setSpec = specState[1];

      var historyState = React.useState({ past: [], future: [] });
      var history = historyState[0];
      var setHistory = historyState[1];

      var initialTextState = React.useState(pretty(spec.initialState ?? {}));
      var initialText = initialTextState[0];
      var setInitialText = initialTextState[1];

      var runState = React.useState({ running: false, events: [], result: null, startedAt: 0, finishedAt: 0 });
      var run = runState[0];
      var setRun = runState[1];

      var selectedState = React.useState("");
      var selected = selectedState[0];
      var setSelected = selectedState[1];

      var exportOpenState = React.useState(false);
      var exportOpen = exportOpenState[0];
      var setExportOpen = exportOpenState[1];

      var simpleModeState = React.useState(loadSimpleMode());
      var simpleMode = simpleModeState[0];
      var setSimpleMode = simpleModeState[1];

      var runModeState = React.useState("browser");
      var runMode = runModeState[0];
      var setRunMode = runModeState[1];

      var genPromptState = React.useState("");
      var genPrompt = genPromptState[0];
      var setGenPrompt = genPromptState[1];
      var generateState = React.useState({ busy: false, result: null });
      var generate = generateState[0];
      var setGenerate = generateState[1];

      var hostOnlyPresent = spec.nodes.some(function (n) { return n.kind === "subagent" || n.kind === "gate"; });

      var controllerRef = React.useRef(null);
      var fileInputRef = React.useRef(null);
      var exportDialogRef = React.useRef(null);
      var exportCloseRef = React.useRef(null);
      var exportPriorFocusRef = React.useRef(null);

      var kitValidation = GraphKit.studioValidate(spec);
      var validation = {
        ok: kitValidation.ok && uiValidate(spec).length === 0,
        errors: kitValidation.errors.concat(uiValidate(spec)),
        warnings: kitValidation.warnings,
      };
      var initialParsed = tryParseJson(initialText);
      var canRun = !run.running && validation.ok && initialParsed.ok;
      var timeline = buildTimeline(run.events);
      var statuses = nodeStatuses(run.events);

      React.useEffect(function () {
        setWorkspace(function (previous) {
          return Object.assign({}, previous, {
            activeId: activeGraphId,
            graphs: previous.graphs.map(function (graph) {
              return graph.id === activeGraphId
                ? Object.assign({}, graph, { spec: spec, updatedAt: Date.now() })
                : graph;
            }),
          });
        });
      }, [spec, activeGraphId]);

      React.useEffect(function () {
        storeWorkspace(workspace);
      }, [workspace]);

      // 关闭抽屉或重渲染期间若仍在运行，取消 AbortController：
      // 引擎会收到 abort → 上抛 → disposers 在 finally 中清理订阅。
      React.useEffect(function () {
        return function () {
          var controller = controllerRef.current;
          if (controller) {
            controllerRef.current = null;
            try { controller.abort(new Error("Studio 已关闭，运行被中止。")); } catch (err) { /* noop */ }
          }
        };
      }, []);

      React.useEffect(function () {
        function onKeyDown(event) {
          if (event.key === "Escape" && exportOpen) setExportOpen(false);
          var target = event.target;
          if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) redo(); else undo();
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
            event.preventDefault();
            redo();
          }
        }
        window.addEventListener("keydown", onKeyDown);
        return function () { window.removeEventListener("keydown", onKeyDown); };
      }, [exportOpen, history, spec]);

      React.useEffect(function () {
        if (!exportOpen) return;
        exportPriorFocusRef.current = document.activeElement;
        if (exportCloseRef.current) exportCloseRef.current.focus();
        function onKeyDown(event) { trapFocus(event, exportDialogRef.current); }
        window.addEventListener("keydown", onKeyDown);
        return function () {
          window.removeEventListener("keydown", onKeyDown);
          if (exportPriorFocusRef.current && exportPriorFocusRef.current.focus) exportPriorFocusRef.current.focus();
        };
      }, [exportOpen]);

      function resetRun() {
        setRun({ running: false, events: [], result: null, startedAt: 0, finishedAt: 0 });
      }

      function applySpec(next, recordHistory) {
        if (recordHistory) {
          setHistory({
            past: history.past.concat([spec]).slice(-50),
            future: [],
          });
        }
        setSpec(normalizeSpec(next));
        setInitialText(pretty(next.initialState ?? {}));
        resetRun();
      }

      function updateSpec(mutator) {
        var copy = JSON.parse(JSON.stringify(spec));
        mutator(copy);
        applySpec(copy, true);
      }

      function loadSpec(next) {
        applySpec(next, true);
      }

      function undo() {
        if (history.past.length === 0) return;
        var previous = history.past[history.past.length - 1];
        setHistory({ past: history.past.slice(0, -1), future: [spec].concat(history.future).slice(0, 50) });
        setSpec(previous);
        setInitialText(pretty(previous.initialState ?? {}));
        resetRun();
      }

      function redo() {
        if (history.future.length === 0) return;
        var next = history.future[0];
        setHistory({ past: history.past.concat([spec]).slice(-50), future: history.future.slice(1) });
        setSpec(next);
        setInitialText(pretty(next.initialState ?? {}));
        resetRun();
      }

      function switchGraph(id) {
        var next = workspace.graphs.find(function (graph) { return graph.id === id; });
        if (!next || id === activeGraphId) return;
        setActiveGraphId(id);
        setSpec(next.spec);
        setInitialText(pretty(next.spec.initialState ?? {}));
        setHistory({ past: [], future: [] });
        resetRun();
      }

      function createGraph(copyCurrent) {
        var graph = newGraph(copyCurrent ? activeGraph.name + " 副本" : "未命名图", copyCurrent ? spec : blankSpec());
        setWorkspace(function (previous) {
          return { activeId: graph.id, graphs: previous.graphs.concat([graph]) };
        });
        setActiveGraphId(graph.id);
        setSpec(graph.spec);
        setInitialText(pretty(graph.spec.initialState ?? {}));
        setHistory({ past: [], future: [] });
        resetRun();
      }

      function renameGraph(name) {
        setWorkspace(function (previous) {
          return Object.assign({}, previous, {
            graphs: previous.graphs.map(function (graph) {
              return graph.id === activeGraphId ? Object.assign({}, graph, { name: name || "未命名图" }) : graph;
            }),
          });
        });
      }

      function deleteGraph() {
        if (workspace.graphs.length <= 1 || !window.confirm("删除“" + activeGraph.name + "”？此操作不能从本地工作区恢复。")) return;
        var remaining = workspace.graphs.filter(function (graph) { return graph.id !== activeGraphId; });
        var next = remaining[0];
        setWorkspace({ activeId: next.id, graphs: remaining });
        setActiveGraphId(next.id);
        setSpec(next.spec);
        setInitialText(pretty(next.spec.initialState ?? {}));
        setHistory({ past: [], future: [] });
        resetRun();
      }

      async function startRun() {
        if (!hostCtx) {
          // 正常不会触发：浏览器 half 经 apply(ctx) 注入真实 ctx，独立页经
          // build-standalone 注入本地事件总线 hostCtx；走到这里说明 Studio 未正确挂载。
          console.warn("Graph Studio: 浏览器模拟运行缺少 hostCtx（Studio 未正确挂载？），已取消。");
          return;
        }
        if (!canRun) return;
        var initialState = initialParsed.ok ? initialParsed.value : {};
        if (typeof initialState !== "object" || initialState === null || Array.isArray(initialState)) {
          setRun(function (prev) { return Object.assign({}, prev, { result: { ok: false, error: "初始状态必须是 JSON 对象。" } }); });
          return;
        }
        var controller = new AbortController();
        controllerRef.current = controller;
        updateSpec(function (copy) { copy.initialState = initialState; });
        setRun({ running: true, events: [], result: null, startedAt: Date.now(), finishedAt: 0 });
        var disposers = [
          "graph/start",
          "graph/node-start",
          "graph/node-end",
          "graph/node-error",
          "graph/error",
          "graph/end",
        ].map(function (name) {
          return hostCtx.on(name, function (payload) {
            setRun(function (prev) {
              return Object.assign({}, prev, { events: prev.events.concat([{ name: name, payload: payload }]) });
            });
          });
        });
        var graph = GraphKit.studioBuildGraph(hostCtx, normalizeSpec(spec), 25);
        var outcome;
        try {
          var result = await graph.run(initialState, { signal: controller.signal });
          outcome = { ok: true, result: result };
        } catch (err) {
          outcome = { ok: false, error: err && err.message ? err.message : String(err) };
        } finally {
          disposers.forEach(function (dispose) { try { dispose(); } catch (err) { /* noop */ } });
        }
        setRun(function (prev) {
          return Object.assign({}, prev, { running: false, finishedAt: Date.now(), result: outcome });
        });
      }

      function stopRun() {
        if (controllerRef.current) controllerRef.current.abort(new Error("已在 Studio 中手动停止。"));
      }

      // 宿主真实运行：POST /graph-studio/run，在 dsh 进程里执行同一份引擎，
      // 后端把 graph/* 事件随结果一并返回，前端复用同一套轨迹渲染。
      async function startHostRun() {
        if (!canRun) return;
        var initialState = initialParsed.ok ? initialParsed.value : {};
        var controller = new AbortController();
        controllerRef.current = controller;
        updateSpec(function (copy) { copy.initialState = initialState; });
        setRun({ running: true, events: [], result: null, startedAt: Date.now(), finishedAt: 0 });
        try {
          var resp = await fetch("/graph-studio/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spec: normalizeSpec(spec), initialState: initialState }),
            signal: controller.signal,
          });
          var data = await resp.json().catch(function () { return null; });
          if (!resp.ok || !data) {
            setRun(function (p) {
              return Object.assign({}, p, {
                running: false,
                finishedAt: Date.now(),
                result: { ok: false, error: (data && data.error) || ("宿主运行失败（HTTP " + resp.status + "）") },
              });
            });
            return;
          }
          setRun(function (p) {
            return Object.assign({}, p, {
              running: false,
              finishedAt: Date.now(),
              events: data.events || [],
              result: data.ok
                ? { ok: true, result: data.result }
                : { ok: false, error: data.error },
            });
          });
        } catch (err) {
          setRun(function (p) {
            return Object.assign({}, p, {
              running: false,
              finishedAt: Date.now(),
              result: { ok: false, error: String(err && err.message ? err.message : err) },
            });
          });
        }
      }

      // 发布为 slash 命令：POST /graph-studio/register-command，后端用 ctx.graph.registerCommand 注册。
      async function publishCommand() {
        var baseName = (activeGraph && activeGraph.name) || "studio-graph";
        var name = baseName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "studio-graph";
        setRun({ running: false, events: [], result: null, startedAt: 0, finishedAt: 0 });
        try {
          var resp = await fetch("/graph-studio/register-command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spec: normalizeSpec(spec), name: name, description: activeGraph.name }),
          });
          var data = await resp.json().catch(function () { return null; });
          if (!resp.ok || !data || !data.ok) {
            setRun({ running: false, finishedAt: Date.now(), result: { ok: false, error: (data && data.error) || ("发布失败（HTTP " + resp.status + "）") } });
          } else {
            setRun({ running: false, finishedAt: Date.now(), result: { ok: true, command: data.name, message: "已发布为 slash 命令 /" + data.name + "，可在会话中输入运行。" } });
          }
        } catch (err) {
          setRun({ running: false, finishedAt: Date.now(), result: { ok: false, error: String(err && err.message ? err.message : err) } });
        }
      }

      // 自然语言建图：把描述交给后端 /graph-studio/generate，返回 StudioGraphSpec 供预览确认。
      async function startGenerate() {
        var prompt = genPrompt.trim();
        if (!prompt || generate.busy) return;
        setGenerate({ busy: true, result: null });
        try {
          var resp = await fetch("/graph-studio/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: prompt, spec: normalizeSpec(spec) }),
          });
          var data = await resp.json().catch(function () { return null; });
          if (!resp.ok || !data || !data.ok) {
            setGenerate({ busy: false, result: { error: (data && data.error) || ("生成失败（HTTP " + resp.status + "）") } });
          } else {
            setGenerate({ busy: false, result: { spec: data.spec, validation: data.validation, raw: data.raw } });
          }
        } catch (err) {
          setGenerate({ busy: false, result: { error: String(err && err.message ? err.message : err) } });
        }
      }
      function applyGenerated() {
        if (generate.result && generate.result.spec) loadSpec(generate.result.spec);
        setGenerate({ busy: false, result: null });
        setGenPrompt("");
      }
      function discardGenerated() {
        setGenerate({ busy: false, result: null });
      }

      function onImportFile(event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file) return;
        file.text().then(function (text) {
          var parsed = tryParseJson(text);
          if (parsed.ok) loadSpec(parsed.value);
          else setRun(function (prev) { return Object.assign({}, prev, { result: { ok: false, error: "导入失败：" + parsed.error } }); });
        });
      }

      var header = el(
        "header",
        { className: "dshgs-header" },
        el("div", { className: "dshgs-title" }, "Graph Studio"),
        el(
          "div",
          { className: "dshgs-header-actions" },
          el(
            "select",
            {
              className: "dshgs-input dshgs-select dshgs-graph-picker",
              value: activeGraphId,
              title: "切换图",
              onChange: function (event) { switchGraph(event.target.value); },
            },
            workspace.graphs.map(function (graph) {
              return el("option", { key: graph.id, value: graph.id }, graph.name);
            }),
          ),
          el("input", {
            className: "dshgs-input dshgs-graph-name",
            value: activeGraph.name,
            title: "当前图名称",
            onChange: function (event) { renameGraph(event.target.value); },
          }),
          el("button", { type: "button", className: "dshgs-btn", onClick: function () { createGraph(false); } }, "新建图"),
          el("button", { type: "button", className: "dshgs-btn", onClick: function () { createGraph(true); } }, "复制图"),
          el("button", { type: "button", className: "dshgs-btn dshgs-btn-danger", disabled: workspace.graphs.length <= 1, onClick: deleteGraph }, "删除图"),
          el(
            "select",
            {
              className: "dshgs-input dshgs-select",
              onChange: function (event) {
                var example = GraphKit.studioExamples.find(function (x) { return x.id === event.target.value; });
                if (example) loadSpec(example.spec);
              },
              defaultValue: "",
              title: "载入内置示例",
            },
            el("option", { value: "", disabled: true }, "载入示例…"),
            GraphKit.studioExamples.map(function (example) {
              return el("option", { key: example.id, value: example.id }, example.name);
            }),
          ),
          simpleMode
            ? null
            : el("button", { className: "dshgs-btn", onClick: function () { if (fileInputRef.current) fileInputRef.current.click(); } }, "导入 JSON"),
          simpleMode
            ? null
            : el("input", {
              ref: fileInputRef,
              type: "file",
              accept: ".json,application/json",
              style: { display: "none" },
              onChange: onImportFile,
            }),
          simpleMode
            ? null
            : el("button", { className: "dshgs-btn", onClick: function () { return setExportOpen(true); } }, "导出 JSON"),
          el("button", {
            className: "dshgs-btn",
            title: simpleMode ? "切换到高级模式（显示导入/导出 JSON、校验面板与初始状态编辑）" : "切换到简约模式（隐藏高级控件，更适合普通用户）",
            onClick: function () { var next = !simpleMode; setSimpleMode(next); saveSimpleMode(next); },
          }, simpleMode ? "高级模式" : "简约模式"),
          el("button", { type: "button", className: "dshgs-btn", disabled: history.past.length === 0, title: "撤销（Ctrl/Cmd+Z）", onClick: undo }, "撤销"),
          el("button", { type: "button", className: "dshgs-btn", disabled: history.future.length === 0, title: "重做（Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y）", onClick: redo }, "重做"),
          el("button", {
            type: "button", className: "dshgs-btn dshgs-btn-danger", onClick: function () {
              if (window.confirm("清空当前图？可用撤销恢复。")) loadSpec(blankSpec());
            },
          }, "清空"),
          el(
            "span",
            { className: "dshgs-badge dshgs-badge-" + (validation.ok ? "ok" : "err") },
            validation.ok ? "校验通过" : "校验未通过（" + validation.errors.length + "）",
          ),
          el("span", { className: "dshgs-run-hint" }, workspace.graphs.length + " 个图，本地自动保存"),
        ),
      );

      var hint = el(
        "div",
        { className: "dshgs-run-hint" },
        "玩法：从入口节点开始，每张卡片 = 「这个节点做什么」+「执行完去哪」；一路连到「到头」即结束。左侧改图，右侧即时预览，底部运行看轨迹。",
      );

      var validationPanel = el(
        "div",
        { className: "dshgs-validation", role: "status", "aria-live": "polite" },
        validation.errors.map(function (message, index) {
          return el("div", { key: "e" + index, className: "dshgs-validation-item dshgs-validation-error" }, "✖ " + message);
        }),
        validation.warnings.map(function (message, index) {
          return el("div", { key: "w" + index, className: "dshgs-validation-item dshgs-validation-warn" }, "⚠ " + message);
        }),
      );

      var genResultBox = null;
      if (generate.result) {
        if (generate.result.error) {
          genResultBox = el(
            "div",
            { className: "dshgs-gen-result" },
            el("div", { className: "dshgs-inline-err" }, "✖ " + generate.result.error),
          );
        } else {
          var gs = generate.result.spec;
          var genNodeCount = gs.nodes ? gs.nodes.length : 0;
          var genEdgeCount = (gs.edges ? gs.edges.length : 0) + (gs.conditionalEdges ? gs.conditionalEdges.length : 0);
          var genErrCount = generate.result.validation && generate.result.validation.errors.length ? generate.result.validation.errors.length : 0;
          genResultBox = el(
            "div",
            { className: "dshgs-gen-result" },
            el("div", { className: "dshgs-gen-summary" },
              "生成 " + genNodeCount + " 个节点、" + genEdgeCount + " 条边" +
              (genErrCount ? "（校验 " + genErrCount + " 处错误，应用后需修正）" : "")),
            el("button", { className: "dshgs-btn dshgs-btn-primary", onClick: applyGenerated }, "应用到画布"),
            el("button", { className: "dshgs-btn", onClick: discardGenerated }, "放弃"),
            el("details", { className: "dshgs-gen-raw" },
              el("summary", null, "查看 JSON"),
              el("pre", { className: "dshgs-code dshgs-pre" }, pretty(gs)),
            ),
          );
        }
      }
      var genBar = el(
        "div",
        { className: "dshgs-gen" },
        el("input", {
          className: "dshgs-input dshgs-gen-input",
          placeholder: "用一句话描述流程，例如：写代码并跑测试，不通过就改，最多重试 3 次",
          value: genPrompt,
          onChange: function (event) { setGenPrompt(event.target.value); },
          onKeyDown: function (event) { if (event.key === "Enter" && !generate.busy) startGenerate(); },
        }),
        el("button", { className: "dshgs-btn dshgs-btn-primary", disabled: !genPrompt.trim() || generate.busy, onClick: startGenerate }, generate.busy ? "生成中…" : "AI 生成图"),
        genResultBox,
      );

      var main = el(
        "div",
        { className: "dshgs-main" },
        genBar,
        spec.nodes.length === 0
          ? el(WelcomePanel, { loadSpec: loadSpec })
          : el(ConfigPanel, {
              spec: spec,
              updateSpec: updateSpec,
              selected: selected,
              setSelected: setSelected,
            }),
        el(DagPanel, { spec: spec, statuses: statuses, selected: selected, setSelected: setSelected, updateSpec: updateSpec, running: run.running }),
      );

      var runPanel = el(RunPanel, {
        initialText: initialText,
        setInitialText: setInitialText,
        initialValid: initialParsed.ok,
        initialError: initialParsed.ok ? null : initialParsed.error,
        running: run.running,
        canRun: canRun,
        timeline: timeline,
        run: run,
        startRun: startRun,
        stopRun: stopRun,
        simpleMode: simpleMode,
        validation: validation,
        hostOnlyPresent: hostOnlyPresent,
        runMode: runMode,
        setRunMode: setRunMode,
        startHostRun: startHostRun,
        onPublish: publishCommand,
        graphName: activeGraph.name,
      });

      var exportOverlay = exportOpen
        ? el(
            "div",
            { className: "dshgs-overlay", ref: exportDialogRef, role: "dialog", "aria-modal": true, "aria-label": "导出图定义" },
            el(
              "div",
              { className: "dshgs-overlay-card" },
              el("div", { className: "dshgs-overlay-title" }, "图定义 JSON（复制后可在宿主侧 studioBuildGraph / fromDefinition 使用）"),
              el("textarea", { className: "dshgs-code dshgs-overlay-text", readOnly: true, value: pretty(spec) }),
              el(
                "div",
                { className: "dshgs-overlay-actions" },
                el("button", {
                  className: "dshgs-btn",
                  onClick: function () {
                    window.navigator.clipboard && window.navigator.clipboard.writeText(pretty(spec));
                  },
                }, "复制"),
                el("button", { className: "dshgs-btn", ref: exportCloseRef, onClick: function () { return setExportOpen(false); } }, "关闭"),
              ),
            ),
          )
        : null;

      return el(
        "div",
        { className: "dshgs-root" },
        el(
          "datalist",
          { id: "dshgs-nodelist" },
          spec.nodes.map(function (node) { return el("option", { key: node.name, value: node.name }); }),
          el("option", { value: END }),
        ),
        header,
        hint,
        simpleMode ? null : validationPanel,
        main,
        runPanel,
        exportOverlay,
      );
    }

    // ---- 空状态：欢迎引导 + 模板 ----

    function WelcomePanel(props) {
      var loadSpec = props.loadSpec;
      var templates = [
        {
          key: "linear",
          title: "线性流水线",
          detail: "两步骨架：A 做完固定去 B，B 到头结束。",
          spec: {
            entryPoint: "step_a",
            maxIterations: 25,
            initialState: {},
            nodes: [
              { name: "step_a", kind: "patch", label: "第一步", patch: { done_a: true } },
              { name: "step_b", kind: "patch", label: "第二步", patch: { done_b: true } },
            ],
            edges: [{ from: "step_a", to: "step_b" }],
            conditionalEdges: [],
          },
        },
        {
          key: "loop",
          title: "质量门回环",
          detail: "生成 → 检查；不过关就回到生成重来（尝试 3 次后放行）。",
          spec: {
            entryPoint: "generate",
            maxIterations: 25,
            initialState: {},
            nodes: [
              { name: "generate", kind: "patch", label: "生成", patch: { attempts: { $inc: 1 } } },
              {
                name: "check",
                kind: "patch",
                label: "检查",
                patch: { passed: { $test: { field: "attempts", op: "gte", value: 3 } } },
              },
            ],
            edges: [{ from: "generate", to: "check" }],
            conditionalEdges: [
              {
                from: "check",
                rules: [{ field: "passed", op: "eq", value: true, to: END }],
                fallback: "generate",
              },
            ],
          },
        },
      ];
      return el(
        "div",
        { className: "dshgs-welcome" },
        el("div", { className: "dshgs-welcome-title" }, "欢迎使用 Graph Studio"),
        el("div", { className: "dshgs-welcome-steps" },
          el("div", { className: "dshgs-step" },
            el("div", { className: "dshgs-step-num" }, "1"),
            el("div", { className: "dshgs-step-body" },
              el("div", { className: "dshgs-step-title" }, "选择模板"),
              el("div", { className: "dshgs-step-detail" }, "从下方模板或内置示例开始，快速搭建你的第一个状态图。"),
            ),
          ),
          el("div", { className: "dshgs-step" },
            el("div", { className: "dshgs-step-num" }, "2"),
            el("div", { className: "dshgs-step-body" },
              el("div", { className: "dshgs-step-title" }, "编辑节点"),
              el("div", { className: "dshgs-step-detail" }, "点击节点卡片，配置每个节点做什么、执行完去哪。"),
            ),
          ),
          el("div", { className: "dshgs-step" },
            el("div", { className: "dshgs-step-num" }, "3"),
            el("div", { className: "dshgs-step-body" },
              el("div", { className: "dshgs-step-title" }, "运行与调试"),
              el("div", { className: "dshgs-step-detail" }, "设置初始状态，点击运行，观察轨迹与 DAG 高亮。"),
            ),
          ),
        ),
        el("div", { className: "dshgs-welcome-templates" },
          el("div", { className: "dshgs-section-title" }, "快速开始模板"),
          templates.map(function (template) {
            return el(
              "button",
              {
                key: template.key,
                className: "dshgs-template-btn",
                onClick: function () { loadSpec(template.spec); },
              },
              el("div", { className: "dshgs-template-title" }, "▸ " + template.title),
              el("div", { className: "dshgs-template-detail" }, template.detail),
            );
          }),
          el("div", { className: "dshgs-section-title" }, "或载入完整示例"),
          GraphKit.studioExamples.map(function (example) {
            return el(
              "button",
              {
                key: example.id,
                className: "dshgs-template-btn",
                onClick: function () { loadSpec(example.spec); },
              },
              el("div", { className: "dshgs-template-title" }, "▸ " + example.name),
              el("div", { className: "dshgs-template-detail" }, "内置示例，载入后可直接运行。"),
            );
          }),
        ),
      );
    }

    // ---- 左列：节点卡片流（做什么 + 执行完去哪） ----

    /** 目标下拉：到头（结束）= END，其余为节点名。 */
    function targetSelect(options) {
      return el(
        "select",
        {
          className: "dshgs-input dshgs-select",
          value: options.value,
          onChange: function (event) { options.onChange(event.target.value); },
        },
        el("option", { value: END }, "到头（结束）"),
        options.names.map(function (name) {
          return el("option", { key: name, value: name }, name);
        }),
      );
    }

    function ConfigPanel(props) {
      var spec = props.spec;
      var updateSpec = props.updateSpec;
      var nodeNames = spec.nodes.map(function (n) { return n.name; });

      var nodeCards = spec.nodes.map(function (node, index) {
        return el(NodeCard, {
          key: node.name + ":" + index,
          node: node,
          index: index,
          spec: spec,
          updateSpec: updateSpec,
          nodeNames: nodeNames,
          selected: props.selected === node.name,
          setSelected: props.setSelected,
        });
      });

      return el(
        "div",
        { className: "dshgs-config" },
        el("div", { className: "dshgs-section-title" }, "节点卡片（从上往下就是执行路径）"),
        nodeCards,
        el("button", {
          className: "dshgs-btn dshgs-btn-mini",
          onClick: function () {
            updateSpec(function (c) {
              var name = "节点_" + (c.nodes.length + 1);
              while (c.nodes.some(function (n) { return n.name === name; })) name += "_";
              c.nodes.push({ name: name, kind: "patch", patch: {} });
              if (!c.entryPoint) c.entryPoint = name;
            });
          },
        }, "+ 添加节点"),
        el(
          "div",
          { className: "dshgs-row dshgs-global-row" },
          el("label", { className: "dshgs-label" }, "从哪个节点开始"),
          el(
            "select",
            {
              className: "dshgs-input dshgs-select",
              value: spec.entryPoint,
              onChange: function (event) { updateSpec(function (c) { c.entryPoint = event.target.value; }); },
            },
            el("option", { value: "" }, "— 选择入口 —"),
            nodeNames.map(function (name) { return el("option", { key: name, value: name }, name); }),
          ),
          el("label", { className: "dshgs-label" }, "迭代上限"),
          el("input", {
            className: "dshgs-input dshgs-input-number",
            type: "number",
            min: 1,
            value: spec.maxIterations ?? 25,
            onChange: function (event) { updateSpec(function (c) { c.maxIterations = Number(event.target.value) || 1; }); },
          }),
        ),
      );
    }

    /** patch / counter.then 的字段行编辑器：一行 = 字段名 + 类型（固定值/自增/判定）+ 值。 */
    function FieldRowsEditor(props) {
      var fields = props.fields ?? {};
      var entries = Object.entries(fields);

      function write(nextEntries) {
        props.onChange(Object.fromEntries(nextEntries));
      }

      function classify(value) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (value.$inc !== undefined) return "inc";
          if (value.$test !== undefined) return "test";
        }
        return "val";
      }

      var rows = entries.map(function (entry, rowIndex) {
        var key = entry[0];
        var value = entry[1];
        var type = classify(value);
        var keyBad = key === "";
        return el(
          "div",
          { key: "frow" + rowIndex, className: "dshgs-fieldrow" + (keyBad ? " dshgs-fieldrow-bad" : "") },
          el("input", {
            className: "dshgs-input dshgs-fieldrow-key",
            placeholder: props.keyPlaceholder || "字段名",
            value: key,
            onChange: function (event) {
              var next = entries.map(function (pair, i) {
                return i === rowIndex ? [event.target.value, pair[1]] : pair;
              });
              write(next);
            },
          }),
          el(
            "select",
            {
              className: "dshgs-input dshgs-select dshgs-fieldrow-type",
              value: type,
              onChange: function (event) {
                var nextType = event.target.value;
                var nextValue;
                if (nextType === "inc") nextValue = { $inc: 1 };
                else if (nextType === "test") nextValue = { $test: { field: "", op: "eq", value: true } };
                else nextValue = "";
                var next = entries.map(function (pair, i) {
                  return i === rowIndex ? [pair[0], nextValue] : pair;
                });
                write(next);
              },
            },
            el("option", { value: "val" }, "设为"),
            el("option", { value: "inc" }, "自增"),
            el("option", { value: "test" }, "判定"),
          ),
          type === "val"
            ? el("input", {
                className: "dshgs-input dshgs-fieldrow-value",
                placeholder: '值（true / 3 / 文本）',
                value: valueToText(value),
                onChange: function (event) {
                  var next = entries.map(function (pair, i) {
                    return i === rowIndex ? [pair[0], parseValueText(event.target.value)] : pair;
                  });
                  write(next);
                },
              })
            : null,
          type === "inc"
            ? el("input", {
                className: "dshgs-input dshgs-fieldrow-value",
                type: "number",
                title: "每次执行加多少",
                value: (value && value.$inc) ?? 1,
                onChange: function (event) {
                  var next = entries.map(function (pair, i) {
                    return i === rowIndex ? [pair[0], { $inc: Number(event.target.value) || 1 }] : pair;
                  });
                  write(next);
                },
              })
            : null,
          type === "test"
            ? el(
                "span",
                { className: "dshgs-fieldrow-test" },
                el("input", {
                  className: "dshgs-input",
                  placeholder: "看哪个字段",
                  value: (value && value.$test && value.$test.field) ?? "",
                  onChange: function (event) {
                    var next = entries.map(function (pair, i) {
                      if (i !== rowIndex) return pair;
                      return [pair[0], { $test: Object.assign({}, pair[1].$test, { field: event.target.value }) }];
                    });
                    write(next);
                  },
                }),
                el(
                  "select",
                  {
                    className: "dshgs-input dshgs-select dshgs-op-select",
                    value: (value && value.$test && value.$test.op) ?? "eq",
                    onChange: function (event) {
                      var next = entries.map(function (pair, i) {
                        if (i !== rowIndex) return pair;
                        return [pair[0], { $test: Object.assign({}, pair[1].$test, { op: event.target.value }) }];
                      });
                      write(next);
                    },
                  },
                  ["eq", "ne", "gt", "gte", "lt", "lte", "exists"].map(function (op) {
                    return el("option", { key: op, value: op }, OP_LABEL[op]);
                  }),
                ),
                el("input", {
                  className: "dshgs-input",
                  placeholder: '和什么比（true / 3）',
                  value: value && value.$test && value.$test.value !== undefined ? valueToText(value.$test.value) : "",
                  onChange: function (event) {
                    var next = entries.map(function (pair, i) {
                      if (i !== rowIndex) return pair;
                      var text = event.target.value;
                      return [pair[0], { $test: Object.assign({}, pair[1].$test, { value: parseValueText(text) }) }];
                    });
                    write(next);
                  },
                }),
              )
            : null,
          el("button", {
            className: "dshgs-icon-btn",
            title: "删除该字段行",
            onClick: function () {
              write(entries.filter(function (_, i) { return i !== rowIndex; }));
            },
          }, "✕"),
          keyBad ? el("div", { className: "dshgs-inline-err" }, "字段名必填") : null,
        );
      });

      return el(
        "div",
        { className: "dshgs-fieldrows" },
        rows,
        el("button", {
          className: "dshgs-btn dshgs-btn-mini",
          onClick: function () { write(entries.concat([["", ""]])); },
        }, "+ 加字段"),
      );
    }

    /** 一张节点卡片内的「执行完去哪」：到头 / 固定去 / 按条件走。 */
    function OutgoingEditor(props) {
      var spec = props.spec;
      var updateSpec = props.updateSpec;
      var nodeName = props.node.name;
      var names = props.nodeNames.filter(function (n) { return n !== nodeName; });

      var edge = spec.edges.find(function (e) { return e.from === nodeName; });
      var cond = spec.conditionalEdges.find(function (e) { return e.from === nodeName; });
      var mode = cond ? "cond" : edge ? "static" : "none";

      function setMode(nextMode) {
        // 同模式再点一次不要重置用户已配置的目标 / 规则。
        if (nextMode === mode) return;
        updateSpec(function (c) {
          c.edges = c.edges.filter(function (e) { return e.from !== nodeName; });
          c.conditionalEdges = c.conditionalEdges.filter(function (e) { return e.from !== nodeName; });
          if (nextMode === "static") c.edges.push({ from: nodeName, to: names[0] ?? END });
          if (nextMode === "cond") {
            c.conditionalEdges.push({
              from: nodeName,
              rules: [{ field: "", op: "eq", value: true, to: names[0] ?? END }],
              fallback: END,
            });
          }
        });
      }

      function modeButton(value, label, title) {
        return el(
          "button",
          {
            className: "dshgs-mode-btn" + (mode === value ? " dshgs-mode-btn-active" : ""),
            title: title,
            onClick: function () { setMode(value); },
            type: "button",
          },
          label,
        );
      }

      var modeControls = el(
        "div",
        { className: "dshgs-mode-group" },
        modeButton("none", "到头", "执行完这个节点，图结束"),
        modeButton("static", "固定去 ▾", "执行完固定去另一个节点"),
        modeButton("cond", "按条件走", "按规则选择下一步，可设多条与兜底"),
      );

      var body = null;
      if (mode === "static") {
        body = el(
          "div",
          { className: "dshgs-row" },
          "执行完去：",
          targetSelect({
            names: names,
            value: edge ? edge.to : END,
            onChange: function (next) {
              updateSpec(function (c) {
                var target = c.edges.find(function (e) { return e.from === nodeName; });
                if (target) target.to = next;
              });
            },
          }),
        );
      } else if (mode === "cond") {
        var condIndex = spec.conditionalEdges.indexOf(cond);
        var rules = (cond && cond.rules) || [];
        var ruleRows = rules.map(function (rule, ruleIndex) {
          var targets = Array.isArray(rule.to) ? rule.to.slice() : [rule.to];
          function patchRule(mutator) {
            updateSpec(function (c) {
              var target = c.conditionalEdges[condIndex].rules[ruleIndex];
              mutator(target);
            });
          }
          var targetSelects = targets.map(function (targetValue, targetIndex) {
            return el(
              "span",
              { key: "t" + targetIndex, className: "dshgs-row" },
              targetSelect({
                names: names,
                value: targetValue,
                onChange: function (next) {
                  patchRule(function (rule) {
                    var list = Array.isArray(rule.to) ? rule.to.slice() : [rule.to];
                    list[targetIndex] = next;
                    rule.to = list.length === 1 ? list[0] : list;
                  });
                },
              }),
              targets.length > 1
                ? el("button", {
                    className: "dshgs-icon-btn",
                    title: "移除此并行目标",
                    onClick: function () {
                      patchRule(function (rule) {
                        var list = Array.isArray(rule.to) ? rule.to.slice() : [rule.to];
                        list.splice(targetIndex, 1);
                        rule.to = list.length === 1 ? list[0] : list;
                      });
                    },
                  }, "✕")
                : null,
            );
          });
          return el(
            "div",
            { key: "rule" + ruleIndex, className: "dshgs-rule" },
            el(
              "div",
              { className: "dshgs-row" },
              "当",
              el("input", {
                className: "dshgs-input dshgs-rule-field",
                placeholder: "看哪个字段（留空=必走）",
                value: rule.field ?? "",
                onChange: function (event) {
                  patchRule(function (target) {
                    if (event.target.value === "") delete target.field;
                    else target.field = event.target.value;
                  });
                },
              }),
              el(
                "select",
                {
                  className: "dshgs-input dshgs-select dshgs-op-select",
                  value: rule.op ?? "eq",
                  onChange: function (event) { patchRule(function (target) { target.op = event.target.value; }); },
                },
                ["eq", "ne", "gt", "gte", "lt", "lte", "exists"].map(function (op) {
                  return el("option", { key: op, value: op }, OP_LABEL[op]);
                }),
              ),
              el("input", {
                className: "dshgs-input dshgs-rule-value",
                placeholder: '和什么比（true / 3）',
                value: rule.value !== undefined ? valueToText(rule.value) : "",
                onChange: function (event) {
                  patchRule(function (target) {
                    var text = event.target.value;
                    if (text.trim() === "") delete target.value;
                    else target.value = parseValueText(text);
                  });
                },
              }),
              el("button", {
                className: "dshgs-icon-btn",
                title: "删除此规则",
                onClick: function () {
                  updateSpec(function (c) { c.conditionalEdges[condIndex].rules.splice(ruleIndex, 1); });
                },
              }, "✕"),
            ),
            el(
              "div",
              { className: "dshgs-row" },
              "→ 去",
              targetSelects,
              targets.length === 1
                ? el("button", {
                    className: "dshgs-btn dshgs-btn-mini",
                    title: "同时去多个节点（并行）",
                    onClick: function () {
                      patchRule(function (rule) {
                        rule.to = Array.isArray(rule.to) ? rule.to.concat([names[0] ?? END]) : [rule.to, names[0] ?? END];
                      });
                    },
                  }, "+ 并行目标")
                : null,
            ),
          );
        });
        body = el(
          "div",
          { className: "dshgs-rules" },
          ruleRows,
          el("button", {
            className: "dshgs-btn dshgs-btn-mini",
            onClick: function () {
              updateSpec(function (c) {
                c.conditionalEdges[condIndex].rules.push({ field: "", op: "eq", value: true, to: names[0] ?? END });
              });
            },
          }, "+ 加条件"),
          el(
            "div",
            { className: "dshgs-row dshgs-fallback-row" },
            "以上都不满足时去：",
            targetSelect({
              names: names,
              value: cond ? cond.fallback ?? END : END,
              onChange: function (next) {
                updateSpec(function (c) {
                  var target = c.conditionalEdges[condIndex];
                  target.fallback = next;
                });
              },
            }),
          ),
        );
      }

      return el(
        "div",
        { className: "dshgs-outgoing" },
        el("div", { className: "dshgs-label dshgs-outgoing-label" }, "执行完去哪"),
        modeControls,
        body,
      );
    }

    function NodeCard(props) {
      var node = props.node;
      var updateSpec = props.updateSpec;
      var hostOnly = node.kind === "subagent" || node.kind === "gate";

      function findNode(copy) {
        return copy.nodes.find(function (n) { return n.name === node.name; });
      }

      var kindEditors = {
        patch: function () {
          return el(FieldRowsEditor, {
            keyPlaceholder: "要改的状态字段",
            fields: node.patch ?? {},
            onChange: function (next) {
              updateSpec(function (c) {
                var target = findNode(c);
                if (target) target.patch = next;
              });
            },
          });
        },
        counter: function () {
          var counter = node.counter ?? { field: "", limit: 3 };
          return el(
            "div",
            { className: "dshgs-field" },
            el(
              "div",
              { className: "dshgs-row" },
              "每次给",
              el("input", {
                className: "dshgs-input",
                placeholder: "自增字段",
                value: counter.field ?? "",
                onChange: function (event) {
                  updateSpec(function (c) {
                    var target = findNode(c);
                    if (target) (target.counter ??= { field: "", limit: 3 }).field = event.target.value;
                  });
                },
              }),
              "加 1，到",
              el("input", {
                className: "dshgs-input dshgs-input-number",
                type: "number",
                min: 1,
                value: counter.limit ?? 3,
                onChange: function (event) {
                  updateSpec(function (c) {
                    var target = findNode(c);
                    if (target) (target.counter ??= { field: "", limit: 3 }).limit = Number(event.target.value) || 1;
                  });
                },
              }),
              "次后，额外设置：",
            ),
            el(FieldRowsEditor, {
              keyPlaceholder: "达标后要改的字段（可选）",
              fields: (node.counter && node.counter.then) ?? {},
              onChange: function (next) {
                updateSpec(function (c) {
                  var target = findNode(c);
                  if (target) (target.counter ??= { field: "", limit: 3 }).then = next;
                });
              },
            }),
          );
        },
        subagent: function () {
          return el("div", { className: "dshgs-field" },
            el("div", { className: "dshgs-label" }, "交给子代理做的事（仅宿主侧可执行）"),
            el("textarea", {
              className: "dshgs-code",
              rows: 3,
              placeholder: "任务描述，可用 {{state}} 引用当前状态",
              value: node.prompt ?? "",
              onChange: function (event) {
                updateSpec(function (c) {
                  var target = findNode(c);
                  if (target) target.prompt = event.target.value;
                });
              },
            }),
          );
        },
        gate: function () {
          var gate = node.gate ?? { toolName: "" };
          return el("div", { className: "dshgs-field" },
            el(
              "div",
              { className: "dshgs-row" },
              "审批工具名：",
              el("input", {
                className: "dshgs-input",
                placeholder: "如 graph.deploy",
                value: gate.toolName ?? "",
                onChange: function (event) {
                  updateSpec(function (c) {
                    var target = findNode(c);
                    if (target) (target.gate ??= { toolName: "" }).toolName = event.target.value;
                  });
                },
              }),
            ),
            el("div", { className: "dshgs-label dshgs-label-hostonly" }, "执行前需人工批准（仅宿主侧可执行，需要 dsh-user-approval）"),
          );
        },
      };

      return el(
        "div",
        {
          className: "dshgs-node-card" + (props.selected ? " dshgs-node-card-selected" : ""),
          id: "dshgs-node-" + node.name,
        },
        el(
          "div",
          { className: "dshgs-row dshgs-nodecard-head" },
          el("input", {
            className: "dshgs-input dshgs-input-name",
            list: "dshgs-nodelist",
            value: node.name,
            title: "节点名",
            onChange: function (event) {
              var next = event.target.value;
              updateSpec(function (c) {
                renameNodeRef(c, node.name, next);
              });
            },
          }),
          el(
            "select",
            {
              className: "dshgs-input dshgs-select dshgs-kind-select",
              value: node.kind,
              title: "节点类型",
              onChange: function (event) {
                updateSpec(function (c) {
                  var target = findNode(c);
                  if (target) target.kind = event.target.value;
                });
              },
            },
            el("option", { value: "patch" }, "改状态"),
            el("option", { value: "counter" }, "计数器"),
            el("option", { value: "subagent" }, "子代理"),
            el("option", { value: "gate" }, "审批门"),
          ),
          hostOnly ? el("span", { className: "dshgs-badge dshgs-badge-warn", title: "浏览器运行将在该节点报错" }, "host-only") : null,
          el("button", {
            className: "dshgs-btn dshgs-btn-mini" + (props.spec.entryPoint === node.name ? " dshgs-btn-primary" : ""),
            title: "把此节点设为图的入口（从这里开始执行）",
            disabled: props.spec.entryPoint === node.name,
            onClick: function () { updateSpec(function (c) { c.entryPoint = node.name; }); },
          }, props.spec.entryPoint === node.name ? "✓ 起点" : "设为起点"),
          el("button", {
            className: "dshgs-icon-btn",
            title: "删除节点（连带清理它的边）",
            onClick: function () { updateSpec(function (c) { deleteNodeRef(c, node.name); }); },
          }, "✕"),
        ),
        el("div", { className: "dshgs-row" },
          el("input", {
            className: "dshgs-input",
            placeholder: "白话摘要（画布上显示的名字，可选）",
            value: node.label ?? "",
            onChange: function (event) {
              updateSpec(function (c) {
                var target = findNode(c);
                if (target) target.label = event.target.value;
              });
            },
          }),
        ),
        el("div", { className: "dshgs-label" }, "这个节点做什么"),
        kindEditors[node.kind] ? kindEditors[node.kind]() : null,
        el(OutgoingEditor, {
          spec: props.spec,
          updateSpec: updateSpec,
          node: node,
          nodeNames: props.nodeNames,
        }),
      );
    }

    // ---- 右列：DAG 预览 ----

    function DagPanel(props) {
      var spec = props.spec;
      var layout = computeLayout(spec);
      var zoomState = React.useState(1);
      var zoom = zoomState[0];
      var setZoom = zoomState[1];
      var linkingState = React.useState("");
      var linkingFrom = linkingState[0];
      var setLinkingFrom = linkingState[1];
      var selectedEdgeState = React.useState("");
      var selectedEdge = selectedEdgeState[0];
      var setSelectedEdge = selectedEdgeState[1];
      var canvasRef = React.useRef(null);
      var interactionRef = React.useRef(null);
      var propsRef = React.useRef(props);
      propsRef.current = props;
      React.useEffect(function () {
        function onMove(event) {
          var action = interactionRef.current;
          if (!action) return;
          if (action.kind === "pan") {
            action.canvas.scrollLeft = action.left - (event.clientX - action.x);
            action.canvas.scrollTop = action.top - (event.clientY - action.y);
            return;
          }
          var x = Math.max(12, action.originX + (event.clientX - action.x) / action.pixelsPerUnit);
          var y = Math.max(12, action.originY + (event.clientY - action.y) / action.pixelsPerUnit);
          propsRef.current.updateSpec(function (copy) {
            (copy.positions ??= {})[action.node] = { x: x, y: y };
          });
        }
        function onUp() { interactionRef.current = null; }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return function () {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      }, []);
      if (spec.nodes.length === 0) {
        return el("div", { className: "dshgs-dag dshgs-dag-empty" }, "从左侧模板开始后，这里会实时渲染 DAG 预览。");
      }
      var statuses = props.statuses || {};

      function edgeKey(edge) { return edge.kind + ":" + edge.from + ":" + edge.to; }
      function nextName(copy) {
        var index = copy.nodes.length + 1;
        var name = "节点_" + index;
        while (copy.nodes.some(function (node) { return node.name === name; })) name = "节点_" + (++index);
        return name;
      }
      function addNode(event) {
        if (event.target !== event.currentTarget) return;
        var box = event.currentTarget.getBoundingClientRect();
        var x = Math.max(12, ((event.clientX - box.left) / box.width) * layout.width - NODE_W / 2);
        var y = Math.max(12, ((event.clientY - box.top) / box.height) * layout.height - NODE_H / 2);
        props.updateSpec(function (copy) {
          var name = nextName(copy);
          copy.nodes.push({ name: name, kind: "patch", label: name, patch: {} });
          (copy.positions ??= {})[name] = { x: x, y: y };
          if (!copy.entryPoint) copy.entryPoint = name;
        });
      }
      function connect(from, to) {
        if (!from || from === to) return;
        props.updateSpec(function (copy) {
          if (copy.conditionalEdges.some(function (edge) { return edge.from === from; })) return;
          copy.edges = copy.edges.filter(function (edge) { return edge.from !== from; });
          copy.edges.push({ from: from, to: to });
        });
      }
      function deleteSelectedEdge() {
        if (!selectedEdge || selectedEdge.indexOf("static:") !== 0) return;
        var parts = selectedEdge.split(":");
        props.updateSpec(function (copy) {
          copy.edges = copy.edges.filter(function (edge) { return !(edge.from === parts[1] && edge.to === parts[2]); });
        });
        setSelectedEdge("");
      }
      function startPan(event) {
        if (event.target !== event.currentTarget || !canvasRef.current) return;
        interactionRef.current = {
          kind: "pan", canvas: canvasRef.current, x: event.clientX, y: event.clientY,
          left: canvasRef.current.scrollLeft, top: canvasRef.current.scrollTop,
        };
      }
      function startNodeDrag(event, node, pos) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        var box = event.currentTarget.ownerSVGElement.getBoundingClientRect();
        interactionRef.current = {
          kind: "node", node: node.name, x: event.clientX, y: event.clientY,
          originX: pos.x, originY: pos.y, pixelsPerUnit: box.width / layout.width,
        };
      }

      var edgePaths = layout.edges.map(function (edge, index) {
        var from = layout.positions[edge.from];
        var to = layout.positions[edge.to];
        if (!from || !to) return null;
        var backward = to.x <= from.x;
        var d;
        if (backward) {
          var swing = 46;
          d = "M " + (from.x + NODE_W / 2) + " " + (from.y + NODE_H) +
            " C " + (from.x + NODE_W / 2) + " " + (from.y + NODE_H + swing) +
            ", " + (to.x + NODE_W / 2) + " " + (to.y + NODE_H + swing) +
            ", " + (to.x + NODE_W / 2) + " " + (to.y + NODE_H);
        } else {
          var x1 = from.x + NODE_W;
          var y1 = from.y + NODE_H / 2;
          var x2 = to.x;
          var y2 = to.y + NODE_H / 2;
          var midX = (x1 + x2) / 2;
          d = "M " + x1 + " " + y1 + " C " + midX + " " + y1 + ", " + midX + " " + y2 + ", " + x2 + " " + y2;
        }
        var active = props.running && statuses[edge.from] && statuses[edge.from].state === "done";
        return el("path", {
          key: "e" + index,
          d: d,
          className: "dshgs-edge dshgs-edge-" + edge.kind + (active ? " dshgs-edge-active" : "") + (selectedEdge === edgeKey(edge) ? " dshgs-edge-selected" : ""),
          markerEnd: "url(#dshgs-arrow)",
          onClick: function (event) {
            event.stopPropagation();
            if (edge.kind === "static") setSelectedEdge(edgeKey(edge));
            else props.setSelected(edge.from);
          },
        });
      });

      var nodeShapes = spec.nodes.map(function (node) {
        var pos = layout.positions[node.name];
        if (!pos) return null;
        var status = statuses[node.name] || { runs: 0, state: "idle" };
        var label = node.label || node.name;
        var kindText = { patch: "改状态", counter: "计数器", subagent: "子代理", gate: "审批门" }[node.kind] ?? node.kind;
        return el(
          "g",
          {
            key: node.name,
            transform: "translate(" + pos.x + "," + pos.y + ")",
            className: "dshgs-node dshgs-node-" + status.state + (props.selected === node.name ? " dshgs-node-selected" : ""),
            role: "button",
            tabIndex: 0,
            "aria-label": "节点：" + label,
            onPointerDown: function (event) { startNodeDrag(event, node, pos); },
            onClick: function () {
              if (linkingFrom) {
                connect(linkingFrom, node.name);
                setLinkingFrom("");
              }
              props.setSelected(node.name);
              var target = window.document.getElementById("dshgs-node-" + node.name);
              if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "center" });
            },
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); }
            },
          },
          el("rect", { width: NODE_W, height: NODE_H, rx: 10 }),
          el("text", { x: NODE_W / 2, y: 19, className: "dshgs-node-name", textAnchor: "middle" }, label.length > 14 ? label.slice(0, 13) + "…" : label),
          el("text", { x: NODE_W / 2, y: 35, className: "dshgs-node-kind", textAnchor: "middle" }, kindText),
          status.runs > 0 ? el("circle", { cx: NODE_W - 10, cy: 10, r: 9, className: "dshgs-runs-circle" }) : null,
          status.runs > 0 ? el("text", { x: NODE_W - 10, y: 13.5, className: "dshgs-runs-text", textAnchor: "middle" }, String(status.runs)) : null,
          node.kind === "subagent" || node.kind === "gate" ? el("text", { x: 10, y: 15, className: "dshgs-hostonly-mark", title: "host-only" }, "▲") : null,
          el("circle", {
            cx: NODE_W, cy: NODE_H / 2, r: 6, className: "dshgs-port" + (linkingFrom === node.name ? " dshgs-port-active" : ""),
            role: "button", tabIndex: 0, "aria-label": "从 " + label + " 创建连线",
            onPointerDown: function (event) { event.stopPropagation(); },
            onClick: function (event) { event.stopPropagation(); setLinkingFrom(node.name); },
            onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setLinkingFrom(node.name); } },
          }),
        );
      });

      return el(
        "div",
        { className: "dshgs-dag", ref: canvasRef },
        el("div", { className: "dshgs-canvas-tools" },
          el("button", { type: "button", className: "dshgs-btn dshgs-btn-mini", onClick: function () { setZoom(function (value) { return Math.min(1.8, Math.round((value + 0.1) * 10) / 10); }); } }, "＋"),
          el("span", { className: "dshgs-run-hint" }, Math.round(zoom * 100) + "%"),
          el("button", { type: "button", className: "dshgs-btn dshgs-btn-mini", onClick: function () { setZoom(function (value) { return Math.max(0.6, Math.round((value - 0.1) * 10) / 10); }); } }, "－"),
          el("button", { type: "button", className: "dshgs-btn dshgs-btn-mini", onClick: function () { setZoom(1); } }, "适应"),
          linkingFrom ? el("span", { className: "dshgs-run-hint" }, "选择目标节点以连线，Esc 取消") : null,
          selectedEdge ? el("button", { type: "button", className: "dshgs-btn dshgs-btn-mini dshgs-btn-danger", onClick: deleteSelectedEdge }, "删除连线") : null,
        ),
        el(
          "svg",
          {
            className: "dshgs-svg", viewBox: "0 0 " + layout.width + " " + layout.height, preserveAspectRatio: "xMidYMin meet",
            role: "application", tabIndex: 0, "aria-label": "状态图画布。双击空白处添加节点；选择端口后点击节点创建连线。",
              style: { transform: "scale(" + zoom + ")", transformOrigin: "0 0" },
              onDoubleClick: addNode,
              onPointerDown: startPan,
            onKeyDown: function (event) {
              if (event.key === "Escape") { setLinkingFrom(""); setSelectedEdge(""); }
              if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelectedEdge(); }
            },
          },
          el(
            "defs",
            null,
            el("marker", {
              id: "dshgs-arrow",
              viewBox: "0 0 10 10",
              refX: 9,
              refY: 5,
              markerWidth: 7,
              markerHeight: 7,
              orient: "auto-start-reverse",
            }, el("path", { d: "M 0 1 L 9 5 L 0 9 z", className: "dshgs-arrowhead" })),
          ),
          edgePaths,
          nodeShapes,
        ),
        el(
          "div",
          { className: "dshgs-legend" },
          el("span", { className: "dshgs-legend-item" }, el("svg", { viewBox: "0 0 16 4", className: "dshgs-legend-line" }, el("line", { x1: 0, y1: 2, x2: 16, y2: 2, className: "dshgs-edge-static" })), "固定去"),
          el("span", { className: "dshgs-legend-item" }, el("svg", { viewBox: "0 0 16 4", className: "dshgs-legend-line" }, el("line", { x1: 0, y1: 2, x2: 16, y2: 2, className: "dshgs-edge-cond" })), "按条件走"),
          el("span", { className: "dshgs-legend-item" }, "▲ host-only"),
        ),
      );
    }

    // ---- 底部：运行与轨迹 ----

    function RunPanel(props) {
      var run = props.run;
      var collapsedState = React.useState(false);
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];

      function toggle() {
        setCollapsed(function (prev) { return !prev; });
      }

      var resultBox = null;
      if (run.result && run.result.ok && run.result.command) {
        resultBox = el(
          "div",
          { className: "dshgs-result dshgs-result-ok", role: "status" },
          "✔ " + (run.result.message || ("已发布命令 /" + run.result.command)),
        );
      } else if (run.result && run.result.ok) {
        var result = run.result.result;
        var totalMs = run.finishedAt - run.startedAt;
        resultBox = el(
          "div",
          { className: "dshgs-result dshgs-result-ok", role: "status", "aria-live": "polite" },
          el("div", null, "✔ 完成：" + result.trajectory.join(" → ") + "（" + result.iterations + " 步，" + totalMs + " ms）"),
          el("pre", { className: "dshgs-code dshgs-pre" }, pretty(result.finalState)),
        );
      } else if (run.result && !run.result.ok) {
        resultBox = el("div", { className: "dshgs-result dshgs-result-err", role: "alert" }, "✖ " + run.result.error);
      }

      var rows = props.timeline.map(function (row, index) {
        if (row.kind === "start") {
          return el("div", { key: index, className: "dshgs-tl-row dshgs-tl-meta" }, "▶ 开始 · 从 " + row.entryPoint + " 出发");
        }
        if (row.kind === "node") {
          var patchText = row.patch !== undefined ? JSON.stringify(row.patch) : "";
          return el(
            "div",
            { key: index, className: "dshgs-tl-row" + (row.error ? " dshgs-tl-row-error" : "") },
            el("span", { className: "dshgs-tl-iter" }, "#" + row.iteration),
            el("span", { className: "dshgs-tl-node" }, row.node),
            el("span", { className: "dshgs-tl-duration" }, row.durationMs !== undefined ? row.durationMs + "ms" : row.error ? "✖" : "…"),
            patchText ? el("code", { className: "dshgs-tl-patch", title: patchText }, patchText.length > 80 ? patchText.slice(0, 79) + "…" : patchText) : null,
            row.error ? el("span", { className: "dshgs-tl-error" }, row.error) : null,
          );
        }
        if (row.kind === "node-error") {
          return el("div", { key: index, className: "dshgs-tl-row dshgs-tl-row-error" }, "✖ " + row.node + "：" + row.error);
        }
        if (row.kind === "graph-error") {
          return el("div", { key: index, className: "dshgs-tl-row dshgs-tl-row-error" }, "✖ 终止于 " + row.node + "：" + row.error);
        }
        if (row.kind === "end") {
          return el("div", { key: index, className: "dshgs-tl-row dshgs-tl-meta" }, "■ 结束 · 共 " + row.iterations + " 步");
        }
        return null;
      });

      return el(
        "div",
        { className: "dshgs-run" },
        el("div", { className: "dshgs-run-header" },
          el("span", { className: "dshgs-label" }, "运行"),
          el("button", { className: "dshgs-run-toggle", onClick: toggle, type: "button" }, collapsed ? "展开轨迹 ▾" : "收起轨迹 ▴"),
        ),
        props.simpleMode
          ? null
          : el(
            "div",
            { className: "dshgs-run-controls" },
            el("span", { className: "dshgs-label" }, "初始状态（图运行前长什么样，JSON）"),
            el("textarea", {
              className: "dshgs-code dshgs-initial" + (props.initialValid ? "" : " dshgs-code-invalid"),
              rows: 3,
              value: props.initialText,
              onChange: function (event) { props.setInitialText(event.target.value); },
            }),
            props.initialValid
              ? null
              : el("div", { className: "dshgs-inline-err" }, "JSON 无效：" + props.initialError),
          ),
        props.simpleMode && !props.validation.ok
          ? el(
            "div",
            { className: "dshgs-inline-err" },
            "还有 " + props.validation.errors.length + " 处需要修正后才能运行：" + props.validation.errors.join("；"),
          )
          : null,
        el(
          "div",
          { className: "dshgs-run-buttons" },
          el("span", { className: "dshgs-label" }, "运行方式"),
          el(
            "span",
            { className: "dshgs-mode-group" },
            el("button", {
              type: "button",
              className: "dshgs-mode-btn" + (props.runMode === "browser" ? " dshgs-mode-btn-active" : ""),
              onClick: function () { props.setRunMode("browser"); },
            }, "浏览器模拟"),
            el("button", {
              type: "button",
              className: "dshgs-mode-btn" + (props.runMode === "host" ? " dshgs-mode-btn-active" : ""),
              onClick: function () { props.setRunMode("host"); },
            }, "宿主真实运行"),
          ),
          props.running
            ? el("button", { className: "dshgs-btn dshgs-btn-danger", onClick: props.stopRun }, "■ 停止")
            : el("button", {
              className: "dshgs-btn dshgs-btn-primary",
              disabled: !(props.runMode === "host" ? (props.canRun && !props.hostOnlyPresent) : props.canRun),
              title: (props.runMode === "host" && props.hostOnlyPresent) ? "含审批门 / 子代理节点，宿主直接运行不支持，请用「在会话中运行」" : undefined,
              onClick: props.runMode === "host" ? props.startHostRun : props.startRun,
            }, "▶ 运行"),
          el("button", {
            type: "button",
            className: "dshgs-btn",
            disabled: props.running || !props.validation.ok,
            title: "把当前图发布为 dsh slash 命令（仅支持纯业务节点 patch / counter）",
            onClick: props.onPublish,
          }, "发布为命令"),
        ),
        el("span", { className: "dshgs-run-hint" }, props.runMode === "host"
          ? "宿主真实运行：在 dsh 进程里执行同一份引擎（支持真实状态流转；审批门 / 子代理节点需在会话里运行）。"
          : "浏览器模拟：用与宿主同一份引擎在本地执行；▲ host-only 节点（子代理 / 审批门）在这里只会报教学错误。"),
      !collapsed ? resultBox : null,
      !collapsed && rows.length > 0
        ? el("div", { className: "dshgs-timeline" }, el("div", { className: "dshgs-section-title" }, "轨迹"), rows)
        : null,
    );
    }

    // ---- 样式（dshgs- 前缀；配色改用 dsh 官方 --dsw-alias-* 令牌，fallback 为深色；宿主浅/深主题经 iframe 同步） ----

    var STYLE_TEXT = [
      ".dshgs-root{display:flex;flex-direction:column;gap:8px;height:100%;min-height:560px;padding:10px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary,#e8eaed);background:var(--dsw-alias-bg-base,#1d2128)}",
      /* 设置面板内容列约 500px：水平两栏放不下，配置列在上横向滚动、预览在下整行 */
      ".dshgs-header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".dshgs-title{font-size:15px;font-weight:600}",
      ".dshgs-header-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dshgs-main{display:flex;flex-direction:column;gap:10px;flex:1 1 320px;min-height:320px;overflow:auto}",
      ".dshgs-config{overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}",
      ".dshgs-templates{gap:6px}",
      ".dshgs-template-btn{text-align:left;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;padding:8px 10px;color:inherit;font:inherit;cursor:pointer}",
      ".dshgs-template-btn:hover{border-color:var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-template-title{font-weight:600}",
      ".dshgs-template-detail{font-size:12px;opacity:.7;margin-top:2px}",
      ".dshgs-dag{flex:1 1 240px;min-height:240px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:6px;position:relative}",
      ".dshgs-dag-empty{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}",
      ".dshgs-svg{width:100%;height:auto;display:block}",
      ".dshgs-section-title{font-weight:600;margin-top:6px;padding-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
      ".dshgs-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dshgs-node-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));flex:1 1 0;width:100%;min-width:0;box-sizing:border-box}",
      ".dshgs-node-card-selected{border-color:var(--dsw-alias-brand-primary,#4f8ef7);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-nodecard-head{flex-wrap:nowrap}",
      ".dshgs-input{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;color:inherit;padding:4px 8px;font:inherit;min-width:0;flex:1;box-sizing:border-box}",
      ".dshgs-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-input-name{font-weight:600;flex:1.2}",
      ".dshgs-input-number{flex:none;width:72px}",
      ".dshgs-select{flex:none;max-width:150px}",
      ".dshgs-graph-picker{max-width:170px}.dshgs-graph-name{max-width:150px}",
      ".dshgs-kind-select{max-width:96px}",
      ".dshgs-op-select{flex:none;width:80px}",
      ".dshgs-label{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.75))}",
      ".dshgs-label-hostonly{color:var(--dsw-alias-state-warn-primary,#e0a23c);opacity:1}",
      ".dshgs-btn{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.15));border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35)));border-radius:6px;color:inherit;padding:4px 10px;font:inherit;cursor:pointer}",
      ".dshgs-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dshgs-btn-primary{border-color:var(--dsw-alias-brand-primary,#4f8ef7);color:var(--dsw-alias-brand-primary,#4f8ef7);font-weight:600}",
      ".dshgs-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5566d);color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-btn-mini{align-self:flex-start;padding:2px 8px;font-size:12px}",
      ".dshgs-icon-btn{background:none;border:none;color:inherit;opacity:.55;cursor:pointer;padding:2px 4px;font:inherit;flex:none}",
      ".dshgs-icon-btn:hover{opacity:1}",
      ".dshgs-mode-group{display:inline-flex;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35)));border-radius:6px;overflow:hidden}",
      ".dshgs-mode-btn{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));border:none;color:inherit;padding:3px 10px;font:inherit;cursor:pointer;font-size:12px;white-space:nowrap}",
      ".dshgs-mode-btn:hover{background:var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
      ".dshgs-mode-btn-active{background:var(--dsw-alias-brand-primary,#4f8ef7);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dshgs-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;color:inherit;padding:4px 8px;width:100%;box-sizing:border-box;resize:vertical}",
      ".dshgs-code-invalid{border-color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-pre{white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;margin:6px 0 0}",
      ".dshgs-badge{font-size:11px;border-radius:999px;padding:2px 8px;border:1px solid}",
      ".dshgs-badge-ok{color:var(--dsw-alias-state-success-primary,#31b57c);border-color:var(--dsw-alias-state-success-primary,#31b57c)}",
      ".dshgs-badge-err{color:var(--dsw-alias-state-error-primary,#e5566d);border-color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-badge-warn{color:var(--dsw-alias-state-warn-primary,#e0a23c);border-color:var(--dsw-alias-state-warn-primary,#e0a23c)}",
      ".dshgs-validation{display:flex;flex-direction:column;gap:2px}",
      ".dshgs-validation-item{font-size:12px}",
      ".dshgs-validation-error{color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-validation-warn{color:var(--dsw-alias-state-warn-primary,#e0a23c)}",
      ".dshgs-fieldrows{display:flex;flex-direction:column;gap:4px}",
      ".dshgs-fieldrow{display:grid;grid-template-columns:1fr 74px minmax(0,1.6fr) 24px;gap:4px;align-items:center}",
      ".dshgs-fieldrow-bad .dshgs-input{border-color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-fieldrow-test{display:flex;gap:4px;min-width:0;flex:1}",
      ".dshgs-inline-err{color:var(--dsw-alias-state-error-primary,#e5566d);font-size:11px;grid-column:1/-1}",
      ".dshgs-rule{border-left:2px solid #b07ce8;padding-left:8px;display:flex;flex-direction:column;gap:4px}",
      ".dshgs-rule-field{flex:none;width:150px}",
      ".dshgs-rule-value{flex:none;width:130px}",
      ".dshgs-rules{display:flex;flex-direction:column;gap:6px}",
      ".dshgs-fallback-row{padding-left:10px}",
      ".dshgs-outgoing{border-top:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.3));padding-top:6px;display:flex;flex-direction:column;gap:4px}",
      ".dshgs-outgoing-label{font-weight:600;opacity:.9}",
      ".dshgs-global-row{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));padding-top:8px}",
      ".dshgs-edge{fill:none;stroke-width:1.6}",
      ".dshgs-edge-static{stroke:var(--dsw-alias-border-l3,#8a94a6)}",
      ".dshgs-edge-cond{stroke:#b07ce8;stroke-dasharray:5 4}",
      ".dshgs-edge-active{stroke:var(--dsw-alias-state-success-primary,#31b57c)}",
      ".dshgs-edge-selected{stroke:var(--dsw-alias-state-warn-primary,#e0a23c);stroke-width:3;cursor:pointer}",
      ".dshgs-arrowhead{fill:var(--dsw-alias-border-l3,#8a94a6)}",
      ".dshgs-node{cursor:pointer}",
      ".dshgs-node:focus{outline:none}.dshgs-node:focus rect{stroke:var(--dsw-alias-brand-primary,#4f8ef7);stroke-width:2.5}",
      ".dshgs-port{fill:var(--dsw-alias-brand-primary,#4f8ef7);stroke:var(--dsw-alias-border-l3,#fff);stroke-width:1.5;cursor:crosshair}.dshgs-port-active{fill:var(--dsw-alias-state-warn-primary,#e0a23c)}",
      ".dshgs-node rect{fill:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));stroke:var(--dsw-alias-border-l3,#8a94a6);stroke-width:1.4}",
      ".dshgs-node-idle rect{stroke:var(--dsw-alias-border-l3,#8a94a6)}",
      ".dshgs-node-running rect{stroke:var(--dsw-alias-brand-primary,#4f8ef7);stroke-width:2;animation:dshgs-pulse 1s ease-in-out infinite}",
      ".dshgs-node-done rect{stroke:var(--dsw-alias-state-success-primary,#31b57c)}",
      ".dshgs-node-error rect{stroke:var(--dsw-alias-state-error-primary,#e5566d);stroke-width:2}",
      ".dshgs-node-selected rect{stroke-width:2.4}",
      ".dshgs-node-name{font-size:12px;font-weight:600;fill:currentColor}",
      ".dshgs-node-kind{font-size:10px;opacity:.65;fill:currentColor}",
      ".dshgs-hostonly-mark{font-size:9px;fill:var(--dsw-alias-state-warn-primary,#e0a23c)}",
      ".dshgs-runs-circle{fill:var(--dsw-alias-border-l3,rgba(127,127,127,.35)))}",
      ".dshgs-runs-text{font-size:9px;fill:currentColor}",
      "@keyframes dshgs-pulse{0%,100%{opacity:1}50%{opacity:.45}}",
      ".dshgs-legend{display:flex;gap:14px;font-size:11px;opacity:.8;padding:2px 4px;position:sticky;left:0}",
      ".dshgs-canvas-tools{display:flex;align-items:center;gap:5px;padding:2px 0 7px;position:sticky;left:0;z-index:1;background:inherit}",
      ".dshgs-legend-item{display:inline-flex;align-items:center;gap:4px}",
      ".dshgs-legend-line{width:18px;height:5px}",
      ".dshgs-run{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;max-height:40%;overflow:auto}",
      ".dshgs-run-controls{display:flex;flex-direction:column;gap:4px}",
      ".dshgs-initial{width:100%}",
      ".dshgs-run-buttons{display:flex;align-items:center;gap:8px}",
      ".dshgs-run-hint{font-size:11px;opacity:.65}",
      ".dshgs-result{border-radius:8px;padding:8px 10px;border:1px solid}",
      ".dshgs-result-ok{border-color:var(--dsw-alias-state-success-primary,#31b57c);color:inherit}",
      ".dshgs-result-err{border-color:var(--dsw-alias-state-error-primary,#e5566d);color:var(--dsw-alias-state-error-primary,#e5566d);white-space:pre-wrap}",
      ".dshgs-timeline{display:flex;flex-direction:column;gap:2px}",
      ".dshgs-tl-row{display:flex;align-items:baseline;gap:8px;font-size:12px}",
      ".dshgs-tl-iter{opacity:.55;font-size:11px;min-width:26px}",
      ".dshgs-tl-node{font-weight:600}",
      ".dshgs-tl-duration{opacity:.7;font-size:11px;min-width:40px}",
      ".dshgs-tl-patch{font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.75;word-break:break-all}",
      ".dshgs-tl-error{color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-tl-row-error{color:var(--dsw-alias-state-error-primary,#e5566d)}",
      ".dshgs-tl-meta{opacity:.7}",
      ".dshgs-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center;z-index:2147482999}",
      /* 全屏抽屉：占满 shell.overlay 覆盖层，自身主题背景独立于设置面板 */
      ".dshgs-overlay-card{background:var(--dsw-alias-bg-layer-2,#2b2f36);color:var(--dsw-alias-label-primary,#e8eaed);border-radius:12px;padding:14px;width:min(720px,90vw);display:flex;flex-direction:column;gap:8px}",
      ".dshgs-overlay-title{font-size:13px}",
      ".dshgs-overlay-text{height:50vh}",
      ".dshgs-overlay-actions{display:flex;gap:8px;justify-content:flex-end}",
      ".dshgs-fullscreen{position:fixed;inset:0;background:var(--dsw-alias-bg-base,#1d2128);color:var(--dsw-alias-label-primary,#e8eaed);display:flex;flex-direction:column;z-index:2147483000}",
      ".dshgs-fullscreen-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
      ".dshgs-frame{display:block;flex:1;min-height:0;width:100%;border:0;background:var(--dsw-alias-bg-base,#1d2128)}",
      ".dshgs-fullscreen .dshgs-main{flex-direction:row;flex:1;min-height:0;overflow:hidden}",
      ".dshgs-fullscreen .dshgs-config{width:480px;flex:none;height:100%;overflow:auto;box-sizing:border-box}",
      ".dshgs-fullscreen .dshgs-dag{flex:1;min-width:0;height:100%}",
      ".dshgs-fullscreen .dshgs-node-card{min-width:440px;width:100%}",
      ".dshgs-fullscreen .dshgs-run{max-height:none;overflow:auto}",
      /* Welcome 引导面板 */
      ".dshgs-welcome{display:flex;flex-direction:column;gap:12px;padding:4px}",
      ".dshgs-welcome-title{font-size:16px;font-weight:600;margin-bottom:4px}",
      ".dshgs-welcome-steps{display:flex;flex-direction:column;gap:8px}",
      ".dshgs-step{display:flex;gap:10px;align-items:flex-start}",
      ".dshgs-step-num{width:24px;height:24px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4f8ef7);color:var(--dsw-alias-label-primary-foreground,#fff);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex:none}",
      ".dshgs-step-body{flex:1}",
      ".dshgs-step-title{font-weight:600;font-size:13px}",
      ".dshgs-step-detail{font-size:12px;opacity:.7;margin-top:2px}",
      ".dshgs-welcome-templates{display:flex;flex-direction:column;gap:6px}",
      /* 运行面板折叠 */
      ".dshgs-run-collapsed{display:flex;align-items:center;gap:8px;padding:6px 10px}",
      ".dshgs-run-toggle{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.15));border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35)));border-radius:6px;color:inherit;padding:3px 10px;font:inherit;cursor:pointer;font-size:12px}",
      ".dshgs-run-toggle:hover{border-color:var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-run-header{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      /* 节点类型语义色 */
      ".dshgs-node-patch rect{stroke:var(--dsw-alias-brand-primary,#4f8ef7)}",
      ".dshgs-node-counter rect{stroke:var(--dsw-alias-state-warn-primary,#e0a23c)}",
      ".dshgs-node-subagent rect{stroke:#b07ce8}",
      ".dshgs-node-gate rect{stroke:var(--dsw-alias-state-success-primary,#31b57c)}",
      /* 侧边栏入口按钮：位于宿主 UI 内（Settings 旁），hover 用宿主变量、带回退 */
      ".dshgs-entry{background:none;border:none;color:inherit;opacity:.8;cursor:pointer;padding:4px 8px;font:inherit;font-size:12px;white-space:nowrap;border-radius:6px}",
      ".dshgs-entry:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))}",
      /* 自然语言生成栏 */
      ".dshgs-gen{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-1,rgba(79,142,247,.08))}",
      ".dshgs-gen-input{flex:1 1 auto}",
      ".dshgs-gen-result{display:flex;flex-direction:column;gap:8px;border-top:1px dashed var(--dsw-alias-border-l3,rgba(127,127,127,.35)));padding-top:8px}",
      ".dshgs-gen-summary{font-size:13px;font-weight:600}",
      ".dshgs-gen-preview{display:flex;flex-direction:column;gap:8px}",
      ".dshgs-gen-raw{font-size:12px}",
      ".dshgs-gen-raw pre{margin:6px 0 0}",
    ].join("\n");

    // ---- 插件导出 ----

    // 宿主主题跟随（主文档侧）：把宿主的 --dsw-alias-* / --dsh-* 令牌与 color-scheme
    // 合并拷贝到 documentElement，使 .dshgs-* UI（如全屏抽屉顶栏）跟随宿主浅/深主题，
    // 而非永远走深色 fallback。同时同源 iframe（/graph-studio）经 parent.documentElement
    // 也能读到令牌（standalone-runtime 会再拷贝一次，双重保险）。
    // 只写入本插件用到的 --dsw/--dsh 命名空间令牌，并观察 html/body 属性与 head 主题样式变化，
    // 因此不会冻结宿主自身的换肤（宿主改 data-theme/class 或替换主题 <style> 时这里会重新拷贝）。
    function syncHostThemeToDocument() {
      try {
        var doc = window.document;
        function roots() {
          var r = [doc.documentElement, doc.body];
          var tagged = doc.querySelector("[data-theme],[data-color-scheme],[data-dsh-theme]");
          if (tagged) r.push(tagged);
          return r;
        }
        var applying = false;
        function applyTokens() {
          if (applying) return;
          applying = true;
          try {
            var dst = doc.documentElement.style;
            var scheme = "";
            roots().forEach(function (root) {
              if (!root) return;
              var cs = window.getComputedStyle(root);
              for (var i = 0; i < cs.length; i++) {
                var name = cs[i];
                if (name.indexOf("--dsw") === 0 || name.indexOf("--dsh") === 0) {
                  dst.setProperty(name, cs.getPropertyValue(name));
                }
              }
              if (!scheme) {
                var s = cs.getPropertyValue("color-scheme");
                if (s) scheme = s;
              }
            });
            if (!scheme && window.matchMedia) {
              scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
            }
            if (scheme) dst.setProperty("color-scheme", scheme);
          } finally { applying = false; }
        }
        applyTokens();
        // 令牌可能晚于插件加载才就绪，补一次。
        setTimeout(applyTokens, 300);
        if (typeof MutationObserver !== "undefined") {
          var pending = false;
          function schedule() {
            if (pending) return;
            pending = true;
            setTimeout(function () { pending = false; applyTokens(); }, 120);
          }
          [doc.documentElement, doc.body].forEach(function (root) {
            if (root) new MutationObserver(schedule).observe(root, { attributes: true });
          });
          if (doc.head) {
            new MutationObserver(schedule).observe(doc.head, { childList: true, characterData: true, subtree: true });
          }
        }
      } catch (e) { /* 无宿主环境静默 */ }
    }



    exports.apply = function (ctx) {
      hostCtx = ctx;
      if (typeof window !== "undefined" && typeof window.document !== "undefined" && !window.document.getElementById("dshgs-style")) {
        var style = window.document.createElement("style");
        style.id = "dshgs-style";
        style.textContent = STYLE_TEXT;
        window.document.head.appendChild(style);
      }
      // 让抽屉顶栏等主文档侧 .dshgs-* UI 跟随宿主浅/深主题（避免永远深色 fallback）。
      syncHostThemeToDocument();
      // 全屏抽屉：挂 shell.overlay（root 级、inset:0 覆盖层），
      // 访问 /#graph-studio-open 或点侧边栏按钮打开，画布空间不受设置面板限制。
      // 设计器与单个会话无关，不占会话视图 tab，也不挂设置面板窄容器。
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "graph-studio-fullscreen",
            order: 20,
          },
          FullscreenStudio,
        );
      });
      // 入口按钮：侧边栏底部小动作（additive 槽位，不替换既有 UI）。
      // 点击设 hash → hashchange → 抽屉打开；状态单向流动。
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "graph-studio-open-button",
            order: 10,
            label: "Graph Studio",
          },
          function () {
            function open() {
              if (window.location && window.location.hash !== "#graph-studio-open") {
                window.location.hash = "graph-studio-open";
              }
            }
            return el(
              "button",
              {
                type: "button",
                className: "dshgs-entry",
                title: "打开 Graph Studio（可视化状态图设计器）",
                onClick: open,
              },
              "Graph Studio",
            );
          },
        );
      });
    };

    return module.exports;
  },
});
