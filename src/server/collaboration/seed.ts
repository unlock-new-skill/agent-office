import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { OfficeConfigSchema, type OfficeConfig } from '../../shared/contracts.js';

/** Parses office.yaml text with the safe (JSON-compatible) schema and validates it. */
export const parseOfficeConfig = (text: string): OfficeConfig => OfficeConfigSchema.parse(load(text, { json: true }));

/** Reads office.yaml, falling back to the committed example; returns null when neither exists. */
export const readOfficeConfig = (paths: string[]): OfficeConfig | null => {
  const found = paths.find(candidate => existsSync(candidate));
  return found ? parseOfficeConfig(readFileSync(found, 'utf8')) : null;
};
