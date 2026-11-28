#!/usr/bin/env node
import { main } from '../src/cli.ts';

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
