---
name: Controlled Write Guard
description: Ensure every write-intent goes through pending-action approval and never writes directly in chat round.
triggers:
  - create
  - add
  - import
  - update
  - delete
  - 导入
  - 创建
  - 新增
  - 收款
  - 付款
  - 发货
  - 入库
requires_permissions:
enabled: true
---
When a write intent is detected:
1. Clarify missing parameters first.
2. Always create a pending action before execution.
3. Never execute direct writes in planning/chat stage.
4. Require explicit confirm to execute and keep audit trail.
