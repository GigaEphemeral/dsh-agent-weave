import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Graph Studio 浏览器 bundle 的装载契约测试：
 * 用桩 __ModuleLoader__ + 桩 React 执行 factory，验证插件形状
 * （inject/apply）与 conversation.view 注册链路（不渲染真实 DOM）。
 */

function loadBundle() {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let registration = null;
  const loader = {
    load(entry) {
      registration = entry;
    },
  };
  const fakeReact = {
    createElement() {
      return null;
    },
    Fragment: Symbol("fragment"),
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {},
    useRef() {
      return { current: null };
    },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      navigator: {},
      document: undefined,
    },
  };
  new Function(
    "window",
    source,
  )(sandbox.window);
  assert.ok(registration, "bundle 应通过 window.__ModuleLoader__.load 注册");
  const exports = registration.factory((specifier) => {
    if (specifier === "react") return fakeReact;
    throw new Error(`意外的模块请求：${specifier}`);
  });
  return { registration, exports };
}

test("client bundle：注册 id 正确并导出插件形状", () => {
  const { registration, exports } = loadBundle();
  assert.equal(registration.id, "dsh-state-graph");
  assert.deepEqual(exports.inject, ["slots"]);
  assert.equal(typeof exports.apply, "function");
});

test("client bundle：apply 注册全屏抽屉 + 侧边栏入口", () => {
  const { exports } = loadBundle();
  const registered = [];
  const ctx = {
    on() {
      return () => {};
    },
    effect(fn) {
      fn();
      return () => {};
    },
    slots: {
      inject(slotName, factory) {
        registered.push({ slotName, entry: factory() });
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  exports.apply(ctx);
  const names = registered.map((r) => r.slotName);
  assert.deepEqual(names, ["shell.overlay", "sidebar.footer.action"]);

  const overlay = registered.find((r) => r.slotName === "shell.overlay").entry;
  assert.equal(overlay.options.id, "graph-studio-fullscreen");
  assert.equal(overlay.options.name, "shell.overlay");
  assert.equal(typeof overlay.component, "function");

  const entry = registered.find((r) => r.slotName === "sidebar.footer.action").entry;
  assert.equal(entry.options.id, "graph-studio-open-button");
  assert.equal(entry.options.name, "sidebar.footer.action");
  assert.equal(entry.options.label, "Graph Studio");
  assert.equal(typeof entry.component, "function");
});

test("client bundle：内联 GraphKit 可用（引擎 + DSL 单源随包）", () => {
  const { exports } = loadBundle();
  const ctx = {
    on() {
      return () => {};
    },
    effect(fn) {
      fn();
      return () => {};
    },
    slots: {
      inject() {
        return () => {};
      },
      register() {
        return {};
      },
    },
  };
  exports.apply(ctx);
  // bundle 内自包含 Studio 示例与校验逻辑：直接对源文本做最小断言，
  // 真正的行为由 test/studio.test.mjs 在宿主侧对同一份 engine 源验证。
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("studioExamples"));
  assert.ok(source.includes("codegen-loop"));
  assert.ok(source.includes("class StateGraph"));
});

test("独立页产物：内联本地渲染器并挂载 Studio", () => {
  const source = readFileSync(new URL("../lib/studio.html", import.meta.url), "utf8");
  assert.ok(source.includes("window.__GraphStudioStandalone"));
  assert.ok(source.includes("window.__GraphStudioStandalone.mount"));
  assert.ok(source.includes('getElementById("root")'));
  assert.ok(!source.includes("return null; // 独立页不含 React DOM"));
});

test("client bundle：包含编辑历史、工作区与危险操作确认", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes("function undo()"));
  assert.ok(source.includes("function redo()"));
  assert.ok(source.includes("function createGraph("));
  assert.ok(source.includes("function switchGraph("));
  assert.ok(source.includes("workspace.v2"));
  assert.ok(source.includes("function trapFocus("));
  assert.ok(source.includes('"aria-modal": true'));
  assert.ok(source.includes('src: "/graph-studio"'));
  assert.ok(source.includes("清空当前图？可用撤销恢复。"));
});
