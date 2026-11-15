/*
 * Backpressure simulator core. Pure logic, no DOM, so it runs in the browser and in Node.
 *
 * Two copies of the same consumer receive the same messages from two workflows:
 *   - "unprotected" takes everything it polls into memory and dispatches it on a shared pool.
 *   - "protected" asks an admission gate first (AIMD concurrency limit + byte budget +
 *     per-workflow quota). What is not admitted stays in the broker as lag.
 *
 * The gate logic mirrors the Java library in projects/backpressure.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BackpressureSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DT = 0.1; // simulated seconds per tick

  var C = {
    heapMax: 512,        // MB
    heapBase: 140,       // MB used by the idle service
    footprint: 2.5,      // heap MB per payload MB while in flight
    timeout: 2.5,        // s before a downstream call is abandoned and retried
    restart: 5,          // s a pod takes to come back after an OutOfMemoryError
    pool: 16,            // shared worker threads in the unprotected consumer
    pollPerTick: 6,      // records per poll in the unprotected consumer (60/s)
    budgetShare: 0.35,   // in-flight byte budget as a share of the heap
    workflowShare: 0.6,  // most of the budget one workflow may hold
    heapHigh: 0.8,       // heap utilisation that counts as an overload signal
    slowFactor: 6,       // how much slower workflow A's downstream gets
    shedAt: 1.5          // a downstream rejects calls beyond this multiple of its capacity
  };

  function Aimd(min, initial, max, factor, cooldown) {
    this.min = min; this.max = max; this.factor = factor; this.cooldown = cooldown;
    this.limit = initial; this.lastCut = -Infinity;
  }
  Aimd.prototype.onSuccess = function (inFlight) {
    if (inFlight + 1 < Math.floor(this.limit)) return; // an idle limit proves nothing
    this.limit = Math.min(this.max, this.limit + 1 / this.limit);
  };
  Aimd.prototype.onOverload = function (now) {
    if (now - this.lastCut < this.cooldown) return false;
    this.lastCut = now;
    this.limit = Math.max(this.min, this.limit * this.factor);
    return true;
  };

  function newSystem(isProtected) {
    return {
      isProtected: isProtected,
      lag: { A: 0, B: 0 },
      queue: [],            // in memory, waiting for a thread (unprotected only)
      running: [],          // in memory, being delivered downstream
      heap: C.heapBase,
      status: 'running',
      downUntil: 0,
      crashes: 0,
      timeouts: 0,
      delivered: { A: 0, B: 0 },
      recent: { A: [], B: [] },   // completion timestamps for throughput
      mix: 0,
      rejected: 0,
      limiter: isProtected ? { A: new Aimd(1, 4, 64, 0.7, 1), B: new Aimd(1, 4, 64, 0.7, 1) } : null
    };
  }

  function Sim() {
    this.params = { rateA: 20, rateB: 10, sizeA: 1, sizeB: 0.5, slowA: false };
    this.downstream = { A: { capacity: 8, latency: 0.25 }, B: { capacity: 8, latency: 0.2 } };
    this.reset();
  }

  Sim.prototype.reset = function () {
    this.t = 0;
    this.acc = { A: 0, B: 0 };
    this.unprotected = newSystem(false);
    this.protected = newSystem(true);
  };

  // The most concurrent calls a downstream accepts before it starts rejecting them.
  Sim.prototype.shedLimit = function (wf) {
    return Math.floor(this.downstream[wf].capacity * C.shedAt);
  };

  Sim.prototype.latency = function (wf, concurrent) {
    var d = this.downstream[wf];
    var slow = wf === 'A' && this.params.slowA ? C.slowFactor : 1;
    return d.latency * slow * Math.max(1, concurrent / d.capacity);
  };

  function countRunning(s) {
    var n = { A: 0, B: 0 };
    for (var i = 0; i < s.running.length; i++) n[s.running[i].wf]++;
    return n;
  }

  function memoryMb(s) {
    var mb = 0, i;
    for (i = 0; i < s.queue.length; i++) mb += s.queue[i].mb;
    for (i = 0; i < s.running.length; i++) mb += s.running[i].mb;
    return mb * C.footprint;
  }

  Sim.prototype.message = function (wf) {
    return { wf: wf, mb: wf === 'A' ? this.params.sizeA : this.params.sizeB, age: 0, progress: 0 };
  };

  // Deliver what is running. Returns the messages that timed out.
  Sim.prototype.advance = function (s) {
    var n = countRunning(s), still = [], timedOut = [];
    for (var i = 0; i < s.running.length; i++) {
      var m = s.running[i];
      m.age += DT;
      m.progress += DT / this.latency(m.wf, n[m.wf]);
      if (m.progress >= 1) {
        s.delivered[m.wf]++;
        s.recent[m.wf].push(this.t);
        if (s.isProtected) s.limiter[m.wf].onSuccess(n[m.wf]);
      } else if (m.age >= C.timeout) {
        s.timeouts++;
        timedOut.push(m);
      } else {
        still.push(m);
      }
    }
    s.running = still;
    return timedOut;
  };

  Sim.prototype.stepUnprotected = function (s) {
    if (this.t < s.downUntil) { s.status = 'restarting'; s.heap = 0; return; }
    s.status = 'running';

    // Poll: everything fetched is deserialised straight into memory.
    for (var i = 0; i < C.pollPerTick; i++) {
      var total = s.lag.A + s.lag.B;
      if (total === 0) break;
      s.mix += s.lag.A / total;
      var wf = (s.mix >= 1 && s.lag.A > 0) || s.lag.B === 0 ? 'A' : 'B';
      if (wf === 'A') s.mix -= 1;
      s.lag[wf]--;
      s.queue.push(this.message(wf));
    }
    // One shared pool, first come first served. Calls the downstream rejects are
    // retried from memory, like the timeouts below.
    var n = countRunning(s), rejected = [];
    while (s.running.length < C.pool && s.queue.length) {
      var next = s.queue.shift();
      if (n[next.wf] >= this.shedLimit(next.wf)) { rejected.push(next); s.rejected++; continue; }
      n[next.wf]++;
      s.running.push(next);
    }
    for (var r = 0; r < rejected.length; r++) s.queue.push(rejected[r]);

    // Timed-out calls are retried from memory, so they keep their heap.
    var timedOut = this.advance(s);
    for (var j = 0; j < timedOut.length; j++) {
      timedOut[j].age = 0; timedOut[j].progress = 0;
      s.queue.push(timedOut[j]);
    }

    s.heap = C.heapBase + memoryMb(s);
    if (s.heap >= C.heapMax) {
      // OutOfMemoryError: offsets were never committed, so everything is redelivered.
      var lost = s.queue.concat(s.running);
      for (var k = 0; k < lost.length; k++) s.lag[lost[k].wf]++;
      s.queue = []; s.running = [];
      s.crashes++;
      s.downUntil = this.t + C.restart;
      s.status = 'restarting';
      s.heap = C.heapMax;
    }
  };

  Sim.prototype.stepProtected = function (s) {
    s.status = 'running';
    var budget = C.heapMax * C.budgetShare;
    var cap = budget * C.workflowShare;
    var n = countRunning(s);
    var bytes = { A: 0, B: 0 };
    for (var i = 0; i < s.running.length; i++) bytes[s.running[i].wf] += s.running[i].mb * C.footprint;

    if (s.heap / C.heapMax >= C.heapHigh) {
      s.limiter.A.onOverload(this.t);
      s.limiter.B.onOverload(this.t);
    }

    // Admission: a message is taken into memory only if all three checks pass.
    var order = Math.round(this.t / DT) % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    for (var o = 0; o < 2; o++) {
      var wf = order[o];
      while (s.lag[wf] > 0) {
        var m = this.message(wf), est = m.mb * C.footprint, all = bytes.A + bytes.B;
        if (n[wf] >= Math.floor(s.limiter[wf].limit)) break;          // adaptive concurrency
        if (bytes[wf] > 0 && bytes[wf] + est > cap) break;            // workflow quota
        if (all > 0 && all + est > budget) break;                     // global byte budget
        if (n[wf] >= this.shedLimit(wf)) {                            // downstream said no
          s.rejected++;
          s.limiter[wf].onOverload(this.t);
          break;
        }
        s.lag[wf]--; n[wf]++; bytes[wf] += est;
        s.running.push(m);
      }
    }

    // A timeout is an overload signal too; the message goes back to the broker.
    var timedOut = this.advance(s);
    for (var j = 0; j < timedOut.length; j++) {
      s.limiter[timedOut[j].wf].onOverload(this.t);
      s.lag[timedOut[j].wf]++;
    }
    s.heap = C.heapBase + memoryMb(s);
  };

  Sim.prototype.tick = function () {
    this.t += DT;
    var wfs = ['A', 'B'];
    for (var i = 0; i < 2; i++) {
      var wf = wfs[i];
      this.acc[wf] += (wf === 'A' ? this.params.rateA : this.params.rateB) * DT;
      var arrivals = Math.floor(this.acc[wf]);
      this.acc[wf] -= arrivals;
      this.unprotected.lag[wf] += arrivals;
      this.protected.lag[wf] += arrivals;
    }
    this.stepUnprotected(this.unprotected);
    this.stepProtected(this.protected);
  };

  // Messages per second delivered for a workflow, averaged over the last two seconds.
  Sim.prototype.throughput = function (s, wf) {
    var r = s.recent[wf], cutoff = this.t - 2;
    while (r.length && r[0] < cutoff) r.shift();
    return r.length / 2;
  };

  Sim.prototype.sample = function () {
    var u = this.unprotected, p = this.protected;
    return {
      t: this.t,
      heapU: u.status === 'restarting' && u.heap === 0 ? null : u.heap,
      heapP: p.heap,
      thrBU: this.throughput(u, 'B'),
      thrBP: this.throughput(p, 'B'),
      thrAU: this.throughput(u, 'A'),
      thrAP: this.throughput(p, 'A'),
      limitA: p.limiter.A.limit,
      lagU: u.lag.A + u.lag.B,
      lagP: p.lag.A + p.lag.B
    };
  };

  return { Sim: Sim, Aimd: Aimd, DT: DT, C: C };
});
