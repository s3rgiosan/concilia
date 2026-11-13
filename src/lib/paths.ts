/** The last segment of a file path, split on `/` or `\`. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
