import type { Context } from "@deepseek-ai/cordis";

/**
 * 节点业务执行体：返回需合并到全局状态的增量（Partial<State>）。
 * 引擎负责不可变合并与跳转；节点自身不应修改传入的 state。
 */
export type NodeHandler<TState = any> = (
  state: TState,
  ctx: Context,
  signal?: AbortSignal,
) => Promise<Partial<TState>> | Partial<TState>;

/** 当前一次 run 的内部上下文；不暴露为公共 NodeHandler 契约。 */
interface GraphRunContext {
  agent?: unknown;
}

type InternalNodeHandler<TState> = (
  state: TState,
  ctx: Context,
  signal?: AbortSignal,
  runtime?: GraphRunContext,
) => Promise<Partial<TState>> | Partial<TState>;

/**
 * 动态路由判断：返回下一个目标 NodeName 或并行目标数组，或返回 "__END__" 终止图执行。
 */
export type ConditionHandler<TState = any> = (
  state: TState,
  ctx: Context,
  signal?: AbortSignal,
) => string | string[] | Promise<string | string[]>;

/** 图执行终止哨兵（与静态边 / 条件路由共用）。 */
export const END = "__END__";

export interface GraphDefinition<TState = any> {
  nodes: Map<string, InternalNodeHandler<TState>>;
  edges: Map<string, string>;
  conditionalEdges: Map<string, ConditionHandler<TState>>;
  approvalGates: Map<string, GraphApprovalGateOptions>;
  /** 经 addSubagent 注册的节点名（委托给真实 dsh 子代理，需要 turn 上下文）。 */
  subagentNodes: Set<string>;
  subagentProvider?: string;
  entryPoint?: string;
  maxIterations: number;
}

/** Optional controls for one graph execution. */
export interface GraphRunOptions<TState = any> {
  /** Cooperative cancellation for nodes, routes, and graph traversal. */
  signal?: AbortSignal;
  /** 审批门上下文：透传给 `ctx.approval.request` 的 agent。 */
  agent?: unknown;
  /** 每次节点补丁合并后的检查点回调；宿主可在此接入 dsh 持久化。回调不应抛错。 */
  checkpoint?: (info: GraphCheckpointInfo<TState>) => void | Promise<void>;
}

/** 节点补丁合并后的检查点信息。 */
export interface GraphCheckpointInfo<TState = any> {
  graphId: string;
  node: string;
  state: TState;
  iteration: number;
}

/** 声明式图定义：与链式 API 等价的对象形式，供配置驱动与命令集成使用。 */
export interface GraphEdgeSpec {
  from: string;
  to: string;
}

export interface GraphConditionalEdgeSpec<TState = any> {
  from: string;
  condition: ConditionHandler<TState>;
}

export interface GraphDefinitionSpec<TState = any> {
  entryPoint: string;
  nodes: Record<string, NodeHandler<TState>>;
  edges?: GraphEdgeSpec[];
  conditionalEdges?: GraphConditionalEdgeSpec<TState>[];
  maxIterations?: number;
}

/** 审批门：节点执行前向 `ctx.approval` 请求一次性授权（需 dsh-user-approval 插件）。 */
export interface GraphApprovalGateOptions {
  /** 审批展示与审计使用的工具名。 */
  toolName: string;
  /** 审批请求的人类可读原因。 */
  reason?: string;
}

/** 命令执行结果（对齐 dsh-commands 的 CommandResult 形状）。 */
export type GraphCommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string };

/** 命令调用入参（对齐 dsh-commands 的 CommandInvocation 形状）。 */
export interface GraphCommandInvocation {
  agent: unknown;
  rawInput: string;
  signal: AbortSignal;
}

/** 把一张图注册为 dsh slash 命令的声明。 */
export interface GraphCommandDefinition<TState extends Record<string, any> = any> {
  /** 小写命令名（不含斜杠）。 */
  name: string;
  /** 命令摘要（发现 UI 展示）。 */
  description: string;
  /** 自由输入占位提示。 */
  inputHint?: string;
  /** 图实例或声明式定义。 */
  graph: StateGraph<TState> | GraphDefinitionSpec<TState>;
  /** rawInput → 初始状态；默认 JSON.parse（空输入报错）。 */
  parseInput?: (rawInput: string) => TState;
}
/** `ctx.approval` 的最小结构（dsh-user-approval 的鸭子类型，避免硬依赖）。 */
interface ApprovalServiceLike {
  request(req: {
    agent: unknown;
    toolName: string;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Options for embedding a subgraph. */
export interface SubgraphOptions<TState, TSubState> {
  /** Map parent graph state into the initial state for the subgraph. Defaults to identity. */
  inputMapper?: (state: TState) => TSubState;
  /** Map subgraph final state back to parent state patch. Defaults to identity. */
  outputMapper?: (subState: TSubState, parentState: TState) => Partial<TState>;
}

/** dsh `ctx.subagents` 服务的最小结构（鸭子类型，避免硬依赖 dsh-subagent 类型）。 */
export interface SubagentsServiceLike {
  start(name: string, request: unknown): Promise<SubagentRunLike>;
  list(): string[];
  getProvider?(name: string): { capabilities?: { outputSchema?: boolean } } | undefined;
}

/** `SubagentRun` 的最小结构：结果载荷 + 释放句柄。 */
export interface SubagentRunLike {
  id: string;
  result: Promise<SubagentResultLike>;
  dispose(): Promise<void> | void;
}

/** `SubagentResult` 的最小结构：终态输出 / 结构化结果 / 终止原因。 */
export interface SubagentResultLike {
  /** 子代理最后的助手输出（ContentBlock[] 或退化的 text）。 */
  output: readonly { type?: string; text?: string }[] | string;
  /** outputSchema 校验通过后的结构化值（可为 undefined）。 */
  structured?: unknown;
  /** 终止原因：completed / aborted / error / max-tokens / refusal / 其他。 */
  stopReason: string;
  /** 非助手输出的失败诊断文本。 */
  diagnostic?: string;
}

/**
 * 把一次性子代理的 `SubagentResult` 收敛为可合并的状态增量。
 * - `completed`：取 `structured`（存在时）否则取 output 的文本串联（退化输出）；
 * - 其他 stopReason：抛错（附带 diagnostic 与部分输出，与 dsh 工具层语义一致）；
 * - `output` 非对象数组（如纯字符串）：按文本串联处理。
 */
export function subagentResultToPatch<TState>(
  result: SubagentResultLike,
): Partial<TState> {
  if (result.stopReason !== "completed") {
    const detail: string[] = [];
    if (result.diagnostic) detail.push(`Diagnostic: ${result.diagnostic}`);
    const partialText = subagentOutputText(result.output);
    if (partialText) detail.push(`Partial output before the run ended:\n${partialText}`);
    throw new Error(
      `subagent run ended abnormally (${String(result.stopReason)})${detail.length > 0 ? `\n${detail.join("\n")}` : ""}`,
    );
  }
  if (result.structured !== undefined && result.structured !== null) {
    if (typeof result.structured !== "object") {
      throw new TypeError(
        `subagent structured result must be an object patch, got ${typeof result.structured}`,
      );
    }
    return result.structured as Partial<TState>;
  }
  const text = subagentOutputText(result.output);
  if (text.length === 0) return {};
  return { output: text } as unknown as Partial<TState>;
}

/** 从 SubagentResult.output 中提取文本串联（容忍字符串或 ContentBlock 数组）。 */
export function subagentOutputText(
  output: readonly { type?: string; text?: string }[] | string,
): string {
  if (typeof output === "string") return output;
  return output
    .filter(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * 子代理节点默认输出映射：把子代理的（结构化或文本）结果转成父状态增量。
 * - 子代理返回了 resultKey（默认 "result"）字段 → 直接作为增量合并（须为对象）；
 * - 否则尝试把输出文本 JSON.parse 为对象增量；
 * - 解析失败时退化为 `{ [resultKey]: 文本 }`（文本结果落到状态字段，便于下游使用）。
 */
export function fromSubagentPatch<TState>(
  subState: unknown,
  _parentState: TState,
  resultKey = "result",
): Partial<TState> {
  if (subState !== undefined && subState !== null) {
    if (typeof subState === "object" && !Array.isArray(subState)) {
      return subState as Partial<TState>;
    }
    if (typeof subState === "string") {
      try {
        const parsed: unknown = JSON.parse(subState);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Partial<TState>;
        }
      } catch {
        // 非 JSON，作为文本结果落到 resultKey 字段
      }
      return { [resultKey]: subState } as unknown as Partial<TState>;
    }
  }
  return { [resultKey]: subState } as unknown as Partial<TState>;
}

/** `ctx.agentDefaultModel` 服务的最小结构（鸭子类型）。 */
interface AgentDefaultModelLike {
  currentSelection(): Promise<{ provider?: string; model?: string } | undefined>;
}

/** 子代理的模型路由解析结果。 */
export interface ResolvedSubagentModel {
  provider?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * 解析子代理节点的模型路由（供 `agentOptions` 使用），优先级：
 * 1. 显式 `options.agentOptions`（调用方指定，完全覆盖）；
 * 2. 父 Agent 的 `options.provider/model`（dsh 默认继承源，`parent.options`）；
 * 3. 兜底：`ctx.agentDefaultModel.currentSelection()`（当前实际生效/默认模型）。
 *
 * 返回 `undefined` 表示无需显式 agentOptions（dsh 会自己继承 parent.options）。
 */
export async function resolveSubagentAgentOptions(
  parentAgent: unknown,
  ctx: Context,
  explicit?: Record<string, unknown>,
): Promise<ResolvedSubagentModel | undefined> {
  if (explicit !== undefined) {
    // 显式指定：直接透传（调用方负责完整性）
    return explicit as ResolvedSubagentModel;
  }
  const parentOptions = (parentAgent as { options?: { provider?: string; model?: string; maxTokens?: number } } | undefined)
    ?.options;
  const inherited: ResolvedSubagentModel = {};
  if (parentOptions?.provider !== undefined) inherited.provider = parentOptions.provider;
  if (parentOptions?.model !== undefined) inherited.model = parentOptions.model;
  if (parentOptions?.maxTokens !== undefined) inherited.maxTokens = parentOptions.maxTokens;
  // 父 Agent options 已含完整路由 → 交给 dsh 默认继承（resolveChildAgentOptions）
  if (inherited.provider && inherited.model) return undefined;
  // 缺 provider 或 model：用当前默认模型补齐缺失字段（保留父已有的字段）
  const adm = (ctx as { agentDefaultModel?: AgentDefaultModelLike }).agentDefaultModel;
  if (adm?.currentSelection) {
    try {
      const selection = await adm.currentSelection();
      const selProvider = selection?.provider;
      const selModel = selection?.model;
      if (selProvider !== undefined || selModel !== undefined) {
        return {
          ...(inherited.provider ?? selProvider) !== undefined
            ? { provider: inherited.provider ?? selProvider }
            : {},
          ...(inherited.model ?? selModel) !== undefined
            ? { model: inherited.model ?? selModel }
            : {},
          ...(inherited.maxTokens !== undefined ? { maxTokens: inherited.maxTokens } : {}),
        };
      }
    } catch {
      // 兜底失败：不阻塞，交给 dsh 默认继承
    }
  }
  return inherited.provider || inherited.model ? inherited : undefined;
}

/** 一次性子代理节点（addSubagent 注册）的选项。 */
export interface SubagentNodeOptions<TState> {
  /** 使用的 subagent provider 名（如 "spawn" / "fork"，默认取配置 provider）。 */
  provider?: string;
  /** 子代理短标签（展示与审计，默认取节点名）。 */
  label?: string;
  /** 子代理输出 → 父状态增量（默认 JSON.parse，见 fromSubagentPatch）。 */
  outputMapper?: (subState: unknown, parentState: TState) => Partial<TState>;
  /** 请求 outputSchema 时的结果名（默认 "result"），映射到 subState 的该字段。 */
  resultKey?: string;
  /**
   * 子代理的 agentOptions（如 provider / model / maxTokens）。**显式指定时
   * 完全覆盖**自动解析的模型路由；缺省时自动继承父 Agent 模型（`parent.options`），
   * 父 Agent 缺路由则用 `ctx.agentDefaultModel.currentSelection()` 兜底。
   */
  agentOptions?: Record<string, unknown>;
  /** 透传给子代理的 maxDepth（需要 provider 支持 depthLimit）。 */
  maxDepth?: number;
  /** 透传给子代理的 toolFilter。 */
  toolFilter?: { allow?: string[]; deny?: string[] };
  /** 透传给子代理的 persona。 */
  persona?: string;
}

/** 图执行完成后的最终产物及全量跳转轨迹。graphId 标识本次执行，区分重复/并发轨迹。 */
export interface GraphExecutionResult<TState = any> {
  graphId: string;
  finalState: TState;
  trajectory: string[];
  iterations: number;
}

// ---- dsh 追加式 Trajectory 事件总线（graph/* 事件载荷） ----

export interface GraphStartEvent<TState = any> {
  graphId: string;
  initialState: TState;
  entryPoint: string;
}

export interface GraphNodeStartEvent<TState = any> {
  graphId: string;
  node: string;
  state: TState;
  iteration: number;
}

export interface GraphNodeEndEvent<TState = any> {
  graphId: string;
  node: string;
  state: TState;
  durationMs?: number;
  patch?: Partial<TState>;
}

export interface GraphNodeErrorEvent {
  graphId: string;
  node: string;
  error: unknown;
}

export interface GraphErrorEvent<TState = any> {
  graphId: string;
  error: Error;
  state: TState;
  lastNode: string;
}

export interface GraphEndEvent<TState = any> {
  graphId: string;
  finalState: TState;
  trajectory: string[];
  iterations: number;
}

// graph/* 事件声明与载荷同源（engine.ts 随引擎单源共享，宿主与浏览器共用）。
// `Context.graph` 服务接口的增强在 index.ts（服务在插件入口实现）。
declare module "@deepseek-ai/cordis" {
  interface Events {
    "graph/start"(event: GraphStartEvent): void;
    "graph/node-start"(event: GraphNodeStartEvent): void;
    "graph/node-end"(event: GraphNodeEndEvent): void;
    "graph/node-error"(event: GraphNodeErrorEvent): void;
    "graph/error"(event: GraphErrorEvent): void;
    "graph/end"(event: GraphEndEvent): void;
  }
}

/**
 * 有向状态图运行时内核：节点注册、静态边/条件路由、迭代熔断与轨迹留存。
 *
 * 节点只返回状态增量（Patch），引擎做浅拷贝合并；回环由 maxIterations
 * 熔断，超限抛错并发出 graph/error 事件。
 *
 * 本文件不依赖任何 Node 专属 API（随机 id 走 globalThis.crypto），
 * 可被宿主（dsh 插件）与浏览器（Graph Studio 视图）单源共享。
 */
export class StateGraph<TState extends Record<string, any>> {
  /**
   * 本实例的唯一标识，保留用于兼容已有调用方；graph/* 事件载荷使用每次
   * run() 独立生成的 graphId，以区分同一图的重复/并发执行轨迹。
   */
  readonly id: string;

  private def: GraphDefinition<TState> = {
    nodes: new Map(),
    edges: new Map(),
    conditionalEdges: new Map(),
    approvalGates: new Map(),
    subagentNodes: new Set(),
    subagentProvider: undefined,
    maxIterations: 25,
  };

  constructor(private ctx: Context, maxIterations = 25) {
    assertValidMaxIterations(maxIterations);
    this.id = `graph-${randomHexId()}`;
    this.def.maxIterations = maxIterations;
  }

  addNode(name: string, handler: NodeHandler<TState>): this {
    return this.addInternalNode(name, handler);
  }

  private addInternalNode(name: string, handler: InternalNodeHandler<TState>): this {
    if (name === END) {
      throw new Error(`节点名 "${END}" 为保留哨兵，禁止注册。`);
    }
    if (this.def.nodes.has(name)) {
      throw new Error(`节点 "${name}" 已注册。`);
    }
    this.def.nodes.set(name, handler);
    return this;
  }

  /**
   * 注册一个嵌套子图作为节点：自动将父图的 signal 传递给子图，
   * 并支持输入/输出状态映射。
   */
  addSubgraph<TSubState extends Record<string, any>>(
    name: string,
    subgraph: StateGraph<TSubState>,
    options?: SubgraphOptions<TState, TSubState>,
  ): this {
    const inputMapper =
      options?.inputMapper ?? ((s: TState) => s as unknown as TSubState);
    const outputMapper =
      options?.outputMapper ??
      ((subState: TSubState) => subState as unknown as Partial<TState>);
    return this.addInternalNode(name, async (state, _ctx, signal, runtime) => {
      const initialSubState = inputMapper(state);
      const subResult = await subgraph.run(initialSubState, { signal, agent: runtime?.agent });
      return outputMapper(subResult.finalState, state);
    });
  }

  /**
   * 注册一个"子代理节点"：节点执行时经 `ctx.subagents.start(provider, …)`
   * 启动一个**一次性 dsh 子代理**（真正的 Agent，独立会话），输出经映射
   * 合并回父图状态。需要 dsh-subagent 运行时（dsh-subagent-spawn-in-process /
   * dsh-subagent-fork-in-process 等 provider）与 `run({ agent })` 提供父 Agent
   * 上下文。
   *
   * 与 `addSubgraph` 的区别：子图是进程内复用同一 ctx 的状态机；子代理节点是
   * 把节点委托给一个独立 Agent（可走 LLM / 工具），适合"子图 = subagent"方向。
   * 约定（可覆盖）：
   * - prompt 由 `options.prompt` 或默认 `JSON.stringify(inputMapper(state))` 组成；
   * - 请求 `options.resultKey`（默认 "result"）命名的 outputSchema；
   * - 结果经 `options.outputMapper`（默认 `fromSubagentPatch`）映射为父状态增量。
   */
  addSubagent(
    name: string,
    options: SubagentNodeOptions<TState> & {
      /** 委托给子代理的任务文本（模板变量：{{node}} {{state}}）。 */
      prompt: string;
      /** 父状态 → 子代理初始输入；默认透传整个 state。 */
      inputMapper?: (state: TState) => unknown;
    },
  ): this {
    const label = options.label ?? name;
    const prompt = options.prompt;
    const inputMapper = options.inputMapper ?? ((s: TState) => s);
    const outputMapper =
      options.outputMapper ??
      ((subState: unknown, parentState: TState) =>
        fromSubagentPatch(subState, parentState, options.resultKey ?? "result"));
    const resultKey = options.resultKey ?? "result";
    this.def.subagentNodes.add(name);
    return this.addInternalNode(name, async (state, ctx, signal, runtime) => {
      const subagentsHost = ctx as { subagents?: SubagentsServiceLike };
      const subagents = subagentsHost.subagents;
      if (!subagents?.start) {
        throw new Error(
          `子代理节点 "${name}" 需要 ctx.subagents 服务（dsh-subagent 运行时）。`,
        );
      }
      const effectiveProvider = options.provider ?? this.def.subagentProvider ?? "spawn";
      const renderedPrompt = prompt
        .replaceAll("{{node}}", name)
        .replaceAll("{{state}}", JSON.stringify(inputMapper(state)));
      // 模型路由：显式 agentOptions > 父 Agent options > agentDefaultModel 兜底。
      // 解析结果为空时交给 dsh 默认继承（resolveChildAgentOptions 会继承 parent.options）。
      const resolvedModel = await resolveSubagentAgentOptions(
        runtime?.agent,
        ctx,
        options.agentOptions,
      );
      const run = await subagents.start(effectiveProvider, {
        label,
        prompt: [{ type: "text", text: renderedPrompt }],
        parent: runtime?.agent,
        signal,
        ...(resolvedModel !== undefined ? { agentOptions: resolvedModel } : {}),
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
        ...(options.toolFilter !== undefined
          ? { toolFilter: options.toolFilter }
          : {}),
        ...(options.persona !== undefined ? { persona: options.persona } : {}),
        ...{
          outputSchema: {
            type: "object",
            properties: { [resultKey]: {} },
            required: [resultKey],
            additionalProperties: false,
          },
        },
      });
      try {
        const result = await run.result;
        signal?.throwIfAborted();
        if (result.stopReason !== "completed") {
          throw new Error(
            `子代理节点 "${name}" 未正常完成：${String(result.stopReason)}` +
              (result.diagnostic ? `\nDiagnostic: ${result.diagnostic}` : "") +
              (subagentOutputText(result.output)
                ? `\nPartial output before the run ended:\n${subagentOutputText(result.output)}`
                : ""),
          );
        }
        const subState =
          result.structured !== undefined && result.structured !== null
            ? (result.structured as Record<string, unknown>)[resultKey]
            : subagentOutputText(result.output);
        return outputMapper(subState, state);
      } finally {
        await run.dispose();
      }
    });
  }

  setEntryPoint(nodeName: string): this {
    this.def.entryPoint = nodeName;
    return this;
  }

  /** 设置本图子代理节点的默认 provider 名（未在 addSubagent 显式指定时生效）。 */
  setSubagentProvider(provider: string): this {
    this.def.subagentProvider = provider;
    return this;
  }

  /**
   * 返回需要 dsh turn 上下文（agent 工具 / 事件处理器 / agent/inject）才能执行的
   * 节点名：审批门节点与子代理节点。无 turn 的入口（如 slash 命令）必须拒绝
   * 包含这些节点的图——审批请求会被 dsh 以 idle ask 拒绝，子代理需要真实父
   * Agent 推导会话、谱系与委托深度。返回空数组表示图可在任意上下文执行。
   */
  listTurnBoundNodes(): string[] {
    return [...this.def.approvalGates.keys(), ...this.def.subagentNodes];
  }

  addEdge(from: string, to: string): this {
    if (this.def.edges.has(from)) {
      throw new Error(`节点 "${from}" 的静态边已注册。`);
    }
    this.def.edges.set(from, to);
    return this;
  }

  addConditionalEdge(from: string, condition: ConditionHandler<TState>): this {
    if (this.def.conditionalEdges.has(from)) {
      throw new Error(`节点 "${from}" 的条件边已注册。`);
    }
    this.def.conditionalEdges.set(from, condition);
    return this;
  }
  /**
   * 注册一个审批门：节点执行前向 `ctx.approval` 请求一次性授权（dsh-user-approval
   * 插件提供）。通过（`allowed-once`）后继续执行该节点（无 handler 则为纯门，
   * 产生空增量）；拒绝 / 取消 / 无应答均抛错，按节点错误路径上报。需要
   * `run(initialState, { agent })` 提供审批上下文。
   */
  addApprovalGate(name: string, options: GraphApprovalGateOptions): this {
    if (this.def.approvalGates.has(name)) {
      throw new Error(`节点 "${name}" 的审批门已注册。`);
    }
    this.def.approvalGates.set(name, options);
    return this;
  }

  async run(
    initialState: TState,
    options: GraphRunOptions<TState> = {},
  ): Promise<GraphExecutionResult<TState>> {
    const signal = options.signal;
    const agent = options.agent;
    const runtime: GraphRunContext = { agent };
    const checkpoint = options.checkpoint;
    signal?.throwIfAborted();

    if (!this.def.entryPoint || !this.def.nodes.has(this.def.entryPoint)) {
      throw new Error("图必须指定一个已注册的有效入口节点（entryPoint）。");
    }

    const entryPoint = this.def.entryPoint;
    const graphId = `graph-${randomHexId()}`;
    let currentNode: string | undefined = entryPoint;
    let state: TState = { ...initialState };
    const trajectory: string[] = [];
    let iterations = 0;

    // 取消终态契约：graph/start 之后的取消在任意时点都补发一次 graph/error 再抛，
    // 保证轨迹观察者对每次已启动的执行都能收到终结事件（正常 = end，异常/取消 = error）。
    // graph/start 之前的预取消保持无事件（图尚未启动，无轨迹可终结）。
    const abortCheckpoint = () => {
      if (!signal?.aborted) return;
      const err =
        signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
      this.ctx.emit("graph/error", {
        graphId,
        error: err,
        state,
        lastNode: trajectory.length > 0 ? trajectory[trajectory.length - 1] : entryPoint,
      });
      throw err;
    };

    this.ctx.emit("graph/start", {
      graphId,
      initialState,
      entryPoint,
    });
    abortCheckpoint();

    while (currentNode && currentNode !== END) {
      abortCheckpoint();

      // 熔断边界语义：maxIterations 指"最多执行的迭代次数"；第 maxIterations+1 次
      // 进入此处时检查并抛错终止（第 N 次仍会执行完），超限发 graph/error。
      if (++iterations > this.def.maxIterations) {
        const err = new Error(
          `迭代次数超过上限（${this.def.maxIterations}），疑似死循环，已终止。`,
        );
        this.ctx.emit("graph/error", {
          graphId,
          error: err,
          state,
          lastNode: currentNode,
        });
        throw err;
      }

      trajectory.push(currentNode);
      abortCheckpoint();
      this.ctx.emit("graph/node-start", {
        graphId,
        node: currentNode,
        state,
        iteration: iterations,
      });
      abortCheckpoint();

      const gate = this.def.approvalGates.get(currentNode);
      const handler = this.def.nodes.get(currentNode);
      if (!handler && !gate) {
        // 目标节点缺失（条件路由返回未注册名 / 静态边悬空）：补发 graph/error 后上抛，
        // 让轨迹观察者收到失败终结，而非静默无终态。
        const err = new Error(`节点 "${currentNode}" 缺少处理器（目标节点缺失）。`);
        this.ctx.emit("graph/error", {
          graphId,
          error: err,
          state,
          lastNode: currentNode,
        });
        throw err;
      }

      // try 只包住节点执行本身：补丁合并与 node-end 发射留在块外，graph/* 监听器
      // 抛错（cordis emit 同步传播、不隔离）不会被误归类为节点业务错误。
      let patch: Partial<TState> | undefined;
      let durationMs = 0;
      try {
        // 审批门：执行前向 ctx.approval 请求一次性授权（需 dsh-user-approval 插件）。
        if (gate) {
          // ctx.approval 由 dsh-user-approval 插件注入，本插件不硬依赖其类型，
          // 此处做鸭子类型检测后调用。
          const approvalHost = this.ctx as { approval?: ApprovalServiceLike };
          const approval = approvalHost.approval;
          if (!approval?.request) {
            throw new Error(
              `审批门 "${currentNode}" 需要 ctx.approval 服务（dsh-user-approval 插件）。`,
            );
          }
          if (agent === undefined) {
            throw new Error(
              `审批门 "${currentNode}" 需要 run({ agent }) 提供审批上下文。`,
            );
          }
          const outcome = await approval.request({
            agent,
            toolName: gate.toolName,
            reason: gate.reason,
            signal,
          });
          if (outcome !== "allowed-once") {
            throw new Error(`审批门 "${currentNode}" 未通过（${outcome}）。`);
          }
        }
        const startTime = Date.now();
        patch = handler ? await handler(state, this.ctx, signal, runtime) : {};
        signal?.throwIfAborted();
        if (patch == null) {
          throw new TypeError(`节点 "${currentNode}" 返回了空状态增量（null/undefined）。`);
        }
        durationMs = Date.now() - startTime;
        state = { ...state, ...patch };
      } catch (nodeErr) {
        this.ctx.emit("graph/node-error", {
          graphId,
          node: currentNode,
          error: nodeErr,
        });
        // 取消造成的中断：node-error 只是过程诊断，还需补发 graph/error 终态，
        // 与路由段/检查点取消的语义一致；节点自身业务错误不在此列。
        if (signal?.aborted) {
          this.ctx.emit("graph/error", {
            graphId,
            error: nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)),
            state,
            lastNode: currentNode,
          });
        }
        throw nodeErr;
      }

      this.ctx.emit("graph/node-end", {
        graphId,
        node: currentNode,
        state,
        durationMs,
        patch,
      });
      if (checkpoint) {
        await checkpoint({ graphId, node: currentNode, state, iteration: iterations });
      }
      abortCheckpoint();

      try {
        signal?.throwIfAborted();
        if (this.def.conditionalEdges.has(currentNode)) {
          const router: ConditionHandler<TState> = this.def.conditionalEdges.get(currentNode)!;
          const next = await router(state, this.ctx, signal);
          signal?.throwIfAborted();

          if (Array.isArray(next)) {
            if (next.length === 0) {
              currentNode = END;
            } else {
              for (const target of next) {
                if (typeof target !== "string" || (target !== END && !this.def.nodes.has(target))) {
                  throw new Error(
                    `条件路由返回了非法目标：${describeRouteTarget(target)}（必须是已注册节点名或 "__END__"）。`,
                  );
                }
              }
              const validTargets = next.filter((t) => t !== END);
              if (validTargets.length > 0 && next.includes(END)) {
                throw new Error(
                  `条件路由返回的并行目标数组不能混用 "__END__" 与节点名。`,
                );
              }
              if (validTargets.length === 0) {
                currentNode = END;
              } else if (validTargets.length === 1) {
                currentNode = validTargets[0];
              } else {
                // 并行分支汇聚（Fan-out）：并发执行各目标节点。
                // 取消检查只用裸 throwIfAborted：分支错误与取消的终态由外层
                // route catch 统一补发一次 graph/error，避免并行路径多次发终态。
                signal?.throwIfAborted();
                if (++iterations > this.def.maxIterations) {
                  const err = new Error(
                    `迭代次数超过上限（${this.def.maxIterations}），疑似死循环，已终止。`,
                  );
                  this.ctx.emit("graph/error", {
                    graphId,
                    error: err,
                    state,
                    lastNode: validTargets[0],
                  });
                  throw err;
                }
                trajectory.push(...validTargets);
                const parallelResults = await Promise.all(
                  validTargets.map(async (target) => {
                    signal?.throwIfAborted();
                    this.ctx.emit("graph/node-start", {
                      graphId,
                      node: target,
                      state,
                      iteration: iterations,
                    });
                    const h = this.def.nodes.get(target)!;
                    const startTime = Date.now();
                    try {
                      const branchGate = this.def.approvalGates.get(target);
                      if (branchGate) {
                        const approval = (this.ctx as { approval?: ApprovalServiceLike }).approval;
                        if (!approval?.request) {
                          throw new Error(
                            `审批门 "${target}" 需要 ctx.approval 服务（dsh-user-approval 插件）。`,
                          );
                        }
                        if (agent === undefined) {
                          throw new Error(
                            `审批门 "${target}" 需要 run({ agent }) 提供审批上下文。`,
                          );
                        }
                        const outcome = await approval.request({
                          agent,
                          toolName: branchGate.toolName,
                          reason: branchGate.reason,
                          signal,
                        });
                        if (outcome !== "allowed-once") {
                          throw new Error(`审批门 "${target}" 未通过（${outcome}）。`);
                        }
                      }
                      const branchPatch = await h(state, this.ctx, signal, runtime);
                      signal?.throwIfAborted();
                      if (branchPatch == null) {
                        throw new TypeError(
                          `节点 "${target}" 返回了空状态增量（null/undefined）。`,
                        );
                      }
                      const branchDuration = Date.now() - startTime;
                      return { target, patch: branchPatch, durationMs: branchDuration };
                    } catch (nodeErr) {
                      // 分支失败：只发过程诊断；终态（取消 → graph/error）由
                      // 外层 catch 按 FanoutNodeError 统一补发一次。
                      this.ctx.emit("graph/node-error", {
                        graphId,
                        node: target,
                        error: nodeErr,
                      });
                      throw new FanoutNodeError(target, nodeErr);
                    }
                  }),
                );
                for (const { target, patch: branchPatch, durationMs: branchDuration } of parallelResults) {
                  state = { ...state, ...branchPatch };
                  this.ctx.emit("graph/node-end", {
                    graphId,
                    node: target,
                    state,
                    durationMs: branchDuration,
                    patch: branchPatch,
                  });
                  if (checkpoint) {
                    await checkpoint({ graphId, node: target, state, iteration: iterations });
                  }
                }
                // 汇聚跳转：寻找并行节点中定义的出边（Join Node）
                let nextFromParallel: string | undefined = undefined;
                for (const target of validTargets) {
                  if (this.def.edges.has(target)) {
                    nextFromParallel = this.def.edges.get(target);
                  }
                }
                currentNode = nextFromParallel ?? END;
              }
            }
          } else {
            // 路由返回值必须是已注册节点名或 END 哨兵：undefined（忘写 return）、
            // 非字符串、未注册名一律视为路由错误，与"未注册节点名抛错"同一语义，
            // 不能静默当作正常终止（否则路由 bug 会被洗成 graph/end"成功"）。
            if (typeof next !== "string" || (next !== END && !this.def.nodes.has(next))) {
              // 只抛错不 emit：错误会被下方 catch 捕获，由它统一补发一次
              // graph/error——否则非法目标会 double-emit。
              throw new Error(
                `条件路由返回了非法目标：${describeRouteTarget(next)}（必须是已注册节点名或 "__END__"）。`,
              );
            }
            currentNode = next;
          }
        } else if (this.def.edges.has(currentNode)) {
          currentNode = this.def.edges.get(currentNode);
        } else {
          currentNode = END;
        }
        signal?.throwIfAborted();
      } catch (routeErr) {
        if (routeErr instanceof FanoutNodeError) {
          // 并行分支节点错误：终态规则与单节点路径一致——业务错误仅发
          // node-error（分支 catch 已发）；取消则补发一次 graph/error 终态。
          if (signal?.aborted) {
            const causeErr =
              routeErr.cause instanceof Error
                ? routeErr.cause
                : new Error(String(routeErr.cause));
            this.ctx.emit("graph/error", {
              graphId,
              error: causeErr,
              state,
              lastNode: routeErr.target,
            });
          }
          throw routeErr.cause;
        }
        // 路由函数抛错（或上方校验抛错）：补发 graph/error（此前无任何终态事件）后再上抛。
        const err =
          routeErr instanceof Error ? routeErr : new Error(String(routeErr));
        this.ctx.emit("graph/error", {
          graphId,
          error: err,
          state,
          // 循环不变量保证 currentNode 为已注册节点名（while 条件已收窄）；catch 内
          // TS 丢失该收窄，此处断言。
          lastNode: currentNode as string,
        });
        throw err;
      }
    }

    // graph/end 仅在正常终止（END 或无出边）时发出；异常终止发 graph/error
    // （节点业务错误先发 graph/node-error），取消在任意时点补发 graph/error。
    abortCheckpoint();
    this.ctx.emit("graph/end", {
      graphId,
      finalState: state,
      trajectory,
      iterations,
    });
    return { graphId, finalState: state, trajectory, iterations };
  }
}

/**
 * 并行分支节点失败的内部标记：携带失败分支名与原始错误，供 run 的外层路由
 * catch 区分"分支节点错误"与"路由本身错误"，使终态事件规则与单节点路径一致。
 */
class FanoutNodeError extends Error {
  constructor(
    readonly target: string,
    readonly cause: unknown,
  ) {
    super(`Parallel node "${target}" failed.`);
    this.name = "FanoutNodeError";
  }
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

/**
 * 同构随机 hex id：Node ≥19 与浏览器均提供 globalThis.crypto，
 * 引擎因此不再依赖 node:crypto，可原样跑在浏览器侧。
 */
function randomHexId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

// ---- Graph Studio 声明式 JSON DSL（浏览器 / 宿主单源共享） ----
//
// StateGraph 的节点与条件是函数，无法跨 JSON 序线。Studio DSL 用一小套
// 声明式原语（patch / counter / subagent / gate 节点 + 规则式条件路由）
// 描述图结构，studioValidate 校验、studioBuildGraph 在两侧用同一份引擎
// 代码构建真实 StateGraph——浏览器里逐节点实时跑，宿主里跑全功能
// （子代理 / 审批门只在宿主可用，校验结果会给出提示）。

/** Studio 条件判定算子（路由规则与 $test 补丁值共用一套求值语义）。 */
export type StudioTestOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "exists";

/** 一条判定：state[field] op value（exists 只看字段是否存在）。 */
export interface StudioTest {
  /** 参与判定的状态字段（顶层，不嵌套）。 */
  field: string;
  op: StudioTestOp;
  /** eq/ne/gt/gte/lt/lte 的比较值；exists 忽略。 */
  value?: unknown;
}

/** 补丁值运算：`{ $inc: n }` 数值自增、`{ $test: {...} }` 布尔判定；其余为字面量。 */
export interface StudioPatchOps {
  $inc?: number;
  $test?: StudioTest;
}

export type StudioNodeKind = "patch" | "counter" | "subagent" | "gate";

/** Studio 节点声明。 */
export interface StudioNodeSpec {
  name: string;
  kind: StudioNodeKind;
  /** 展示标签（可选，默认取 name）。 */
  label?: string;
  /** kind=patch：静态增量对象，值支持 $inc / $test 运算。 */
  patch?: Record<string, unknown>;
  /** kind=counter：自增字段与上限（达到上限时额外合并 then）。 */
  counter?: { field: string; limit: number; then?: Record<string, unknown> };
  /** kind=subagent（仅宿主）：任务提示模板，变量 {{node}} / {{state}}。 */
  prompt?: string;
  /** kind=subagent：provider 名（默认取引擎配置）。 */
  provider?: string;
  /** kind=subagent：结构化结果字段名（默认 "result"）。 */
  resultKey?: string;
  /** kind=gate（仅宿主）：审批门声明。 */
  gate?: { toolName: string; reason?: string };
}

/** 一条路由规则：省略 field/op 时为无条件规则（恒命中）。 */
export interface StudioRule extends Partial<StudioTest> {
  /** 命中后的目标：节点名、`"__END__"` 或并行目标数组（Fan-out，不可与 END 混用）。 */
  to: string | string[];
}

/** Studio 条件边：规则按序匹配，首个命中者生效；全部未命中走 fallback（默认 END）。 */
export interface StudioConditionalEdgeSpec {
  from: string;
  rules: StudioRule[];
  /** 全部规则未命中时的目标（默认 `"__END__"`）。 */
  fallback?: string;
}

/** Studio 图定义（JSON 可序列化）。initialState 仅为运行便捷保存，非图结构。 */
export interface StudioGraphSpec {
  entryPoint: string;
  maxIterations?: number;
  initialState?: Record<string, unknown>;
  nodes: StudioNodeSpec[];
  edges: { from: string; to: string }[];
  conditionalEdges: StudioConditionalEdgeSpec[];
}

/** studioValidate 的结果：errors 阻断运行，warnings 仅提示。 */
export interface StudioValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const STUDIO_NODE_KINDS: readonly StudioNodeKind[] = [
  "patch",
  "counter",
  "subagent",
  "gate",
];

const STUDIO_OPS: readonly StudioTestOp[] = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
];

/** 判定求值：eq/ne 对字面量用严格相等（对象比较 JSON 序列化值）；数值比较两侧 Number() 化。 */
export function studioTest(
  state: Record<string, unknown>,
  test: Pick<StudioTest, "field" | "op"> & { value?: unknown },
): boolean {
  const actual = state[test.field];
  const expected = test.value;
  switch (test.op) {
    case "exists":
      return actual !== undefined;
    case "eq":
      return studioEquals(actual, expected);
    case "ne":
      return !studioEquals(actual, expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = Number(actual);
      const b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (test.op === "gt") return a > b;
      if (test.op === "gte") return a >= b;
      if (test.op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function studioEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return Object.is(a, b);
}

/**
 * 补丁值求值：识别 $inc / $test 运算，其余原样字面量。
 * $inc / $test 都基于节点执行前的状态快照求值：同一补丁内先写入的字段
 * 对后面的 $test 不可见（跨节点可见），避免结果依赖字段书写顺序。
 */
function resolvePatchValue(
  state: Record<string, unknown>,
  field: string,
  spec: unknown,
): unknown {
  if (typeof spec === "object" && spec !== null && !Array.isArray(spec)) {
    const op = spec as StudioPatchOps;
    if (op.$inc !== undefined) {
      const current = Number(state[field]);
      return (Number.isFinite(current) ? current : 0) + op.$inc;
    }
    if (op.$test !== undefined) {
      return studioTest(state, { ...op.$test, field: op.$test.field });
    }
  }
  return spec;
}

/** kind=patch 节点 handler：按补丁对象逐字段求值后整体合并。 */
function studioPatchHandler(patch: Record<string, unknown>): NodeHandler {
  return (state) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      out[key] = resolvePatchValue(state as Record<string, unknown>, key, value);
    }
    return out as Partial<Record<string, unknown>>;
  };
}

/** kind=counter 节点 handler：field 自增；新值达到 limit 时额外合并 then。 */
function studioCounterHandler(counter: {
  field: string;
  limit: number;
  then?: Record<string, unknown>;
}): NodeHandler {
  return (state) => {
    const record = state as Record<string, unknown>;
    const current = Number(record[counter.field]);
    const next = (Number.isFinite(current) ? current : 0) + 1;
    if (next >= counter.limit && counter.then) {
      return { [counter.field]: next, ...counter.then };
    }
    return { [counter.field]: next };
  };
}

/** 条件边 handler：规则按序首个命中生效；无 field 的规则恒命中。 */
function studioConditionHandler(
  edge: StudioConditionalEdgeSpec,
): ConditionHandler {
  return (state) => {
    const record = state as Record<string, unknown>;
    for (const rule of edge.rules) {
      const hit =
        rule.field === undefined || rule.op === undefined
          ? true
          : studioTest(record, rule as StudioTest);
      if (hit) return rule.to;
    }
    return edge.fallback ?? END;
  };
}

/**
 * 从 Studio JSON 规格构建真实 StateGraph。ctx 只需满足引擎最小面
 * （emit/on 及透传给节点的服务，如浏览器插件 ctx 或宿主 ctx）。
 * subagent / gate 节点在缺少对应 dsh 服务的运行环境中会在执行到该节点时
 * 抛出教学错误（注册阶段不报错）。
 */
export function studioBuildGraph(
  ctx: Context,
  spec: StudioGraphSpec,
  defaultMaxIterations = 25,
): StateGraph<Record<string, unknown>> {
  const graph = new StateGraph<Record<string, unknown>>(
    ctx,
    spec.maxIterations ?? defaultMaxIterations,
  );
  for (const node of spec.nodes) {
    switch (node.kind) {
      case "patch":
        graph.addNode(node.name, studioPatchHandler(node.patch ?? {}));
        break;
      case "counter":
        graph.addNode(node.name, studioCounterHandler(node.counter!));
        break;
      case "subagent":
        graph.addSubagent(node.name, {
          prompt: node.prompt ?? "",
          ...(node.provider !== undefined ? { provider: node.provider } : {}),
          ...(node.resultKey !== undefined ? { resultKey: node.resultKey } : {}),
          ...(node.label !== undefined ? { label: node.label } : {}),
        });
        break;
      case "gate":
        // gate 节点同时注册空补丁 handler：引擎先过审批门再执行空增量，
        // 行为与纯门一致，且入口校验（entryPoint 必须在节点表）对 gate 节点同样成立。
        graph.addNode(node.name, () => ({}) as Partial<Record<string, unknown>>);
        graph.addApprovalGate(node.name, {
          toolName: node.gate!.toolName,
          ...(node.gate!.reason !== undefined ? { reason: node.gate!.reason } : {}),
        });
        break;
    }
  }
  for (const edge of spec.edges) {
    graph.addEdge(edge.from, edge.to);
  }
  for (const edge of spec.conditionalEdges) {
    graph.addConditionalEdge(edge.from, studioConditionHandler(edge));
  }
  graph.setEntryPoint(spec.entryPoint);
  return graph;
}

/** 结构校验：errors 阻断运行（与引擎注册/路由语义一致），warnings 仅提示。 */
export function studioValidate(spec: StudioGraphSpec): StudioValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof spec !== "object" || spec === null) {
    return { ok: false, errors: ["图定义必须是对象。"], warnings };
  }
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const names = new Set<string>();

  if (nodes.length === 0) errors.push("至少需要一个节点。");
  nodes.forEach((node, index) => {
    const at = `节点[${index}]`;
    if (typeof node?.name !== "string" || node.name.length === 0) {
      errors.push(`${at}：name 必须是非空字符串。`);
      return;
    }
    if (node.name === END) errors.push(`${at}："__END__" 是保留哨兵，不能作为节点名。`);
    if (names.has(node.name)) errors.push(`节点 "${node.name}" 重复定义。`);
    names.add(node.name);
    if (!STUDIO_NODE_KINDS.includes(node.kind)) {
      errors.push(`节点 "${node.name}"：kind 必须是 ${STUDIO_NODE_KINDS.join(" / ")}。`);
      return;
    }
    switch (node.kind) {
      case "patch":
        if (typeof node.patch !== "object" || node.patch === null || Array.isArray(node.patch)) {
          errors.push(`节点 "${node.name}"（patch）：patch 必须是对象。`);
        }
        break;
      case "counter":
        if (
          typeof node.counter?.field !== "string" ||
          node.counter.field.length === 0
        ) {
          errors.push(`节点 "${node.name}"（counter）：counter.field 必须是非空字符串。`);
        }
        if (
          typeof node.counter?.limit !== "number" ||
          !Number.isInteger(node.counter.limit) ||
          node.counter.limit < 1
        ) {
          errors.push(`节点 "${node.name}"（counter）：counter.limit 必须是正整数。`);
        }
        break;
      case "subagent":
        if (typeof node.prompt !== "string" || node.prompt.length === 0) {
          errors.push(`节点 "${node.name}"（subagent）：prompt 必须是非空字符串。`);
        }
        warnings.push(`节点 "${node.name}"（subagent）：仅宿主侧可执行（需要 dsh-subagent 运行时与父 Agent）。`);
        break;
      case "gate":
        if (typeof node.gate?.toolName !== "string" || node.gate.toolName.length === 0) {
          errors.push(`节点 "${node.name}"（gate）：gate.toolName 必须是非空字符串。`);
        }
        warnings.push(`节点 "${node.name}"（gate）：仅宿主侧可执行（需要 dsh-user-approval 插件与 agent 上下文）。`);
        break;
    }
  });

  if (typeof spec.entryPoint !== "string" || !names.has(spec.entryPoint)) {
    errors.push(`入口节点 "${String(spec.entryPoint)}" 未在节点表中定义。`);
  }
  if (spec.maxIterations !== undefined) {
    if (
      typeof spec.maxIterations !== "number" ||
      !Number.isInteger(spec.maxIterations) ||
      spec.maxIterations < 1
    ) {
      errors.push("maxIterations 必须是正整数。");
    }
  }
  if (
    spec.initialState !== undefined &&
    (typeof spec.initialState !== "object" ||
      spec.initialState === null ||
      Array.isArray(spec.initialState))
  ) {
    errors.push("initialState 必须是对象。");
  }

  const staticFrom = new Set<string>();
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  for (const edge of edges) {
    const at = `静态边 ${String(edge?.from)} → ${String(edge?.to)}`;
    if (typeof edge?.from !== "string" || !names.has(edge.from)) {
      errors.push(`${at}：from 必须是已定义节点。`);
      continue;
    }
    if (typeof edge.to !== "string" || (edge.to !== END && !names.has(edge.to))) {
      errors.push(`${at}：to 必须是已定义节点或 "__END__"。`);
    }
    if (staticFrom.has(edge.from)) {
      errors.push(`节点 "${edge.from}" 的静态边重复定义（引擎每节点仅一条出边）。`);
    }
    staticFrom.add(edge.from);
  }

  const condFrom = new Set<string>();
  const condEdges = Array.isArray(spec.conditionalEdges) ? spec.conditionalEdges : [];
  for (const edge of condEdges) {
    const at = `条件边 @${String(edge?.from)}`;
    if (typeof edge?.from !== "string" || !names.has(edge.from)) {
      errors.push(`${at}：from 必须是已定义节点。`);
      continue;
    }
    if (condFrom.has(edge.from)) {
      errors.push(`节点 "${edge.from}" 的条件边重复定义。`);
    }
    condFrom.add(edge.from);
    if (staticFrom.has(edge.from)) {
      warnings.push(`节点 "${edge.from}" 同时定义静态边与条件边：运行时条件边优先生效。`);
    }
    const rules = Array.isArray(edge.rules) ? edge.rules : [];
    if (rules.length === 0) errors.push(`${at}：至少需要一条规则。`);
    rules.forEach((rule, i) => {
      if (rule?.field !== undefined && !STUDIO_OPS.includes(rule.op!)) {
        errors.push(`${at} 规则[${i}]：op 必须是 ${STUDIO_OPS.join(" / ")}。`);
      }
      const targets = Array.isArray(rule?.to) ? rule.to : [rule?.to];
      if (targets.length === 0) {
        errors.push(`${at} 规则[${i}]：目标不能为空。`);
        return;
      }
      const hasEnd = targets.includes(END);
      if (hasEnd && targets.length > 1) {
        errors.push(`${at} 规则[${i}]：并行目标数组不能混用 "__END__" 与节点名。`);
      }
      if (!hasEnd) {
        for (const target of targets) {
          if (typeof target !== "string" || !names.has(target)) {
            errors.push(`${at} 规则[${i}]：目标 "${String(target)}" 不是已定义节点。`);
          }
        }
      }
    });
    if (
      edge.fallback !== undefined &&
      edge.fallback !== END &&
      !names.has(edge.fallback)
    ) {
      errors.push(`${at}：fallback "${edge.fallback}" 不是已定义节点或 "__END__"。`);
    }
  }

  // 可达性：从入口沿运行时生效的出边（有条件边的节点忽略其静态边——
  // 与引擎"条件边优先"一致——加上条件目标与 fallback）BFS。
  if (names.has(spec.entryPoint)) {
    const successors = new Map<string, string[]>();
    for (const name of names) successors.set(name, []);
    for (const edge of edges) {
      if (
        successors.has(edge?.from) &&
        !condFrom.has(edge.from) &&
        (names.has(edge?.to) || edge?.to === END)
      ) {
        successors.get(edge.from)!.push(edge.to);
      }
    }
    for (const edge of condEdges) {
      if (!successors.has(edge?.from)) continue;
      for (const rule of Array.isArray(edge.rules) ? edge.rules : []) {
        for (const target of Array.isArray(rule?.to) ? rule.to : [rule?.to]) {
          if (typeof target === "string" && (names.has(target) || target === END)) {
            successors.get(edge.from)!.push(target);
          }
        }
      }
      if (typeof edge.fallback === "string") successors.get(edge.from)!.push(edge.fallback);
    }
    const seen = new Set<string>([spec.entryPoint]);
    const queue = [spec.entryPoint];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of successors.get(current) ?? []) {
        if (next !== END && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const name of names) {
      if (!seen.has(name)) warnings.push(`节点 "${name}" 从入口不可达。`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Studio 内置示例（与 smoke §5 工作流语义一致的 JSON 版 + 并行/子代理演示）。 */
export interface StudioExample {
  id: string;
  name: string;
  spec: StudioGraphSpec;
}

export const studioExamples: StudioExample[] = [
  {
    id: "codegen-loop",
    name: "代码生成质量门（回环）",
    spec: {
      entryPoint: "generate_code",
      maxIterations: 25,
      initialState: { rev: 1 },
      nodes: [
        {
          name: "generate_code",
          kind: "patch",
          label: "生成代码",
          patch: { rev: { $inc: 1 }, code: "fn_draft" },
        },
        {
          name: "static_analyze",
          kind: "patch",
          label: "静态检查",
          patch: { lintOk: { $test: { field: "rev", op: "gte", value: 2 } } },
        },
        {
          name: "run_unit_test",
          kind: "patch",
          label: "单元测试",
          patch: { testOk: { $test: { field: "rev", op: "gte", value: 3 } } },
        },
      ],
      edges: [
        { from: "generate_code", to: "static_analyze" },
        { from: "static_analyze", to: "run_unit_test" },
      ],
      conditionalEdges: [
        {
          from: "static_analyze",
          rules: [{ field: "lintOk", op: "eq", value: true, to: "run_unit_test" }],
          fallback: "generate_code",
        },
        {
          from: "run_unit_test",
          rules: [{ field: "testOk", op: "eq", value: true, to: END }],
          fallback: "generate_code",
        },
      ],
    },
  },
  {
    id: "fan-out-join",
    name: "并行展开汇聚（Fan-out）",
    spec: {
      entryPoint: "split",
      maxIterations: 25,
      initialState: {},
      nodes: [
        { name: "split", kind: "patch", label: "拆分任务", patch: { started: true } },
        { name: "part_a", kind: "patch", label: "分支 A", patch: { partA: "A 完成" } },
        { name: "part_b", kind: "patch", label: "分支 B", patch: { partB: "B 完成" } },
        { name: "join", kind: "patch", label: "汇聚", patch: { joined: true } },
      ],
      edges: [
        { from: "part_a", to: "join" },
        { from: "part_b", to: "join" },
      ],
      conditionalEdges: [
        { from: "split", rules: [{ to: ["part_a", "part_b"] }] },
      ],
    },
  },
  {
    id: "host-subagent",
    name: "子代理委托（仅宿主）",
    spec: {
      entryPoint: "research",
      maxIterations: 25,
      initialState: { task: "调研 dsh 插件机制" },
      nodes: [
        {
          name: "research",
          kind: "subagent",
          label: "调研子代理",
          prompt:
            "完成任务：{{state}}，返回 JSON：{ \"result\": { \"summary\": \"…\" } }",
          resultKey: "result",
        },
        { name: "report", kind: "patch", label: "生成报告", patch: { reported: true } },
      ],
      edges: [{ from: "research", to: "report" }],
      conditionalEdges: [],
    },
  },
];
