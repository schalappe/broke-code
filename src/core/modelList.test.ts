import { describe, expect, test } from "bun:test";
import { chooseModel, emptyModelsLabel, type ModelPickItem, type ModelPickPorts, modelChoices } from "./modelList";
import type { ModelsState } from "./protocol";

const french = { t: (message: string, ...args: (string | number | boolean)[]) => `fr:${message}${args.join(",")}` };
const failed: ModelsState = {
  status: "failed",
  error: { kind: "unreachable", provider: "P", baseUrl: "http://x", cause: "down" },
};

describe("emptyModelsLabel", () => {
  test("says why the list is empty, through the translator it is given", () => {
    expect(emptyModelsLabel({ status: "loading" }, french, "blank")).toBe("fr:Loading models…");
    expect(emptyModelsLabel(failed, french, "blank")).toBe("fr:Models unavailable");
    expect(emptyModelsLabel({ status: "loaded", models: [] }, french, "blank")).toBe("fr:No models");
  });

  test("without a provider: blank for the header's select, No models for the Quick Pick", () => {
    expect(emptyModelsLabel({ status: "noProvider" }, french, "blank")).toBe("");
    expect(emptyModelsLabel({ status: "noProvider" }, french, "noModels")).toBe("fr:No models");
  });
});

describe("modelChoices", () => {
  test("lists the selected provider's models in listing order, the selected one marked current", () => {
    expect(modelChoices({ models: { status: "loaded", models: ["a", "b", "c"] }, model: "b" })).toEqual([
      { model: "a", current: false },
      { model: "b", current: true },
      { model: "c", current: false },
    ]);
  });

  test("lists nothing until the models are listed", () => {
    expect(modelChoices({ models: { status: "loading" }, model: "b" })).toEqual([]);
    expect(modelChoices({ models: { status: "noProvider" }, model: undefined })).toEqual([]);
    expect(modelChoices({ models: { status: "loaded", models: [] }, model: undefined })).toEqual([]);
  });
});

describe("chooseModel", () => {
  /** Ports that record what the relay did; `answer` is what the pick resolves to, or a function that throws. */
  function recordingPorts(answer: (items: ModelPickItem[]) => ModelPickItem | undefined) {
    const calls = {
      picks: [] as { items: ModelPickItem[]; placeholder: string }[],
      selected: [] as string[],
      errors: [] as string[],
    };
    const ports: ModelPickPorts = {
      pick: async (items, placeholder) => {
        calls.picks.push({ items, placeholder });
        return answer(items);
      },
      selectModel: (model) => calls.selected.push(model),
      showError: (message) => calls.errors.push(message),
    };
    return { ports, calls };
  }
  const loaded: ModelsState = { status: "loaded", models: ["a", "b"] };

  test("offers the listed models, the current one described as such, under Choose the model", async () => {
    const { ports, calls } = recordingPorts(() => undefined);
    await chooseModel({ models: loaded, model: "b" }, ports, french);
    expect(calls.picks).toEqual([
      {
        items: [{ label: "a" }, { label: "b", description: "fr:current" }],
        placeholder: "fr:Choose the model",
      },
    ]);
  });

  test("opens empty before the models are listed, its placeholder saying why", async () => {
    const cases: [ModelsState, string][] = [
      [{ status: "loading" }, "fr:Loading models…"],
      [failed, "fr:Models unavailable"],
      [{ status: "loaded", models: [] }, "fr:No models"],
      [{ status: "noProvider" }, "fr:No models"],
    ];
    for (const [models, placeholder] of cases) {
      const { ports, calls } = recordingPorts(() => undefined);
      await chooseModel({ models, model: undefined }, ports, french);
      expect(calls.picks).toEqual([{ items: [], placeholder }]);
    }
  });

  test("a pick selects that model", async () => {
    const { ports, calls } = recordingPorts((items) => items[0]);
    await chooseModel({ models: loaded, model: "b" }, ports, french);
    expect(calls.selected).toEqual(["a"]);
    expect(calls.errors).toEqual([]);
  });

  test("a cancelled pick changes nothing", async () => {
    const { ports, calls } = recordingPorts(() => undefined);
    await chooseModel({ models: loaded, model: "b" }, ports, french);
    expect(calls.selected).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  test("a pick that fails is shown as an error and selects nothing", async () => {
    const { ports, calls } = recordingPorts(() => {
      throw new Error("no window");
    });
    const logged = console.error;
    console.error = () => {};
    try {
      await chooseModel({ models: loaded, model: "b" }, ports, french);
    } finally {
      console.error = logged;
    }
    expect(calls.selected).toEqual([]);
    expect(calls.errors).toEqual(["fr:Could not open the model list: {0}Error: no window"]);
  });
});
