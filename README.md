# CodeGrunt <small>（代码民工）</small>

<p align="center">
  <img src="./assets/logo.png" alt="CodeGrunt Logo" width="50%" />
</p>

> **代码民工** — 终端原生的 AI 命令行编程助手，基于 DeepSeek 构建。

[![npm version](https://img.shields.io/npm/v/codegrunt.svg)](https://www.npmjs.com/package/codegrunt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

CodeGrunt 是一个开源的终端原生 AI 编程助手。它能读懂你的代码库、理解上下文，帮助你在命令行中编写、重构、调试和交付代码。

```bash
# 交互式 REPL
codegrunt

# 单次任务
codegrunt "把 auth 模块重构为 async/await"
```

---

## 特性

- **🤖 P/G/E 智能代理** — 使用 Intentor → Planner → Generator → Evaluator 四阶段架构：意图分类（含 Skill 自动匹配 + Continuation 检测）→ 任务分解 → 管道执行（支持步骤内多轮工具调用）→ 质量评估与自动修正（最多 3 次），确保输出质量
- **🧠 子代理系统** — `agent_open` 工具可将独立研究任务委派给只读子代理，避免主上下文被中间工具调用结果污染
- **📂 理解代码库** — 通过 `@` 文件引用、项目指南文件（`CODEGRUNT.md` / `CLAUDE.md`）和代码符号索引（`/index`）理解你的项目结构
- **🔌 DeepSeek 驱动** — 内置支持 DeepSeek Chat、V4 Flash、V4 Pro 和 R1 推理模型，支持根据任务复杂度自动路由模型
- **🛠️ 工具调用** — 11 个内置工具（插件式注册表，支持运行时增删）：文件读写/编辑、Shell 执行、目录列表、代码搜索、Web 搜索、持久化记忆读写、子代理委派，破坏性操作显示 diff 预览并请求用户确认
- **🌐 Web 搜索** — 支持 Mojeek（默认，无需 API Key）、SearXNG（自托管）和 DuckDuckGo 三种搜索引擎
- **⚡ 流式输出** — 实时 Token 流式传输，支持 Markdown 渲染和推理过程可见，终端体验流畅
- **📎 @-引用** — 使用 `@file.ts`、`@src/` 或 `@https://example.com` 将文件内容、目录列表或网页内容直接注入提示词
- **🎯 斜杠命令** — `/init` 自动生成项目指南、`/model` 切换模型、`/compact` 压缩对话历史、`/review` 审查变更、`/skills` 管理技能等
- **🔒 默认安全** — 破坏性操作（写入/编辑/Shell）显示 diff 预览并要求用户确认后执行，支持「本次会话全部允许」和 workspace 级别权限覆盖
- **🔧 技能系统** — 从 `.zip` 文件安装可复用的提示词模板，Intentor 自动按关键词匹配合适的 Skill，也支持子代理模式（只读执行）
- **🧠 习惯学习** — 自动分析用户的语言偏好、回答详细程度、工具确认行为，并将学习结果持久化到记忆中以优化后续交互
- **📸 自动快照** — 每次编码轮次后自动创建 side-git 快照，可通过 `/restore` 回滚
- **💲 费用追踪** — 使用 `/cost` 和 `/balance` 命令实时查看会话 Token 用量和费用
- **🎨 现代终端 UI** — 基于 Ink/React 的终端输入组件，支持方向键导航、历史记录、自动补全下拉菜单
- **📋 结构化日志** — Logger v2 支持 JSONL 文件日志（`~/.codegrunt/logs/`）、Trace ID 跨会话关联、日志自动轮转（5 文件、每文件 5MB）
- **🔌 钩子系统** — 支持用户自定义钩子脚本（Shell/JS），在提示提交、工具使用前后和停止时触发
- **🔍 语言诊断** — 编辑后自动运行 TypeScript/Python/Go/Rust/ESLint 诊断并反馈结果
- **🖥️ MCP 集成** — 支持 Model Context Protocol 服务器连接，通过 MCP 服务器扩展工具集

---

## 快速开始

```bash
# 全局安装
npm install -g codegrunt

# 设置 API 密钥
export DEEPSEEK_API_KEY=your_key_here

# 启动交互式会话
codegrunt

# 单次任务
codegrunt "解释这个项目的架构"
```

首次运行且未配置 API 密钥时，CodeGrunt 会启动交互式设置向导引导你完成配置。

---

## 安装

**环境要求：** Node.js 18+

### npm（推荐）

```bash
npm install -g codegrunt
```

### pnpm

```bash
pnpm add -g codegrunt
```

### 从源码构建

```bash
git clone https://github.com/your-org/codegrunt.git
cd codegrunt
npm install
npm run build
npm link
```

---

## 使用方法

### 交互式 REPL

```bash
codegrunt
```

启动交互式会话，提供：

- 显示当前模型的 ASCII 艺术横幅
- `>` 提示符用于输入任务（含会话用量显示）
- 文件路径（`@`）和斜杠命令（`/`）的 Tab 补全
- 多行输入支持（括号识别）
- 方向键历史记录导航
- 基于 Ink/React 的现代终端输入界面

### 单次任务模式

```bash
codegrunt "你的任务描述"
```

执行单个任务后退出。适用于脚本编写和快速查询。

### 斜杠命令

| 命令 | 描述 |
|---|---|
| `/help` | 显示帮助信息和所有可用命令 |
| `/model` | 交互式切换模型（方向键选择器） |
| `/model <id>` | 切换到指定模型（例如 `/model deepseek-v4-pro`） |
| `/init` | 分析代码库并生成 `CODEGRUNT.md` 项目指南 |
| `/index` | 构建代码符号索引，加速 `code_search` 工具 |
| `/clear` | 清除对话上下文 |
| `/compact` | 总结并压缩对话历史以节省 Token（块式分层压缩） |
| `/review` | 审查本次会话的变更是否有逻辑问题 |
| `/cost` | 显示会话 Token 使用量和预估费用（含缓存命中/未命中统计） |
| `/balance` | 显示账户余额和用量（今日 / 本月） |
| `/config` | 显示或修改配置设置 |
| `/reasoning` / `/effort` | 设置 R1 模型的推理强度（low/medium/high） |
| `/skills` | 列出和管理技能（创建、列表、安装） |
| `/search-engine` | 切换 Web 搜索用的搜索引擎 |
| `/restore` | 从自动快照恢复工作状态 |

### @-引用

在提示词中直接引用文件、目录或 URL：

| 语法 | 描述 | 示例 |
|---|---|---|
| `@<文件>` | 注入文件内容 | `@src/index.ts` |
| `@<目录>` | 注入目录列表（最多 20 条） | `@src/components/` |
| `@<网址>` | 获取并注入网页内容 | `@https://example.com` |

支持文件和目录路径的 Tab 补全。目录扫描跳过 `node_modules`、`.git`、`dist`、`.next`、`__pycache__`、`.cache`。

---

## 配置

CodeGrunt 通过环境变量或 `~/.codegrunt/config.json` 文件配置。

### 环境变量

| 变量 | 描述 | 默认值 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | — |
| `CODEGRUNT_MODEL` | 使用的模型 ID | `deepseek-v4-pro` |
| `CODEGRUNT_PROVIDER` | LLM 提供商 | `deepseek` |
| `CODEGRUNT_MAX_TOKENS` | 每次响应的最大 Token 数 | `8192` |
| `CODEGRUNT_TEMPERATURE` | 响应温度 (0-2) | `0.2` |
| `CODEGRUNT_BASE_URL` | 自定义 API 基础 URL | `https://api.deepseek.com` |
| `CODEGRUNT_REASONING_EFFORT` | R1 推理强度：`low` \| `medium` \| `high` | `medium` |
| `CODEGRUNT_TOP_P` | 核采样 (0-1) | `1` |
| `CODEGRUNT_FREQUENCY_PENALTY` | 重复惩罚 (-2 到 2) | `0` |
| `CODEGRUNT_PRESENCE_PENALTY` | 主题多样性惩罚 (-2 到 2) | `0` |
| `CODEGRUNT_LOG_LEVEL` | 日志级别：`debug` \| `info` \| `warn` \| `error` | `info` |
| `CODEGRUNT_LOG_FILE` | 设为 `0` 或 `false` 禁用文件日志 | 启用 |
| `CODEGRUNT_VERBOSE` | 启用详细 stderr 输出 | 禁用 |
| `CODEGRUNT_SEARCH_ENGINE` | Web 搜索引擎：`mojeek` \| `searxng` \| `duckduckgo` | `mojeek` |
| `CODEGRUNT_SEARXNG_URL` | 自托管 SearXNG 实例 URL（当引擎为 searxng 时） | — |

### 配置文件 (`~/.codegrunt/config.json`)

```json
{
  "apiKey": "sk-xxxxxxxx",
  "model": "deepseek-v4-pro",
  "maxTokens": 8192,
  "temperature": 0.2,
  "reasoningEffort": "medium",
  "topP": 1,
  "frequencyPenalty": 0,
  "presencePenalty": 0
}
```

配置文件在首次运行时通过设置向导自动生成。环境变量优先级高于配置文件。

---

## 支持的模型

| 提供商 | 模型 | 状态 |
|---|---|---|
| [DeepSeek](https://platform.deepseek.com/) | `deepseek-chat`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-reasoner` | ✅ 支持 |

---

> 📖 完整的架构说明、代理循环、工具系统、上下文管理、管道引擎等详细设计文档，请参阅 [开发者指南](docs/development-guide.md)。

## 开发

### 命令

```bash
npm run dev        # 开发模式，热重载 (tsx)
npm run build      # 编译 TypeScript 到 dist/
npm run typecheck  # 仅类型检查，不输出文件
npm test           # 运行 vitest 测试套件
npm start          # 运行编译后的 dist/cli/index.js

# 运行单个测试文件
npx vitest run tests/tools/read_file.test.ts
```

关于项目结构的详细说明、架构设计、代理循环等内容，请参阅：
- [开发者指南（中文）](docs/development-guide.md)
- [开发指南（英文）](docs/development-guide-en.md)

---

## 许可证

MIT
