import mammoth from 'mammoth';

export async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}
