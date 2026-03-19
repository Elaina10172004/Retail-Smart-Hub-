# Agent 回答流程

本文梳理本仓库里 AI 从用户输入到最终回复的完整路径。

## 1. 入口

1. 前端位于 `Retail-Smart-Hub/`。
2. AI 页面会收集：
   - `prompt`
   - `conversationId`
   - `history`
   - `attachments`
3. 请求模式会按模型分流：
   - `deepseek` 走 `/api/ai/chat/stream`
   - 其他模型走普通 `/api/ai/chat`

## 2. Node 层

Express 层主要做四件事：

1. 校验请求体
2. 注入认证上下文：
   - 用户 ID
   - 租户
   - 角色
   - 权限
   - token
3. 转发给 Python Agent
4. 收尾副作用：
   - 记忆写回
   - 审计日志

## 3. Python 主流程

Python 运行时统一走 `run_chat(...)`。

主要阶段：

1. 请求校验
2. 上下文解析
3. 分层路由判断
4. small 模型上下文修正
5. small 只读工具预取
6. large planner-executor 生成最终回复
7. 记忆采集和结果封装

## 4. 上下文解析

在生成最终答案前，系统会整理：

- profile memory
- RAG 知识块
- 引用信息
- 附件上下文
- skill 上下文
- 可见工具 schema

如果模型未配置，系统会提前返回未配置结果。

## 5. 分层路由

路由器会判断：

- `route`
- `intention`
- `complexity`
- `modalities`
- 是否允许 `web_fallback`

常见路由：

- `direct_context`
- `kb_rag`
- `table_first`
- `hybrid`
- `web_only`

## 6. Small 模型阶段

small 模型不直接回答用户。

它的职责是：

- 改写查询
- 标记 `missing_evidence`
- 修正检索诊断
- 在需要时用只读工具预取运行时证据

常见只读工具：

- `get_dashboard_overview`
- `get_reports_overview`
- `get_finance_overview`
- `get_inventory_overview`
- `list_system_notifications`

只读预取成功后，已满足的证据缺口会在交给 large 前被移除。

## 7. 证据交接

系统会把以下内容打包给 large 模型：

- profile 上下文
- RAG 知识上下文
- 附件上下文
- 预取到的运行时工具上下文
- 证据项
- 未解决缺口

large 模型拿到的是 planner-executor 提示词，而不是普通 assistant 提示词。

## 8. Large 模型阶段

large 模型分三步：

1. `PLAN`
2. `EXECUTE`
3. `ANSWER`

### PLAN

- 生成结构化计划
- 不调用工具
- 不输出最终答案

### EXECUTE

- 判断是否还需要工具
- 可以直接发起工具调用
- 如果还存在缺口且模型自己没有调工具，编排器会触发 deterministic fallback

### ANSWER

- 基于证据输出最终答案
- 保留未解决缺口
- 返回答案元信息和 trace

## 9. 决定性补调

如果 large 模型留下未解决缺口，但没有自己发起工具调用，编排器会尝试补调。

当前规则：

- web 工具传 `{"query": ...}`
- 没有必填参数的工具传 `{}`
- 需要必填参数的工具，如果无法安全推断，就跳过

这样可以避免把 `query/q/prompt` 这类自由文本错塞给结构化工具，例如 `get_dashboard_overview`。

## 10. 最终响应

最终响应可能包含：

- `reply`
- `reasoningContent`
- `toolCalls`
- `citations`
- `webSources`
- `pendingAction`
- `approval`
- `trace`
- `answer_meta`

## 11. 流式说明

目前的流式不是所有模型都使用原生 provider streaming。

前端层面：

- 只有 `deepseek` 走 `/api/ai/chat/stream`
- 其他模型走普通非流式接口
