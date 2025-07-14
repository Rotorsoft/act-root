import http from "k6/http";
import { check, sleep } from "k6";

export let options = {
  stages: [
    { duration: "30s", target: 50 },
    { duration: "30s", target: 100 },
    { duration: "30s", target: 200 },
    { duration: "30s", target: 0 },
  ],
};

export default function () {
  const url = "http://app:3000/todos";
  const payload = JSON.stringify({ text: "scaling test" });
  const params = { headers: { "Content-Type": "application/json" } };

  let res = http.post(url, payload, params);
  check(res, { "status was 201": (r) => r.status == 201 });
  sleep(0.01);
}
