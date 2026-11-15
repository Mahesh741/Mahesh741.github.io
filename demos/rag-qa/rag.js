/*
 * A small retrieval pipeline that runs in the browser (and in Node for tests):
 *   chunk -> index (BM25) -> retrieve -> answer from the retrieved text, with citations.
 *
 * The full project in projects/rag-qa has the same shape, with OpenAI embeddings in Qdrant
 * for retrieval and an LLM for the answer. Nothing here calls a server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rag = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STOPWORDS = {};
  ('a about an and are as at be been by can could did do does for from had has have he her him his how i ' +
   'in is it its me my of on or our she so tell that the their them they this to us was we were what when ' +
   'where which who why will with would you your also any been done get keep know long make many much ' +
   'one other some there use used using work worked working build built').split(' ').forEach(function (w) { STOPWORDS[w] = true; });

  // Query expansion: everyday words mapped to the vocabulary the documents use. A dense
  // embedding model does this implicitly; a keyword index needs it spelled out.
  var SYNONYMS = {
    study: ['education'], studied: ['education'], college: ['education'], university: ['education'],
    degree: ['education'], qualification: ['education'], graduate: ['education'],
    mobile: ['phone'], telephone: ['phone'], reach: ['contact'], mail: ['email'],
    machine: ['deep', 'neural'], ml: ['deep', 'learning', 'neural'], ai: ['langgraph', 'rag'],
    db: ['databases'], database: ['databases'], sql: ['databases'],
    client: ['integration', 'workflow'], tenant: ['workflow'], hurting: ['affect'], hurt: ['affect'],
    login: ['authentication'], auth: ['authentication'], security: ['authentication', 'authorization'],
    monitoring: ['observability'], logs: ['observability'], crash: ['exhaust'], oom: ['heap'],
    job: ['engineer'], company: ['acuver'], employer: ['acuver'], skills: ['stack'], languages: ['language']
  };

  // Light stemming so "retries", "retried" and "retry" meet in the index.
  function stem(word) {
    var w = word;
    if (w.length > 4 && /ies$/.test(w)) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && /ied$/.test(w)) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 5 && /ing$/.test(w)) w = w.slice(0, -3);
    else if (w.length > 4 && /ed$/.test(w)) w = w.slice(0, -2);
    if (w.length > 4 && /e$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && /(.)\1$/.test(w) && !/(ss|ll|ee|oo)$/.test(w)) w = w.slice(0, -1);
    return w;
  }

  function words(text) {
    return (text.toLowerCase().match(/[a-z0-9]+(?:[.+#-][a-z0-9]+)*/g) || []);
  }

  // Index terms: lowercased, split on punctuation inside tokens, stopwords removed, stemmed.
  function terms(text) {
    var out = [];
    words(text).forEach(function (token) {
      token.split(/[.+#-]/).forEach(function (part) {
        if (!part || STOPWORDS[part]) return;
        var stemmed = stem(part);
        if (!STOPWORDS[stemmed]) out.push(stemmed);
      });
    });
    return out;
  }

  function sentences(text) {
    return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  /*
   * Sentence-aware chunking with overlap: sentences are packed into chunks of up to
   * maxWords words, and each chunk starts with the last sentence of the previous one, so
   * a fact that spans a boundary is still retrievable from one chunk.
   */
  function chunk(text, maxWords) {
    var list = sentences(text), chunks = [], i = 0;
    while (i < list.length) {
      var current = [], count = 0, j = i;
      while (j < list.length) {
        var n = list[j].split(' ').length;
        if (current.length && count + n > maxWords) break;
        current.push(list[j]); count += n; j++;
      }
      chunks.push(current.join(' '));
      if (j >= list.length) break;
      i = Math.max(i + 1, j - 1);
    }
    return chunks;
  }

  function Index(options) {
    options = options || {};
    this.maxWords = options.maxWords || 60;
    this.k1 = 1.2; this.b = 0.75;
    this.chunks = [];      // { id, document, position, text, terms, tf }
    this.df = {};          // term -> number of chunks containing it
    this.totalTerms = 0;
  }

  Index.prototype.add = function (title, text) {
    var pieces = chunk(text, this.maxWords), self = this;
    pieces.forEach(function (piece, position) {
      var list = terms(title + ' ' + piece), tf = {};
      list.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      Object.keys(tf).forEach(function (t) { self.df[t] = (self.df[t] || 0) + 1; });
      self.totalTerms += list.length;
      self.chunks.push({ id: self.chunks.length, document: title, position: position, text: piece, length: list.length, tf: tf });
    });
    return pieces.length;
  };

  Index.prototype.idf = function (term) {
    var n = this.df[term] || 0, N = this.chunks.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  // Query terms, plus expansions for words the index would otherwise miss.
  function expand(question) {
    var query = [], added = [], seen = {};
    terms(question).forEach(function (t) { if (!seen[t]) { seen[t] = true; query.push(t); } });
    words(question).forEach(function (w) {
      (SYNONYMS[w] || []).forEach(function (extra) {
        var t = stem(extra);
        if (!seen[t]) { seen[t] = true; added.push(t); }
      });
    });
    return { query: query, added: added };
  }

  // BM25 over the chunks. Returns the best topK with the query terms each one matched.
  Index.prototype.search = function (question, topK) {
    var self = this, expanded = expand(question), query = expanded.query.concat(expanded.added);
    var average = this.totalTerms / Math.max(1, this.chunks.length);
    var results = this.chunks.map(function (c) {
      var score = 0, matched = [];
      query.forEach(function (t) {
        var tf = c.tf[t];
        if (!tf) return;
        matched.push(t);
        score += self.idf(t) * tf * (self.k1 + 1) / (tf + self.k1 * (1 - self.b + self.b * c.length / average));
      });
      return { chunk: c, score: score, matched: matched };
    }).filter(function (r) { return r.score > 0; });
    results.sort(function (a, b) { return b.score - a.score; });
    return {
      query: query, original: expanded.query, added: expanded.added,
      known: query.filter(function (t) { return self.df[t]; }), hits: results.slice(0, topK || 4)
    };
  };

  /*
   * Build an answer from the retrieved chunks only: the sentences that best cover the
   * question, each tagged with the number of the source it came from. If retrieval found
   * nothing that covers enough of the question, say so instead of guessing.
   */
  Index.prototype.ask = function (question, topK) {
    var self = this, result = this.search(question, topK || 4);
    var weight = function (list) { return list.reduce(function (sum, t) { return sum + self.idf(t); }, 0); };
    var best = result.hits[0];
    // Grounding check, two conditions. The best chunk must cover at least half of the query
    // terms the index knows, counting rarer terms for more. And at most half of the words
    // asked may be absent from every document: a question about something the documents
    // never mention must be refused, not answered from whatever happens to match.
    var total = weight(result.known);
    var coverage = best && total > 0 ? weight(best.matched) / total : 0;
    var absent = result.original.filter(function (t) { return !self.df[t]; }).length;
    var absentShare = result.original.length ? (result.added.length ? 0 : absent / result.original.length) : 1;
    var base = { sources: result.hits, query: result.original, added: result.added, known: result.known, coverage: coverage };
    if (!best || coverage < 0.5 || absentShare > 0.5) {
      base.grounded = false; base.answer = [];
      return base;
    }

    var candidates = [];
    result.hits.forEach(function (hit, sourceIndex) {
      if (hit.score < best.score * 0.6) return;
      sentences(hit.chunk.text).forEach(function (sentence, order) {
        var present = {}, matched = [];
        terms(sentence).forEach(function (t) { present[t] = true; });
        result.query.forEach(function (t) { if (present[t]) matched.push(t); });
        if (!matched.length) return;
        candidates.push({ text: sentence, source: sourceIndex + 1, order: order, matched: matched,
          score: weight(matched) * hit.score / best.score });
      });
    });
    candidates.sort(function (a, b) { return b.score - a.score; });

    // Take the strongest sentence, then at most two more that are nearly as strong and
    // cover a query term the answer does not have yet. Overlapping chunks repeat
    // sentences, so identical text is used once.
    var chosen = [], covered = {}, texts = {};
    candidates.forEach(function (c) {
      if (chosen.length >= 3 || texts[c.text]) return;
      var adds = c.matched.some(function (t) { return !covered[t]; });
      if (chosen.length && (!adds || c.score < candidates[0].score * 0.6)) return;
      chosen.push(c); texts[c.text] = true;
      c.matched.forEach(function (t) { covered[t] = true; });
    });
    chosen.sort(function (a, b) { return a.source - b.source || a.order - b.order; });
    base.grounded = true; base.answer = chosen;
    return base;
  };

  return { Index: Index, chunk: chunk, terms: terms, stem: stem, sentences: sentences };
});
