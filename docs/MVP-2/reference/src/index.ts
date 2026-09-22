import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StateGraph, studioBuildGraph, studioExamples, studioValidate } from "./engine.js";
import type {
  GraphCommandDefinition,
  GraphCommandInvocation,
  GraphCommandResult,
  GraphDefinitionSpec,
} from "./engine.js";

// 引擎内核与 Studio DSL 单源在 engine.ts（无 Node 专属依赖，浏览器侧共享），
// 此处重导出保持既有公共 API 形状不变。graph/* Events 增强随引擎在 engine.ts。
export * from "./engine.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** StateGraph 编排引擎服务：创建隔离的状态图实例。 */
    graph: GraphEngineService;
  }
}

/** 插件配置。 */
export interface Config {
  /** 默认防死循环单次执行最大迭代上限。 */
  defaultMaxIterations: number;
  /** 是否在控制台及日志总线输出路由轨迹。 */
  logTrajectory: boolean;
  /** 子代理节点未显式指定 provider 时使用的默认 provider 名。 */
  defaultSubagentProvider?: string;
}

/**
 * StateGraph 编排引擎服务（ctx.graph）。作为插件默认导出：
 * 提供隔离的状态图工厂，并在 logTrajectory 开启时订阅 graph/* 事件输出轨迹日志。
 */
export default class GraphEngineService extends Service {
  static Config: z<Config> = z.object({
    defaultMaxIterations: z
      .number()
      .min(1)
      .step(1)
      .default(25)
      .description("默认防死循环单次执行最大迭代上限"),
    logTrajectory: z
      .boolean()
      .default(true)
      .description("是否在控制台及日志总线输出路由轨迹"),
    defaultSubagentProvider: z
      .string()
      .default("spawn")
      .description("子代理节点未显式指定 provider 时使用的默认 provider 名"),
  });

  constructor(ctx: Context, public config: Config) {
    super(ctx, "graph");
    assertValidMaxIterations(config.defaultMaxIterations);

    if (config.logTrajectory) {
      ctx.on("graph/node-start", ({ node, iteration }) => {
        ctx.logger("graph").debug(`[StateGraph] [#${iteration}] Running Node: ${node}`);
      });
      ctx.on("graph/end", ({ trajectory, iterations }) => {
        ctx.logger("graph").info(
          `[StateGraph] Completed in ${iterations} steps. Route: ${trajectory.join(" -> ")}`,
        );
      });
    }

    // 独立全屏页：dsh web 有 webserver 时挂载 /graph-studio（与 cbx 仪表盘同机制）。
    // 页面是随包发布的单文件 lib/studio.html（构建时引擎内联），
    // 与浏览器 half 的全屏抽屉共享同一份 Studio 视图；无 webserver 的 profile 下静默跳过。
    this.registerStudioPage(ctx);
  }

  /**
   * 把 Graph Studio 独立页面挂到 dsh 的 webserver（鸭子类型，无硬依赖）。
   * 插件加载时 webserver 可能尚未就绪，因此轮询等待（与 cbx 仪表盘同机制）；
   * 超时（headless / TUI）静默跳过。注意 cordis 守卫对未注入服务"读即抛"，
   * 必须用 ctx.get("webServer") 而非直接读 ctx.webServer。
   */
  private registerStudioPage(ctx: Context): void {
    const attempts = 25; // 25 × 200ms = 5s 启动裕量
    const pollMs = 200;
    let disposed = false;
    void (async () => {
      for (let attempt = 0; attempt < attempts && !disposed; attempt += 1) {
        let webServer: { register(route: unknown): unknown } | undefined;
        try {
          webServer = ctx.get("webServer") as { register(route: unknown): unknown } | undefined;
        } catch {
          /* headless / 尚未就绪 */
        }
        if (webServer?.register) {
          this.mountStudioRoutes(webServer);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    })();
    // 服务卸载时停止等待：把 ctx.on 收紧到只接受事件的声明成员之外的事件
    // 不在 Events 里，这里做最小类型桥接（事件名 + 监听器各补一个断言）。
    ctx.on("dispose" as never, (() => {
      disposed = true;
    }) as never);
  }

  private mountStudioRoutes(webServer: { register(route: unknown): unknown }): void {
    let html: string | null | undefined;
    const loadHtml = () => {
      if (html !== undefined) return html;
      try {
        html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "studio.html"), "utf8");
      } catch {
        html = null; // 构建产物缺失（如未运行 build:standalone）
      }
      return html;
    };
    const mountStudio = (path: string) => {
      webServer.register({
        kind: "exact",
        path,
        handler: (req: { method?: string }, res: {
          writeHead(code: number, headers?: Record<string, string>): unknown;
          end(body?: string): unknown;
        }) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405);
            res.end();
            return;
          }
          const page = loadHtml();
          if (page === null) {
            res.writeHead(404);
            res.end("Graph Studio page not built. Run `npm run build` in dsh-state-graph.");
            return;
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });
          res.end(page);
        },
      });
    };
    // 独立全屏页：无 client half（TUI / headless / 未装浏览器 half）时仍可访问。
    // web profile 的主界面入口是 client half 的全屏抽屉（/#graph-studio-open 深链接），
    // 不再需要第二个独立页路由——避免两套"打开 Studio"的宿主路径。
    mountStudio("/graph-studio");

    // 安全说明（适用于下列三个 Studio 端点）：这些端点随 dsh webserver 在
    // 本地（localhost）serve，供 Graph Studio 设计器调用，无任何鉴权 / 速率限制，
    // 且会按 spec 在 dsh 进程内执行图。仅用于本地开发，切勿绑定到不可信网络或
    // 公网暴露；如需远程访问请走 dsh 自身的鉴权隧道。
    // 宿主真实运行端点：在 dsh 进程里用与浏览器同一份引擎执行 Studio 图。
    // 仅支持纯业务节点（patch / counter）——审批门 / 子代理节点需要 dsh turn
    // 上下文（父 Agent / 审批服务），HTTP 请求不在任何 turn 内，按 registerCommand
    // 同款 fail-fast 拒绝并引导用户改用「在会话中运行」。graph/* 事件经 ctx 代理
    // 捕获后随结果一并返回，浏览器侧复用同一套轨迹渲染。
    webServer.register({
      kind: "exact",
      path: "/graph-studio/run",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (!requireLoopbackRequest(req, res)) return;
          if (req.method !== "POST") {
            respondJson(res, 405, { ok: false, error: "仅支持 POST。" });
            return;
          }
          const body = await readJsonBody(req);
          const spec = body.spec;
          const initialState =
            body.initialState === undefined ? {} : body.initialState;
          const validation = studioValidate(spec as never);
          if (!validation.ok) {
            respondJson(
              res,
              400,
              { ok: false, error: "图定义校验未通过：\n" + validation.errors.join("\n") },
            );
            return;
          }
          if (typeof initialState !== "object" || initialState === null || Array.isArray(initialState)) {
            respondJson(res, 400, { ok: false, error: "初始状态必须是 JSON 对象。" });
            return;
          }
          const events: { name: string; payload: Record<string, unknown> }[] = [];
          const runCtx = makeCapturingCtx(this.ctx, events);
          let graph: StateGraph<Record<string, unknown>>;
          try {
            graph = studioBuildGraph(runCtx, spec as never, this.config.defaultMaxIterations);
          } catch (err) {
            respondJson(res, 400, { ok: false, error: describeRouteTarget(err) });
            return;
          }
          const turnBound = graph.listTurnBoundNodes();
          if (turnBound.length > 0) {
            respondJson(
              res,
              400,
              {
                ok: false,
                error:
                  `宿主直接运行仅支持纯业务节点（patch / counter）。节点 [${turnBound.join(", ")}] ` +
                  `含审批门 / 子代理，需要 dsh turn 上下文。请改用「在会话中运行」或删除这些节点。`,
              },
            );
            return;
          }
          const result = await graph.run(initialState as Record<string, unknown>, { signal: undefined });
          respondJson(res, 200, { ok: true, result, events });
        } catch (err) {
          respondJson(res, 500, { ok: false, error: describeRouteTarget(err) });
        }
      },
    });

    // 发布为 slash 命令：把当前图注册为 dsh 命令（需 dsh-commands 插件提供 ctx.commands）。
    // 同样仅支持纯业务节点——含审批门 / 子代理的图不能在命令上下文执行，直接拒绝。
    webServer.register({
      kind: "exact",
      path: "/graph-studio/register-command",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (!requireLoopbackRequest(req, res)) return;
          if (req.method !== "POST") {
            respondJson(res, 405, { ok: false, error: "仅支持 POST。" });
            return;
          }
          const body = await readJsonBody(req);
          const spec = body.spec;
          const validation = studioValidate(spec as never);
          if (!validation.ok) {
            respondJson(
              res,
              400,
              { ok: false, error: "图定义校验未通过：\n" + validation.errors.join("\n") },
            );
            return;
          }
          let graph: StateGraph<Record<string, unknown>>;
          try {
            graph = studioBuildGraph(this.ctx, spec as never, this.config.defaultMaxIterations);
          } catch (err) {
            respondJson(res, 400, { ok: false, error: describeRouteTarget(err) });
            return;
          }
          const turnBound = graph.listTurnBoundNodes();
          if (turnBound.length > 0) {
            respondJson(
              res,
              400,
              {
                ok: false,
                error:
                  `含审批门 / 子代理节点的图不能作为 slash 命令（需要在 dsh turn 上下文执行）。` +
                  `先移除这些节点，或改用「在会话中运行」。受限节点：[${turnBound.join(", ")}]`,
              },
            );
            return;
          }
          // slugify 是命令名的唯一权威规整点：前端 publishCommand 也会先 slugify 一次
          // 用作预览，但此处对 body.name 再规整一次以兜底（slug 对 slug 幂等），
          // 二者规则需保持一致，修改时请同步 client/studio.js 的 publishCommand。
          let name = slugify(String(body.name ?? ""));
          if (!name) name = `studio-graph-${Date.now().toString(36)}`;
          const description =
            typeof body.description === "string" && body.description.trim()
              ? body.description.trim()
              : `Graph Studio 导出的状态图：${name}`;
          try {
            this.registerCommand({ name, description, graph });
          } catch (err) {
            respondJson(res, 400, { ok: false, error: describeRouteTarget(err) });
            return;
          }
          respondJson(res, 200, { ok: true, name });
        } catch (err) {
          respondJson(res, 500, { ok: false, error: describeRouteTarget(err) });
        }
      },
    });

    // 自然语言建图：把用户描述交给默认模型生成 StudioGraphSpec，经 studioValidate 校验后返回，
    // 由前端以「预览 + 应用到画布」形式让用户确认。仅用 patch / counter 节点（host-only 节点需 turn 上下文）。
    webServer.register({
      kind: "exact",
      path: "/graph-studio/generate",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          if (!requireLoopbackRequest(req, res)) return;
          if (req.method !== "POST") {
            respondJson(res, 405, { ok: false, error: "仅支持 POST。" });
            return;
          }
          const body = await readJsonBody(req);
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
          if (!prompt) {
            respondJson(res, 400, { ok: false, error: "prompt 不能为空。" });
            return;
          }
          const currentSpecRaw = body.spec as Record<string, unknown> | undefined;
          const currentSpec = currentSpecRaw && Array.isArray(currentSpecRaw.nodes) ? currentSpecRaw : undefined;
          let generated;
          try {
            generated = await generateGraphSpec(this.ctx, prompt, currentSpec);
          } catch (err) {
            respondJson(res, 400, { ok: false, error: describeRouteTarget(err) });
            return;
          }
          if (!generated.spec) {
            respondJson(res, 422, { ok: false, error: "模型未返回可用的 JSON 图定义。", raw: generated.raw });
            return;
          }
          const validation = studioValidate(generated.spec as never);
          respondJson(res, 200, { ok: true, spec: generated.spec, validation, raw: generated.raw });
        } catch (err) {
          respondJson(res, 500, { ok: false, error: describeRouteTarget(err) });
        }
      },
    });
  }

  /** 创建一个隔离的 StateGraph 实例。 */
  create<TState extends Record<string, any>>(
    maxIterations = this.config.defaultMaxIterations,
  ): StateGraph<TState> {
    const graph = new StateGraph<TState>(this.ctx, maxIterations);
    if (this.config.defaultSubagentProvider) {
      graph.setSubagentProvider(this.config.defaultSubagentProvider);
    }
    return graph;
  }

  /**
   * 从声明式定义构建图：与链式 API（addNode / addEdge / addConditionalEdge /
   * setEntryPoint）等价的对象形式，便于配置驱动与命令集成。
   */
  fromDefinition<TState extends Record<string, any>>(
    spec: GraphDefinitionSpec<TState>,
  ): StateGraph<TState> {
    const graph = this.create<TState>(spec.maxIterations);
    for (const [name, handler] of Object.entries(spec.nodes)) {
      graph.addNode(name, handler);
    }
    for (const edge of spec.edges ?? []) {
      graph.addEdge(edge.from, edge.to);
    }
    for (const edge of spec.conditionalEdges ?? []) {
      graph.addConditionalEdge(edge.from, edge.condition);
    }
    graph.setEntryPoint(spec.entryPoint);
    return graph;
  }

  /**
   * 把一张图注册为 dsh slash 命令（需要 dsh-commands 插件提供 `ctx.commands`）。
   * 命令的 `rawInput` 经 `parseInput`（默认 JSON.parse）解析为初始状态，执行图后
   * 以轨迹文本作为 CommandResult 返回。返回的 disposer 可注销该命令。
   */
  registerCommand<TState extends Record<string, any>>(
    definition: GraphCommandDefinition<TState>,
  ): () => void {
    // ctx.commands 由 dsh-commands 插件注入，本插件不硬依赖其类型，此处做鸭子
    // 类型检测；register 返回注销函数。
    const commandsHost = this.ctx as {
      commands?: {
        register(def: unknown): unknown;
      };
    };
    const commands = commandsHost.commands;
    if (!commands?.register) {
      throw new Error(
        "ctx.graph.registerCommand 需要 dsh-commands 插件提供 ctx.commands 服务。",
      );
    }
    const graph =
      definition.graph instanceof StateGraph
        ? definition.graph
        : this.fromDefinition(definition.graph);
    // slash 命令执行不在 dsh turn 内（log-only appends，无 open turn）：
    // 审批门节点的 ctx.approval.request 会被 dsh 以 idle ask 拒绝，子代理节点
    // 需要真实父 Agent 推导会话/谱系/委托深度——因此命令图仅支持纯业务节点 +
    // 条件路由，含审批门/子代理节点的图在注册时直接拒绝（fail fast）。
    const turnBoundNodes = graph.listTurnBoundNodes();
    if (turnBoundNodes.length > 0) {
      throw new Error(
        `slash 命令仅支持纯业务节点与条件路由；节点 [${turnBoundNodes.join(", ")}] ` +
          `含审批门/子代理，需要 dsh turn 上下文（agent 工具 / 事件处理器 / agent/inject）执行，` +
          `请改用这些路径运行该图。`,
      );
    }
    const parseInput =
      definition.parseInput ??
      ((rawInput: string) => {
        if (rawInput.trim().length === 0) {
          throw new Error("缺少初始状态 JSON。");
        }
        return JSON.parse(rawInput) as TState;
      });
    const handler = async (
      invocation: GraphCommandInvocation,
    ): Promise<GraphCommandResult> => {
      let initialState: TState;
      try {
        initialState = parseInput(invocation.rawInput);
      } catch (err) {
        return { kind: "error", text: `初始状态解析失败：${describeRouteTarget(err)}` };
      }
      try {
        const result = await graph.run(initialState, {
          signal: invocation.signal,
          agent: invocation.agent,
        });
        return {
          kind: "success",
          text: `轨迹：${result.trajectory.join(" -> ")}（${result.iterations} 步）`,
        };
      } catch (err) {
        return { kind: "error", text: `图执行失败：${describeRouteTarget(err)}` };
      }
    };
    return commands.register({
      name: definition.name,
      description: definition.description,
      ...(definition.inputHint !== undefined
        ? { input: { hint: definition.inputHint } }
        : {}),
      handler,
    }) as () => void;
  }
}

// ---- Graph Studio 宿主 HTTP 端点辅助函数（webServer 鸭子类型，Node http req/res） ----

/** 读取并按上限解析 JSON 对象请求体；超限后立即关闭底层 socket 释放连接，不再排空剩余数据。 */
async function readJsonBody(req: IncomingMessage, maxBodyBytes = 1 << 20): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) break;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.byteLength;
    if (size > maxBodyBytes) {
      tooLarge = true;
      // 立即销毁 socket：拒绝慢速大请求，避免连接被恶意/错误的大 body 长期占用。
      req.destroy();
      break;
    }
    chunks.push(buf);
  }
  if (tooLarge) {
    const e = new Error(`请求体超过 ${maxBodyBytes} 字节上限。`);
    (e as Error & { code?: string }).code = "EBIG";
    throw e;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("请求体必须是合法 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求体必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

/** Studio HTTP 端点只接受真实 loopback socket；不信任可伪造的转发头。 */
function requireLoopbackRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const address = req.socket?.remoteAddress;
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") {
    return true;
  }
  respondJson(res, 403, { ok: false, error: "Graph Studio 端点仅允许本机访问。" });
  return false;
}

/** slug 化命令名：仅保留小写字母/数字/连字符；空则回退到调用方给出的默认名。 */
function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 48);
}

/** 把 graph/* 事件载荷清洗为可 JSON 序列化：Error → {message}，丢弃大体积 state / finalState。 */
function sanitizeGraphPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...payload };
  const err = safe.error;
  if (err instanceof Error) safe.error = { message: err.message };
  else if (typeof err !== "object" && err !== undefined) safe.error = String(err);
  delete safe.state;
  delete safe.finalState;
  return safe;
}

/**
 * 用 Proxy 包裹真实 ctx：拦截 emit，把 graph/* 事件快照进 events 数组，同时仍转发给
 * 真实 ctx（宿主日志 / logTrajectory 照常工作）。子代理 / 审批门等服务经 Proxy 透传到
 * 真实 ctx，不受影响。
 */
function makeCapturingCtx(
  ctx: Context,
  events: { name: string; payload: Record<string, unknown> }[],
): Context {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (prop === "emit" && typeof value === "function") {
        return (name: unknown, payload: unknown) => {
          if (typeof name === "string" && name.startsWith("graph/")) {
            events.push({ name, payload: sanitizeGraphPayload((payload as Record<string, unknown>) ?? {}) });
          }
          return (value as (n: unknown, p: unknown) => void).call(target, name, payload);
        };
      }
      return value;
    },
  });
}

/** 从模型文本里抽取第一个 JSON 对象（容忍 ```json 围栏与前后杂言）。 */
function extractJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 给模型的结构化 DSL 说明 + 一个内置示例作为格式参考。 */
function buildSystemPrompt(): string {
  const example = studioExamples && studioExamples[0] ? studioExamples[0].spec : null;
  return [
    "你是 Graph Studio 的状态图设计助手。根据用户的自然语言描述，生成一份 GraphStudio 状态图定义（JSON）。",
    "规则：",
    "1. 只使用两类节点：patch（修改状态字段）与 counter（计数到上限后合并额外补丁）。不要使用 subagent / gate 节点——它们需要真实会话上下文，无法在此独立运行。",
    '2. 节点字段：name（唯一标识，英文/数字）、kind（patch 或 counter）、label（白话摘要，中文，可选）、patch（对象：字段=值；自增写 {"$inc":1}；判定写 {"$test":{"field":...,"op":...,"value":...}}）、counter（{field,limit,then?}）。',
    "3. 边：edges（静态顺序 from→to）与 conditionalEdges（from + rules[{field,op,value,to}] + fallback）。op ∈ eq/ne/gt/gte/lt/lte/exists。",
    "4. entryPoint 必须是某个节点 name；maxIterations 默认 25；initialState 默认 {}。",
    '5. 用条件边的 to 指回更早的节点实现"重试直到通过"的回环；用 __END__ 表示结束。',
    "6. 只输出 JSON，不要任何解释、注释或 markdown 代码围栏。",
    example ? "示例（仅作结构参考，不要照抄）：\n" + JSON.stringify(example) : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * 调用默认模型把自然语言描述生成 StudioGraphSpec。鸭子类型读取 llm / agentDefaultModel
 * （避免硬依赖 dsh-llm）；未加载或模型未选时抛出可读错误。stream 输出逐块累积为文本后抽取 JSON。
 */
async function generateGraphSpec(
  ctx: Context,
  prompt: string,
  currentSpec: Record<string, unknown> | undefined,
): Promise<{ spec: Record<string, unknown> | null; raw: string }> {
  const llm = (ctx as unknown as { get(service: string): unknown }).get("llm");
  if (!llm || typeof (llm as { stream?: unknown }).stream !== "function") {
    throw new Error("需要 dsh-llm 模型服务（当前 profile 未加载 dsh-llm）。");
  }
  const am = (ctx as unknown as { get(service: string): unknown }).get("agentDefaultModel");
  const sel = am && typeof (am as { currentSelection?: () => unknown }).currentSelection === "function"
    ? await (am as { currentSelection(): Promise<{ provider?: string; model?: string } | undefined> }).currentSelection()
    : null;
  if (!sel || !sel.provider || !sel.model) {
    throw new Error("未选择默认模型（请在 Models 页面选择一个）。");
  }
  const system = buildSystemPrompt();
  const user = currentSpec
    ? "当前图定义：\n" + JSON.stringify(currentSpec, null, 2) + "\n\n请按下列要求修改这张图：\n" + prompt
    : prompt;
  const messages = [
    { role: "system", content: [{ type: "text", text: system }] },
    { role: "user", content: [{ type: "text", text: user }] },
  ];
  let text = "";
  const stream = (llm as {
    stream(options: { provider: string; model: string; messages: unknown[]; signal?: unknown }): AsyncIterable<{ type?: string; text?: string }>;
  }).stream({ provider: sel.provider as string, model: sel.model as string, messages, signal: undefined });
  for await (const chunk of stream) {
    if (!chunk) continue;
    // 宽松累积：不同 provider / 模型的 stream chunk 形态不一（常见 type 为
    // "text-delta" / "content"，也有 chunk 直接带 text 字段而不带 type），
    // 只要携带文本就拼接——避免某实现不用 "text-delta" 而导致 text 始终为空、
    // extractJson 返回 null、生成端点退化成 422。finish 类 chunk 通常无文本，
    // 仅用于提前结束循环（流自身结束也会退出 for-await）。
    if (chunk.text != null) text += chunk.text;
    if (chunk.type === "finish") break;
  }
  return { spec: extractJson(text), raw: text };
}

function assertValidMaxIterations(value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `maxIterations 必须是有限正整数，实际为 ${String(value)}。`,
    );
  }
}

/** 路由返回值的安全描述：BigInt/循环引用等不可 JSON 序列化的值降级为 String()。 */
function describeRouteTarget(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
