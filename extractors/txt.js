import { readFile } from 'fs/promises';

export async function extractTextFile(filePath) {
  return await readFile(filePath, 'utf-8');
}
