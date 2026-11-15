(function () {
  'use strict';

  var SAMPLES = [
    'What did Mahesh do with Kafka?',
    'Which databases has he used?',
    'How does the order system avoid charging a customer twice?',
    'Has he worked on login and security?',
    'How can I contact him?',
    'What is the capital of Mongolia?'
  ];

  var $ = function (id) { return document.getElementById(id); };
  var index = new Rag.Index();
  var documents = [];

  function node(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function addDocument(title, text) {
    var chunks = index.add(title, text);
    documents.push({ title: title, chunks: chunks });
    return chunks;
  }

  function renderDocuments() {
    var list = $('docs');
    clear(list);
    documents.forEach(function (doc) {
      var item = node('li');
      item.appendChild(node('b', null, doc.title));
      item.appendChild(node('span', 'num', doc.chunks + (doc.chunks === 1 ? ' chunk' : ' chunks')));
      list.appendChild(item);
    });
    $('stats').textContent = documents.length + ' documents · ' + index.chunks.length + ' chunks · ' +
      Object.keys(index.df).length + ' distinct terms';
  }

  // Text with the matched query terms highlighted. Built from text nodes, so pasted
  // documents can never inject markup.
  function highlighted(text, matched) {
    var p = node('p'), wanted = {};
    matched.forEach(function (t) { wanted[t] = true; });
    text.split(/([A-Za-z0-9]+)/).forEach(function (piece) {
      if (!piece) return;
      var stems = Rag.terms(piece);
      if (stems.length === 1 && wanted[stems[0]]) p.appendChild(node('mark', null, piece));
      else p.appendChild(document.createTextNode(piece));
    });
    return p;
  }

  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  var ICON_NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>';

  function ask(question) {
    question = question.trim();
    if (!question) return;
    var result = index.ask(question, 4);
    var answer = $('answer'), verdict = $('verdict');
    clear(answer);

    verdict.className = 'pill ' + (result.grounded ? 'good' : 'neutral');
    verdict.innerHTML = result.grounded ? ICON_OK : ICON_NO;
    verdict.appendChild(document.createTextNode(result.grounded ? 'Grounded in sources' : 'Not answered'));

    var used = {};
    if (result.grounded) {
      var p = node('p', 'answer-text');
      result.answer.forEach(function (sentence, i) {
        if (i) p.appendChild(document.createTextNode(' '));
        p.appendChild(document.createTextNode(sentence.text));
        p.appendChild(node('span', 'cite num', String(sentence.source)));
        used[sentence.source] = true;
      });
      answer.appendChild(p);
    } else {
      answer.appendChild(node('p', 'answer-text refused',
        'I could not find anything about that in the indexed documents, so I am not going to guess.'));
    }

    // Step 1: query terms
    var terms = $('terms');
    clear(terms);
    result.query.forEach(function (t) {
      terms.appendChild(node('span', 'tag mono' + (index.df[t] ? '' : ' unknown'), t));
    });
    result.added.forEach(function (t) { terms.appendChild(node('span', 'tag mono added', '+ ' + t)); });
    if (!result.query.length && !result.added.length) terms.appendChild(node('span', 'note', 'No searchable terms: every word was a stopword.'));
    var absent = result.query.filter(function (t) { return !index.df[t]; }).length;
    var notes = ['Stopwords removed, the rest stemmed.'];
    if (result.added.length) notes.push('Dashed terms were added by query expansion.');
    if (absent) notes.push('Struck-through terms appear in no document.');
    $('terms-note').textContent = notes.join(' ');

    // Step 2: retrieved passages
    var hits = $('hits');
    clear(hits);
    if (!result.sources.length) hits.appendChild(node('p', 'note', 'No passage shares a term with the question.'));
    var top = result.sources.length ? result.sources[0].score : 1;
    result.sources.forEach(function (hit, i) {
      var box = node('div', 'hit' + (used[i + 1] ? ' used' : ''));
      var head = node('div', 'hit-head');
      head.appendChild(node('span', 'rank num', String(i + 1)));
      head.appendChild(node('b', null, hit.chunk.document));
      head.appendChild(node('span', null, 'chunk ' + (hit.chunk.position + 1)));
      var score = node('span', 'score num');
      var bar = node('span', 'scorebar'); var fill = node('i');
      fill.style.width = Math.round(hit.score / top * 100) + '%';
      bar.appendChild(fill); bar.setAttribute('aria-hidden', 'true');
      score.appendChild(bar);
      score.appendChild(document.createTextNode('BM25 ' + hit.score.toFixed(2)));
      head.appendChild(score);
      box.appendChild(head);
      box.appendChild(highlighted(hit.chunk.text, hit.matched));
      hits.appendChild(box);
    });

    // Step 3: grounding
    var percent = Math.round(result.coverage * 100);
    var text;
    if (result.grounded) {
      text = 'The top passage covers ' + percent + '% of the question\'s weighted terms, above the 50% threshold, so an answer was assembled from the outlined passages.';
    } else if (!result.sources.length || absent > result.query.length / 2) {
      text = 'Most of what was asked appears in no document, so the question is outside what the index can support. A language model would not be called here either.';
    } else {
      text = 'The top passage covers only ' + percent + '% of the question\'s weighted terms, below the 50% threshold, so no answer was produced.';
    }
    $('grounding').textContent = text;
    $('trace').hidden = false;
  }

  // ---------- Wiring ----------
  window.RAG_CORPUS.forEach(function (doc) { addDocument(doc.title, doc.text); });
  renderDocuments();

  var samples = $('samples');
  SAMPLES.forEach(function (q) {
    var button = node('button', null, q);
    button.type = 'button';
    button.addEventListener('click', function () { $('question').value = q; ask(q); });
    samples.appendChild(button);
  });

  $('ask-form').addEventListener('submit', function (event) {
    event.preventDefault();
    ask($('question').value);
  });

  $('add-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var title = $('doc-title').value.trim(), text = $('doc-text').value.trim();
    if (!title || !text) return;
    addDocument(title, text);
    renderDocuments();
    $('doc-title').value = ''; $('doc-text').value = '';
    if ($('question').value.trim()) ask($('question').value);
  });

  window.__demo = { ask: ask, index: index };
})();
