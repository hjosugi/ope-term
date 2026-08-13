export const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
export const MAX_TERMINAL_INPUT_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Returns the UTF-8 size only when adding the input stays within the backlog budget. */
export function boundedTerminalInputBytes(
  input: string,
  currentBytes: number,
  maximumBytes = MAX_TERMINAL_INPUT_BACKLOG_BYTES,
): number | null {
  if (
    !Number.isSafeInteger(currentBytes)
    || currentBytes < 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 0
  ) return null;
  const remaining = maximumBytes - currentBytes;
  // UTF-8 is never smaller than the number of UTF-16 code units for valid JS
  // strings. Avoid allocating another huge buffer for an obviously oversized paste.
  if (remaining < 0 || input.length > remaining) return null;
  const bytes = new TextEncoder().encode(input).byteLength;
  return bytes <= remaining ? bytes : null;
}

/** Splits input at UTF-8 character boundaries without changing its contents. */
export function chunkTerminalInput(
  input: string,
  maximumBytes = MAX_TERMINAL_INPUT_BYTES,
): string[] {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error('terminal input chunk size must be an integer of at least 4 bytes');
  }
  if (!input) return [];

  const encoded = new TextEncoder().encode(input);
  if (encoded.length <= maximumBytes) return [input];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + maximumBytes, encoded.length);
    while (end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start) throw new Error('terminal input chunk size cannot fit one UTF-8 character');
    chunks.push(decoder.decode(encoded.subarray(start, end)));
    start = end;
  }
  return chunks;
}
