interface PreparedStatement {
  run: (...params: unknown[]) => unknown;
}

interface SeedDatabase {
  prepare: (sql: string) => PreparedStatement;
  transaction: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => (...args: TArgs) => TResult;
}

export function seedBootstrapData(db: SeedDatabase) {
  const seed = db.transaction(() => {
    const insertSupplier = db.prepare(
      'INSERT INTO suppliers (id, name, contact_name, phone, lead_time_days, status) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertWarehouse = db.prepare(
      'INSERT INTO warehouses (id, name, location_code, capacity) VALUES (?, ?, ?, ?)',
    );
    const insertProduct = db.prepare(
      'INSERT INTO products (id, sku, name, category, unit, status, safe_stock, sale_price, cost_price, preferred_supplier_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertInventory = db.prepare(
      'INSERT INTO inventory (id, product_id, warehouse_id, current_stock, reserved_stock) VALUES (?, ?, ?, ?, ?)',
    );
    const insertSalesOrder = db.prepare(
      'INSERT INTO sales_orders (id, customer_name, order_channel, order_date, expected_delivery_date, status, stock_status, total_amount, item_count, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertSalesOrderItem = db.prepare(
      'INSERT INTO sales_order_items (id, sales_order_id, product_id, sku, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertPurchaseOrder = db.prepare(
      'INSERT INTO purchase_orders (id, supplier_id, created_at, expected_at, status, source, remark) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertPurchaseOrderItem = db.prepare(
      'INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, arrived_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertReceivingNote = db.prepare(
      'INSERT INTO receiving_notes (id, purchase_order_id, supplier_id, expected_qty, arrived_qty, qualified_qty, defect_qty, status, arrived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertReceivingNoteItem = db.prepare(
      'INSERT INTO receiving_note_items (id, receiving_note_id, purchase_order_item_id, product_id, expected_qty, arrived_qty, qualified_qty, defect_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertInboundOrder = db.prepare(
      'INSERT INTO inbound_orders (id, receiving_note_id, warehouse_id, inbound_qty, status, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    [
      ['SUP-001', '宝洁供应链', '刘婷', '13800000001', 4, 'active'],
      ['SUP-002', '维达集团', '陈峰', '13800000002', 3, 'active'],
      ['SUP-003', '华润怡宝华北分销', '王蕾', '13800000003', 2, 'active'],
      ['SUP-004', '蓝月亮家庭清洁', '孙浩', '13800000004', 5, 'active'],
      ['SUP-005', '亿滋食品', '赵洁', '13800000005', 3, 'active'],
    ].forEach((row) => insertSupplier.run(...row));

    [
      ['WH-001', '华北成品仓', 'A区-01货架', 2000],
      ['WH-002', '华北周转仓', 'B区-12货架', 1500],
    ].forEach((row) => insertWarehouse.run(...row));

    [
      ['PRD-001', 'SKU-1001', '维达抽纸 24包', '纸品日化', '件', 'active', 50, 59.9, 38, 'SUP-002'],
      ['PRD-002', 'SKU-1002', '瓶装矿泉水 (怡宝 550ml)', '饮料饮品', '箱', 'active', 30, 36, 24, 'SUP-003'],
      ['PRD-003', 'SKU-1003', '蓝月亮洗衣液 3kg', '家清洗护', '桶', 'active', 100, 79, 48, 'SUP-004'],
      ['PRD-004', 'SKU-1004', '农夫山泉 24瓶装', '饮料饮品', '箱', 'active', 50, 42, 28, 'SUP-003'],
      ['PRD-005', 'SKU-1005', '洁柔卷纸 12卷', '家庭纸品', '提', 'active', 100, 45, 29, 'SUP-002'],
      ['PRD-006', 'SKU-1006', '奥利奥夹心饼干', '休闲食品', '箱', 'active', 40, 18, 8, 'SUP-005'],
    ].forEach((row) => insertProduct.run(...row));

    [
      ['INV-001', 'PRD-001', 'WH-001', 12, 0],
      ['INV-002', 'PRD-002', 'WH-001', 25, 0],
      ['INV-003', 'PRD-003', 'WH-001', 8, 0],
      ['INV-004', 'PRD-004', 'WH-001', 150, 0],
      ['INV-005', 'PRD-005', 'WH-001', 320, 0],
      ['INV-006', 'PRD-006', 'WH-001', 45, 0],
    ].forEach((row) => insertInventory.run(...row));

    [
      ['ORD-20260311-001', '朝阳社区店', '门店补货', '2026-03-11', '2026-03-13', '待发货', '库存充足', 12500, 12, null],
      ['ORD-20260311-002', '线上商城华北仓', '线上商城', '2026-03-11', '2026-03-14', '待发货', '部分缺货', 3200, 5, '饮料促销单需优先备货'],
      ['ORD-20260310-005', '海淀校园店', '门店补货', '2026-03-10', '2026-03-11', '已发货', '-', 850, 3, null],
      ['ORD-20260310-008', '西单旗舰店', '企业团购', '2026-03-10', '2026-03-12', '已完成', '-', 45000, 42, '团购合同已归档'],
      ['ORD-20260309-012', '国贸写字楼店', '门店补货', '2026-03-09', '2026-03-10', '已取消', '-', 8900, 6, '客户临时取消活动'],
    ].forEach((row) => insertSalesOrder.run(...row));

    [
      ['ORD-20260311-001-ITEM-1', 'ORD-20260311-001', 'PRD-005', 'SKU-1005', '洁柔卷纸 12卷', 12, 45],
      ['ORD-20260311-002-ITEM-1', 'ORD-20260311-002', 'PRD-002', 'SKU-1002', '瓶装矿泉水 (怡宝 550ml)', 5, 36],
      ['ORD-20260310-005-ITEM-1', 'ORD-20260310-005', 'PRD-006', 'SKU-1006', '奥利奥夹心饼干', 3, 18],
      ['ORD-20260310-008-ITEM-1', 'ORD-20260310-008', 'PRD-001', 'SKU-1001', '维达抽纸 24包', 42, 59.9],
      ['ORD-20260309-012-ITEM-1', 'ORD-20260309-012', 'PRD-003', 'SKU-1003', '蓝月亮洗衣液 3kg', 6, 79],
    ].forEach((row) => insertSalesOrderItem.run(...row));

    [
      ['PO-20260310-001', 'SUP-002', '2026-03-10', '2026-03-14', '待审核', '安全库存补货', '纸品补货建议单'],
      ['PO-20260309-002', 'SUP-003', '2026-03-09', '2026-03-13', '采购中', '饮料促销备货', '大促活动前置补货'],
      ['PO-20260308-003', 'SUP-004', '2026-03-08', '2026-03-11', '部分到货', '缺货补采', '洗护缺口补采'],
      ['PO-20260306-004', 'SUP-005', '2026-03-06', '2026-03-09', '已完成', '常规补货', '零食补货已完成'],
    ].forEach((row) => insertPurchaseOrder.run(...row));

    [
      ['PO-20260310-001-ITEM-1', 'PO-20260310-001', 'PRD-001', 80, 0, 38],
      ['PO-20260309-002-ITEM-1', 'PO-20260309-002', 'PRD-002', 120, 120, 24],
      ['PO-20260308-003-ITEM-1', 'PO-20260308-003', 'PRD-003', 150, 100, 48],
      ['PO-20260306-004-ITEM-1', 'PO-20260306-004', 'PRD-006', 90, 90, 8],
    ].forEach((row) => insertPurchaseOrderItem.run(...row));

    [
      ['RCV-20260311-001', 'PO-20260310-001', 'SUP-002', 80, 80, 78, 2, '待验收', '2026-03-11'],
      ['RCV-20260311-002', 'PO-20260309-002', 'SUP-003', 120, 120, 120, 0, '已验收待入库', '2026-03-11'],
      ['RCV-20260310-003', 'PO-20260308-003', 'SUP-004', 150, 100, 100, 0, '部分到货', '2026-03-10'],
      ['RCV-20260309-004', 'PO-20260306-004', 'SUP-005', 90, 90, 90, 0, '已入库', '2026-03-09'],
    ].forEach((row) => insertReceivingNote.run(...row));

    [
      ['RCV-20260311-001-ITEM-1', 'RCV-20260311-001', 'PO-20260310-001-ITEM-1', 'PRD-001', 80, 80, 78, 2],
      ['RCV-20260311-002-ITEM-1', 'RCV-20260311-002', 'PO-20260309-002-ITEM-1', 'PRD-002', 120, 120, 120, 0],
      ['RCV-20260310-003-ITEM-1', 'RCV-20260310-003', 'PO-20260308-003-ITEM-1', 'PRD-003', 150, 100, 100, 0],
      ['RCV-20260309-004-ITEM-1', 'RCV-20260309-004', 'PO-20260306-004-ITEM-1', 'PRD-006', 90, 90, 90, 0],
    ].forEach((row) => insertReceivingNoteItem.run(...row));

    [
      ['INB-20260311-001', 'RCV-20260311-001', 'WH-001', 78, '待入库', null],
      ['INB-20260311-002', 'RCV-20260311-002', 'WH-001', 120, '待入库', null],
      ['INB-20260309-003', 'RCV-20260309-004', 'WH-001', 90, '已入库', '2026-03-09'],
    ].forEach((row) => insertInboundOrder.run(...row));
  });

  seed();
}
