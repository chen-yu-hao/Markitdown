import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Reuse the previous profile before Chromium starts or acquires its instance lock.
 * Keeping files in place preserves recovery data and permits rollback after a rename. */
export function installedDataDirectory(currentDirectory: string): string {
  const current = path.resolve(currentDirectory);
  const legacy = path.join(path.dirname(current), 'Markedown');
  if (current === legacy || !existsSync(legacy)) return current;
  if (existsSync(current) && readdirSync(current).length > 0) return current;
  return legacy;
}
