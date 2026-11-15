const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

async function post(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const detail = typeof problem.detail === 'string' ? problem.detail : `request failed (${response.status})`;
    throw new Error(detail);
  }
  return response.json();
}

export const addDocument = (title, text) => post('/documents', { title, text });
export const ask = (question, topK = 4) => post('/ask', { question, top_k: topK });
