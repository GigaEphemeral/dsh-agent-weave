/**
 * 组装 Graph Studio 独立全屏页面（/graph-studio）：把 tsc 编译出的引擎
 * CJS（无任何 require）内联进 studio.html 的 GraphKit IIFE，产出
 * lib/studio.html——宿主 ctx.webServer 直接以单文件 serve。
 *
 * 页面自身不带 React：studio.html 从 dsh 的 /plugins 加载 ui-renderer 等
 * 平台 bundle 太绕，这里改为把 createElement 桩内联进页面，让同一个
 * studio.js 组件体（工厂函数）以纯 JS 运行，零构建依赖。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enginePath = join(root, ".client-build", "engine.js");
const studioPath = join(root, "client", "studio.js");
const runtimePath = join(root, "client", "standalone-runtime.js");
const outPath = join(root, "lib", "studio.html");
const ENGINE_MARKER = "//__GRAPH_KIT_INJECT__";
const HEAD_MARKER = "<!--__STUDIO_HEAD_INJECT__-->";

const engine = readFileSync(enginePath, "utf8");
const studio = readFileSync(studioPath, "utf8");
const runtime = readFileSync(runtimePath, "utf8");
const html = readFileSync(join(root, "client", "studio.html"), "utf8");

for (const needle of ["class StateGraph", "studioBuildGraph", "studioValidate"]) {
  if (!engine.includes(needle)) {
    throw new Error(`build-standalone: 引擎产物缺少 ${needle}`);
  }
}
if (studio.split(ENGINE_MARKER).length !== 2) {
  throw new Error(`build-standalone: studio.js 注入标记必须恰好一次`);
}
if (!html.includes(HEAD_MARKER)) {
  throw new Error(`build-standalone: studio.html 缺少 ${HEAD_MARKER}`);
}

// 引擎（无 require）+ studio 工厂（只 require("react")）都内联；
// react 桩在本页的 <script> 里提供（见 studio.html 的 head 注入）。
const bundle = studio
  .replace(ENGINE_MARKER, () => engine)
  .replace(/require\("react"\)/g, "window.__React__");

// 替换掉 ModuleLoader 包装，保留工厂体：工厂体开头有
// `window.__ModuleLoader__.load({ id, factory })`，页面里改为直接取 factory 执行。
const factorySource = bundle.replace(
  /window\.__ModuleLoader__\.load\(\{[\s\S]*?factory:\s*(function)\s*\(require\)\s*\{([\s\S]*?)\n\}\);\s*$/,
  (_m, _kw, body) => body,
);
if (!factorySource.includes("exports.apply") || !factorySource.includes("return module.exports;")) {
  throw new Error("build-standalone: 未能从 bundle 中剥离出工厂体");
}

const terminalReturn = factorySource.lastIndexOf("return module.exports;");
if (terminalReturn < 0) {
  throw new Error("build-standalone: 未找到 factory 返回语句");
}
const factorySuffix = factorySource
  .slice(terminalReturn + "return module.exports;".length)
  .replace(/\n\s*},\s*$/, "");
const standaloneSource =
  factorySource.slice(0, terminalReturn) +
  `
    var standaloneListeners = {};
    hostCtx = {
      emit: function (name, payload) {
        (standaloneListeners[name] || []).slice().forEach(function (listener) { listener(payload); });
      },
      on: function (name, listener) {
        (standaloneListeners[name] ??= []).push(listener);
        return function () {
          standaloneListeners[name] = (standaloneListeners[name] || []).filter(function (candidate) { return candidate !== listener; });
        };
      },
    };
    var standaloneStyle = window.document.createElement("style");
    standaloneStyle.textContent = STYLE_TEXT;
    window.document.head.appendChild(standaloneStyle);
    function mountStandaloneStudio() {
      window.__GraphStudioStandalone.mount(window.document.getElementById("root"), el(StudioView, {}));
    }
    if (window.document.readyState === "loading") {
      window.document.addEventListener("DOMContentLoaded", mountStandaloneStudio, { once: true });
    } else {
      mountStandaloneStudio();
    }` +
  factorySuffix;

const out = html.replace(
  HEAD_MARKER,
  `<script>${runtime}</script>\n  <script>${standaloneSource}</script>`,
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, "utf8");
console.log(`build-standalone: lib/studio.html (${out.length} bytes)`);
