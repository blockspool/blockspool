import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@blockspool/core/services': path.resolve(__dirname, 'packages/core/src/services/index.ts'),
      '@blockspool/core/repos': path.resolve(__dirname, 'packages/core/src/repos/index.ts'),
      '@blockspool/core/scout': path.resolve(__dirname, 'packages/core/src/scout/index.ts'),
      '@blockspool/core/db': path.resolve(__dirname, 'packages/core/src/db/index.ts'),
      '@blockspool/core/utils': path.resolve(__dirname, 'packages/core/src/utils/index.ts'),
      '@blockspool/core/exec': path.resolve(__dirname, 'packages/core/src/exec/index.ts'),
      '@blockspool/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@blockspool/sqlite': path.resolve(__dirname, 'packages/sqlite/src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
    include: ['packages/*/src/test/**/*.test.ts'],
  },
});
