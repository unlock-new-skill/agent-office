import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const sha256File = async (filename: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
};
