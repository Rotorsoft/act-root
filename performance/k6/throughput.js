import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution"; // <-- import for abort
import { Gauge } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://app:3000";
const VUS = Number(__ENV.VUS) || 100;
const WRITE_DURATION = __ENV.WRITE_DURATION || "10s";
const WRITE_RATIO = Number(__ENV.WRITE_RATIO) || 0.5;
const CONVERGENCE_DURATION = Number(__ENV.CONVERGENCE_DURATION) || "600s";

const _totalTodos = new Gauge("total_todos");
const _activeTodos = new Gauge("active_todos");
const _lastEventInStore = new Gauge("last_event_in_store");
const _drainCount = new Gauge("drain_count");
const _eventCount = new Gauge("event_count");
const _streamCount = new Gauge("stream_count");
const _laggingCovergenceTime = new Gauge("lagging_convergence_time", true);
const _leadingCovergenceTime = new Gauge("leading_convergence_time", true);
const _scenarioType = new Gauge("scenario_type");

let streams = [];

export const options = {
  scenarios: {
    load_writers: {
      executor: "constant-vus",
      vus: Math.floor(VUS * WRITE_RATIO),
      duration: WRITE_DURATION,
      exec: "writer",
    },
    convergence: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1000, // some upper bound
      startTime: WRITE_DURATION,
      exec: "convergence",
      maxDuration: CONVERGENCE_DURATION,
    },
  },
};

export function writer() {
  const op = Math.random();
  if (op < 0.4 || streams.length === 0) {
    const payload = JSON.stringify({ text: `todo ${Math.random()}` });
    const res = http.post(`${BASE_URL}/todos`, payload, {
      headers: { "Content-Type": "application/json" },
    });
    check(res, { created: (r) => r.status === 201 });
    const stream = res.json("stream");
    if (res.status === 201 && stream) streams.push(stream);
  } else if (op < 0.7 && streams.length > 0) {
    const idx = Math.floor(Math.random() * streams.length);
    const stream = streams[idx];
    const payload = JSON.stringify({ text: `updated ${Math.random()}` });
    const res = http.put(`${BASE_URL}/todos/${stream}`, payload, {
      headers: { "Content-Type": "application/json" },
    });
    check(res, { updated: (r) => r.status === 200 });
  } else if (streams.length > 0) {
    const idx = Math.floor(Math.random() * streams.length);
    const stream = streams[idx];
    const res = http.del(`${BASE_URL}/todos/${stream}`);
    check(res, { deleted: (r) => r.status === 204 });
    streams.splice(idx, 1);
  }
  sleep(0.001);
}

export function convergence() {
  const res = http.get(`${BASE_URL}/stats`);
  if (res.status === 200) {
    const {
      totalTodos,
      activeTodos,
      lastEventInStore,
      lagging,
      leading,
      drainCount,
      eventCount,
      streamCount,
      serialProjection,
    } = res.json();

    _totalTodos.add(totalTodos);
    _activeTodos.add(activeTodos);
    _lastEventInStore.add(lastEventInStore);
    _drainCount.add(drainCount);
    _eventCount.add(eventCount);
    _streamCount.add(streamCount);
    _scenarioType.add(serialProjection ? 1 : 0);

    // --- abort test when convergence is reached ---
    if (lagging.convergedAt && leading.convergedAt) {
      _laggingCovergenceTime.add(lagging.convergedTime);
      _leadingCovergenceTime.add(leading.convergedTime);
      console.log(`Convergence reached, stopping test...`);
      exec.test.abort();
    }
  }
  sleep(2); // Poll every 2 seconds
}
