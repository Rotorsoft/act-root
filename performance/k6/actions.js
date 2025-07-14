import http from "k6/http";
import { check, sleep } from "k6";

export let options = {
  vus: __ENV.VUS ? parseInt(__ENV.VUS) : 100,
  duration: __ENV.DURATION || "30s",
};

export default function () {
  const url = "http://app:3000/todos";
  const actorId = `actor-${__VU}`;
  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${actorId}`,
    },
  };

  // 1. Create
  let createRes = http.post(
    url,
    JSON.stringify({ text: "hello world" }),
    params
  );
  check(createRes, { "create status was 201": (r) => r.status == 201 });
  let streamId;
  try {
    streamId = JSON.parse(createRes.body).stream;
  } catch (e) {
    streamId = null;
  }
  if (!streamId) {
    console.log("Failed to create TODO:", createRes.status, createRes.body);
    return;
  }

  // 2. Update
  let updateRes = http.put(
    `${url}/${streamId}`,
    JSON.stringify({ text: "updated text" }),
    params
  );
  check(updateRes, { "update status was 200": (r) => r.status == 200 });

  // 3. Delete
  let deleteRes = http.del(`${url}/${streamId}`, null, params);
  check(deleteRes, { "delete status was 204": (r) => r.status == 204 });

  sleep(0.01);
}
