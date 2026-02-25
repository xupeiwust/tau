#!/usr/bin/env tsx

import process from 'node:process';

const [command] = process.argv.slice(2);

if (command) {
  const { run } = await import('./repos/commands.js');
  run(process.argv.slice(2));
} else {
  const { launch } = await import('./repos/ui.js');
  launch();
}
