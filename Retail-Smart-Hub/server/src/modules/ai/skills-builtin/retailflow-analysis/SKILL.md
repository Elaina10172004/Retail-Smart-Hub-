---
name: RetailFlow Analysis
description: 处理业务问答、仪表盘分析、状态解释、规则说明和结果核对；默认作为读侧兜底技能。
---

## Runtime Metadata

- Triggers: 分析, 查询, 解释, 仪表盘, 报表, 库存, 财务, 状态, why, analyze, 怎么, 如何, 流程, 规则
- Recommended tools: get_dashboard_overview, get_order_detail, get_procurement_detail, query_inventory_item, list_inventory_alerts, get_finance_overview, list_receivables, list_payables, list_customers, get_customer_summary, get_reports_overview, get_master_data_overview, list_arrivals, get_arrival_detail, list_inbounds, get_inbound_detail, list_shipments, get_shipment_detail
- Enabled: true

## 适用任务

1. 用户询问业务状态：仪表盘、订单、采购、库存、发货、财务指标
2. 用户需要解释：页面数据含义、异常原因、流程当前阶段、系统规则
3. 用户想了解流程：采购流程、销售流程、单据流转规则
4. 作为默认读侧兜底技能

## 单据流转知识

### 采购流程
采购单(PO) → 验收单(ARV) → 入库单(INB)
- 采购单确认后推进到货 → 生成验收单
- 验收单确认 → 生成入库单 → 库存增加

### 销售流程
销售单(SO) → 发货单(SHP) → 收款单(RCP)
- 销售单确认后推进发货 → 生成发货单
- 发货单确认 → 库存减少
- 收款单确认 → 应收账款减少

### 合并流转
- 支持从多张源单据选择商品项合并生成新单据
- 发货合并：必须同一客户
- 验收合并：必须同一供应商
- 支持部分流转（只选部分商品项）

## 执行规则

1. 优先使用只读工具获取实时数据，工具结果优先级最高
2. 分析时引用具体数据（数字、日期、状态），避免模糊表述
3. 当用户问"为什么"时，先查单据链路（采购→验收→入库 或 销售→发货→收款）
4. 当用户问"怎么做"时，给出分步操作指引
5. 当用户问流程规则时，引用上述单据流转知识
6. 库存不足时建议生成采购建议；订单积压时建议推进发货
7. 异常检测：如果某单据长期停留在中间状态，主动提示
8. 不把推测包装成事实，证据不足时明确说明
9. 如果用户意图转向建单/导入/写入，转交 import 或 operations 技能
