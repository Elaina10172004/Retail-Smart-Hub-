export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export function parseAuditPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return (
      Object.entries(parsed)
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' | ') || '-'
    );
  } catch {
    return payload || '-';
  }
}

export function formatDateTime(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return value || '-';
  }

  return timestamp.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
