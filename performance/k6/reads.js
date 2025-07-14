import http from "k6/http";
import { check, sleep } from "k6";

export let options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS) : 100,
  duration: __ENV.DURATION || "30s",
};

export default function () {
  const res = http.get("http://app:3000/todos");
  check(res, { "status was 200": (r) => r.status == 200 });
  sleep(0.01);
}
