export function buildSearchTokens(query: string) {
  return query
    .trim()
    .toLowerCase()
    .split(/[\s\u3000]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function matchesSearchTokens(tokens: string[], values: Array<string | number | null | undefined>) {
  if (tokens.length === 0) {
    return true;
  }

  const haystack = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).toLowerCase())
    .join(' ');

  return tokens.every((token) => haystack.includes(token));
}

export function matchesSearchQuery(query: string, values: Array<string | number | null | undefined>) {
  return matchesSearchTokens(buildSearchTokens(query), values);
}
