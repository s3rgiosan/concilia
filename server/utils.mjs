import { openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';

/**
 * Atomically write `data` to `filePath`. Writes to a sibling .tmp file first,
 * fsyncs, then renames over the destination so a crash mid-write cannot
 * leave a half-written file at the canonical path.
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 */
export function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}
