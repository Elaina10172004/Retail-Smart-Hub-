# Retail Smart Hub

Retail Smart Hub 是一个面向零售、仓储和物流场景的桌面端系统。

本仓库根目录用于交付，真正的应用代码都在 [`Retail-Smart-Hub/`](./Retail-Smart-Hub) 中。

## 仓库结构

- `Retail-Smart-Hub/`：主应用，包含 React、Vite、Electron、Express 和 Python Agent
- `docs/rag/knowledge/`：AI 检索使用的业务知识文档
- `start.bat`：根目录启动脚本

## 使用

如果只是想在本机直接跑起来，通常直接在仓库根目录双击 `start.bat` 就行。

- 脚本会先检查 Node.js、npm 和项目依赖，缺少时会自动补装或提示你手动安装。
- 如果你的环境需要本地 embedding 运行时，`start.bat` 也会检查并处理 Ollama。
- 首次启动会自动生成管理员一次性临时口令，用于首次登录并强制改密。临时口令会打印在服务端启动日志中，同时在应用数据目录下写入 `bootstrap-admin-password.txt`；生产环境请通过环境变量 `AUTH_BOOTSTRAP_ADMIN_PASSWORD` 显式设置初始管理员口令（同样会强制首登改密）。
- AI 对话能力可以在登录后的“配置管理”里直接配置 API Key、模型和基址；`.env` 主要用于启动默认值、Python Agent、Embedding 和其他运行级配置。只看业务系统界面通常不需要额外操作。
- 找回密码默认走本地演示流程：在非生产环境中，服务端会直接返回一次性重置令牌预览，方便离线演示和本机验证；生产环境不会内置邮件或短信投递，如果你需要自助找回，必须自行接入真实外部投递通道。

桌面安装版默认会以 `production` 模式启动内嵌 API，不会因为缺少 `NODE_ENV` 自动回退到 development。若你需要本地开发/演示模式，请显式设置 `RETAIL_SMART_HUB_DEV=true` 或 `NODE_ENV=development`。

首次登录后建议立刻修改管理员临时口令。

## 技术栈

- 前端：React 19、TypeScript、Vite、Tailwind
- 桌面端：Electron
- 后端：Express、TypeScript
- 数据层：SQLite
- AI：Python Agent Runtime，支持 DeepSeek / OpenAI / Gemini
- 校验：Zod
- 测试：Node 测试运行器 + Python `unittest`

## 快速开始

进入应用目录：

```bash
cd Retail-Smart-Hub
```

安装依赖：

```bash
npm ci
```

复制环境变量文件（可选，想改启动默认值时再配）：

```bash
copy .env.example .env
```

如果你希望一开始就固定默认模型、Python Agent 或 Embedding 运行参数，再补齐 `.env` 中对应配置。AI 模型的 API Key 也可以后续在系统内“配置管理”里直接填写。

启动开发服务：

```bash
npm run dev:server
npm run dev
```

桌面开发模式：

```bash
npm run desktop:dev
```

## 构建与测试

在 `Retail-Smart-Hub/` 下执行：

```bash
npm run typecheck
npm test
npm run build
```

桌面端打包：

```bash
npm run desktop:build
```

## AI 运行时

当前 AI 主链路使用 Python Agent Runtime，支持：

- RAG 检索
- 层级式 small / large 协作
- 运行时工具调用
- 带审批的受控写操作
- 记忆采集与审计接入

## 说明

- 仓库保留 `docs/rag/knowledge/` 作为业务知识库。
- 开发文档和内部草稿不纳入提交内容。
