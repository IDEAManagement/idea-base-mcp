#!/usr/bin/env node
// CLI entry point action.yml invokes. All logic lives in github-action.js so
// it can be imported and unit tested directly (see github-action.test.js);
// this file exists only so action.yml has a plain `node <path>` to run.

import { run } from './github-action.js';

run()
  .then((result) => {
    if (!result.ok) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
