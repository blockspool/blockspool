// Shared UTF-8 truncation utility.
// Extracted to break circular dependency between run-manager and event-helpers.

export interface TruncateResult {
  value: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Truncate a string to fit within a byte budget using binary search.
 * Ensures the result is valid UTF-8 (no split surrogate pairs).
 */
export function truncateUtf8(value: string, maxBytes: number): TruncateResult {
  const safeMaxBytes = Math.max(0, maxBytes);
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= safeMaxBytes) {
    return { value, truncated: false, originalBytes };
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, mid);
    if (Buffer.byteLength(candidate, 'utf8') <= safeMaxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { value: value.slice(0, low), truncated: true, originalBytes };
}
