export function wantsGenerateProcurement(normalized: string) {
  return (
    normalized.includes('自动补货') ||
    ((normalized.includes('生成') || normalized.includes('创建')) &&
      normalized.includes('采购单') &&
      (normalized.includes('补货') || normalized.includes('低库存') || normalized.includes('缺货')))
  );
}

export function wantsCreateCustomer(normalized: string) {
  return (
    normalized.includes('创建客户') ||
    normalized.includes('新增客户') ||
    normalized.includes('添加客户') ||
    normalized.includes('创建客户档案') ||
    normalized.includes('新增客户档案')
  );
}

export function wantsCreateProductMasterData(normalized: string) {
  return (
    normalized.includes('创建商品') ||
    normalized.includes('新增商品') ||
    normalized.includes('添加商品') ||
    normalized.includes('录入商品') ||
    normalized.includes('创建商品档案') ||
    normalized.includes('新增商品档案')
  );
}

export function wantsAdvanceArrival(normalized: string) {
  return (
    normalized.includes('推进到货') ||
    normalized.includes('到货推进') ||
    normalized.includes('确认验收') ||
    (normalized.includes('到货') && normalized.includes('验收'))
  );
}

export function wantsConfirmInbound(normalized: string) {
  return normalized.includes('确认入库') || normalized.includes('入库确认') || (normalized.includes('入库') && normalized.includes('确认'));
}

export function wantsDispatchShipping(normalized: string) {
  return normalized.includes('确认发货') || normalized.includes('发货确认') || (normalized.includes('发货') && normalized.includes('确认'));
}

export function wantsRegisterReceipt(normalized: string) {
  return normalized.includes('登记收款') || normalized.includes('确认收款') || normalized.includes('收款登记') || (normalized.includes('收款') && normalized.includes('ar-'));
}

export function wantsRegisterPayment(normalized: string) {
  return normalized.includes('登记付款') || normalized.includes('确认付款') || normalized.includes('付款登记') || (normalized.includes('付款') && normalized.includes('ap-'));
}

export function wantsCreateSalesOrder(normalized: string) {
  return normalized.includes('创建订单') || normalized.includes('新建订单') || normalized.includes('创建销售订单');
}

export function matchesWriteIntent(normalized: string) {
  return (
    wantsGenerateProcurement(normalized) ||
    wantsCreateCustomer(normalized) ||
    wantsCreateProductMasterData(normalized) ||
    wantsAdvanceArrival(normalized) ||
    wantsConfirmInbound(normalized) ||
    wantsDispatchShipping(normalized) ||
    wantsRegisterReceipt(normalized) ||
    wantsRegisterPayment(normalized) ||
    wantsCreateSalesOrder(normalized)
  );
}

export function hasPromptField(prompt: string, labels: string[]) {
  return labels.some((label) => prompt.includes(label));
}

function formatComparableValue(value: unknown) {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return value === undefined || value === null ? '' : String(value);
}

export function buildDiffLine(label: string, previousValue: unknown, nextValue: unknown) {
  const before = formatComparableValue(previousValue);
  const after = formatComparableValue(nextValue);
  if (before === after) {
    return '';
  }

  return `- 调整 ${label}：${before || '-'} -> ${after || '-'}`;
}
