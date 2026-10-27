import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const validateTranscriptPath = (candidate: string, trustedRoots: string[]): string => {
  const resolved = realpathSync(candidate); const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('unsafe_transcript_file');
  const allowed = trustedRoots.map(root => realpathSync(root)).some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('transcript_outside_trusted_root');
  return resolved;
};
