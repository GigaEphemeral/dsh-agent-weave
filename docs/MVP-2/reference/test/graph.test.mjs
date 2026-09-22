import { test } from "node:test";
import assert from "node:assert/strict";
import GraphEngineService, { StateGraph, END } from "../lib/index.js";

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
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("线性图：状态增量合并、轨迹与迭代计数正确", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", (s) => ({ step: (s.step ?? 0) + 1 }))
    .addNode("b", (s) => ({ done: true, step: s.step }))
    .addEdge("a", "b")
    .setEntryPoint("a");
  const result = await graph.run({});
  assert.equal(result.finalState.step, 1);
  assert.equal(result.finalState.done, true);
  assert.deepEqual(result.trajectory, ["a", "b"]);
  assert.equal(result.iterations, 2);
  const names = ctx.events.map((e) => e.name);
  assert.deepEqual(names, [
    "graph/start",
    "graph/node-start",
    "graph/node-end",
    "graph/node-start",
    "graph/node-end",
    "graph/end",
  ]);
  assert.equal(ctx.events[0].payload.graphId, result.graphId);
});

test("同一图重复运行：每次运行生成独立 graphId", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({ done: true }))
    .setEntryPoint("a");

  const first = await graph.run({});
  const second = await graph.run({});

  assert.notEqual(first.graphId, second.graphId);
  assert.deepEqual(
    ctx.events.map((event) => event.payload.graphId),
    [
      first.graphId,
      first.graphId,
      first.graphId,
      first.graphId,
      second.graphId,
      second.graphId,
      second.graphId,
      second.graphId,
    ],
  );
});

test("同一图并发运行：每次运行的事件和结果使用独立 graphId", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async (state) => {
      await sleep(1);
      return { run: state.run };
    })
    .setEntryPoint("a");

  const [first, second] = await Promise.all([
    graph.run({ run: "first" }),
    graph.run({ run: "second" }),
  ]);

  assert.notEqual(first.graphId, second.graphId);
  for (const result of [first, second]) {
    const events = ctx.events.filter((event) => event.payload.graphId === result.graphId);
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.payload.graphId === result.graphId));
  }
});

test("同一图并发运行：子代理保留各自 run 的父 Agent", async () => {
  const ctx = stubCtx();
  const parents = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  ctx.subagents = {
    async start(_provider, request) {
      parents.push(request.parent.id);
      return {
        result: Promise.resolve({ stopReason: "completed", structured: { result: {} }, output: "" }),
        dispose() {},
      };
    },
  };
  const graph = new StateGraph(ctx, 10)
    .addNode("wait", async (state) => {
      if (state.wait) await waiting;
      return {};
    })
    .addSubagent("delegate", { prompt: "delegate" })
    .addEdge("wait", "delegate")
    .setEntryPoint("wait");

  const first = graph.run({ wait: true }, { agent: { id: "agent-a" } });
  await new Promise((resolve) => setImmediate(resolve));
  await graph.run({ wait: false }, { agent: { id: "agent-b" } });
  release();
  await first;
  assert.deepEqual(parents, ["agent-b", "agent-a"]);
});

test("同一图后续运行未传 agent 时不复用之前的父 Agent", async () => {
  const ctx = stubCtx();
  const parents = [];
  ctx.subagents = {
    async start(_provider, request) {
      parents.push(request.parent);
      return {
        result: Promise.resolve({ stopReason: "completed", structured: { result: {} }, output: "" }),
        dispose() {},
      };
    },
  };
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "delegate" })
    .setEntryPoint("delegate");

  await graph.run({}, { agent: { id: "agent-a" } });
  await graph.run({});
  assert.deepEqual(parents, [{ id: "agent-a" }, undefined]);
});

test("条件边优先于静态边，可路由到 END", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let routeContext;
  let routeSignal;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({ n: 1 }))
    .addNode("b", () => ({ n: 2 }))
    .addEdge("a", "b")
    .addConditionalEdge("a", (s, routeCtx, signal) => {
      routeContext = routeCtx;
      routeSignal = signal;
      return s.n === 1 ? "__END__" : "b";
    })
    .setEntryPoint("a");
  const result = await graph.run({ n: 0 }, { signal: controller.signal });
  assert.deepEqual(result.trajectory, ["a"]);
  assert.equal(result.finalState.n, 1);
  assert.strictEqual(routeContext, ctx);
  assert.strictEqual(routeSignal, controller.signal);
});

test("预取消：不启动图，也不发 graph/end", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  controller.abort(new Error("pre-cancelled"));
  let called = false;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => {
      called = true;
      return {};
    })
    .setEntryPoint("a");

  await assert.rejects(
    graph.run({}, { signal: controller.signal }),
    (error) => error === controller.signal.reason,
  );
  assert.equal(called, false);
  assert.equal(ctx.events.length, 0);
});

test("节点收到同一个 signal", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let nodeSignal;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", (_state, _ctx, signal) => {
      nodeSignal = signal;
      return {};
    })
    .setEntryPoint("a");

  await graph.run({}, { signal: controller.signal });
  assert.strictEqual(nodeSignal, controller.signal);
});

test("运行中取消：合作型节点拒绝且不发 graph/end", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async (_state, _ctx, signal) => {
      markStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return {};
    })
    .setEntryPoint("a");

  const running = graph.run({}, { signal: controller.signal });
  await started;
  const reason = new Error("cancelled while running");
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  assert.ok(!ctx.events.some((event) => event.name === "graph/end"));
  // 取消终态契约：node-error（过程诊断）+ graph/error（终态），各恰好一次
  assert.equal(
    ctx.events.filter((event) => event.name === "graph/node-error").length,
    1,
  );
  const errorEvents = ctx.events.filter((event) => event.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.error, reason);
  assert.equal(errorEvents[0].payload.lastNode, "a");
});

test("路由段取消：补发 graph/error 终态后拒绝", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let markRouting;
  const routing = new Promise((resolve) => {
    markRouting = resolve;
  });
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", async (_state, _ctx, signal) => {
      markRouting();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "a";
    })
    .setEntryPoint("a");

  const running = graph.run({}, { signal: controller.signal });
  await routing;
  const reason = new Error("cancelled while routing");
  controller.abort(reason);

  await assert.rejects(running, (error) => error === reason);
  const errorEvents = ctx.events.filter((event) => event.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.error, reason);
  assert.equal(errorEvents[0].payload.lastNode, "a");
  assert.ok(!ctx.events.some((event) => event.name === "graph/end"));
});

test("graph/start 监听器内同步取消：仍收到 graph/error 终态", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  const reason = new Error("cancelled at start");
  ctx.on("graph/start", () => controller.abort(reason));
  let called = false;
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => {
      called = true;
      return {};
    })
    .setEntryPoint("a");

  await assert.rejects(
    graph.run({}, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(called, false);
  // 此前该时点取消会导致 graph/start 之后无任何终态事件
  assert.deepEqual(ctx.events.map((event) => event.name), [
    "graph/start",
    "graph/error",
  ]);
  assert.equal(ctx.events[1].payload.error, reason);
  assert.equal(ctx.events[1].payload.lastNode, "a");
});

test("迭代熔断：自环超限抛错并补发 graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 3)
    .addNode("loop", (s) => ({ i: (s.i ?? 0) + 1 }))
    .addConditionalEdge("loop", (s) => (s.i < 100 ? "loop" : END))
    .setEntryPoint("loop");
  await assert.rejects(graph.run({}), /迭代次数超过上限/);
  const errorEvents = ctx.events.filter((e) => e.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.lastNode, "loop");
  // 熔断语义：第 N 次仍执行完（iterations === maxIterations）
  const nodeStarts = ctx.events.filter((e) => e.name === "graph/node-start");
  assert.equal(nodeStarts.length, 3);
  // 异常终止不发 graph/end
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("路由到未注册节点：抛错 + graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => "ghost")
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /非法目标/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 1);
});

test("静态边悬空目标：抛错 + graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addEdge("a", "ghost")
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /缺少处理器/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 1);
});

test("节点抛错：graph/node-error 后上抛，不发 end", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async () => {
      await sleep(1);
      throw new Error("handler boom");
    })
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /handler boom/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("缺入口/重名节点/重复边在 run 前拒绝", async () => {
  const ctx = stubCtx();
  await assert.rejects(new StateGraph(ctx, 10).addNode("a", () => ({})).run({}), /entryPoint/);
  assert.throws(
    () => new StateGraph(ctx, 10).addNode("a", () => ({})).addNode("a", () => ({})),
    /已注册/,
  );
  assert.throws(
    () => new StateGraph(ctx, 10).addEdge("a", "b").addEdge("a", "c"),
    /已注册/,
  );
  assert.throws(
    () =>
      new StateGraph(ctx, 10)
        .addConditionalEdge("a", () => "b")
        .addConditionalEdge("a", () => "c"),
    /已注册/,
  );
});

test("路由返回 undefined/BigInt：抛非法目标错误且错误消息可读", async () => {
  const ctx = stubCtx();
  const ghostRoute = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => undefined)
    .setEntryPoint("a");
  await assert.rejects(ghostRoute.run({}), /非法目标：undefined/);

  const bigintRoute = new StateGraph(ctx, 10)
    .addNode("a", () => ({}))
    .addConditionalEdge("a", () => 1n)
    .setEntryPoint("a");
  // BigInt 不可 JSON 序列化：错误消息构造降级为 String()，不再自抛 TypeError
  await assert.rejects(bigintRoute.run({}), /非法目标：1/);
});

test("logTrajectory=true：订阅 node-start/end 输出轨迹日志", () => {
  const logs = [];
  const listeners = {};
  const ctx = {
    emit() {},
    on(name, listener) {
      (listeners[name] ??= []).push(listener);
    },
    logger(scope) {
      return {
        debug: (message) => logs.push(`[${scope}] debug ${message}`),
        info: (message) => logs.push(`[${scope}] info ${message}`),
      };
    },
    reflect: { provide() {} },
  };
  new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: true });

  assert.deepEqual(listeners["graph/node-start"].length, 1);
  assert.deepEqual(listeners["graph/end"].length, 1);
  listeners["graph/node-start"][0]({ node: "a", iteration: 2 });
  listeners["graph/end"][0]({ trajectory: ["a", "b"], iterations: 2 });
  assert.deepEqual(logs, [
    "[graph] debug [StateGraph] [#2] Running Node: a",
    "[graph] info [StateGraph] Completed in 2 steps. Route: a -> b",
  ]);
});

test("maxIterations：构造与配置边界拒绝非正数、非整数和非有限值", () => {
  const ctx = stubCtx();
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new StateGraph(ctx, value),
      /maxIterations 必须是有限正整数/,
      `constructor should reject ${String(value)}`,
    );
    assert.throws(
      () => GraphEngineService.Config({ defaultMaxIterations: value, logTrajectory: false }),
      /number|multiple|>=/i,
      `config should reject ${String(value)}`,
    );
  }
});

test("graph/node-end 包含 durationMs 和 patch 增量", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("calc", async () => {
      await sleep(10);
      return { score: 100 };
    })
    .setEntryPoint("calc");
  const result = await graph.run({});
  assert.equal(result.finalState.score, 100);
  const endEvent = ctx.events.find((e) => e.name === "graph/node-end");
  assert.ok(endEvent);
  assert.equal(endEvent.payload.node, "calc");
  assert.deepEqual(endEvent.payload.patch, { score: 100 });
  assert.ok(typeof endEvent.payload.durationMs === "number" && endEvent.payload.durationMs >= 5);
});

test("addSubgraph: 嵌套子图声明式组合与状态映射", async () => {
  const ctx = stubCtx();
  const subGraph = new StateGraph(ctx, 5)
    .addNode("sub_step", (s) => ({ subCount: (s.subCount ?? 0) + 10 }))
    .setEntryPoint("sub_step");

  const mainGraph = new StateGraph(ctx, 10)
    .addNode("init", () => ({ count: 1 }))
    .addSubgraph("nested", subGraph, {
      inputMapper: (mainState) => ({ subCount: mainState.count }),
      outputMapper: (subState, mainState) => ({
        count: mainState.count,
        subResult: subState.subCount,
      }),
    })
    .addEdge("init", "nested")
    .setEntryPoint("init");

  const result = await mainGraph.run({});
  assert.equal(result.finalState.count, 1);
  assert.equal(result.finalState.subResult, 11);
  assert.deepEqual(result.trajectory, ["init", "nested"]);
});

test("Fan-out / Fan-in: 条件路由返回并行目标数组并汇聚", async () => {
  const ctx = stubCtx();
  let executedA = false;
  let executedB = false;

  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({ init: true }))
    .addNode("branch_a", async (s) => {
      await sleep(5);
      executedA = true;
      return { fromA: true };
    })
    .addNode("branch_b", async (s) => {
      await sleep(5);
      executedB = true;
      return { fromB: true };
    })
    .addNode("join", (s) => ({
      joined: true,
      allOk: s.fromA && s.fromB,
    }))
    .addConditionalEdge("split", () => ["branch_a", "branch_b"])
    .addEdge("branch_b", "join")
    .setEntryPoint("split");

  const result = await graph.run({});
  assert.equal(executedA, true);
  assert.equal(executedB, true);
  assert.equal(result.finalState.fromA, true);
  assert.equal(result.finalState.fromB, true);
  assert.equal(result.finalState.joined, true);
  assert.equal(result.finalState.allOk, true);
  assert.deepEqual(result.trajectory, ["split", "branch_a", "branch_b", "join"]);
});

test("Fan-out 分支执行前也会请求审批", async () => {
  const ctx = stubCtx();
  const requests = [];
  ctx.approval = {
    request: async (request) => {
      requests.push(request);
      return "allowed-once";
    },
  };
  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({}))
    .addNode("protected", () => ({ protected: true }))
    .addNode("other", () => ({ other: true }))
    .addApprovalGate("protected", { toolName: "graph.protected" })
    .addConditionalEdge("split", () => ["protected", "other"])
    .setEntryPoint("split");

  const agent = { id: "agent-a" };
  const result = await graph.run({}, { agent });
  assert.equal(result.finalState.protected, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, agent);
  assert.equal(requests[0].toolName, "graph.protected");
});
test("fan-out 分支业务错误：仅 node-error，无 graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({ init: true }))
    .addNode("bad", async () => {
      await sleep(1);
      throw new Error("branch boom");
    })
    .addNode("ok", () => ({ fromOk: true }))
    .addConditionalEdge("split", () => ["bad", "ok"])
    .setEntryPoint("split");
  await assert.rejects(graph.run({}), /branch boom/);
  // 与单节点契约一致：节点业务错误只有 node-error，无 graph/error 终态
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 0);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("fan-out 分支取消：graph/error 恰好一次且 lastNode 为失败分支", async () => {
  const ctx = stubCtx();
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({ init: true }))
    .addNode("slow", async (_s, _c, signal) => {
      markStarted();
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return {};
    })
    .addNode("fast", () => ({ fromFast: true }))
    .addConditionalEdge("split", () => ["slow", "fast"])
    .setEntryPoint("split");
  const running = graph.run({}, { signal: controller.signal });
  await started;
  const reason = new Error("cancelled fanout");
  controller.abort(reason);
  await assert.rejects(running, (error) => error === reason);
  // 取消终态契约：每个失败分支各发一次 node-error 诊断，但 graph/error 终态仅一次
  const errorEvents = ctx.events.filter((e) => e.name === "graph/error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.error, reason);
  assert.ok(["slow", "fast"].includes(errorEvents[0].payload.lastNode));
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("节点返回 undefined 增量：抛错 + node-error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("a", async () => {
      await sleep(1);
      // 忘写 return → undefined
    })
    .setEntryPoint("a");
  await assert.rejects(graph.run({}), /空状态增量/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("addNode 禁止注册保留哨兵 __END__", () => {
  const ctx = stubCtx();
  assert.throws(
    () => new StateGraph(ctx, 10).addNode("__END__", () => ({})),
    /保留哨兵/,
  );
});

test("并行数组混用 __END__ 与节点名：报错 + graph/error", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("split", () => ({ init: true }))
    .addNode("a", () => ({ fromA: true }))
    .addConditionalEdge("split", () => ["__END__", "a"])
    .setEntryPoint("split");
  await assert.rejects(graph.run({}), /不能混用/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/error").length, 1);
});
/** 带 reflect + ctx.commands 桩的 Service 上下文。 */
function serviceCtx() {
  const ctx = stubCtx();
  ctx.reflect = { provide() {} };
  ctx.registered = [];
  ctx.commands = {
    register(def) {
      ctx.registered.push(def);
      return () => {
        const index = ctx.registered.indexOf(def);
        if (index >= 0) ctx.registered.splice(index, 1);
      };
    },
  };
  return ctx;
}

test("fromDefinition：声明式构建与链式 API 等价", async () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  const graph = service.fromDefinition({
    entryPoint: "a",
    nodes: {
      a: (s) => ({ step: (s.step ?? 0) + 1 }),
      b: (s) => ({ done: true }),
    },
    edges: [{ from: "a", to: "b" }],
  });
  const result = await graph.run({ step: 0 });
  assert.deepEqual(result.finalState, { step: 1, done: true });
  assert.deepEqual(result.trajectory, ["a", "b"]);
});

test("fromDefinition：条件边与 maxIterations 生效", async () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  const graph = service.fromDefinition({
    entryPoint: "a",
    nodes: { a: (s) => ({ n: (s.n ?? 0) + 1 }) },
    conditionalEdges: [{ from: "a", condition: (s) => (s.n < 3 ? "a" : END) }],
    maxIterations: 10,
  });
  const result = await graph.run({});
  assert.equal(result.finalState.n, 3);
  assert.equal(result.iterations, 3);
});

test("registerCommand：注册 slash 命令并返回轨迹结果", async () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  const dispose = service.registerCommand({
    name: "pipeline",
    description: "运行流水线图",
    inputHint: '{"task":"..."}',
    graph: {
      entryPoint: "gen",
      nodes: {
        gen: (s) => ({ code: `fn_${s.task}` }),
        check: (s) => ({ ok: true }),
      },
      edges: [{ from: "gen", to: "check" }],
    },
  });
  assert.equal(ctx.registered.length, 1);
  const def = ctx.registered[0];
  assert.equal(def.name, "pipeline");
  assert.equal(def.input.hint, '{"task":"..."}');
  const result = await def.handler({
    agent: { id: "a1" },
    rawInput: '{"task":"T1"}',
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "success");
  assert.match(result.text, /gen -> check（2 步）/);
  dispose();
  assert.equal(ctx.registered.length, 0);
});

test("registerCommand：parseInput 失败返回 error 结果", async () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  service.registerCommand({
    name: "pipeline",
    description: "运行流水线图",
    graph: { entryPoint: "a", nodes: { a: () => ({}) } },
  });
  const def = ctx.registered[0];
  const result = await def.handler({
    agent: {},
    rawInput: "not json",
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "error");
  assert.match(result.text, /初始状态解析失败/);
});

test("registerCommand：图执行失败返回 error 结果", async () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  service.registerCommand({
    name: "boom",
    description: "失败的图",
    graph: {
      entryPoint: "a",
      nodes: { a: async () => { throw new Error("boom"); } },
    },
  });
  const def = ctx.registered[0];
  const result = await def.handler({
    agent: {},
    rawInput: "{}",
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "error");
  assert.match(result.text, /图执行失败/);
});

test("registerCommand：缺少 ctx.commands 时抛错", () => {
  const ctx = serviceCtx();
  delete ctx.commands;
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  assert.throws(
    () =>
      service.registerCommand({
        name: "x",
        description: "d",
        graph: { entryPoint: "a", nodes: { a: () => ({}) } },
      }),
    /ctx\.commands/,
  );
});

test("registerCommand：含审批门节点的 StateGraph 实例注册时被拒绝", () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  const graph = new StateGraph(ctx, 10)
    .addNode("deploy", () => ({}))
    .addApprovalGate("deploy", { toolName: "graph.deploy", reason: "部署需要确认" })
    .setEntryPoint("deploy");
  assert.throws(
    () =>
      service.registerCommand({
        name: "deploy-cmd",
        description: "部署图",
        graph,
      }),
    /仅支持纯业务节点与条件路由.*审批门/,
  );
  assert.equal(ctx.registered.length, 0);
});

test("registerCommand：含子代理节点的 StateGraph 实例注册时被拒绝", () => {
  const ctx = serviceCtx();
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  const graph = new StateGraph(ctx, 10)
    .addSubagent("research", { prompt: "调研任务：{{state}}" })
    .setEntryPoint("research");
  assert.throws(
    () =>
      service.registerCommand({
        name: "research-cmd",
        description: "调研图",
        graph,
      }),
    /仅支持纯业务节点与条件路由.*子代理/,
  );
  assert.equal(ctx.registered.length, 0);
});

test("listTurnBoundNodes：返回审批门与子代理节点名", () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("plain", () => ({}))
    .addApprovalGate("deploy", { toolName: "graph.deploy" })
    .addSubagent("research", { prompt: "调研 {{state}}" })
    .setEntryPoint("plain");
  assert.deepEqual(graph.listTurnBoundNodes().sort(), ["deploy", "research"]);
});

test("checkpoint：节点合并后按序回调", async () => {
  const ctx = stubCtx();
  const checkpoints = [];
  const graph = new StateGraph(ctx, 10)
    .addNode("a", (s) => ({ step: (s.step ?? 0) + 1 }))
    .addNode("b", (s) => ({ done: true }))
    .addEdge("a", "b")
    .setEntryPoint("a");
  const result = await graph.run({}, {
    checkpoint: (info) => {
      checkpoints.push(info);
    },
  });
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(checkpoints.map((c) => c.node), ["a", "b"]);
  assert.equal(checkpoints[0].iteration, 1);
  assert.equal(checkpoints[0].state.step, 1);
  assert.equal(checkpoints[0].graphId, result.graphId);
});

test("approval gate：allowed-once 通过并继续执行", async () => {
  const ctx = stubCtx();
  const asks = [];
  ctx.approval = {
    request: async (req) => {
      asks.push(req);
      return "allowed-once";
    },
  };
  const graph = new StateGraph(ctx, 10)
    .addNode("approve", () => ({ ok: true }))
    .addApprovalGate("approve", { toolName: "graph.gate", reason: "执行敏感操作" })
    .setEntryPoint("approve");
  const controller = new AbortController();
  const result = await graph.run({}, { agent: { id: "a1" }, signal: controller.signal });
  assert.deepEqual(result.finalState, { ok: true });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].toolName, "graph.gate");
  assert.equal(asks[0].reason, "执行敏感操作");
  assert.equal(asks[0].agent.id, "a1");
  assert.strictEqual(asks[0].signal, controller.signal);
});

test("approval gate：rejected 抛错 + node-error", async () => {
  const ctx = stubCtx();
  ctx.approval = { request: async () => "rejected" };
  const graph = new StateGraph(ctx, 10)
    .addNode("approve", () => ({}))
    .addApprovalGate("approve", { toolName: "graph.gate" })
    .setEntryPoint("approve");
  await assert.rejects(graph.run({}, { agent: {} }), /未通过（rejected）/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("approval gate：纯门无 handler 通过后继续", async () => {
  const ctx = stubCtx();
  ctx.approval = { request: async () => "allowed-once" };
  const graph = new StateGraph(ctx, 10)
    .addNode("pre", () => ({ started: true }))
    .addApprovalGate("approve", { toolName: "graph.gate" })
    .addNode("work", (s) => ({ done: true }))
    .addEdge("pre", "approve")
    .addEdge("approve", "work")
    .setEntryPoint("pre");
  const result = await graph.run({}, { agent: {} });
  assert.deepEqual(result.finalState, { started: true, done: true });
  assert.deepEqual(result.trajectory, ["pre", "approve", "work"]);
});

test("approval gate：缺少 agent 上下文抛错", async () => {
  const ctx = stubCtx();
  ctx.approval = { request: async () => "allowed-once" };
  const graph = new StateGraph(ctx, 10)
    .addNode("approve", () => ({}))
    .addApprovalGate("approve", { toolName: "graph.gate" })
    .setEntryPoint("approve");
  await assert.rejects(graph.run({}), /run\(\{ agent \}\)/);
});

test("approval gate：缺少 ctx.approval 服务抛错", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addNode("approve", () => ({}))
    .addApprovalGate("approve", { toolName: "graph.gate" })
    .setEntryPoint("approve");
  await assert.rejects(graph.run({}, { agent: {} }), /ctx\.approval/);
});

test("approval gate：重复注册拒绝", () => {
  const ctx = stubCtx();
  assert.throws(
    () =>
      new StateGraph(ctx, 10)
        .addApprovalGate("a", { toolName: "t" })
        .addApprovalGate("a", { toolName: "t" }),
    /审批门已注册/,
  );
});

// ---- 子代理节点（addSubagent）：一次性 dsh 子代理委托 ----

/** 构造一个模拟 dsh ctx.subagents 服务的最小 provider。 */
function stubSubagents({ onStart } = {}) {
  const calls = [];
  const service = {
    calls,
    start: async (name, request) => {
      calls.push({ name, request });
      // 真实 dsh 要求 parent（父 Agent）必填，否则 start 拒绝
      if (!request.parent) throw new Error("subagent start requires a parent agent");
      if (onStart) return onStart(name, request);
      // 默认：completed + 结构化 result
      return {
        id: `run-${calls.length}`,
        result: Promise.resolve({
          stopReason: "completed",
          output: [],
          structured: { result: { code: "sub-agent-code" } },
        }),
        dispose: async () => {},
      };
    },
    list: () => ["spawn", "fork"],
    getProvider: () => ({ capabilities: { outputSchema: true } }),
  };
  return service;
}

test("addSubagent：委托子代理并合并结构化结果", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", {
      provider: "spawn",
      prompt: "生成代码：{{state}}",
      inputMapper: (s) => ({ task: s.task }),
    })
    .addNode("after", (s) => ({ reviewed: true, code: s.code }))
    .addEdge("delegate", "after")
    .setEntryPoint("delegate");

  const controller = new AbortController();
  const result = await graph.run(
    { task: "hello" },
    { agent: { id: "parent-1" }, signal: controller.signal },
  );
  assert.deepEqual(result.finalState, {
    task: "hello",
    code: "sub-agent-code",
    reviewed: true,
  });
  assert.deepEqual(result.trajectory, ["delegate", "after"]);
  assert.equal(subagents.calls.length, 1);
  const call = subagents.calls[0];
  assert.equal(call.name, "spawn");
  assert.equal(call.request.label, "delegate");
  assert.equal(call.request.parent.id, "parent-1");
  assert.equal(call.request.prompt[0].type, "text");
  assert.match(call.request.prompt[0].text, /生成代码：\{"task":"hello"\}/);
  assert.ok(call.request.signal instanceof AbortSignal);
  assert.strictEqual(call.request.signal, controller.signal);
  assert.deepEqual(call.request.outputSchema, {
    type: "object",
    properties: { result: {} },
    required: ["result"],
    additionalProperties: false,
  });
});

test("addSubagent：run 未传 agent 时父上下文缺失抛错", async () => {
  const ctx = stubCtx();
  ctx.subagents = stubSubagents();
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  await assert.rejects(graph.run({}), /subagents|parent/);
});

test("addSubagent：缺少 ctx.subagents 服务抛错", async () => {
  const ctx = stubCtx();
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  await assert.rejects(graph.run({}, { agent: {} }), /ctx\.subagents/);
});

test("addSubagent：非 completed stopReason 抛错（含诊断与部分输出）", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents({
    onStart: () => ({
      id: "run-1",
      result: Promise.resolve({
        stopReason: "error",
        output: [{ type: "text", text: "partial result" }],
        diagnostic: "model failed",
      }),
      dispose: async () => {},
    }),
  });
  ctx.subagents = subagents;
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  const err = await graph.run({}, { agent: {} }).then(() => null, (e) => e);
  assert.match(err.message, /未正常完成：error/);
  assert.match(err.message, /Diagnostic: model failed/);
  assert.match(err.message, /partial result/);
  assert.equal(ctx.events.filter((e) => e.name === "graph/node-error").length, 1);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("addSubagent：文本输出经 JSON.parse 合并；非 JSON 落到 result 字段", async () => {
  const ctx = stubCtx();
  ctx.subagents = stubSubagents({
    onStart: () => ({
      id: "run-1",
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: '{"code":"parsed-code"}' }],
      }),
      dispose: async () => {},
    }),
  });
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it", resultKey: "result" })
    .setEntryPoint("delegate");
  const result = await graph.run({}, { agent: {} });
  assert.deepEqual(result.finalState, { code: "parsed-code" });

  // 非 JSON 文本 → 落到 result 字段
  ctx.subagents = stubSubagents({
    onStart: () => ({
      id: "run-2",
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: "plain text answer" }],
      }),
      dispose: async () => {},
    }),
  });
  const graph2 = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  const result2 = await graph2.run({}, { agent: {} });
  assert.deepEqual(result2.finalState, { result: "plain text answer" });
});

test("addSubagent：取消信号透传且取消后抛错", async () => {
  const ctx = stubCtx();
  let seenSignal;
  const subagents = stubSubagents({
    onStart: (_name, request) => {
      seenSignal = request.signal;
      return {
        id: "run-1",
        result: new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
        dispose: async () => {},
      };
    },
  });
  ctx.subagents = subagents;
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  const controller = new AbortController();
  const runPromise = graph.run({}, { agent: {}, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(runPromise, /aborted/);
  assert.ok(seenSignal instanceof AbortSignal);
  assert.ok(!ctx.events.some((e) => e.name === "graph/end"));
});

test("addSubagent：自定义 outputMapper 覆盖默认映射", async () => {
  const ctx = stubCtx();
  ctx.subagents = stubSubagents({
    onStart: () => ({
      id: "run-1",
      result: Promise.resolve({
        stopReason: "completed",
        output: [{ type: "text", text: "raw" }],
      }),
      dispose: async () => {},
    }),
  });
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", {
      prompt: "do it",
      outputMapper: (subState, parentState) => ({
        delegated: subState,
        parentTask: parentState.task,
      }),
    })
    .setEntryPoint("delegate");
  const result = await graph.run({ task: "T" }, { agent: {} });
  assert.deepEqual(result.finalState, { task: "T", delegated: "raw", parentTask: "T" });
});

test("addSubagent：dispose 在结果收集后调用", async () => {
  const ctx = stubCtx();
  let disposed = false;
  ctx.subagents = stubSubagents({
    onStart: () => ({
      id: "run-1",
      result: Promise.resolve({
        stopReason: "completed",
        output: [],
        structured: { result: { ok: true } },
      }),
      dispose: async () => {
        disposed = true;
      },
    }),
  });
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  const result = await graph.run({}, { agent: {} });
  assert.equal(result.finalState.ok, true);
  assert.equal(disposed, true);
});

// ---- 子代理模型解析：自动继承父 Agent 模型 + 显式 agentOptions 覆盖 ----

test("addSubagent：父 Agent options 完整时自动继承（不传 agentOptions）", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  ctx.agentDefaultModel = {
    currentSelection: async () => ({ provider: "fallback", model: "m-fallback" }),
  };
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  await graph.run(
    {},
    { agent: { id: "p1", options: { provider: "commandcode", model: "deepseek/deepseek-v4-flash" } } },
  );
  assert.equal(subagents.calls.length, 1);
  // 父 options 完整 → 不传 agentOptions，交给 dsh 默认继承（resolveChildAgentOptions）
  assert.equal(subagents.calls[0].request.agentOptions, undefined);
});

test("addSubagent：父 Agent 缺模型时用 agentDefaultModel 兜底", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  ctx.agentDefaultModel = {
    currentSelection: async () => ({ provider: "commandcode", model: "deepseek/deepseek-v4-flash" }),
  };
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  await graph.run({}, { agent: { id: "p1", options: {} } });
  assert.equal(subagents.calls.length, 1);
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: "commandcode",
    model: "deepseek/deepseek-v4-flash",
  });
});

test("addSubagent：显式 agentOptions 完全覆盖自动继承", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  ctx.agentDefaultModel = {
    currentSelection: async () => ({ provider: "fallback", model: "m-fallback" }),
  };
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", {
      prompt: "do it",
      agentOptions: { provider: "my-provider", model: "my-model", maxTokens: 2048 },
    })
    .setEntryPoint("delegate");
  await graph.run(
    {},
    { agent: { id: "p1", options: { provider: "parent-p", model: "parent-m" } } },
  );
  assert.equal(subagents.calls.length, 1);
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: "my-provider",
    model: "my-model",
    maxTokens: 2048,
  });
});

test("addSubagent：父 Agent options 部分缺失时保留已有字段并兜底模型", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  ctx.agentDefaultModel = {
    currentSelection: async () => ({ provider: "default-p", model: "default-m" }),
  };
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  // 父只有 provider 没有 model → 用 default 的 model 兜底，保留父 provider
  await graph.run({}, { agent: { id: "p1", options: { provider: "parent-p" } } });
  assert.equal(subagents.calls.length, 1);
  assert.deepEqual(subagents.calls[0].request.agentOptions, {
    provider: "parent-p",
    model: "default-m",
  });
});

test("addSubagent：agentDefaultModel 缺失时静默退回 dsh 默认继承", async () => {
  const ctx = stubCtx();
  const subagents = stubSubagents();
  ctx.subagents = subagents;
  // 无 ctx.agentDefaultModel、父无 options → agentOptions 不传，交给 dsh
  const graph = new StateGraph(ctx, 10)
    .addSubagent("delegate", { prompt: "do it" })
    .setEntryPoint("delegate");
  await graph.run({}, { agent: { id: "p1", options: {} } });
  assert.equal(subagents.calls.length, 1);
  assert.equal(subagents.calls[0].request.agentOptions, undefined);
});

test("/graph-studio/generate：非 text-delta 的 stream chunk 也能累积文本", async () => {
  const ctx = serviceCtx();
  const routes = [];
  ctx.get = (name) => {
    if (name === "webServer") return { register: (r) => routes.push(r) };
    if (name === "agentDefaultModel") return { currentSelection: async () => ({ provider: "p", model: "m" }) };
    if (name === "llm") {
      return {
        stream() {
          return (async function* () {
            // 某些 provider / 模型返回的 delta chunk 不带 "text-delta" type，
            // 仅以 text 字段携带内容——生成逻辑应宽松累积，而非丢弃。
            yield { type: "content", text: '{"nodes":[{"name":"a","kind":"patch","patch":{}}]' };
            yield { type: "content", text: ',"entryPoint":"a","maxIterations":25}' };
            yield { type: "finish" };
          })();
        },
      };
    }
    return undefined;
  };
  const service = new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  // registerStudioPage 轮询挂载路由，首次即可拿到 webServer。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gen = routes.find((r) => r.path === "/graph-studio/generate");
  assert.ok(gen, "generate 路由已注册");

  const req = {
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      const data = [Buffer.from(JSON.stringify({ prompt: "写代码并跑测试" }))];
      let i = 0;
      return {
        async next() {
          if (i >= data.length) return { done: true };
          return { done: false, value: data[i++] };
        },
      };
    },
  };
  let status = 0;
  let out = "";
  const res = { writeHead(s) { status = s; }, end(b) { out = b; } };
  await gen.handler(req, res);
  assert.equal(status, 200);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.ok(Array.isArray(parsed.spec.nodes));
  assert.equal(parsed.spec.entryPoint, "a");
});

test("/graph-studio/generate：非 loopback 请求被拒绝且不调用模型", async () => {
  const ctx = serviceCtx();
  const routes = [];
  let streamCalls = 0;
  ctx.get = (name) => {
    if (name === "webServer") return { register: (r) => routes.push(r) };
    if (name === "agentDefaultModel") {
      return { currentSelection: async () => ({ provider: "p", model: "m" }) };
    }
    if (name === "llm") {
      return {
        stream() {
          streamCalls += 1;
          return (async function* () {})();
        },
      };
    }
    return undefined;
  };
  new GraphEngineService(ctx, { defaultMaxIterations: 25, logTrajectory: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gen = routes.find((r) => r.path === "/graph-studio/generate");
  assert.ok(gen, "generate 路由已注册");

  let status = 0;
  let out = "";
  const res = { writeHead(s) { status = s; }, end(b) { out = b; } };
  await gen.handler(
    { method: "POST", socket: { remoteAddress: "192.0.2.1" } },
    res,
  );

  assert.equal(status, 403);
  assert.equal(streamCalls, 0);
  assert.deepEqual(JSON.parse(out), {
    ok: false,
    error: "Graph Studio 端点仅允许本机访问。",
  });
});

