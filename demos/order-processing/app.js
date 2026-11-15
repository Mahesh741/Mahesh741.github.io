(function () {
  'use strict';

  // Mirrors application.yml in projects/order-processing.
  var MAIN = 'orders.created';
  var ATTEMPTS = 4;                    // 1 delivery + 3 retries
  var DELAYS = [1000, 2000, 4000];     // backoff before retry-0, retry-1, retry-2
  var PROCESSING_MS = 500;
  var TOPICS = [
    { name: MAIN, role: 'main topic' },
    { name: MAIN + '-retry-0', role: 'waits 1 s' },
    { name: MAIN + '-retry-1', role: 'waits 2 s' },
    { name: MAIN + '-retry-2', role: 'waits 4 s' },
    { name: MAIN + '-dlt', role: 'dead-letter topic', dlt: true }
  ];
  var SKUS = ['SKU-KEYBOARD', 'SKU-MONITOR', 'SKU-HEADSET', 'SKU-WEBCAM', 'SKU-DOCK'];

  var now = 0;
  var nextId = 1041;
  var orders = [];            // newest first
  var deadLetters = [];       // newest first
  var queues = TOPICS.map(function () { return []; });   // messages waiting, per topic
  var busy = TOPICS.map(function () { return null; });   // message being consumed, per topic
  var charged = {};           // order id -> payment reference (idempotency)
  var outage = false;
  var lastEvent = null;
  var dirty = true;

  var $ = function (id) { return document.getElementById(id); };

  function log(text) {
    var line = document.createElement('div');
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = (now / 1000).toFixed(1).padStart(5, ' ') + 's  ';
    line.appendChild(t);
    line.appendChild(document.createTextNode(text));
    var box = $('log');
    box.insertBefore(line, box.firstChild);
    while (box.childNodes.length > 60) box.removeChild(box.lastChild);
  }

  function find(id) {
    for (var i = 0; i < orders.length; i++) if (orders[i].id === id) return orders[i];
    return null;
  }

  function publish(orderId, topicIndex, readyAt) {
    queues[topicIndex].push({ orderId: orderId, readyAt: readyAt, queuedAt: now });
    dirty = true;
  }

  function placeOrder(sku) {
    var order = { id: nextId++, sku: sku, status: 'PENDING', attempts: 0, reason: '' };
    orders.unshift(order);
    lastEvent = order.id;
    log('POST /api/orders → 202 Accepted, order #' + order.id + ' stored as PENDING');
    publish(order.id, 0, now);
    return order;
  }

  // What OrderProcessor.process() does with one event.
  function process(message, topicIndex) {
    var order = find(message.orderId);
    if (order.status !== 'PENDING') {
      log('#' + order.id + ' is already ' + order.status + ', duplicate event ignored');
      return;
    }
    order.attempts++;
    var error = null, retryable = true;
    if (order.sku.indexOf('UNKNOWN-') === 0) {
      error = 'SKU ' + order.sku + ' does not exist';
      retryable = false;
    } else if (!charged[order.id] && outage) {
      error = 'payment gateway is unavailable';
    }

    if (!error) {
      charged[order.id] = 'pay_' + order.id;
      order.status = 'COMPLETED';
      order.reason = '';
      log('#' + order.id + ' attempt ' + order.attempts + ': inventory reserved, payment captured → COMPLETED');
      return;
    }

    order.reason = error;
    var nextTopic = topicIndex + 1;
    if (!retryable) {
      log('#' + order.id + ' attempt ' + order.attempts + ' failed: ' + error + ' (not retryable) → ' + TOPICS[4].name);
      publish(order.id, 4, now);
    } else if (nextTopic >= ATTEMPTS) {
      // retry-2 was the fourth delivery in this chain: the retry budget is spent.
      log('#' + order.id + ' attempt ' + order.attempts + ' failed: ' + error + ' → retries exhausted → ' + TOPICS[4].name);
      publish(order.id, 4, now);
    } else {
      var delay = DELAYS[topicIndex];
      log('#' + order.id + ' attempt ' + order.attempts + ' failed: ' + error + ' → ' + TOPICS[nextTopic].name + ' (' + delay / 1000 + ' s backoff)');
      publish(order.id, nextTopic, now + delay);
    }
  }

  // What the @DltHandler does.
  function deadLetter(message) {
    var order = find(message.orderId);
    order.status = 'FAILED';
    deadLetters.unshift({ orderId: order.id, reason: order.reason, replayed: false });
    log('#' + order.id + ' dead-lettered after ' + order.attempts + (order.attempts === 1 ? ' attempt' : ' attempts') + ' → FAILED');
  }

  function replay(letter) {
    var order = find(letter.orderId);
    letter.replayed = true;
    order.status = 'PENDING';
    order.reason = '';
    log('POST /api/dead-letters/…/replay → #' + order.id + ' back on ' + MAIN + ' with fresh retries');
    publish(order.id, 0, now);
  }

  function tick(dt) {
    now += dt;
    for (var i = 0; i < TOPICS.length; i++) {
      var current = busy[i];
      if (current && now >= current.doneAt) {
        busy[i] = null;
        if (TOPICS[i].dlt) deadLetter(current); else process(current, i);
        dirty = true;
      }
      if (!busy[i] && queues[i].length && queues[i][0].readyAt <= now) {
        var message = queues[i].shift();
        message.doneAt = now + (TOPICS[i].dlt ? 250 : PROCESSING_MS);
        message.startedAt = now;
        busy[i] = message;
        dirty = true;
      }
    }
  }

  // ---------- Rendering ----------
  var ICONS = {
    COMPLETED: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
    FAILED: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6v8"/><path d="M12 18.5v.5"/></svg>',
    PENDING: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>'
  };
  var PILL = { COMPLETED: 'good', FAILED: 'critical', PENDING: 'neutral' };

  function pill(status) {
    var span = document.createElement('span');
    span.className = 'pill ' + PILL[status];
    span.innerHTML = ICONS[status];
    span.appendChild(document.createTextNode(status));
    return span;
  }

  function text(tag, value, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    node.textContent = value;
    return node;
  }

  var slotNodes = [];
  function buildPipeline() {
    var root = $('pipeline');
    TOPICS.forEach(function (topic) {
      var box = document.createElement('div');
      box.className = 'topic' + (topic.dlt ? ' dlt' : '');
      box.appendChild(text('h3', topic.name, 'mono'));
      box.appendChild(text('div', topic.role, 'role'));
      var slots = document.createElement('div');
      slots.className = 'slots';
      box.appendChild(slots);
      root.appendChild(box);
      slotNodes.push(slots);
    });
  }

  function chip(message, working, isDlt) {
    var order = find(message.orderId);
    var node = document.createElement('div');
    node.className = 'chip' + (working ? ' working' : '');
    node.appendChild(text('b', '#' + order.id));
    var state;
    if (working) state = isDlt ? 'recording dead letter' : order.status === 'PENDING' ? 'processing, attempt ' + (order.attempts + 1) : 'duplicate event';
    else if (message.readyAt > now) state = 'backing off';
    else state = 'queued';
    node.appendChild(text('span', state, 'state'));
    if (working || message.readyAt > now) {
      var bar = document.createElement('div'); bar.className = 'bar';
      var fill = document.createElement('i');
      fill.setAttribute('data-from', working ? message.startedAt : message.queuedAt);
      fill.setAttribute('data-to', working ? message.doneAt : message.readyAt);
      bar.appendChild(fill); node.appendChild(bar);
    }
    return node;
  }

  function render() {
    var i;
    for (i = 0; i < TOPICS.length; i++) {
      var slots = slotNodes[i];
      while (slots.firstChild) slots.removeChild(slots.firstChild);
      if (busy[i]) slots.appendChild(chip(busy[i], true, TOPICS[i].dlt));
      queues[i].forEach(function (m) { slots.appendChild(chip(m, false, false)); });
      if (!slots.firstChild) slots.appendChild(text('div', 'empty', 'empty'));
    }

    var body = $('orders');
    while (body.firstChild) body.removeChild(body.firstChild);
    orders.slice(0, 12).forEach(function (order) {
      var row = document.createElement('tr');
      row.appendChild(text('td', '#' + order.id, 'mono'));
      row.appendChild(text('td', order.sku, 'mono'));
      var status = document.createElement('td'); status.appendChild(pill(order.status)); row.appendChild(status);
      row.appendChild(text('td', String(order.attempts), 'num'));
      row.appendChild(text('td', order.reason || '–', 'reason'));
      body.appendChild(row);
    });

    var counts = { PENDING: 0, COMPLETED: 0, FAILED: 0 };
    orders.forEach(function (o) { counts[o.status]++; });
    var c = $('counts');
    while (c.firstChild) c.removeChild(c.firstChild);
    [['Completed', counts.COMPLETED], ['Pending', counts.PENDING], ['Failed', counts.FAILED]].forEach(function (pair) {
      var span = document.createElement('span');
      span.appendChild(text('b', String(pair[1]), 'num'));
      span.appendChild(document.createTextNode(' ' + pair[0].toLowerCase()));
      c.appendChild(span);
    });

    var dead = $('dead');
    while (dead.firstChild) dead.removeChild(dead.firstChild);
    if (!deadLetters.length) dead.appendChild(text('div', 'None yet. Orders land here when their retries run out.', 'empty'));
    deadLetters.slice(0, 6).forEach(function (letter) {
      var row = document.createElement('div'); row.className = 'row';
      var left = document.createElement('div');
      left.appendChild(text('b', 'Order #' + letter.orderId));
      left.appendChild(text('span', letter.reason, 'why'));
      row.appendChild(left);
      var button = text('button', letter.replayed ? 'Replayed' : 'Replay', 'btn small');
      button.type = 'button';
      button.disabled = letter.replayed;
      button.setAttribute('aria-label', (letter.replayed ? 'Replayed order ' : 'Replay order ') + letter.orderId);
      button.addEventListener('click', function () { replay(letter); updateHint(); });
      row.appendChild(button);
      dead.appendChild(row);
    });
    dirty = false;
  }

  function renderBars() {
    var fills = document.querySelectorAll('#pipeline .bar i');
    for (var i = 0; i < fills.length; i++) {
      var from = Number(fills[i].getAttribute('data-from')), to = Number(fills[i].getAttribute('data-to'));
      var share = to > from ? (now - from) / (to - from) : 1;
      fills[i].style.width = Math.max(0, Math.min(1, share)) * 100 + '%';
    }
  }

  function updateHint() {
    var hint = $('hint');
    var pendingReplay = deadLetters.some(function (d) { return !d.replayed && d.reason.indexOf('payment') === 0; });
    var lead, body;
    if (pendingReplay && outage) {
      lead = 'Next: ';
      body = 'the order is dead-lettered and marked FAILED. End the outage with the switch, then press Replay.';
    } else if (pendingReplay) {
      lead = 'Next: ';
      body = 'the gateway is healthy again. Press Replay on the dead letter to put the order back on the main topic.';
    } else if (outage) {
      lead = 'Outage on: ';
      body = 'place an order. Each failed attempt moves it one retry topic to the right, waiting 1, 2 and then 4 seconds.';
    } else {
      lead = 'Try it: ';
      body = 'switch the payment gateway to an outage, place an order and watch it move through the retry topics to the dead-letter topic. Then end the outage and press Replay.';
    }
    while (hint.firstChild) hint.removeChild(hint.firstChild);
    hint.appendChild(text('b', lead));
    hint.appendChild(document.createTextNode(body));
  }

  // ---------- Controls ----------
  $('place').addEventListener('click', function () {
    placeOrder(SKUS[nextId % SKUS.length]);
  });
  $('place-invalid').addEventListener('click', function () {
    placeOrder('UNKNOWN-' + (nextId % 90 + 10));
  });
  $('duplicate').addEventListener('click', function () {
    // Prefer an order that has finished, so the duplicate is clearly a duplicate.
    var target = null;
    for (var i = 0; i < orders.length && target === null; i++) {
      if (orders[i].status === 'COMPLETED') target = orders[i].id;
    }
    if (target === null) target = lastEvent;
    if (target === null) return;
    log('Kafka redelivers the event for #' + target + ' (at-least-once delivery)');
    publish(target, 0, now);
  });
  $('outage').addEventListener('click', function () {
    outage = !outage;
    this.setAttribute('aria-checked', String(outage));
    $('outage-label').textContent = 'Payment gateway: ' + (outage ? 'outage' : 'healthy');
    log(outage ? 'Payment gateway outage begins' : 'Payment gateway recovers');
    updateHint();
  });

  buildPipeline();
  placeOrder(SKUS[0]);
  placeOrder(SKUS[1]);

  var lastDead = 0;
  function step(dt) {
    tick(dt);
    if (deadLetters.length !== lastDead) { lastDead = deadLetters.length; updateHint(); }
    if (dirty) render();
    renderBars();
  }
  var previous = performance.now();
  setInterval(function () {
    var t = performance.now(), dt = Math.min(250, t - previous);
    previous = t;
    if (!document.hidden) step(dt);
  }, 50);
  render();

  // Exposed for automated checks.
  window.__demo = {
    step: step,
    state: function () { return { orders: orders, deadLetters: deadLetters, now: now, queues: queues, busy: busy }; }
  };
})();
