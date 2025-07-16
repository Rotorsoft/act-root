import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Gauge } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://app:3000";
const VUS = Number(__ENV.VUS) || 100;
const DURATION = __ENV.DURATION || "30s";
const WRITE_RATIO = Number(__ENV.WRITE_RATIO) || 0.5; // % of VUs doing writes
const CONVERGENCE_VUS = Number(__ENV.CONVERGENCE_VUS) || 10;
const CONVERGENCE_MAX = Number(__ENV.CONVERGENCE_MAX) || 60; // max seconds to wait for convergence

const eventIdLag = new Trend("event_id_lag"); // Trend over time
const eventsInStore = new Trend("events_in_store");
const eventsProjected = new Trend("events_projected");
const scenarioTypeMetric = new Gauge("scenario_type");

let streams = [];

export const options = {
  scenarios: {
    load_writers: {
      executor: "constant-vus",
      vus: Math.floor(VUS * WRITE_RATIO),
      duration: DURATION,
      exec: "writer",
    },
    stats_reader: {
      executor: "constant-vus",
      vus: 1,
      duration: DURATION,
      exec: "statsReader",
      startTime: "0s",
    },
    convergence: {
      executor: "per-vu-iterations",
      vus: CONVERGENCE_VUS,
      iterations: Math.ceil(CONVERGENCE_MAX * 10),
      startTime: DURATION,
      exec: "convergenceReader",
      maxDuration: `${CONVERGENCE_MAX}s`,
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
    if (res.status === 201 && res.json("stream")) {
      streams.push(res.json("stream"));
    }
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
  sleep(0.1);
}

function logStats(res) {
  if (res.status === 200) {
    const stats = res.json();
    eventsInStore.add(stats.lastEventInStore);
    eventsProjected.add(stats.lastProjectedEvent);
    eventIdLag.add(stats.lastEventInStore - stats.lastProjectedEvent);
    scenarioTypeMetric.add(stats.serialProjection ? 1 : 0); // 1 = Serial, 0 = Parallel
  }
}

export function statsReader() {
  const res = http.get(`${BASE_URL}/stats`);
  logStats(res);
  sleep(5); // Poll every 5 seconds
}

export function convergenceReader() {
  for (let i = 0; i < 1; ++i) {
    http.post(`${BASE_URL}/drain`);
    const statsRes = http.get(`${BASE_URL}/stats`);
    check(statsRes, { "stats ok": (r) => r.status === 200 });
    logStats(statsRes);
    sleep(1);
  }
}

export function teardown() {
  const res = http.get(`${BASE_URL}/stats`);
  logStats(res);
}
