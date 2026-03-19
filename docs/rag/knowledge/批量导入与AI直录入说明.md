# 批量导入与 AI 直录入说明
## 文档作用
本文档说明当前系统已支持的文件导入能力、AI 助手上传导入能力、表头规范和实验模板位置。

## 当前支持范围
1. 客户批量导入
   - 页面：`客户档案`
   - AI 页面：`AI 智能助手`
   - 接口：`POST /api/customers/import`
   - 权限：`settings.master-data`
2. 商品批量导入
   - 页面：`系统设置 -> 基础资料`
   - AI 页面：`AI 智能助手`
   - 接口：`POST /api/settings/products/import`
   - 权限：`settings.master-data`
3. 订单批量导入
   - 页面：`AI 智能助手`
   - 接口：`POST /api/orders/import`
   - 权限：`orders.create`

## AI 页面上传导入
AI 助手页现在提供文件上传按钮，支持：
1. 上传 `txt`
2. 上传 `csv`
3. 上传 `xls`
4. 上传 `xlsx`

上传流程：
1. 在 AI 页面选择导入目标，或使用“自动识别”
2. 上传文件（此时仅附加到当前会话，不执行写入）
3. 输入指令并点击发送
4. AI 按指令进入“预览/校验/导入”模式并回显执行状态

## 模板文件
可直接用于实验的模板放在：
1. `Retail-Smart-Hub/public/templates/ai-customer-import-template.csv`
2. `Retail-Smart-Hub/public/templates/ai-product-import-template.csv`
3. `Retail-Smart-Hub/public/templates/ai-order-import-template.csv`
4. `Retail-Smart-Hub/public/templates/ai-customer-import-template.xlsx`
5. `Retail-Smart-Hub/public/templates/ai-product-import-template.xlsx`
6. `Retail-Smart-Hub/public/templates/ai-order-import-template.xlsx`

## 文件格式规则
1. `txt/csv` 需要首行表头
2. 文本分隔符支持：制表符、逗号、分号、竖线
3. `xls/xlsx` 默认读取第一个工作表
4. 空白行会计入 `skippedCount`

## 客户导入表头
可识别字段：
1. `customerName` / `customer` / `客户名称` / `客户`
2. `channelPreference` / `channel` / `渠道`
3. `contactName` / `contact` / `联系人`
4. `phone` / `mobile` / `电话` / `手机号`

最小必填：
1. 客户名称
2. 渠道

## 商品导入表头
可识别字段：
1. `sku` / `SKU` / `商品编码` / `商品编号`
2. `name` / `productName` / `商品名称` / `商品`
3. `category` / `品类`
4. `unit` / `单位`
5. `safeStock` / `安全库存`
6. `salePrice` / `price` / `售价`
7. `costPrice` / `cost` / `成本价`
8. `supplier` / `supplierId` / `supplierName` / `供应商`

规则：
1. 必填：`sku`、`name`、`salePrice`、`costPrice`、`supplier`
2. 默认值：
   - `category = 日用百货`
   - `unit = 件`
   - `safeStock = 30`
3. 供应商必须是系统内启用状态，可填写供应商编号或供应商名称

## 订单导入表头
订单导入采用“每行一条商品明细，同一个 `orderNo` 归并为同一张订单”的方式。

可识别字段：
1. `orderNo` / `orderCode` / `导入单号` / `订单组`
2. `customerName` / `customer` / `客户名称`
3. `orderChannel` / `channel` / `渠道`
4. `expectedDeliveryDate` / `deliveryDate` / `交付日期`
5. `remark` / `备注`
6. `sku` / `SKU`
7. `productName` / `商品名称` / `商品`
8. `quantity` / `qty` / `数量`
9. `unitPrice` / `price` / `单价`

规则：
1. 必填：`orderNo`、`customerName`、`orderChannel`、`expectedDeliveryDate`、`sku`、`quantity`
2. `unitPrice` 为空时，自动取商品当前销售价
3. `productName` 为空时，自动取商品档案名称
4. 同一个 `orderNo` 下的客户、渠道、交付日期、备注必须一致

## 返回结果口径
导入接口统一返回：
1. `totalCount`
2. `createdCount`
3. `skippedCount`
4. `errorCount`
5. `createdIds`
6. `errors`

说明：
1. 重复客户或重复 SKU 会进入 `skippedCount`
2. 缺字段、商品不存在、供应商不存在、数值格式错误会进入 `errors`
3. 订单导入中，`createdCount` 表示成功创建的订单数，不是订单明细行数

## AI 直录入
当前 AI 已支持：
1. 创建客户
2. 创建商品
3. 上传客户表导入
4. 上传商品表导入
5. 上传订单表导入
6. 附件预览与校验（不写入）

文档技能模式：
1. 预览模式：默认模式，返回识别类型、行数、字段，不写入。
2. 校验模式：提示“校验/检查/错误”时触发，不写入。
3. 导入模式：提示“导入/录入/执行”时触发，才会真实写入。

示例：
1. `创建客户 华东便利店 渠道 门店补货 联系人 张三 电话 13800001234`
2. `创建商品 SKU SKU-2001 商品 维达湿巾 品类 纸品日化 单位 件 安全库存 30 售价 12.8 成本价 8.5 供应商 维达集团`
3. 在 AI 页面上传客户、商品或订单模板文件
