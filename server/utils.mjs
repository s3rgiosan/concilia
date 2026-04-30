import { writeFileSync, renameSync } from 'node:fs';

export function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}
