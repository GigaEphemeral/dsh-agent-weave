import { test } from "node:test";
import assert from "node:assert/strict";
import {
  studioValidate,
  studioBuildGraph,
  studioExamples,
  studioTest,
  END,
} from "../lib/index.js";

/** 最小 ctx 桩：StateGraph 运行时只调用 ctx.emit / ctx.on。 */
function stubCtx() {
  const events = [];
  const listeners = [];
  return {
    events,
    emit(name, payload) {
      events.push({ name, payload });
      for (const { name: n, listener } of listeners) {
        if (n === name) listener(payload);
      }
    },
    on(name, listener) {
      listeners.push({ name, listener });
      return () => {
        const index = listeners.indexOf({ name, listener });
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
}

function findExample(id) {
  return studioExamples.find((example) => example.id === id);
}

// ---- studioTest：DSL 判定求值 ----

test("studioTest：六种比较与 exists 求值正确", () => {
  const state = { n: 3, s: "ok", flag: true, missing: undefined };
  assert.equal(studioTest(state, { field: "n", op: "eq", value: 3 }), true);
  assert.equal(studioTest(state, { field: "n", op: "ne", value: 3 }), false);
  assert.equal(studioTest(state, { field: "n", op: "gt", value: 2 }), true);
  assert.equal(studioTest(state, { field: "n", op: "gte", value: 3 }), true);
  assert.equal(studioTest(state, { field: "n", op: "lt", value: 3 }), false);
  assert.equal(studioTest(state, { field: "n", op: "lte", value: 3 }), true);
  assert.equal(studioTest(state, { field: "missing", op: "exists" }), false);
  assert.equal(studioTest(state, { field: "s", op: "exists" }), true);
  assert.equal(studioTest(state, { field: "s", op: "eq", value: "ok" }), true);
  assert.equal(studioTest(state, { field: "flag", op: "eq", value: true }), true);
  // 非数值比较按 NaN 处理为 false，而不是抛错
  assert.equal(studioTest(state, { field: "s", op: "gt", value: 1 }), false);
});

// ---- studioValidate：结构校验 ----

test("studioValidate：内置示例全部通过且无错误", () => {
  for (const example of studioExamples) {
    const result = studioValidate(example.spec);
    assert.equal(result.ok, true, `${example.id} 应通过校验：${result.errors.join("; ")}`);
  }
  // host-only 示例应携带警告提示
  const hostOnly = studioValidate(findExample("host-subagent").spec);
  assert.ok(hostOnly.warnings.some((w) => w.includes("仅宿主侧")));
});

test("studioValidate：缺节点、重名、保留名、坏入口报错", () => {
  const base = { entryPoint: "", nodes: [], edges: [], conditionalEdges: [] };
  assert.equal(studioValidate(base).ok, false);

  assert.equal(
    studioValidate({
      ...base,
      nodes: [{ name: "a", kind: "patch", patch: {} }, { name: "a", kind: "patch", patch: {} }],
    }).errors.some((e) => e.includes("重复定义")),
    true,
  );

  assert.equal(
    studioValidate({
      ...base,
      nodes: [{ name: END, kind: "patch", patch: {} }],
    }).errors.some((e) => e.includes("保留哨兵")),
    true,
  );

  assert.equal(
    studioValidate({
      ...base,
      entryPoint: "ghost",
      nodes: [{ name: "a", kind: "patch", patch: {} }],
    }).errors.some((e) => e.includes("未在节点表中定义")),
    true,
  );
});

test("studioValidate：kind 专属字段缺失与非法 maxIterations 报错", () => {
  const errors = studioValidate({
    entryPoint: "a",
    maxIterations: 0,
    nodes: [
      { name: "a", kind: "patch" },
      { name: "c", kind: "counter", counter: { field: "", limit: 2 } },
      { name: "s", kind: "subagent" },
      { name: "g", kind: "gate" },
      { name: "bad", kind: "nope" },
    ],
    edges: [],
    conditionalEdges: [],
  }).errors;
  assert.ok(errors.some((e) => e.includes("patch 必须是对象")));
  assert.ok(errors.some((e) => e.includes("counter.field")));
  assert.ok(errors.some((e) => e.includes("prompt")));
  assert.ok(errors.some((e) => e.includes("toolName")));
  assert.ok(errors.some((e) => e.includes("kind 必须是")));
  assert.ok(errors.some((e) => e.includes("maxIterations")));
});

test("studioValidate：悬空边、重复出边、坏规则目标与混用 END 报错", () => {
  const nodes = [{ name: "a", kind: "patch", patch: {} }];
  const spec = (edges, conditionalEdges) => ({
    entryPoint: "a",
    nodes,
    edges,
    conditionalEdges,
  });
  assert.ok(
    studioValidate(spec([{ from: "a", to: "ghost" }], [])).errors.some((e) => e.includes("to 必须是")),
  );
  assert.ok(
    studioValidate(
      spec([{ from: "a", to: END }, { from: "a", to: END }], []),
    ).errors.some((e) => e.includes("静态边重复定义")),
  );
  assert.ok(
    studioValidate(spec([], [{ from: "a", rules: [{ field: "x", op: "eq", value: 1, to: "ghost" }] }]))
      .errors.some((e) => e.includes("不是已定义节点")),
  );
  assert.ok(
    studioValidate(spec([], [{ from: "a", rules: [{ to: ["b", END] }] }]))
      .errors.some((e) => e.includes("不能混用")),
  );
  assert.ok(
    studioValidate(spec([], [{ from: "a", rules: [] }])).errors.some((e) => e.includes("至少需要一条规则")),
  );
  assert.ok(
    studioValidate(spec([], [{ from: "a", rules: [{ to: "a" }], fallback: "ghost" }]))
      .errors.some((e) => e.includes("fallback")),
  );
});

test("studioValidate：静态+条件并存与不可达节点给出警告", () => {
  const result = studioValidate({
    entryPoint: "a",
    nodes: [
      { name: "a", kind: "patch", patch: {} },
      { name: "island", kind: "patch", patch: {} },
    ],
    edges: [{ from: "a", to: "island" }],
    conditionalEdges: [{ from: "a", rules: [{ to: END }] }],
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("条件边优先生效")));
  assert.ok(result.warnings.some((w) => w.includes("不可达")));
});

// ---- studioBuildGraph：DSL → 真实引擎 ----

test("codegen-loop 示例：轨迹与 smoke §5 工作流一致", async () => {
  const ctx = stubCtx();
  const example = findExample("codegen-loop");
  const graph = studioBuildGraph(ctx, example.spec);
  const result = await graph.run(example.spec.initialState);
  assert.deepEqual(result.trajectory, [
    "generate_code",
    "static_analyze",
    "run_unit_test",
    "generate_code",
    "static_analyze",
    "run_unit_test",
  ]);
  assert.equal(result.iterations, 6);
  assert.equal(result.finalState.lintOk, true);
  assert.equal(result.finalState.testOk, true);
});

test("fan-out-join 示例：并行目标与汇聚", async () => {
  const ctx = stubCtx();
  const example = findExample("fan-out-join");
  const graph = studioBuildGraph(ctx, example.spec);
  const result = await graph.run({});
  assert.deepEqual(result.trajectory, ["split", "part_a", "part_b", "join"]);
  assert.deepEqual(result.finalState, {
    started: true,
    partA: "A 完成",
    partB: "B 完成",
    joined: true,
  });
});

test("patch 节点：$inc 自增（缺省字段从 0 起）与 $test 布尔", async () => {
  const ctx = stubCtx();
  const graph = studioBuildGraph(ctx, {
    entryPoint: "a",
    nodes: [
      {
        name: "a",
        kind: "patch",
        patch: {
          count: { $inc: 2 },
          fresh: { $inc: 1 },
          // $test 基于节点执行前的状态快照：count 仍为 3
          ready: { $test: { field: "count", op: "gte", value: 5 } },
          literal: "保持字面量",
        },
      },
      {
        name: "b",
        kind: "patch",
        // 跨节点可见：b 看到合并后的 count=5
        patch: { seen: { $test: { field: "count", op: "gte", value: 5 } } },
      },
    ],
    edges: [{ from: "a", to: "b" }],
    conditionalEdges: [],
  });
  const result = await graph.run({ count: 3 });
  assert.equal(result.finalState.count, 5);
  assert.equal(result.finalState.fresh, 1);
  assert.equal(result.finalState.ready, false);
  assert.equal(result.finalState.seen, true);
  assert.equal(result.finalState.literal, "保持字面量");
});

test("counter 节点：达到上限时合并 then 补丁", async () => {
  const ctx = stubCtx();
  const graph = studioBuildGraph(ctx, {
    entryPoint: "tick",
    nodes: [
      { name: "tick", kind: "counter", counter: { field: "tries", limit: 3, then: { passed: true } } },
    ],
    edges: [],
    conditionalEdges: [
      { from: "tick", rules: [{ field: "passed", op: "eq", value: true, to: END }], fallback: "tick" },
    ],
  });
  const result = await graph.run({});
  assert.deepEqual(result.trajectory, ["tick", "tick", "tick"]);
  assert.equal(result.finalState.tries, 3);
  assert.equal(result.finalState.passed, true);
});

test("条件边：无 field 规则恒命中、fallback 默认 END、规则按序首个生效", async () => {
  const ctx = stubCtx();
  const graph = studioBuildGraph(ctx, {
    entryPoint: "route",
    nodes: [
      { name: "route", kind: "patch", patch: { mode: "fast" } },
      { name: "slow", kind: "patch", patch: { slow: true } },
      { name: "fast", kind: "patch", patch: { fast: true } },
    ],
    edges: [],
    conditionalEdges: [
      { from: "route", rules: [{ field: "mode", op: "eq", value: "other", to: "slow" }, { to: "fast" }] },
      { from: "fast", rules: [{ field: "never", op: "eq", value: 1, to: "slow" }] },
    ],
  });
  const result = await graph.run({});
  // 第二条无 field 规则恒命中 → fast；fast 的唯一规则不命中 → fallback 默认 END
  assert.deepEqual(result.trajectory, ["route", "fast"]);
  assert.equal(result.finalState.fast, true);
});

test("subagent / gate 节点：浏览器等无服务环境下执行到该节点抛教学错误", async () => {
  const ctx = stubCtx();
  const graph = studioBuildGraph(ctx, findExample("host-subagent").spec);
  await assert.rejects(graph.run({ task: "x" }), /ctx\.subagents/);

  const gateGraph = studioBuildGraph(ctx, {
    entryPoint: "deploy",
    nodes: [{ name: "deploy", kind: "gate", gate: { toolName: "graph.deploy" } }],
    edges: [],
    conditionalEdges: [],
  });
  await assert.rejects(gateGraph.run({}, { agent: {} }), /ctx\.approval/);
});

test("DSL 图的 graph/* 事件流完整（供 Studio 轨迹面板消费）", async () => {
  const ctx = stubCtx();
  const graph = studioBuildGraph(ctx, findExample("fan-out-join").spec);
  await graph.run({});
  assert.deepEqual(ctx.events.map((e) => e.name), [
    "graph/start",
    "graph/node-start", // split
    "graph/node-end",
    "graph/node-start", // part_a / part_b 并行启动
    "graph/node-start",
    "graph/node-end",
    "graph/node-end",
    "graph/node-start", // join
    "graph/node-end",
    "graph/end",
  ]);
  const nodeEnd = ctx.events.find((e) => e.name === "graph/node-end");
  assert.ok(nodeEnd.payload.durationMs !== undefined);
  assert.ok(nodeEnd.payload.patch !== undefined);
});
