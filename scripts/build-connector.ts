import { build } from 'vite';

// Bundles the agent-machine connector (hook + MCP server + installer) into one self-contained ESM file that the
// daemon serves at /connector/agent-office.mjs, so agent machines need Node.js but no repository checkout.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: 'src/connector/cli.ts',
    outDir: 'dist/connector',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'agent-office.mjs' } },
  },
  ssr: { noExternal: true, target: 'node' },
});
