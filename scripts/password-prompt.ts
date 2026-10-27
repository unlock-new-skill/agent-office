import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

let pipedLines: AsyncIterator<string> | undefined;

/** Terminal escape sequences (bracketed-paste markers, arrow keys, …) are keystrokes, never password characters. */
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-9;?]*[~A-Za-z]|O[A-Za-z]|.)/g;

export const readPassword = async (label: string): Promise<string> => {
  if (!input.isTTY || !input.setRawMode) {
    // Piped input: one shared line reader so consecutive prompts consume consecutive lines.
    output.write(label);
    pipedLines ??= createInterface({ input, terminal: false })[Symbol.asyncIterator]();
    const next = await pipedLines.next();
    if (next.done) throw new Error('password_input_closed');
    return next.value;
  }
  output.write(label); input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = (error?: Error): void => { input.setRawMode(false); input.pause(); input.off('data', onData); output.write('\n'); if (error) reject(error); else resolve(password); };
    const onData = (chunk: string): void => {
      for (const character of chunk.replace(ESCAPE_SEQUENCE, '')) {
        if (character === '\n' || character === '\r' || character === '\u0004') return finish();
        if (character === '\u0003') return finish(new Error('setup_cancelled'));
        if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
        else if (character >= ' ') password += character;
      }
    };
    input.on('data', onData);
  });
};

/**
 * Asks for a new password until it is long enough and typed the same twice (3 attempts on a terminal, 1 when piped).
 * Prints the reason for a rejection instead of failing with a stack trace.
 */
export const readNewPassword = async (minLength: number): Promise<string> => {
  const attempts = input.isTTY ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const password = await readPassword(`New manager password (${minLength}+ characters, hidden): `);
    if (password.length < minLength || password.length > 256) {
      output.write(`Rejected: got ${password.length} characters, need ${minLength}-256.\n`);
      continue;
    }
    if (input.isTTY && await readPassword('Repeat password: ') !== password) { output.write('Rejected: the two entries differ.\n'); continue; }
    return password;
  }
  throw new Error('password_not_set');
};
