export function extractLabeledField(prompt: string, labels: string[]) {
  const pattern = new RegExp(`(?:${labels.join('|')})[：:\\s]*([^，。；;\\n]+?)(?=\\s*(?:渠道偏好|渠道|联系人|联系电话|电话|手机号|手机|$))`);
  return pattern.exec(prompt)?.[1]?.trim() || '';
}

export function extractRegexId(prompt: string, regex: RegExp) {
  return prompt.match(regex)?.[0]?.toUpperCase() || '';
}

export function extractFieldByLabels(prompt: string, labels: string[], stopLabels: string[] = []) {
  const stopPattern = stopLabels.length > 0 ? `(?=\\s*(?:${stopLabels.join('|')})[：:\\s]|$)` : '$';
  const pattern = new RegExp(`(?:${labels.join('|')})[：:\\s]*([^，。；;\\n]+?)${stopPattern}`);
  return pattern.exec(prompt)?.[1]?.trim() || '';
}

export function parseMethod(prompt: string, mappings: Array<{ keywords: string[]; method: string }>, fallback: string) {
  for (const mapping of mappings) {
    if (mapping.keywords.some((keyword) => prompt.includes(keyword))) {
      return mapping.method;
    }
  }

  return fallback;
}

export function parseExplicitAmount(prompt: string, id?: string) {
  const labeled = /(?:金额|收款金额|付款金额|实收|实付)[：:\s￥¥]*([0-9]+(?:\.[0-9]{1,2})?)/.exec(prompt);
  if (labeled) {
    return Number(labeled[1]);
  }

  if (id) {
    const upperPrompt = prompt.toUpperCase();
    const upperId = id.toUpperCase();
    const start = upperPrompt.indexOf(upperId);
    if (start >= 0) {
      const afterId = prompt.slice(start + id.length);
      const matched = /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:元|块)?/.exec(afterId);
      if (matched) {
        return Number(matched[1]);
      }
    }
  }

  const withUnit = /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:元|块)/.exec(prompt);
  if (withUnit) {
    return Number(withUnit[1]);
  }

  return null;
}

export function wantsFullSettlement(prompt: string) {
  return ['全部', '全额', '收清', '付清', '结清', '一次结清'].some((keyword) => prompt.includes(keyword));
}

export function normalizeDateInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^\d{4}[/.]\d{2}[/.]\d{2}$/.test(trimmed)) {
    return trimmed.replace(/[/.]/g, '-');
  }

  return '';
}

export function extractExpectedDeliveryDate(prompt: string) {
  const explicit = extractFieldByLabels(
    prompt,
    ['交付日期', '配送日期', '期望送达', '预计送达', '送达日期', '交货日期'],
    ['明细', '商品明细', '商品', '备注'],
  );
  const normalized = normalizeDateInput(explicit);
  if (normalized) {
    return normalized;
  }

  const generic = prompt.match(/\d{4}[-/.]\d{2}[-/.]\d{2}/)?.[0] || '';
  return normalizeDateInput(generic);
}

export function extractOrderItemsText(prompt: string) {
  const matched = /(?:商品明细|订单明细|明细|商品)[：:\s]*([^。；;\n]+?)(?=\s*(?:备注|$))/.exec(prompt);
  return matched?.[1]?.trim() || '';
}
