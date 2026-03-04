/**
 * Simple YAML parsing utilities — no external dependencies.
 *
 * Shared across @promptwheel/cli and @promptwheel/mcp.
 */

/**
 * Simple YAML-like parser for flat key: value files.
 * Handles single-line values and multi-line | blocks.
 * Does NOT handle nested objects, anchors, or complex YAML features.
 */
export function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let multilineValue: string[] = [];
  let multilineIndent = 0;

  for (const line of lines) {
    // Skip comments and empty lines (unless in multiline)
    if (!currentKey && (line.trim().startsWith('#') || line.trim() === '')) continue;

    // Check for multiline continuation
    if (currentKey) {
      const indent = line.length - line.trimStart().length;
      if (indent > multilineIndent && line.trim() !== '') {
        multilineValue.push(line.trim());
        continue;
      } else {
        // End of multiline block
        result[currentKey] = multilineValue.join(' ');
        currentKey = null;
        multilineValue = [];
      }
    }

    // Parse key: value
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      const [, key, value] = match;
      const trimmedValue = value.trim();

      if (trimmedValue === '|' || trimmedValue === '>') {
        // Start multiline block
        currentKey = key;
        multilineIndent = line.length - line.trimStart().length;
        multilineValue = [];
      } else {
        result[key] = trimmedValue;
      }
    }
  }

  // Flush remaining multiline
  if (currentKey) {
    result[currentKey] = multilineValue.join(' ');
  }

  return result;
}

/**
 * Parse a YAML-style list string: "[a, b, c]" or "a, b, c" -> ["a", "b", "c"]
 */
export function parseStringList(value: string): string[] {
  const stripped = value.replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
