# CodeGrunt — 开发者指南

> 如何从源码构建、测试和贡献 CodeGrunt。

---

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [构建系统](#构建系统)
- [开发工作流](#开发工作流)
- [测试](#测试)
- [架构概览](#架构概览)
- [添加新的 LLM 提供商](#添加新的-llm-提供商)
- [添加新工具](#添加新工具)
- [配置系统](#配置系统)
- [钩子系统](#钩子系统)
- [发布流程](#发布流程)
- [常见问题排查](#常见问题排查)

---

## 环境要求

| 依赖 | 最低版本 |
|---|---|
| [Node.js](https://nodejs.org/) | 18.x（推荐 LTS） |
| [npm](https://www.npmjs.com/) | 9.x（Node 18+ 自带） |
| [Git](https://git-scm.com/) | 2.x |
| [TypeScript](https://www.typescriptlang.org/) | 5.5+（通过 npm install 安装） |

可选但推荐：

- [pnpm](https://pnpm.io/) — 比 npm 更快的包管理器
- [tsx](https://tsx.is/) — 用于开发热重载（已包含在 devDependencies 中）

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/codegrunt.git
cd codegrunt
```

### 2. 安装依赖

```bash
npm install
```

安装 package.json 中定义的所有运行时和开发依赖。

### 3. 构建项目

```bash
npm run build
```

将 TypeScript 从 src/ 编译为 JavaScript 到 dist/。输出用于 npm start 命令和发布的 npm 包。

### 4. 验证构建

```bash
npm start -- --help
```

你应该能看到 CLI 帮助输出。如果看到 Error: No API key configured，这是正常的——你需要设置 API 密钥才能使用工具，但构建本身已成功。

### 5. （可选）全局链接

```bash
npm link
```

现在你可以在终端中任何位置运行 codegrunt。

---

## 项目结构

```
codegrunt/
├── src/
│   ├── cli/                  # CLI 入口、REPL、参数解析
│   │   ├── index.ts          # 入口（commander 驱动的 CLI）
│   │   ├── repl.ts           # 交互式 REPL 循环
│   │   ├── input.ts          # 多行输入、Tab 补全、列表选择器
│   │   ├── commands.ts       # 斜杠命令（/help, /model, /init 等）
│   │   ├── branch-commands.ts # /branch, /tree, /switch, /subagent-cache 处理
│   │   ├── setup.ts          # 首次运行设置向导
│   │   ├── init.ts           # /init 命令实现：代码库分析 + CODEGRUNT.md 生成
│   │   ├── skills.ts         # 技能加载和管理（含 zip 安装）
│   │   ├── update.ts         # 版本检查和升级
│   │   ├── banner.ts         # ASCII 艺术横幅
│   │   ├── at-resolver.ts    # @文件/@URL 引用展开
│   │   └── ink/              # Ink/React 常驻终端 UI
│   │       ├── App.tsx           # 常驻 REPL 树（历史 + 实时区 + 状态栏 + 输入）
│   │       ├── PromptInput.tsx   # 主输入组件（光标、历史、补全、忙碌态）
│   │       ├── StatusBar.tsx     # 状态栏（模型 · Git 分支 · Token / 忙碌倒计时）
│   │       ├── Dropdown.tsx      # 自动补全下拉菜单
│   │       ├── ListPicker.tsx    # 方向键列表选择器
│   │       ├── output-channel.ts # 输出路由（sink/实时区）+ picker 注册表
│   │       ├── useAutocomplete.ts # 文件/命令/Skill 补全逻辑
│   │       ├── useHistory.ts     # 持久化历史记录
│   │       ├── git-branch.ts     # 当前 Git 分支获取
│   │       ├── paste.ts          # 括号粘贴状态机
│   │       └── types.ts          # Ink 组件类型定义
│   ├── core/
│   │   ├── agent/
│   │   │   ├── loop.ts       # 代理循环 — P/G/E 编排入口
│   │   │   ├── intentor.ts   # 意图分类器（编码 vs 聊天 + Skill 匹配）
│   │   │   ├── planner.ts    # 任务规划器（分解为多步骤计划）
│   │   │   ├── generator.ts  # 共享生成器（4 阶段管道 runner）
│   │   │   ├── evaluator.ts  # 质量评估器（输出检查 + 自动修正）
│   │   │   ├── chat-flow.ts  # 聊天流程（跳过 Planner/Evaluator）
│   │   │   ├── coding-flow.ts # 编码流程（P/G/E）
│   │   │   ├── skill-flow.ts # Skill 流程（inline / subagent）
│   │   │   ├── complexity.ts # 请求分类器 + 思考模式路由器
│   │   │   ├── r1-harvester.ts # R1 思考内容工具调用回收
│   │   │   ├── subagent.ts   # 只读子代理执行引擎（同步 + 并发）
│   │   │   └── subagent-cache.ts # 子代理结果缓存
│   │   ├── pipeline/         # Harness 风格管道引擎（4 阶段）
│   │   │   ├── engine.ts     # PipelineEngine：阶段执行器 + Builder
│   │   │   ├── types.ts      # 管道上下文、阶段接口、P/G/E 类型定义
│   │   │   └── stages/
│   │   │       ├── prepare-context.ts   # 构建系统提示 + 注入项目指南
│   │   │       ├── stream-response.ts   # 流式 LLM 调用 + Token 累积
│   │   │       ├── process-tools.ts     # 工具调用解析 + 执行 + 结果注入
│   │   │       ├── process-tools-helpers.ts  # 工具执行辅助（确认流/信任模式/权限/参数修复）
│   │   │       └── post-process.ts      # 后处理：盲写警告、Token 统计、R1 回收
│   │   ├── tools/
│   │   │   ├── registry.ts   # 插件式 ToolRegistry（运行时注册/移除）
│   │   │   ├── read_file.ts / write_file.ts / edit_file.ts
│   │   │   ├── execute_shell.ts / list_directory.ts / search_files.ts
│   │   │   ├── memory.ts     # memory_write / memory_read 工具
│   │   │   ├── web_search.ts # Web 搜索工具
│   │   │   ├── code_search.ts # 代码符号搜索工具
│   │   │   └── agent_open.ts # 子代理委派工具
│   │   ├── context/
│   │   │   ├── manager.ts    # 追加式上下文窗口管理（Token 预算、软裁剪）
│   │   │   ├── compact.ts    # 分层块式对话压缩
│   │   │   └── project-guide.ts  # 加载 CODEGRUNT.md / CLAUDE.md 项目指南
│   │   ├── memory/
│   │   │   ├── store.ts      # 持久化记忆存储（JSONL 文件）
│   │   │   └── habits.ts     # 用户行为习惯学习
│   │   ├── index/
│   │   │   ├── index.ts      # 代码符号索引构建和搜索
│   │   │   └── embedder.ts   # TF-IDF 语义向量索引（--semantic）
│   │   ├── permissions/
│   │   │   └── index.ts      # Workspace 级别工具权限覆盖
│   │   ├── snapshot/
│   │   │   └── index.ts      # Side-git 自动快照
│   │   ├── hooks/
│   │   │   └── registry.ts   # 用户自定义钩子脚本系统
│   │   ├── lsp/
│   │   │   └── checker.ts    # 语言诊断（TS/Python/Go/Rust/ESLint）
│   │   ├── mcp/
│   │   │   ├── config.ts     # MCP 服务器配置持久化
│   │   │   ├── manager.ts    # MCP 客户端连接管理
│   │   │   ├── registry.ts   # MCP Registry 搜索
│   │   │   └── types.ts      # MCP 类型定义
│   │   ├── session/
│   │   │   ├── store.ts      # 会话状态持久化（conv-sessions）
│   │   │   └── branching.ts  # 会话分支（fork/switch/tree）
│   │   ├── swebench/
│   │   │   └── export.ts     # SWE-bench 预测导出
│   │   ├── events/
│   │   │   └── bus.ts        # 类型化 EventBus
│   │   ├── observability/
│   │   │   ├── logger.ts     # Logger v2：文件传输 + Trace ID + 日志轮转
│   │   │   ├── metrics.ts    # 轻量 Metrics（计数器、计时器、快照）
│   │   │   └── crash-report.ts # 本地崩溃报告（opt-in）
│   │   └── usage.ts          # 会话/单次调用 Token 用量追踪
│   ├── providers/
│   │   └── deepseek/
│   │       ├── provider.ts   # DeepSeek LLM 提供商实现（含指数退避重试）
│   │       └── client.ts     # OpenAI 兼容客户端工厂 + API Key 验证
│   ├── utils/
│   │   ├── display.ts / confirm.ts / billing.ts / markdown.ts
│   │   ├── interrupt.ts / select.ts / locale.ts / constants.ts
│   │   ├── danger.ts / diff-renderer.ts / line-endings.ts
│   │   ├── pager.ts / tool-spinner.ts
│   ├── config.ts             # 配置加载（环境变量、配置文件）
│   └── types.ts              # 共享 TypeScript 类型和接口
├── tests/                    # 镜像 src/ 结构（Vitest）
│   ├── tools/  agent/  context/  core/  cli/  pipeline/
│   ├── integration/pipeline-e2e.test.ts
│   ├── providers/deepseek-retry.test.ts
│   └── manual/input-test.ts
├── docs/                     # 文档
├── dist/                     # 编译输出（gitignore）
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CODEGRUNT.md               # CodeGrunt 项目指南
├── CLAUDE.md                 # AI 编码助手项目指南
└── README.md
```

---

## 构建系统

### 编译

CodeGrunt 使用标准 TypeScript 编译器（tsc）进行生产构建。

```bash
npm run build          # 编译 src/ → dist/
npm run typecheck      # 仅类型检查，不输出文件
```

tsconfig.json 配置要点：

- target: ES2022 — 现代 JS 输出
- module: ESNext — ESM 模块系统
- moduleResolution: bundler — 兼容 tsx 和 tsc
- strict: true — 完整严格模式
- declaration: true — 生成 .d.ts 文件
- sourceMap: true — 调试源码映射
- jsx: react-jsx — 为 React/Ink 组件提供 JSX 支持（jsxImportSource: react）

关键点：

- **仅 ESM**：项目在 package.json 中使用 "type": "module"。所有导入使用 .js 扩展名约定（例如 import { foo } from './bar.js'）。
- **bundler 解析**：兼容 tsx（开发）和 tsc（生产）。
- **declaration: true**：为使用者生成 .d.ts 类型声明文件。
- **JSX for Ink**：`src/cli/ink/` 目录包含通过 `ink` 库在终端渲染的 React 组件。TSX 文件使用 `react-jsx` 转换。

### 开发 vs 生产

| 模式 | 命令 | 运行方式 |
|---|---|---|
| 开发 | npm run dev | tsx watch src/cli/index.ts — 文件变更时热重载 |
| 生产 | npm run build 然后 npm start | 运行编译后的 dist/cli/index.js |
| 单次任务（开发） | npx tsx src/cli/index.ts "任务" | 直接执行，无需 watch |

### 模块系统

项目仅使用 ES Modules (ESM)：

- package.json 包含 "type": "module"
- 所有导入使用 import/export 语法
- 导入中的文件扩展名使用 .js（TypeScript 的 ESM 约定）
- 动态导入使用 import() 语法

---

## 开发工作流

### 交互式开发

最快的方式是使用 watch 模式：

```bash
npm run dev
```

这会以 tsx watch 启动 REPL，当你保存 src/ 中任何文件的更改时自动重启。无需手动重新编译。

### 单次任务

快速测试特定功能：

```bash
npx tsx src/cli/index.ts "列出当前目录的文件"
```

### 类型检查

单独运行类型检查以捕获类型错误，无需编译：

```bash
npm run typecheck
```

---

## 测试

### 运行测试

```bash
npm test                          # 运行所有测试
npx vitest run                    # 同上
npx vitest                        # 监视模式
```

### 运行单个测试文件

```bash
npx vitest run tests/tools/read_file.test.ts
npx vitest run tests/tools/write_file.test.ts
npx vitest run tests/tools/execute_shell.test.ts
npx vitest run tests/tools/edit_file.test.ts
npx vitest run tests/agent/intentor_planner.test.ts
npx vitest run tests/agent/subagent.test.ts
npx vitest run tests/context/context_manager.test.ts
npx vitest run tests/pipeline/engine.test.ts
npx vitest run tests/integration/pipeline-e2e.test.ts
npx vitest run tests/core/process-tools-helpers.test.ts
npx vitest run tests/cli/PromptInput.test.tsx
```

### 详细输出

```bash
npx vitest --reporter=verbose
```

### 测试结构

测试位于 tests/ 目录，镜像 src/ 的结构。测试框架是 Vitest，在 vitest.config.ts 中配置。

```
tests/
├── tools/          # read_file / write_file / edit_file / execute_shell
├── agent/          # intentor_planner / subagent / r1-harvester / complexity / generator / loop-autocompact
├── context/        # context_manager
├── core/           # permissions / branching / subagent-cache / swebench / mcp / index / embedder / billing / crash-report / errors
├── cli/            # App / PromptInput / ListPicker / StatusBar / output-channel / paste / git-branch / useAutocomplete / useHistory（Ink 组件测试）
├── pipeline/       # engine / process-tools-helpers
├── integration/    # pipeline-e2e（真实 4 阶段串接）
├── providers/      # deepseek-retry
├── utils/          # constants / danger / interrupt / line-endings / markdown / pager / select / tool-spinner / plan-display
└── manual/         # input-test（手动输入测试）
```

关键特性：

- **不需要 API 密钥**：工具层单元测试在本地文件系统和 shell 上操作，不针对任何 LLM。
- **隔离的文件系统**：测试使用临时目录以避免副作用。
- **异步测试**：大多数工具测试是异步的，因为它们涉及 I/O 操作。
- **Ink 组件测试**：使用 `ink-testing-library` 渲染真实组件（`render`），例如 `tests/cli/PromptInput.test.tsx`。

### 编写测试

测试结构示例：

```typescript
import { describe, it, expect } from 'vitest';
import { readFileTool } from '../../src/core/tools/read_file.js';

describe('read_file', () => {
  it('读取已存在的文件', async () => {
    const result = await readFileTool.execute({ path: 'package.json' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"name": "codegrunt"');
  });

  it('不存在的文件返回错误', async () => {
    const result = await readFileTool.execute({ path: 'nonexistent.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read');
  });
});
```

---

## 架构概览

### 高层流程

```
用户输入 (CLI / REPL)
       │
       ▼
  ┌──────────────┐
  │   Intentor   │  意图分类：Skill 匹配 / 编码 / 聊天
  └──────┬───────┘
         │
    ┌────▼─────────────────────────────────────┐
    │  Planner → Generator → Evaluator          │
    │   规划        执行       质量评估           │
    │        (评估不通过自动修正重试，最多 3 次)    │
    └──────────────────────────────────────────┘
         │
    ┌────▼──────────┐
    │  管道引擎       │  4 个阶段：准备→流式→工具→后处理
    │  (Pipeline)    │
    └───────────────┘
         │
    ┌────▼────┐
    │  工具    │  11 个内置工具 + MCP 扩展
    │ (11+)   │
    └─────────┘
         │
    ┌────▼──────────────┐
    │  习惯/记忆         │  自动学习用户偏好并持久化
    │  快照/诊断         │  安全网：自动快照 + 编辑后诊断
    └───────────────────┘
```

### 代理循环（src/core/agent/loop.ts）

代理循环是 CodeGrunt 的核心，采用 **P/G/E（Planner / Generator / Evaluator）+ Intentor** 架构：

**Phase 0 — Intentor（意图分类）**：将任务分为三条路径（实现分散在 `chat-flow.ts` / `coding-flow.ts` / `skill-flow.ts`）：
- **Skill 匹配** → `runSkillFlow`（`skill-flow.ts`）：应用 Skill 系统提示 + 内容，支持子代理模式（只读执行）
- **编码任务** → `runCodingFlow`（`coding-flow.ts`）：P/G/E 管道：规划 → 执行 → 评估 → 修正
- **聊天任务** → `runChatFlow`（`chat-flow.ts`）：直接生成管道，跳过 Planner/Evaluator

Intentor 优先使用快速启发式规则：
- **关键词模式**：编码信号（写/创建/修复/重构）vs 非编码（解释/什么是/总结）
- **Continuation 检测**：短命令式短语如「继续」「go on」「next」默认走编码路径
- **Skill 匹配**：任务与 Skill 名称/描述的关键词重叠（≥40% 匹配度）

仅在启发式规则不明确时才调用 LLM，节省延迟和费用。

**编码流程 — P/G/E 管道**：
1. **Planner（规划器）**：将复杂任务分解为 2-5 个独立可验证的步骤，使用低温（0.1）结构化 JSON 输出。向提示中注入真实工具列表，过滤无效的 `toolsHint` 值。短任务（≤50 字符）和 continuation 信号跳过 Planner
2. **Generator（生成器）**：管道引擎依次执行每个步骤 → 准备上下文 → 流式 LLM 调用 → 工具执行 → 后处理。现支持**步骤内多轮迭代**——单个步骤内可进行多次工具调用往返
3. **Evaluator（评估器）**：检查输出质量 / 计划符合度 / 幻觉（覆盖 14 种错误模式）。不通过则注入反馈并重试（最多 3 次）。3 次失败后提示用户是否继续。`pruneRefineMessages()` 在步骤间清理评估反馈消息。编辑后自动运行 `tsc --noEmit`（TypeScript 项目）
4. `sessionHasRead` 追踪跨步骤的文件读取，避免重复操作

**聊天流程**：跳过 Planner/Evaluator，直接用 Generator 管道迭代到模型停止（最多 30 次）。模型返回空时显示回退文本。

**Skill 流程**：应用 Skill 系统提示 + 内容，然后按聊天模式进行工具调用迭代。支持子代理模式（`mode: 'subagent'`），在隔离的只读上下文中执行。

关键设计决策：

- **系统提示稳定性**：系统提示只构建一次，会话期间不更改。最大化 DeepSeek 提示缓存命中率。R1 推理模型的系统提示嵌入在首条用户消息中
- **管道架构**：借鉴 Harness CI/CD，5 个独立可测试阶段共享 `PipelineContext`
- **EventBus**：所有生命周期事件（管道启动/完成、工具调用、LLM 用量）通过类型化 EventBus 发布
- **流式优先**：所有 LLM 通信通过 `AsyncIterable<StreamChunk>` 流式传输，实时终端输出
- **子代理**：`agent_open` 工具委派只读研究任务，限制使用非破坏性工具集
- **模型分支**：`isReasonerModel()` 检测 R1 变体；`supportsReasoning()` 匹配支持 `reasoning_content` 的模型。`reasoning_content` 仅对最后一条助手消息发送以减少 Token 消耗
- **模型自动路由**（`selectModelForTask`）：仅对 `deepseek-v4-*` 模型生效。非编码/Skill 任务、简单或 ≤60 字符的任务路由到 `deepseek-v4-flash`；复杂编码信号路由到 `deepseek-v4-pro`；永远不会路由到推理模型
- **思考模式路由器**（`complexity.ts` 的 `classifyComplexity()`）：返回 `simple | medium | complex` 三档。编码任务：simple 强制 `thinking: 'disabled'`；complex 在 `config.autoThinkingMode`（默认 true）时强制 `thinking: 'enabled'`；medium 不干预

### 工具系统

工具是 LLM 与用户环境交互的机制。每个工具实现 `Tool` 接口，通过插件式 `ToolRegistry` 注册（支持运行时动态添加/移除）。

11 个内置工具：

| 工具 | 描述 | 破坏性？ |
|---|---|---|
| `read_file` | 读取文件内容（支持行范围，100KB 限制） | 否 |
| `write_file` | 写入内容到文件（自动创建目录） | **是** |
| `edit_file` | 替换文件中的精确字符串 | **是** |
| `execute_shell` | 运行 shell 命令（带超时，最长 5 分钟） | **是** |
| `list_directory` | 列出目录树（默认 500 条，最多 2000 条） | 否 |
| `search_files` | 在文件中搜索文本模式（支持正则和隐藏文件） | 否 |
| `memory_write` | 写入持久化记忆条目 | 否 |
| `memory_read` | 读取持久化记忆条目 | 否 |
| `web_search` | Web 搜索（Mojeek/SearXNG/DuckDuckGo） | 否 |
| `code_search` | 代码符号搜索（需先运行 `/index`） | 否 |
| `agent_open` | 委派研究任务给只读子代理 | 否 |

**安全性**：在破坏性操作（write_file、edit_file、execute_shell）之前，执行器会显示 diff 预览并请求用户确认，提供三个选项：是、本次会话全部允许、否。Workspace 级别权限文件（`.codegrunt/permissions.json`）可覆盖每个工具的行为（allow/deny/ask），选择器在 `process-tools-helpers.ts` 中管理。

### 管道引擎（src/core/pipeline/）

借鉴 Harness CI/CD 管道架构，将每次 Agent 交互分解为 **4 个独立阶段**（在 `src/core/agent/generator.ts` 中串接），所有阶段共享一个 `PipelineContext`：

| 阶段 | 文件 | 职责 |
|---|---|---|
| PrepareContext | `prepare-context.ts` | 构建系统提示、注入项目指南、初始化消息 |
| StreamResponse | `stream-response.ts` | 流式调用 LLM、累积文本/推理/工具调用；转发真实缓存命中/未命中 Token 数 |
| ProcessToolCalls | `process-tools.ts` | 解析工具调用、通过 executor 执行、注入结果 |
| PostProcess | `post-process.ts` | 盲写警告检测、Token 统计、最终输出格式化、R1 思考内容工具调用回收 |

> `process-tools-helpers.ts` **不是**一个独立阶段，而是辅助模块：实现 `executeToolCall()`（破坏性工具确认流、`/trust` 信任模式、workspace 权限检查、`repairToolArgs()` schema 感知参数修复）。

所有阶段共享一个 `PipelineContext`，由 `PipelineEngine` 按序执行。

### 上下文管理（src/core/context/manager.ts）

ContextManager 维护对话历史（**追加式、缓存优先**）：

- **Token 估算**：使用简单的 4:1 字符与 Token 比率。
- **裁剪**：`checkCapacity()` 不再主动从前面裁剪消息；仅设置 `needsCompact`/`nearCapacity` 标志。紧急软裁剪（`softTrimFromEnd()`）仅在 Token 数超过 `预算 × 2.0` 时触发，且从消息**末尾**裁剪（保护 DeepSeek 前缀缓存），绝不触碰前缀。
- **预算**：聊天模型默认 90,000 Token（`CHAT_CONTEXT_BUDGET`）；推理模型 100,000 Token（`CONTEXT_BUDGET`）。
- **自动压缩**（`compact.ts` + `loop.ts` 的 `maybeAutoCompact()`）：当 `needsCompact` 被标记（Token 预算达到 70% 或非系统消息超过 40 条）且 `config.autoCompact`（默认 true）时触发。分层块式压缩：每个块 ≤12000 Token、每块摘要 ≤400 Token、合并最终摘要 ≤1500 Token，保留最近的 15 条消息原样不动，使用 `deepseek-v4-flash` 模型。也可通过 `/compact` 手动触发。

### 提供商系统

所有 LLM 后端实现 LLMProvider 接口。`StreamChunk` 联合类型支持：

- `text_delta` — 增量文本输出
- `reasoning_delta` — 思维链推理（显示为 Thinking...）
- `tool_call_delta` — 流式工具调用参数
- `finish` — 流结束，包含结束原因

DeepSeek 提供商实现包括：
- 指数退避重试：429、5xx 或 `ECONNRESET` 错误时最多重试 3 次（延迟 1s → 2s → 4s）
- 流式工具调用参数累积
- Token 用量追踪

### 子代理系统（src/core/agent/subagent.ts）

`agent_open` 工具可将独立研究任务委派给只读子代理：

- **只读工具集**：限制使用 `read_file`、`search_files`、`list_directory`、`code_search`、`web_search`、`memory_read`。无 `write_file`/`edit_file`/`execute_shell` 权限，因此子代理的工具调用永远不会走 `confirmOrSkip` 确认流
- **隔离上下文**：子代理获得全新的 `Message[]` 数组，看不到主代理的对话历史
- **模型降级**：默认降级为 `deepseek-v4-flash`（与 Intentor 分类调用相同策略）；传 `noModelDowngrade: true`（或显式模型）保留调用方配置的模型层级
- **生命周期**：单次调用 `runSubagent()` 阻塞直至子代理生成最终答案或达到 `MAX_SUBAGENT_ITERATIONS`（10 次）。每个子代理有独立的超时（`DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000`），通过内部 `AbortController` 与调用方 signal 合并实现取消
- **并发执行（v0.7）**：`runSubagentsConcurrent()` 通过 `Promise.allSettled` 批量运行多个任务，并发上限 `MAX_CONCURRENT_SUBAGENTS`（10）。默认任一任务失败即抛出聚合错误；传 `allowPartialFailure: true` 得到混合成功/失败的结果
- **结果缓存（subagent-cache.ts）**：按 `{task, model, systemOverride, cwd}` 的 sha256 哈希缓存结果（`useCache: true` 时启用），5 分钟 TTL、100 条上限（按最近访问淘汰）。用 `/subagent-cache [clear]` 管理

### 记忆系统（src/core/memory/）

- **持久化记忆存储**（`store.ts`）：使用 JSONL 文件存储在 `~/.codegrunt/memory/entries.jsonl`。支持写入、读取、删除和按类型过滤（user/feedback/project/reference）。还支持按工作目录存储会话摘要
- **习惯学习**（`habits.ts`）：自动分析用户的语言偏好（中文/英文）、回答详细程度（精简/详细）、工具确认行为（yes-all/谨慎审查）和任务风格偏好（编码/问答）。达到统计阈值后将学习结果持久化为记忆条目，供后续交互参考

### 代码符号索引（src/core/index/index.ts）

通过 `/index` 命令构建轻量级代码符号索引：

- 无需外部依赖，无需嵌入模型
- 使用 `git ls-files` 或目录遍历收集源文件
- 通过 grep 模式提取函数/类/接口/类型/导出
- 支持 TypeScript、JavaScript、Python、Go、Rust
- 索引存储在 `~/.codegrunt/index/<hash>/index.json`
- `code_search` 工具使用该索引进行快速符号查找

### Workspace 权限（src/core/permissions/index.ts）

`.codegrunt/permissions.json` 文件提供工具级别的权限覆盖：

- `allow` — 跳过确认提示
- `deny` — 硬拦截，工具调用直接失败
- `ask` — 始终提示确认（即使在 auto 模式或 yes-for-all 状态下）

### 自动快照（src/core/snapshot/index.ts）

每次编码轮次后自动创建 side-git 快照：

- 使用独立的 git 目录（`.codegrunt/git`），不污染用户 .git 历史
- 快照存储在 "snapshots" 分支上
- 可通过 `/restore` 命令查看和恢复

### 钩子系统（src/core/hooks/registry.ts）

支持用户自定义钩子脚本，放置在 `~/.codegrunt/hooks/`：

- 四个触发点：`user-prompt-submit`、`pre-tool-use`、`post-tool-use`、`stop`
- 支持 Shell 脚本（.sh/.bash）和 JS 脚本（.js/.mjs/.cjs）
- 脚本接收 JSON 事件输入，返回 `continue`/`block`/`modify` 响应
- 超时（10 秒）或非零退出视为 `continue`，不会导致 Agent 崩溃

### 语言诊断（src/core/lsp/checker.ts）

文件编辑后自动运行项目语言诊断：

- TypeScript：`tsc --noEmit --skipLibCheck`
- Python：`pyright`（带 pyproject.toml/setup.py 的项目）
- Go：`go vet`（带 go.mod 的项目）
- Rust：`cargo check`（带 Cargo.toml 的项目）
- ESLint：`eslint`（带 ESLint 配置的项目）
- 诊断结果格式化后注入 Agent 上下文

### MCP 集成（src/core/mcp/）

支持 Model Context Protocol 服务器：

- 支持 stdio 和 SSE 传输
- MCP 服务器配置存储在 `~/.codegrunt/mcp.json`
- MCP 工具自动包装为 CodeGrunt 工具并注入 ToolRegistry

### 可观测性

- **Logger v2**（`observability/logger.ts`）：结构化分级日志，支持命名空间。功能包括：
  - **文件传输**：结构化 JSONL 日志写入 `~/.codegrunt/logs/`
  - **Trace ID**：唯一 `runId` 用于跨会话关联。通过 `createLogger('namespace', runId)` 创建
  - **日志轮转**：保留最近 5 个日志文件，每个最大 5 MB
  - **环境变量控制**：`CODEGRUNT_LOG_LEVEL`（debug/info/warn/error）、`CODEGRUNT_LOG_FILE`（设为 0/false 禁用）、`CODEGRUNT_VERBOSE`
  - 错误自动发布到 EventBus
- **Metrics**（`observability/metrics.ts`）：计数器/计时器/快照，支持遥测摘要输出（`CODEGRUNT_TELEMETRY=1`）
- **Crash 报告**（`observability/crash-report.ts`）：opt-in（`crashReportOnError` / `CODEGRUNT_CRASH_REPORT`）本地 JSON 崩溃报告，写入 `~/.codegrunt/crash-reports/`，绝不包含消息历史或文件内容，仅含截断的任务文本与错误元数据
- **EventBus**（`events/bus.ts`）：类型化事件总线，事件类型：`pipeline:started` / `pipeline:finished` / `stage:started` / `stage:finished` / `tool:called` / `tool:result` / `llm:request` / `llm:usage` / `error`
- **Usage 追踪**（`usage.ts`）：共享 Token 用量模块（`addUsage`、`getSessionUsage`、`getLastCallUsage`），从 `loop.ts` 提取以避免循环依赖

### Ink/React 终端 UI（`src/cli/ink/`）

CodeGrunt 提供基于 React 的现代终端 UI，使用 `ink` 库构建。REPL 会话期间挂载一个**常驻 React 树**（`App.tsx`），`output-channel.ts` 作为输出路由层：未注册 sink（单次任务模式）时直接写 `process.stdout`，注册 sink（REPL）后路由进 Ink 状态，由 reconciler 持有终端实时区域。

| 组件 | 描述 |
|---|---|
| `App.tsx` | 常驻 REPL 树：`<Static>` 历史 + 实时工具行 + 流式文本 + `<StatusBar>` + `<PromptInput>`/`<ListPicker>`；返回 `AppHandle`（`promptForInput`/`setBusy`/`onCancelBusy`/`setTotalTokens`） |
| `PromptInput.tsx` | 主输入组件：光标移动、上下键历史导航、自动补全下拉、忙碌态（置灰/禁止编辑）、Ctrl+C 双击取消、括号粘贴 |
| `StatusBar.tsx` | 状态栏：左侧 `模型 · ⎇ Git分支 · Nk tokens`，忙碌时右侧 `{elapsed}s · Esc to cancel` |
| `Dropdown.tsx` | 自动补全浮层：`❯` 指示器、skill/builtin/file 分类着色、最多 8 项可见 |
| `ListPicker.tsx` | 方向键选择器，用于模型/配置/信任模式的交互式选择（App 挂载时在树内渲染） |
| `output-channel.ts` | 输出路由（`write`/`appendLiveText`/`setLiveTextDirect`/`commitLiveText`/`setLiveTool`）+ picker 注册表 |
| `useAutocomplete.ts` | 文件路径（`@`）补全、斜杠命令补全、Skill 名称补全 |
| `useHistory.ts` | 持久化命令历史，方向键导航 |
| `git-branch.ts` | 获取并缓存当前 Git 分支（供状态栏显示） |
| `paste.ts` | 括号粘贴状态机（多行粘贴不再被误读为回车） |

---

## 添加新的 LLM 提供商

### 步骤 1：创建提供商目录

```bash
mkdir -p src/providers/myprovider
```

### 步骤 2：实现提供商

```typescript
// src/providers/myprovider/provider.ts
import type { LLMProvider, Message, RequestOptions, StreamChunk } from '../../types.js';

export class MyProvider implements LLMProvider {
  readonly id = 'my-provider';

  async *stream(messages: Message[], options: RequestOptions): AsyncIterable<StreamChunk> {
    for await (const chunk of yourApiCall(messages, options)) {
      if (chunk.type === 'text') {
        yield { type: 'text_delta', text: chunk.content };
      }
    }
    yield { type: 'finish', finish_reason: 'stop' };
  }
}
```

### 步骤 3：注册提供商

在 src/cli/index.ts 中：

```typescript
import { MyProvider } from './providers/myprovider/provider.js';
const provider = new MyProvider(config);
```

### 步骤 4：添加配置支持

更新 src/config.ts 以支持你的提供商的配置。

### 提供商契约

你的提供商必须：

1. 接受 OpenAI 兼容格式的 Message[]
2. 返回 AsyncIterable<StreamChunk>
3. 支持 AbortSignal 用于取消
4. 处理工具定义（通过 options.tools 传递）
5. 尊重 options.model、options.maxTokens、options.temperature

---

## 添加新工具

### 步骤 1：创建工具文件

```typescript
// src/core/tools/my_tool.ts
import type { Tool, ToolResult } from '../../types.js';

export const myTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'my_tool',
      description: '这个工具做什么',
      parameters: {
        type: 'object',
        properties: {
          param1: { type: 'string', description: 'param1 的描述' },
        },
        required: ['param1'],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return { success: true, output: '结果字符串' };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
```

### 步骤 2：注册工具

在 `src/core/tools/registry.ts` 的 `registerBuiltins()` 方法中添加：

```typescript
import { myTool } from './my_tool.js';
// 在 builtins 数组中添加 myTool
```

### 步骤 3：添加安全确认（如果是破坏性操作）

破坏性工具需要实现 diff 预览和确认流程。确认逻辑在 `process-tools-helpers.ts` 中（`executeToolCall` 函数）。确认后将结果注入消息历史。

### 步骤 4：编写测试

```typescript
// tests/tools/my_tool.test.ts
import { describe, it, expect } from 'vitest';
import { myTool } from '../../src/core/tools/my_tool.js';

describe('my_tool', () => {
  it('正确工作', async () => {
    const result = await myTool.execute({ param1: 'test' });
    expect(result.success).toBe(true);
  });
});
```

---

## 斜杠命令

CodeGrunt 在交互式 REPL 中提供了一组斜杠命令，实现在 `src/cli/commands.ts` 中。

| 命令 | 描述 |
|---|---|
| `/help` | 显示可用命令和当前配置 |
| `/model <名称>` | 切换活跃的 LLM 模型（无参数时交互式选择） |
| `/init` | 分析代码库并生成 CODEGRUNT.md 项目指南 |
| `/index` | 构建代码符号索引，加速 code_search 工具（`--semantic` 启用向量语义搜索） |
| `/clear` | 清除对话历史 |
| `/compact` | 总结并压缩对话历史以节省 Token（分层块式压缩） |
| `/review` | 审查会话变更中的逻辑问题 |
| `/cost` | 显示当前会话的 Token 使用量和预估费用（含缓存命中/未命中统计） |
| `/cache` | 显示 DeepSeek 前缀缓存命中率与预估节省 |
| `/cost-report` | 显示今日 / 本月聚合费用报告 |
| `/balance` | 显示账户余额和用量（今日 / 本月） |
| `/config` | 显示或更改配置设置 |
| `/reasoning` / `/effort` | 设置 R1 模型的推理强度（low/medium/high） |
| `/theme` | 切换终端主题（dark / light） |
| `/token` / `/apikey` | 设置或更换 DeepSeek API 密钥 |
| `/trust` | 设置信任模式：plan（只读）/ code（确认）/ auto（全部允许） |
| `/status` | 显示会话状态、信任模式、缓存命中率和上下文大小 |
| `/resume [id]` | 恢复之前的会话（可交互选择） |
| `/sessions [delete <id>]` | 列出和管理已保存的会话 |
| `/memory [delete <id>]` | 显示持久化记忆条目和上次会话摘要 |
| `/hooks` | 列出已加载的钩子脚本 |
| `/skills` | 列出和管理技能（创建、列表、安装） |
| `/search-engine` | 切换 Web 搜索用的搜索引擎 |
| `/baseurl [url]` | 设置自定义 DeepSeek API Base URL |
| `/restore` | 从自动快照恢复工作状态 |
| `/swebench <instance-id>` | 将会话 diff 导出为 SWE-bench 预测（JSONL） |
| `/permissions` | 查看或设置每个工具的 workspace 权限（allow/deny/ask） |
| `/mcp` | 管理 MCP 服务器：list \| add \| remove \| search |
| `/branch <turn>` | 从历史轮次创建会话分支 |
| `/tree` | 可视化会话分支树 |
| `/switch <branch-id>` | 切换到另一个会话分支 |
| `/subagent-cache [clear]` | 显示或清空子代理结果缓存 |

---

## @-引用语法

CodeGrunt 在 REPL 和单次任务模式中支持 `@`-引用，实现在 `src/cli/at-resolver.ts`。这让你可以直接在提示中引用文件和 URL。

### 文件引用

```bash
# 引用文件——文件内容会被内联到提示中
codegrunt "解释 @src/core/agent/loop.ts"

# 引用多个文件
codegrunt "比较 @src/config.ts 和 @src/types.ts"
```

### URL 引用

```bash
# 引用 URL——内容会被获取并内联
codegrunt "总结 @https://example.com/docs/api"
```

### 工作原理

当输入包含 `@<路径>` 或 `@<URL>` 时，`at-resolver.ts` 模块会：

1. 检测输入字符串中的 `@` 标记
2. 对于文件路径：读取文件内容，用文件名前缀 + 文件内容替换 `@路径`
3. 对于 URL：获取 URL 内容并内联
4. 展开后的内容作为用户消息的一部分发送给 LLM

目录扫描跳过 `node_modules`、`.git`、`dist`、`.next`、`__pycache__`、`.cache`。

---

## 首次运行设置向导

当首次启动 CodeGrunt 且未配置 API 密钥时，会运行设置向导（`src/cli/setup.ts`）。

### 功能

1. **检测缺少配置** — 检查是否设置了 `DEEPSEEK_API_KEY` 或存在 `~/.codegrunt/config.json`
2. **提示输入 API 密钥** — 要求用户输入 DeepSeek API 密钥
3. **模型选择** — 让用户从可用的 DeepSeek 模型中选择
4. **保存配置** — 写入 `~/.codegrunt/config.json`
5. **验证密钥** — 进行测试 API 调用以确认密钥有效

### 跳过向导

可以通过预先配置来跳过向导：

```bash
export DEEPSEEK_API_KEY=sk-xxxxxxxx
# 或手动创建 ~/.codegrunt/config.json
```

---

## 项目指南系统

CodeGrunt 会自动加载项目根目录中的 `CODEGRUNT.md` 或 `CLAUDE.md` 文件作为项目级指导，实现在 `src/core/context/project-guide.ts`。

### 工作原理

1. 启动时，CodeGrunt 在当前工作目录查找 `CODEGRUNT.md` 或 `CLAUDE.md`
2. 如果找到，文件内容会被前置到系统提示中
3. 这样每个项目都可以为 AI 助手定义自定义指令

### 示例 `CODEGRUNT.md`

```markdown
# CODEGRUNT.md

该文件为 CodeGrunt 在此项目中工作时提供指导。

## 命令
npm run test        # 运行测试
npm run lint        # 运行 linter
npm run build       # 编译

## 约定
- 在 React 中使用函数式组件
- 优先使用命名导出而非默认导出
- 为新功能编写测试
```

### 优先级

如果 `CODEGRUNT.md` 和 `CLAUDE.md` 同时存在，`CODEGRUNT.md` 优先加载。两个文件都支持 Markdown 格式。

---

## 配置系统

CodeGrunt 的配置加载链（优先级从高到低）：

1. 环境变量（如 `CODEGRUNT_MODEL`）
2. `~/.codegrunt/config.json` 配置文件
3. 硬编码默认值（`src/config.ts` 中的 `DEFAULTS`）

### 关键配置项

| 配置项 | 环境变量 | 默认值 |
|---|---|---|
| API Key | `DEEPSEEK_API_KEY` | — |
| 模型 | `CODEGRUNT_MODEL` | `deepseek-v4-pro` |
| 最大 Token | `CODEGRUNT_MAX_TOKENS` | `8192` |
| 温度 | `CODEGRUNT_TEMPERATURE` | `0.2` |
| 推理强度 | `CODEGRUNT_REASONING_EFFORT` | `medium` |
| Top-P | `CODEGRUNT_TOP_P` | `1` |
| 频率惩罚 | `CODEGRUNT_FREQUENCY_PENALTY` | `0` |
| 存在惩罚 | `CODEGRUNT_PRESENCE_PENALTY` | `0` |
| Base URL | `CODEGRUNT_BASE_URL` | `https://api.deepseek.com` |
| 信任模式 | `CODEGRUNT_TRUST_MODE` | `code` |
| 搜索引擎 | `CODEGRUNT_SEARCH_ENGINE` | `mojeek` |
| SearXNG URL | `CODEGRUNT_SEARXNG_URL` | — |
| 自动思考 | `CODEGRUNT_AUTO_THINKING` | `true` |
| 自动压缩 | `CODEGRUNT_AUTO_COMPACT` | `true` |
| 崩溃报告 | `CODEGRUNT_CRASH_REPORT` | `false` |
| 主题 | `CODEGRUNT_THEME` | `dark` |
| 日志级别 | `CODEGRUNT_LOG_LEVEL` | `info` |
| 文件日志 | `CODEGRUNT_LOG_FILE` | 启用 |
| 详细输出 | `CODEGRUNT_VERBOSE` | 禁用 |

### 模型判断逻辑（`src/config.ts`）

- `isReasonerModel(model)`：检测是否为 R1 推理模型（ID 包含 `reasoner` 或 `r1`）
- `supportsReasoning(model)`：检测是否支持 reasoning_content（R1 模型 + V4 Pro 模型）
- 推理模型：使用更大的上下文预算（`CONTEXT_BUDGET = 100_000`），不支持 temperature 参数
- 聊天模型：使用标准预算（`CHAT_CONTEXT_BUDGET = 90_000`），支持全部参数

---

## 钩子系统

### 目录结构

用户钩子脚本放置在 `~/.codegrunt/hooks/` 目录。

### 事件类型

| 事件名 | 触发时机 | 脚本命名 |
|---|---|---|
| `user-prompt-submit` | 用户提交提示后 | `user-prompt-submit.*` |
| `pre-tool-use` | 工具执行前 | `pre-tool-use.*` |
| `post-tool-use` | 工具执行后 | `post-tool-use.*` |
| `stop` | 会话停止时 | `stop.*` |

### 脚本格式

脚本接收 stdin 上的 JSON 事件，必须在 stdout 上返回 JSON 响应：

```json
{ "action": "continue" }
{ "action": "block", "reason": "..." }
{ "action": "modify", "data": { ... } }
```

支持的语言：Shell（.sh, .bash）和 JavaScript（.js, .mjs, .cjs）。

---

## 发布流程

1. 更新 `package.json` 中的版本号
2. 运行 `npm run build` 确保编译通过
3. 运行 `npm test` 确保测试通过
4. 提交变更并打 tag：`git tag v<version>`
5. 发布：`npm publish`

---

## 常见问题排查

| 问题 | 可能原因 | 解决方法 |
|---|---|---|
| `Error: No API key configured` | 未设置 `DEEPSEEK_API_KEY` | 运行 `codegrunt` 启动设置向导，或手动 `export DEEPSEEK_API_KEY=sk-...` |
| 构建失败 | Node.js 版本过低 | 确保使用 Node.js 18+ |
| 类型错误 | `node_modules` 过期 | 运行 `npm install` 重新安装依赖 |
| `MODULE_NOT_FOUND` | 导入路径缺少 `.js` 扩展名 | ESM 要求导入使用 `.js` 后缀（TypeScript 约定） |
| 工具调用无响应 | API 配额耗尽 | 检查 `/balance` 命令输出 |
| `src/cli/ink/` 中 JSX 编译错误 | 缺少 React 类型 | 运行 `npm install` 确保安装了 `@types/react` |
