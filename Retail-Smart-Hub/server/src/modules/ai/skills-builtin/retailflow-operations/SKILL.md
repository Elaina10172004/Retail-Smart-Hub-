---
name: RetailFlow Operations
description: 处理采购、销售、发货、验收、入库、收款、付款等受控业务操作，统一走待确认动作。
triggers:
  - 创建供应商
  - 供应商档案
  - 创建采购单
  - 创建销售单
  - 创建订单
  - 发货
  - 验收
  - 入库
  - 收款
  - 付款
  - 确认执行
  - 推进
  - 流转
  - 合并
  - pending action
tools:
  - create_supplier_profile
  - create_procurement_order
  - create_sales_order
  - advance_arrival_status
  - confirm_inbound
  - dispatch_shipping
  - register_receipt
  - register_payment
  - generate_shortage_procurement
enabled: true
---

## 适用任务

1. 用户明确要执行业务动作（建单、推进、确认）
2. 用户在识别完附件后要求生成待确认单据
3. 用户要求将单据推进到下一阶段
4. 用户要求合并多张单据流转

## 单据流转操作

### 采购流程操作
1. `create_procurement_order` → 创建采购单草稿（待确认）
2. `advance_arrival_status` → 推进到货（采购单→验收单），支持多采购单合并
3. `confirm_inbound` → 确认入库（验收单→入库单），库存增加

### 销售流程操作
1. `create_sales_order` → 创建销售单草稿（待确认）
2. `dispatch_shipping` → 推进发货（销售单→发货单），支持多销售单合并（必须同客户）
3. `register_receipt` → 登记收款（发货单→收款单）

### 补充操作
- `create_supplier_profile` → 创建供应商档案（待确认），用于导入采购单时补齐缺失供应商主数据
- `generate_shortage_procurement` → 从库存缺货分析生成采购建议
- `register_payment` → 登记付款（采购应付）

## 执行规则

1. **所有写操作走 pending action**：创建后状态为 `awaiting_confirmation`，不声称已落库
2. **先验证再创建**：检查供应商/客户/商品主数据是否存在，不存在时先追问
   - 采购单允许在 `create_procurement_order` 明细里直接新增商品；供应商缺失时先创建/确认供应商，供应商已可用后再用采购单工具一次性创建采购单和新品明细。
3. **流转前置检查**：
   - 发货合并：所选销售单必须同一客户
   - 验收合并：所选采购单必须同一供应商
   - 数量校验：本次流转数量 ≤ 源单据待处理数量
4. **追问优先级**（从 import 技能继承）：
   - 单据类型不明确 → 先问"按采购单还是销售单"
   - 主数据缺失 → 先问"新建还是映射"
   - 两者都不明确 → 先问最阻塞后续执行的那个
5. **部分流转**：支持从多张源单据中选择部分商品项合并流转
6. **确认语义**：用户说"确认"、"执行"、"提交"才是确认；说"看看"、"预览"只是查看
