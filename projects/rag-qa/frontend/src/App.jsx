import { useState } from 'react';
import { addDocument, ask } from './api.js';

export default function App() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [documents, setDocuments] = useState([]);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function run(label, action) {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  const onIngest = (event) => {
    event.preventDefault();
    run('ingest', async () => {
      const created = await addDocument(title, text);
      setDocuments((current) => [...current, created]);
      setTitle('');
      setText('');
    });
  };

  const onAsk = (event) => {
    event.preventDefault();
    run('ask', async () => setResult(await ask(question)));
  };

  return (
    <main>
      <h1>RAG Q&amp;A</h1>
      <p className="lede">Index documents, then ask questions that are answered only from them.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="columns">
        <section>
          <h2>1. Add a document</h2>
          <form onSubmit={onIngest}>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            </label>
            <label>
              Text
              <textarea value={text} onChange={(e) => setText(e.target.value)} required rows={10} />
            </label>
            <button disabled={busy === 'ingest'}>{busy === 'ingest' ? 'Indexing…' : 'Index document'}</button>
          </form>
          {documents.length > 0 && (
            <ul className="documents">
              {documents.map((doc, index) => (
                <li key={index}>
                  {doc.title} <span>{doc.chunks} chunks</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>2. Ask a question</h2>
          <form onSubmit={onAsk}>
            <label>
              Question
              <input value={question} onChange={(e) => setQuestion(e.target.value)} required minLength={3} />
            </label>
            <button disabled={busy === 'ask'}>{busy === 'ask' ? 'Thinking…' : 'Ask'}</button>
          </form>

          {result && (
            <div className="answer">
              <p>{result.answer}</p>
              {!result.grounded && <p className="note">No indexed passage was relevant enough to answer from.</p>}
              {result.sources.length > 0 && (
                <ol>
                  {result.sources.map((source, index) => (
                    <li key={index}>
                      <strong>{source.document}</strong> <span>score {source.score.toFixed(2)}</span>
                      <blockquote>{source.text}</blockquote>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
