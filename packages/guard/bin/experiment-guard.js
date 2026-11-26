#!/usr/bin/env node
// Runs the compiled CLI when it exists (npm installs), otherwise the TypeScript source (Node 22.18+).
import { existsSync } from 'node:fs';

const dist = new URL('../dist/cli.js', import.meta.url);
const entry = existsSync(dist) ? dist : new URL('../src/cli.ts', import.meta.url);
const { main } = await import(entry.href);
await main();
