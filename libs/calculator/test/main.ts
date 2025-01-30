import { act, app } from "@rotorsoft/act";
import { Calculator } from "../src";

async function main() {
  app().with(Calculator);
  app().build();
  await app().listen();

  await act({ stream: "A", action: "PressKey", data: { key: "1" } });
  await act({ stream: "A", action: "PressKey", data: { key: "2" } });
  await act({ stream: "A", action: "PressKey", data: { key: "+" } });
  await act({ stream: "A", action: "PressKey", data: { key: "3" } });
  await act({ stream: "A", action: "PressKey", data: { key: "*" } });
  await act({ stream: "A", action: "PressKey", data: { key: "2" } });
  await act({ stream: "A", action: "PressKey", data: { key: "-" } });
  await act({ stream: "A", action: "PressKey", data: { key: "1" } });
  await act({ stream: "A", action: "PressKey", data: { key: "0" } });
  await act({ stream: "A", action: "PressKey", data: { key: "+" } });
  await act({ stream: "A", action: "PressKey", data: { key: "2" } });
  await act({ stream: "A", action: "PressKey", data: { key: "0" } });

  const result = await act({
    stream: "A",
    action: "PressKey",
    data: { key: "=" }
  });

  await new Promise((resolve) => setTimeout(resolve, 100)).then(() => {
    console.log(result);
  });
}

void main();
