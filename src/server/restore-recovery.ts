import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const JournalSchema = z.object({
  version: z.literal(1),
  target: z.string(),
  temporary: z.string(),
  previous: z.string(),
  oldFiles: z.array(z.string()).max(3),
  oldNames: z.array(z.string()).max(3),
  replacementHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type RestoreJournal = Omit<z.infer<typeof JournalSchema>, 'version' | 'replacementHash'>;
const journalName = (dataDir: string): string => path.join(dataDir, 'restore-journal.json');

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const privateFileExists = (filename: string): boolean => {
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('unsafe_restore_file');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const validatePaths = (dataDir: string, journal: RestoreJournal): void => {
  const root = path.resolve(dataDir);
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error('unsafe_restore_directory');
  }
  const target = path.join(root, 'agent-office.sqlite');
  if (journal.target !== target || !journal.temporary.startsWith(`${target}.restore-`) || !journal.previous.startsWith(`${target}.before-restore-`)) {
    throw new Error('invalid_restore_paths');
  }
  if (path.dirname(journal.temporary) !== root || path.dirname(journal.previous) !== root) throw new Error('invalid_restore_paths');
  if (journal.oldFiles.length !== journal.oldNames.length || new Set(journal.oldFiles).size !== journal.oldFiles.length) throw new Error('invalid_restore_moves');
  for (const [index, original] of journal.oldFiles.entries()) {
    if (![target, `${target}-wal`, `${target}-shm`].includes(original) || journal.oldNames[index] !== `${journal.previous}${original.slice(target.length)}`) {
      throw new Error('invalid_restore_moves');
    }
  }
};

const syncDirectory = (dataDir: string): void => {
  const fd = openSync(dataDir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

const fileHash = (filename: string): string => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(filename, 'r');
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest('hex');
};

export const writeRestoreJournal = (dataDir: string, journal: RestoreJournal): void => {
  validatePaths(dataDir, journal);
  const file = journalName(dataDir);
  if (privateFileExists(file)) throw new Error('restore_already_pending');
  if (!privateFileExists(journal.temporary)) throw new Error('restore_replacement_missing');
  const replacement = openSync(journal.temporary, 'r+');
  try { fsyncSync(replacement); } finally { closeSync(replacement); }
  const record = JournalSchema.parse({ ...journal, version: 1, replacementHash: fileHash(journal.temporary) });
  const temporaryJournal = `${file}.tmp-${randomUUID()}`;
  const fd = openSync(temporaryJournal, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporaryJournal, file);
  syncDirectory(dataDir);
};

export const clearRestoreJournal = (dataDir: string): void => {
  const file = journalName(dataDir);
  if (privateFileExists(file)) { unlinkSync(file); syncDirectory(dataDir); }
};

export const recoverRestore = (dataDir: string): void => {
  const file = journalName(dataDir);
  if (!privateFileExists(file)) return;
  if (lstatSync(file).size > 16 * 1024) throw new Error('invalid_restore_journal');
  const journal = JournalSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  validatePaths(dataDir, journal);
  const hasReplacement = privateFileExists(journal.temporary);

  if (hasReplacement) {
    if (fileHash(journal.temporary) !== journal.replacementHash) throw new Error('restore_replacement_corrupt');
    // Finish retiring the entire old file set before installing the new main database.
    const moves = journal.oldFiles.map((original, index) => {
      const archive = journal.oldNames[index]!;
      const originalExists = privateFileExists(original);
      const archiveExists = privateFileExists(archive);
      if (originalExists === archiveExists) throw new Error('ambiguous_restore_state');
      return { original, archive, originalExists };
    });
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${journal.target}${suffix}`;
      if (!journal.oldFiles.includes(sidecar) && privateFileExists(sidecar)) throw new Error('unexpected_restore_sidecar');
    }
    if (!journal.oldFiles.includes(journal.target) && privateFileExists(journal.target)) throw new Error('ambiguous_restore_state');
    for (const move of moves) {
      if (move.originalExists) { renameSync(move.original, move.archive); syncDirectory(dataDir); }
    }
    renameSync(journal.temporary, journal.target);
    syncDirectory(dataDir);
  }

  if (!privateFileExists(journal.target) || fileHash(journal.target) !== journal.replacementHash) throw new Error('restore_target_unverified');
  for (const archive of journal.oldNames) if (!privateFileExists(archive)) throw new Error('restore_archive_missing');
  for (const suffix of ['-wal', '-shm']) {
    if (privateFileExists(`${journal.target}${suffix}`)) throw new Error('unexpected_restore_sidecar');
  }
  clearRestoreJournal(dataDir);
};
