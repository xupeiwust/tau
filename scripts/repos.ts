import process from 'node:process';

const [command] = process.argv.slice(2);

if (command) {
  const { run } = await import('./repos-manifest/commands.ts');
  run(process.argv.slice(2));
} else {
  const { tsImport } = await import('tsx/esm/api'); // eslint-disable-line import-x/no-extraneous-dependencies -- workspace root dep
  const { launch } = (await tsImport('./repos-manifest/ui.tsx', import.meta.url)) as {
    launch: () => void;
  };
  launch();
}
