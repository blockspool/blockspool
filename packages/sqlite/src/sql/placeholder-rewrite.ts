/**
 * Rewrite Postgres-style placeholders ($1, $2, ...) to SQLite placeholders (?).
 *
 * Rewriting is limited to executable SQL segments. Placeholders inside comments
 * and quoted literals/identifiers are preserved as-is.
 */
type State =
  | 'default'
  | 'single_quote'
  | 'double_quote'
  | 'backtick_quote'
  | 'bracket_quote'
  | 'line_comment'
  | 'block_comment';

export type SqlitePlaceholderRewriteResult = { sql: string; values: unknown[] };

export interface SqlitePlaceholderTemplate {
  sql: string;
  parameterIndexes: number[];
}

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

function parseSqlitePlaceholderTemplate(text: string): SqlitePlaceholderTemplate {
  const parameterIndexes: number[] = [];
  const sqlParts: string[] = [];
  let i = 0;
  let state: State = 'default';

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (state === 'default') {
      if (ch === "'") {
        state = 'single_quote';
        sqlParts.push(ch);
        i++;
        continue;
      }

      if (ch === '"') {
        state = 'double_quote';
        sqlParts.push(ch);
        i++;
        continue;
      }

      if (ch === '`') {
        state = 'backtick_quote';
        sqlParts.push(ch);
        i++;
        continue;
      }

      if (ch === '[') {
        state = 'bracket_quote';
        sqlParts.push(ch);
        i++;
        continue;
      }

      if (ch === '-' && next === '-') {
        state = 'line_comment';
        sqlParts.push('--');
        i += 2;
        continue;
      }

      if (ch === '/' && next === '*') {
        state = 'block_comment';
        sqlParts.push('/*');
        i += 2;
        continue;
      }

      if (ch === '$' && isDigit(next)) {
        let j = i + 1;
        while (j < text.length && isDigit(text[j])) {
          j++;
        }

        parameterIndexes.push(Number(text.slice(i + 1, j)) - 1);
        sqlParts.push('?');
        i = j;
        continue;
      }

      sqlParts.push(ch);
      i++;
      continue;
    }

    if (state === 'single_quote') {
      sqlParts.push(ch);
      i++;

      if (ch === "'") {
        if (text[i] === "'") {
          sqlParts.push(text[i]);
          i++;
        } else {
          state = 'default';
        }
      }
      continue;
    }

    if (state === 'double_quote') {
      sqlParts.push(ch);
      i++;

      if (ch === '"') {
        if (text[i] === '"') {
          sqlParts.push(text[i]);
          i++;
        } else {
          state = 'default';
        }
      }
      continue;
    }

    if (state === 'backtick_quote') {
      sqlParts.push(ch);
      i++;

      if (ch === '`') {
        if (text[i] === '`') {
          sqlParts.push(text[i]);
          i++;
        } else {
          state = 'default';
        }
      }
      continue;
    }

    if (state === 'bracket_quote') {
      sqlParts.push(ch);
      i++;

      if (ch === ']') {
        if (text[i] === ']') {
          sqlParts.push(text[i]);
          i++;
        } else {
          state = 'default';
        }
      }
      continue;
    }

    if (state === 'line_comment') {
      sqlParts.push(ch);
      i++;

      if (ch === '\n') {
        state = 'default';
      }
      continue;
    }

    // block_comment
    sqlParts.push(ch);
    i++;

    if (ch === '*' && text[i] === '/') {
      sqlParts.push('/');
      i++;
      state = 'default';
    }
  }

  return { sql: sqlParts.join(''), parameterIndexes };
}

export function bindSqlitePlaceholderTemplate(
  template: SqlitePlaceholderTemplate,
  params: unknown[]
): SqlitePlaceholderRewriteResult {
  return {
    sql: template.sql,
    values: template.parameterIndexes.map((idx) => params[idx]),
  };
}

export interface SqlitePlaceholderCompiler {
  compile(text: string): SqlitePlaceholderTemplate;
  rewrite(text: string, params?: unknown[]): SqlitePlaceholderRewriteResult;
}

export function createSqlitePlaceholderCompiler(): SqlitePlaceholderCompiler {
  const cache = new Map<string, SqlitePlaceholderTemplate>();

  const compile = (text: string): SqlitePlaceholderTemplate => {
    const cached = cache.get(text);
    if (cached) return cached;

    const template = parseSqlitePlaceholderTemplate(text);
    cache.set(text, template);
    return template;
  };

  const rewrite = (text: string, params?: unknown[]): SqlitePlaceholderRewriteResult => {
    if (!params || params.length === 0) {
      return { sql: text, values: [] };
    }

    return bindSqlitePlaceholderTemplate(compile(text), params);
  };

  return { compile, rewrite };
}

const defaultSqlitePlaceholderCompiler = createSqlitePlaceholderCompiler();

export function rewriteSqlitePlaceholders(
  text: string,
  params?: unknown[]
): SqlitePlaceholderRewriteResult {
  return defaultSqlitePlaceholderCompiler.rewrite(text, params);
}
