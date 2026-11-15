(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var WINDOW = 60;          // seconds of history on each chart
  var SAMPLE_EVERY = 5;     // ticks between chart samples (0.5 s)

  function el(name, attrs, parent) {
    var node = document.createElementNS(SVG, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

  /*
   * Small streaming line chart: one y axis, 2px lines, end dots, a crosshair that
   * snaps to the nearest sample, and one tooltip listing every series.
   */
  function LineChart(container, legend, opts) {
    this.c = container; this.opts = opts; this.samples = []; this.hover = null;
    this.svg = el('svg', { role: 'img', 'aria-label': opts.label }, container);
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    container.appendChild(this.tip);
    this.legendValues = {};
    if (legend) {
      for (var i = 0; i < opts.series.length; i++) {
        var s = opts.series[i], item = document.createElement('span'), key = document.createElement('i');
        key.className = 'key ' + s.cls;
        key.setAttribute('aria-hidden', 'true');
        var name = document.createElement('span'); name.textContent = s.label;
        var value = document.createElement('b'); value.className = 'num';
        item.appendChild(key); item.appendChild(name); item.appendChild(value);
        legend.appendChild(item);
        this.legendValues[s.key] = value;
      }
    }
    var self = this;
    container.addEventListener('pointermove', function (e) { self.hover = e.clientX; self.draw(); });
    container.addEventListener('pointerleave', function () { self.hover = null; self.draw(); });
    if (window.ResizeObserver) new ResizeObserver(function () { self.draw(); }).observe(container);
  }

  LineChart.prototype.set = function (samples) { this.samples = samples; this.draw(); };

  LineChart.prototype.draw = function () {
    var o = this.opts, svg = this.svg, samples = this.samples;
    var W = this.c.clientWidth || 600, H = 210;
    var m = { l: 38, r: 14, t: 12, b: 24 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var tEnd = samples.length ? samples[samples.length - 1].t : 0;
    var t1 = Math.max(WINDOW, tEnd), t0 = t1 - WINDOW;
    function x(t) { return m.l + (t - t0) / WINDOW * pw; }
    function y(v) { return m.t + ph - Math.min(v, o.yMax) / o.yMax * ph; }

    var i, k;
    for (i = 0; i < o.yTicks.length; i++) {
      var ty = y(o.yTicks[i]);
      el('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: ty, y2: ty }, svg);
      el('text', { class: 'axis num', x: m.l - 8, y: ty + 4, 'text-anchor': 'end' }, svg).textContent = o.yTicks[i];
    }
    for (var tt = Math.ceil(t0 / 10) * 10; tt <= t1; tt += 10) {
      el('text', { class: 'axis num', x: x(tt), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = tt + 's';
    }
    if (o.ref) {
      var ry = y(o.ref.value);
      el('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: ry, y2: ry }, svg);
      this.refLabel = { x: m.l + 6, y: ry - 6, text: o.ref.label };
    }

    for (k = 0; k < o.series.length; k++) {
      var s = o.series[k], d = '', pen = false, last = null;
      for (i = 0; i < samples.length; i++) {
        var v = samples[i][s.key];
        if (v === null || samples[i].t < t0) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(samples[i].t).toFixed(1) + ' ' + y(v).toFixed(1);
        pen = true; last = samples[i];
      }
      if (d) el('path', { class: 'line ' + s.cls, d: d }, svg);
      if (last && last === samples[samples.length - 1]) {
        el('circle', { class: 'dot ' + s.cls, cx: x(last.t), cy: y(last[s.key]), r: 4 }, svg);
      }
      if (this.legendValues[s.key]) {
        var now = samples.length ? samples[samples.length - 1][s.key] : null;
        this.legendValues[s.key].textContent = now === null ? 'restarting' : o.format(now);
      }
    }

    // The reference label is drawn after the lines, with a surface-coloured halo,
    // so it stays readable where a line passes behind it.
    if (o.ref) {
      if (this.refLabel.text) el('text', { class: 'ref-label', x: this.refLabel.x, y: this.refLabel.y }, svg).textContent = this.refLabel.text;
    }

    // Crosshair + tooltip
    if (this.hover === null || !samples.length) { this.tip.style.display = 'none'; return; }
    var rect = this.c.getBoundingClientRect();
    var px = (this.hover - rect.left) / rect.width * W;
    var best = null, bestDist = Infinity;
    for (i = 0; i < samples.length; i++) {
      if (samples[i].t < t0) continue;
      var dist = Math.abs(x(samples[i].t) - px);
      if (dist < bestDist) { bestDist = dist; best = samples[i]; }
    }
    if (!best) { this.tip.style.display = 'none'; return; }
    var bx = x(best.t);
    el('line', { class: 'cross', x1: bx, x2: bx, y1: m.t, y2: m.t + ph }, svg);
    for (k = 0; k < o.series.length; k++) {
      var val = best[o.series[k].key];
      if (val !== null) el('circle', { class: 'dot ' + o.series[k].cls, cx: bx, cy: y(val), r: 4 }, svg);
    }
    var tip = this.tip;
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    var head = document.createElement('div'); head.className = 't num';
    head.textContent = 'at ' + best.t.toFixed(1) + ' s';
    tip.appendChild(head);
    for (k = 0; k < o.series.length; k++) {
      var row = document.createElement('div'); row.className = 'row';
      var key = document.createElement('i'); key.className = 'key ' + o.series[k].cls;
      var b = document.createElement('b'); b.className = 'num';
      var value = best[o.series[k].key];
      b.textContent = value === null ? 'restarting' : o.format(value);
      var name = document.createElement('span'); name.textContent = o.series[k].label;
      row.appendChild(key); row.appendChild(b); row.appendChild(name);
      tip.appendChild(row);
    }
    tip.style.display = 'block';
    var scale = rect.width / W, left = bx * scale + 12;
    if (left + tip.offsetWidth > rect.width) left = bx * scale - tip.offsetWidth - 12;
    tip.style.transform = 'translate(' + Math.max(0, left) + 'px, 8px)';
  };

  // ---------- Simulation wiring ----------
  var sim = new BackpressureSim.Sim();
  var C = BackpressureSim.C;
  var samples = [];
  var ticks = 0;
  var running = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $ = function (id) { return document.getElementById(id); };
  var two = [
    { key: 'U', cls: 's2', label: 'Without backpressure' },
    { key: 'P', cls: 's1', label: 'With backpressure' }
  ];
  function series(prefix) {
    return two.map(function (s) { return { key: prefix + s.key, cls: s.cls, label: s.label }; });
  }

  var heapChart = new LineChart($('heap-chart'), $('heap-legend'), {
    label: 'JVM heap used over time for both consumers',
    series: series('heap'), yMax: 560, yTicks: [0, 128, 256, 384, 512],
    ref: { value: 512, label: 'Heap limit 512 MB' },
    format: function (v) { return fmt(v) + ' MB'; }
  });
  var thrChart = new LineChart($('thr-chart'), $('thr-legend'), {
    label: 'Workflow B throughput over time for both consumers',
    series: series('thrB'), yMax: 20, yTicks: [0, 5, 10, 15, 20],
    format: function (v) { return v.toFixed(1) + ' msg/s'; }
  });
  var limitChart = new LineChart($('limit-chart'), null, {
    label: 'Adaptive concurrency limit for workflow A over time',
    series: [{ key: 'limitA', cls: 's1', label: 'Concurrency limit' }], yMax: 20, yTicks: [0, 4, 8, 12, 16, 20],
    ref: { value: 12, label: '' },
    format: function (v) { return v.toFixed(1); }
  });

  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  var ICON_BAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6v8"/><path d="M12 18.5v.5"/></svg>';

  function status(node, system) {
    var down = system.status === 'restarting';
    var state = down ? 'critical' : 'good';
    if (node.getAttribute('data-state') === state) return;
    node.setAttribute('data-state', state);
    node.className = 'pill ' + state;
    node.innerHTML = (down ? ICON_BAD : ICON_OK) + '<span></span>';
    node.lastChild.textContent = down ? 'Restarting after OutOfMemoryError' : 'Running';
  }

  function renderSystem(prefix, system) {
    var down = system.status === 'restarting' && system.heap === 0;
    var heap = down ? 0 : system.heap;
    $(prefix + '-heap').textContent = down ? 'restarting' : fmt(heap) + ' / ' + C.heapMax + ' MB';
    var meter = $(prefix + '-meter'), share = heap / C.heapMax;
    meter.style.width = Math.min(100, share * 100) + '%';
    meter.className = share >= 0.9 ? 'crit' : share >= 0.7 ? 'warn' : '';
    $(prefix + '-crashes').textContent = system.crashes;
    $(prefix + '-lag').textContent = fmt(system.lag.A + system.lag.B);
    $(prefix + '-done').textContent = fmt(system.delivered.A + system.delivered.B);
    status($(prefix + '-status'), system);
  }

  function renderTiles() {
    renderSystem('u', sim.unprotected);
    renderSystem('p', sim.protected);
  }

  function renderCharts() {
    heapChart.set(samples); thrChart.set(samples); limitChart.set(samples);
  }

  function pushSample() {
    samples.push(sim.sample());
    while (samples.length && samples[0].t < sim.t - WINDOW - 1) samples.shift();
  }

  function step() {
    sim.tick();
    ticks++;
    renderTiles();
    if (ticks % SAMPLE_EVERY === 0) { pushSample(); renderCharts(); }
  }

  function updateHint() {
    var hint = $('hint'), u = sim.unprotected;
    while (hint.firstChild) hint.removeChild(hint.firstChild);
    var b = document.createElement('b'), text;
    if (u.crashes > 0) {
      b.textContent = 'What happened: ';
      text = 'the unprotected consumer ran out of heap and restarted ' + u.crashes +
        (u.crashes === 1 ? ' time' : ' times') + '. Each restart redelivers everything it was holding, and the backlog it comes back to is bigger than before. The protected one left the excess in Kafka and kept workflow B flowing. Press Reset to start again.';
    } else if (sim.params.slowA) {
      b.textContent = 'Watch the heap: ';
      text = 'workflow A now completes far fewer messages than arrive. The unprotected consumer keeps polling them into memory; the protected one stops admitting them.';
    } else {
      b.textContent = 'Try it: ';
      text = 'press “Slow down workflow A\'s downstream”. It makes that system 6 times slower, the kind of incident a third-party API has on a bad day.';
    }
    hint.appendChild(b);
    hint.appendChild(document.createTextNode(text));
  }

  // Controls
  var slow = $('slow'), pause = $('pause');
  slow.addEventListener('click', function () {
    sim.params.slowA = !sim.params.slowA;
    slow.setAttribute('aria-pressed', String(sim.params.slowA));
    slow.textContent = sim.params.slowA ? 'Downstream is slow · click to restore' : 'Slow down workflow A\'s downstream';
    updateHint();
  });
  $('rate').addEventListener('input', function (e) {
    sim.params.rateA = Number(e.target.value);
    $('rate-out').textContent = e.target.value + ' msg/s';
  });
  $('size').addEventListener('input', function (e) {
    sim.params.sizeA = Number(e.target.value);
    $('size-out').textContent = e.target.value + ' MB';
  });
  function setRunning(value) {
    running = value;
    pause.textContent = running ? 'Pause' : 'Resume';
  }
  pause.addEventListener('click', function () { setRunning(!running); });
  $('reset').addEventListener('click', function () {
    var keep = sim.params;
    sim.reset();
    sim.params = keep;
    sim.params.slowA = false;
    slow.setAttribute('aria-pressed', 'false');
    slow.textContent = 'Slow down workflow A\'s downstream';
    samples = []; ticks = 0;
    renderTiles(); renderCharts(); updateHint();
    setRunning(true);
  });
  document.addEventListener('themechange', renderCharts);

  var lastCrashes = 0;
  setInterval(function () {
    if (!running || document.hidden) return;
    step();
    if (sim.unprotected.crashes !== lastCrashes) { lastCrashes = sim.unprotected.crashes; updateHint(); }
  }, BackpressureSim.DT * 1000);

  setRunning(running);
  renderTiles();
  pushSample();
  renderCharts();

  // Exposed for automated checks.
  window.__demo = { sim: sim, step: step };
})();
