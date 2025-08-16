import { createWorker } from 'tesseract.js';

export async function extractImageText(filePath) {
  const worker = await createWorker('eng');
  const { data: { text } } = await worker.recognize(filePath);
  await worker.terminate();
  return text || '';
}
