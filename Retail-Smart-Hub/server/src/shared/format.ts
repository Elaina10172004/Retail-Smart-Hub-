export function formatCurrency(value: number) {
  return `¥${value.toLocaleString('zh-CN', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function currentDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function currentDateTimeString() {
  return new Date().toISOString();
}

export function compactDate(dateString = currentDateString()) {
  return dateString.replaceAll('-', '');
}

export function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}
