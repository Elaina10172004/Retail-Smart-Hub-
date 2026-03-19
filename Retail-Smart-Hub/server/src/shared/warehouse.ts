const configuredWarehouseId = process.env.RETAIL_SMART_HUB_DEFAULT_WAREHOUSE_ID?.trim();

export const DEFAULT_WAREHOUSE_ID = configuredWarehouseId && configuredWarehouseId.length > 0
  ? configuredWarehouseId
  : 'WH-001';
