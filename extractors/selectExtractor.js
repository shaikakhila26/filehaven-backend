import path from 'path';
import { extractPDFText } from './pdf.js';
import { extractTextFile } from './txt.js';
import { extractDocxText } from './docx.js';
import { extractImageText } from './ocr.js';

// Add more as needed...
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff'];

export async function extractFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf')          return await extractPDFText(filePath);
  if (ext === '.txt')          return await extractTextFile(filePath);
  if (ext === '.docx')         return await extractDocxText(filePath);
  if (IMAGE_EXTS.includes(ext))return await extractImageText(filePath);

  return '';
}
