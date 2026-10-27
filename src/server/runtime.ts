export const assertSupportedRuntime = (): void => {
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 11 || (minor === 11 && patch < 1)) throw new Error(`unsupported_node_runtime:${process.version}; use Node 24.11.1 via .nvmrc`);
};
