import { readFile } from 'fs/promises';
import pdf from 'pdf-parse';

export async function extractPDFText(filePath) {
  const dataBuffer = await readFile(filePath);
  const data = await pdf(dataBuffer);
  return data.text || '';
}
