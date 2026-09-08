import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/unit/mobile/*.test.ts'], environment: 'node', passWithNoTests: false } });
