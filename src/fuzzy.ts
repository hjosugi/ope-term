export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const needle = query.toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index === -1) return null;
    score += 1;
    if (index === previous + 1) score += 6;
    if (index === 0 || /[\s\-_.\/@:]/.test(haystack[index - 1] ?? '')) score += 10;
    score -= Math.min(index - cursor, 3);
    previous = index;
    cursor = index + 1;
  }
  return score;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string): T[] {
  return items
    .map((item, order) => ({ item, order, score: fuzzyScore(query, key(item)) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item }) => item);
}
