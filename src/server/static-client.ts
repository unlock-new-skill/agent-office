import { readFile } from 'node:fs/promises';
import path from 'node:path';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
export const readClientAsset = async (requestPath: string): Promise<{ body: Buffer; contentType: string } | null> => {
  const root = path.resolve(process.cwd(), 'dist/client'); const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  const candidate = path.resolve(root, relative); if (!candidate.startsWith(`${root}${path.sep}`)) return null;
  try { const body = await readFile(candidate); return { body, contentType: contentTypes[path.extname(candidate)] ?? 'application/octet-stream' }; }
  catch { if (path.extname(candidate)) return null; const body = await readFile(path.join(root, 'index.html')); return { body, contentType: 'text/html; charset=utf-8' }; }
};
