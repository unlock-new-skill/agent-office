export const logger = {
  error: (...values: unknown[]): void => { process.stderr.write(`${values.map(String).join(' ')}\n`); },
  info: (...values: unknown[]): void => { process.stderr.write(`${values.map(String).join(' ')}\n`); },
};
