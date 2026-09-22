/**
 * 组装 Graph Studio 浏览器 bundle：把 tsc 编译出的引擎 CJS（无任何 require）
 * 内联进 client/studio.js 的 GraphKit IIFE，产出 lib/client.js。
 *
 * 该文件由 dsh-client-modules 以 /plugins/<entry-id>/client.js 提供，
 * 浏览器模块表负责 require("react") 注入，因此无需打包器。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const enginePath = join(root, ".client-build", "engine.js");
const studioPath = join(root, "client", "studio.js");
const outPath = join(root, "lib", "client.js");
const MARKER = "//__GRAPH_KIT_INJECT__";

const engine = readFileSync(enginePath, "utf8");
const studio = readFileSync(studioPath, "utf8");

for (const needle of ["class StateGraph", "studioBuildGraph", "studioValidate"]) {
  if (!engine.includes(needle)) {
    throw new Error(`build-client: 引擎产物缺少 ${needle}（检查 tsc 客户端编译步骤）`);
  }
}
if (!studio.includes(MARKER)) {
  throw new Error(`build-client: client/studio.js 缺少注入标记 ${MARKER}`);
}
if (studio.split(MARKER).length !== 2) {
  throw new Error("build-client: 注入标记必须恰好出现一次（当前出现多次，替换会打错位置）");
}
if (engine.includes("require(")) {
  throw new Error("build-client: 引擎 CJS 产物出现了 require()（引擎必须零依赖以供浏览器内联）");
}

// replacer 函数形式避免 engine 文本中的 $ 序列被当作 replace 替换模式。
const bundle = studio.replace(MARKER, () => engine);
writeFileSync(outPath, bundle, "utf8");
console.log(`build-client: lib/client.js (${bundle.length} bytes)`);
