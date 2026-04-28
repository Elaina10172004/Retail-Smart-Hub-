# 项目语言与安全说明

## 1. `ts` 是什么

`ts` 文件使用的是 **TypeScript**。

TypeScript 是 JavaScript 的超集，最终会编译成 JavaScript 运行。它的主要价值是：

- 给变量、函数、对象加类型约束
- 让大型前后端项目更容易维护
- 在编译阶段提前发现很多错误

`tsx` 是 TypeScript + JSX，主要用于 React 组件。

## 2. 仓库里各语言分别负责什么

| 语言 / 扩展名 | 主要位置 | 负责内容 |
| --- | --- | --- |
| `.ts` | `server/src/**`、`src/**`、`scripts/**` | 后端 API、数据库、业务服务、前端共享工具、构建脚本 |
| `.tsx` | `src/pages/**`、`src/components/**`、`src/auth/**` | React 页面、UI 组件、布局、表单和弹窗 |
| `.cjs` | `electron/**`、`scripts/start-electron.cjs` | Electron 主进程、预加载脚本、桌面启动逻辑 |
| `.py` | `python-agent/**` | Python AI sidecar、RAG、模型调用、工具执行、记忆处理 |
| `.json` | 根目录、`public/templates/**`、`database/**` | 配置、提示词、演示数据、构建元数据 |
| `.md` | 根目录、`docs/**` | 说明文档、使用文档、提示词说明 |

## 3. 关键文件和职责

### 前端

- `src/pages/**`
  - 业务页面入口，比如采购、订单、入库、发货、财务、库存、客户、系统设置。
- `src/components/**`
  - 通用组件、单据骨架、表格、弹窗、选择器。
- `src/services/api/**`
  - 前端请求后端 API 的封装。
- `src/lib/**`
  - 格式化、单据构造、导入导出等纯工具逻辑。

### 后端

- `server/src/index.ts`
  - 后端 HTTP 服务启动入口。
- `server/src/app.ts`
  - Express 应用、路由挂载、CORS、信号退出处理。
- `server/src/database/db.ts`
  - SQLite 数据库封装、建表、迁移、初始化、编号生成。
- `server/src/modules/**`
  - 采购、订单、入库、发货、财务、客户、库存、AI 等业务服务。
- `server/src/shared/**`
  - 通用认证、校验、格式化、响应、权限等共享逻辑。

### 桌面壳

- `electron/main.cjs`
  - Electron 主窗口、启动后端、打印、IPC 安全控制。
- `electron/preload.cjs`
  - 预加载脚本，向前端暴露受控能力。

### AI 侧车

- `python-agent/main.py`
  - Python AI 运行入口。
- `python-agent/app/**`
  - 模型适配、RAG、记忆、提示词、工具、路由、工作流状态机。

## 4. SQL 是怎么写的

这个项目没有单独的 `.sql` 文件为主，SQL 主要分散在 TypeScript 里：

- `server/src/database/db.ts`
  - 建表、初始化数据、编号生成、事务封装。
- `server/src/database/migrations/core.migrations.ts`
  - 旧表结构迁移。
- `server/src/database/repositories/schema.repository.ts`
  - 表结构检查、补字段。
- `server/src/modules/**`
  - 各业务模块的增删改查 SQL。
- `server/src/shared/auth.ts`
  - 登录、会话、密码、重置等认证相关 SQL。
- `server/src/modules/ai/**`
  - AI 记忆、待确认动作、知识检索相关 SQL。

## 5. SQL 注入是怎么处理的

当前代码整体上是按 **参数化查询优先** 来写的。

### 已经做对的地方

- 绝大多数查询都使用 `?` 占位符，例如：
  - `db.prepare('SELECT ... WHERE id = ?').get(id)`
  - `db.prepare('UPDATE ... SET x = ? WHERE id = ?').run(value, id)`
- 用户输入会先经过业务校验，再进入数据库层。
- 事务写操作都包在 `transaction()` 或数据库事务里，避免半写入状态。

### 需要注意的地方

下面这些地方会拼接 SQL 字符串，但它们使用的是 **内部白名单 / 内部常量**，不是用户直传值：

- `server/src/database/db.ts`
  - `nextMasterDataId()`、`nextDocumentId()` 会拼表名，但调用方都是内部固定值。
- `server/src/database/repositories/schema.repository.ts`
  - `ensureColumnExists()` 会拼表名和字段定义，只应由迁移代码调用。
- `server/src/database/migrations/core.migrations.ts`
  - 迁移里有少量字符串插值，但插入的是系统日期或固定字段，不是用户输入。

### 结论

- **从当前仓库来看，没有看到直接可利用的 SQL 注入入口。**
- **但动态表名 / 动态字段名 仍然属于高敏感点。**
- 这类 helper 只应接受内部常量，不要把外部请求参数直接传进去。

## 6. 资源释放 / 内存释放是怎么处理的

### 目前已经有的释放逻辑

- `server/src/app.ts`
  - 在 `SIGINT`、`SIGTERM`、`exit` 时停止 Python sidecar。
- `electron/main.cjs`
  - 在 `before-quit` 时关闭 API server。
- `server/src/database/db.ts`
  - SQLite 查询和写入使用 `DatabaseSync`，事务通过 `SAVEPOINT` 管理，写入失败会回滚。

### 当前的现状

- SQLite 连接对象 **目前没有显式调用 `db.close()`**。
- 也就是说，数据库连接主要依赖进程退出后由系统回收。
- 这在桌面程序里通常能工作，但它不是最严格的资源释放方式。

### 建议的增强

如果要把资源释放做得更完整，建议后续补上：

- `db.close()` 的显式关闭方法
- 在 `app.ts` / `electron/main.cjs` 的退出钩子里统一关闭 SQLite 连接
- 保证 Python sidecar、HTTP server、数据库连接的关闭顺序一致

## 7. 一句话总结

- `ts` 就是 TypeScript。
- 前端主要是 `.tsx`，后端主要是 `.ts`，Electron 壳是 `.cjs`，AI 侧车是 `.py`。
- SQL 目前以参数化查询为主，没看到直接可利用的注入入口。
- 资源释放已经有进程级退出钩子，但 SQLite 还没有显式 `close()`，这部分可以继续增强。
