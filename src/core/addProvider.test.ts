import { describe, expect, test } from "bun:test";
import { type AddProviderPorts, addProvider, OLLAMA_PRESET, type ProviderInput } from "./addProvider";

const english = { t: (message: string, ...args: (string | number | boolean)[]) => format(message, args) };

function format(message: string, args: (string | number | boolean)[]): string {
  return message.replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
}

type Answers = {
  /** The Quick Pick row picked, by kind; `undefined` = Escape. */
  kind?: "ollama" | "other";
  /** Each input box's answer in order (name, base URL, key); `undefined` = Escape. */
  inputs?: (string | undefined)[];
  setting?: unknown;
  storeFails?: boolean;
  writeFails?: boolean;
  deleteFails?: boolean;
};

/** Ports over an in-memory setting and key store, recording every call in order. */
function fakeHost(answers: Answers) {
  const log: string[] = [];
  const boxes: ProviderInput[] = [];
  const errors: string[] = [];
  const keys = new Map<string, string>();
  const host = { setting: answers.setting, keys, log, boxes, errors };
  const inputs = [...(answers.inputs ?? [])];
  const ports: AddProviderPorts = {
    pick: async (items) => items.find((item) => item.choice === answers.kind),
    input: async (box) => {
      boxes.push(box);
      return inputs.shift();
    },
    readSetting: () => host.setting,
    writeSetting: async (value) => {
      log.push("writeSetting");
      if (answers.writeFails) throw new Error("EACCES");
      host.setting = value;
    },
    storeKey: async (name, key) => {
      log.push(`storeKey ${name}`);
      if (answers.storeFails) throw new Error("keychain locked");
      keys.set(name, key);
    },
    deleteKey: async (name) => {
      log.push(`deleteKey ${name}`);
      if (answers.deleteFails) throw new Error("keychain gone");
      keys.delete(name);
    },
    select: (name) => log.push(`select ${name}`),
    showError: (message) => errors.push(message),
  };
  return { host, ports };
}

const INTERNAL = { name: "Internal", baseUrl: "https://llm.example.com/v1", caFile: "~/corp.pem" };
const SKIPPED = { name: "Broken", baseUrl: "not a url" };

describe("addProvider, Ollama preset", () => {
  test("stores the empty key, then appends the preset to the setting, then selects it", async () => {
    const { host, ports } = fakeHost({ kind: "ollama", setting: [INTERNAL] });
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.log).toEqual(["storeKey ollama", "writeSetting", "select ollama"]);
    expect(host.keys.get("ollama")).toBe("");
    expect(host.setting).toEqual([INTERNAL, { name: "ollama", baseUrl: "http://localhost:11434/v1" }]);
    expect(host.boxes).toEqual([]);
  });

  test("with a valid ollama already configured, writes nothing and selects it", async () => {
    const setting = [{ name: "ollama", baseUrl: "http://other:11434/v1" }];
    const { host, ports } = fakeHost({ kind: "ollama", setting });
    expect(await addProvider(ports, english)).toBe("selected");
    expect(host.log).toEqual(["select ollama"]);
    expect(host.setting).toBe(setting);
  });

  test("adds the preset when an ollama entry exists only as a skipped one", async () => {
    const { host, ports } = fakeHost({ kind: "ollama", setting: [{ name: "ollama", baseUrl: "nope" }] });
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.setting).toEqual([{ name: "ollama", baseUrl: "nope" }, OLLAMA_PRESET]);
  });
});

describe("addProvider, other service", () => {
  test("asks name, base URL, then key; stores the key before writing the setting, then selects", async () => {
    const { host, ports } = fakeHost({
      kind: "other",
      setting: [INTERNAL, SKIPPED],
      inputs: [" Lab ", "https://lab.example.com/v1/", " sk-123 "],
    });
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.log).toEqual(["storeKey Lab", "writeSetting", "select Lab"]);
    expect(host.keys.get("Lab")).toBe("sk-123");
    expect(host.setting).toEqual([INTERNAL, SKIPPED, { name: "Lab", baseUrl: "https://lab.example.com/v1" }]);
    expect(host.boxes.map((box) => box.password)).toEqual([false, false, true]);
    expect(host.boxes[1]?.placeholder).toMatch(/\/v1$/);
  });

  test("stores an empty key as the empty string", async () => {
    const { host, ports } = fakeHost({ kind: "other", inputs: ["Lab", "http://lab:8080/v1", "  "] });
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.keys.get("Lab")).toBe("");
  });

  test("replaces a setting value that is not an array with the one-entry array", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: { name: "x" }, inputs: ["Lab", "http://lab/v1", ""] });
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.setting).toEqual([{ name: "Lab", baseUrl: "http://lab/v1" }]);
  });

  test("the name box refuses an empty name and one a valid provider uses, by the parser's rule", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [INTERNAL, SKIPPED] });
    await addProvider(ports, english);
    const name = host.boxes[0]!;
    expect(name.validate("  ")).toBe("Enter a name.");
    expect(name.validate("Internal")).toBe("Another provider already uses this name.");
    expect(name.validate(" Internal ")).toBe("Another provider already uses this name.");
    expect(name.validate("Broken")).toBeUndefined();
    expect(name.validate("internal")).toBeUndefined();
  });

  test("the URL box refuses what the parser skips as an invalid URL", async () => {
    const { host, ports } = fakeHost({ kind: "other", inputs: ["Lab"] });
    await addProvider(ports, english);
    const url = host.boxes[1]!;
    for (const value of ["", "localhost:11434", "/v1", "file:///tmp/v1"]) {
      expect(url.validate(value)).toBe("Enter an http or https URL.");
    }
    expect(url.validate("http://localhost:11434/v1")).toBeUndefined();
  });

  test("the key box refuses what the API key shape check refuses", async () => {
    const { host, ports } = fakeHost({ kind: "other", inputs: ["Lab", "http://lab/v1"] });
    await addProvider(ports, english);
    const key = host.boxes[2]!;
    expect(key.validate("sk 1")).toBe(
      "An API key can contain only visible ASCII characters, with no spaces or accents.",
    );
    expect(key.validate(" sk-1 ")).toBeUndefined();
    expect(key.validate("")).toBeUndefined();
  });

  test("a value refused by its box is never written, even if the box returns it", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [INTERNAL], inputs: ["Lab", "localhost", ""] });
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.log).toEqual([]);
    expect(host.errors).toEqual(["Could not add the provider Lab: Enter an http or https URL."]);
  });

  test("a name taken in the settings while the boxes were open is refused and nothing is written", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [], inputs: ["Lab", "http://lab/v1"] });
    ports.input = async (box) => {
      host.boxes.push(box);
      if (host.boxes.length === 3) host.setting = [{ name: "Lab", baseUrl: "http://elsewhere/v1" }];
      return ["Lab", "http://lab/v1", "key"][host.boxes.length - 1];
    };
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.log).toEqual([]);
    expect(host.errors).toEqual(["Could not add the provider Lab: Another provider already uses this name."]);
  });
});

describe("addProvider, cancel and failures", () => {
  test("Escape at each step writes nothing and stores no key", async () => {
    const steps: Answers[] = [
      { kind: undefined },
      { kind: "other", inputs: [undefined] },
      { kind: "other", inputs: ["Lab", undefined] },
      { kind: "other", inputs: ["Lab", "http://lab/v1", undefined] },
    ];
    for (const answers of steps) {
      const { host, ports } = fakeHost({ ...answers, setting: [INTERNAL] });
      expect(await addProvider(ports, english)).toBe("cancelled");
      expect(host.log).toEqual([]);
      expect(host.setting).toEqual([INTERNAL]);
      expect(host.errors).toEqual([]);
    }
  });

  test("a failed key write is shown and writes no setting", async () => {
    const { host, ports } = fakeHost({ kind: "ollama", setting: [INTERNAL], storeFails: true });
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.log).toEqual(["storeKey ollama"]);
    expect(host.setting).toEqual([INTERNAL]);
    expect(host.errors).toEqual(["Could not save the API key for ollama: Error: keychain locked"]);
  });

  test("a failed settings write is shown and deletes the key just stored, so no key is left", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [INTERNAL], inputs: ["Lab", "http://lab/v1", "k"] });
    ports.writeSetting = async () => {
      host.log.push("writeSetting");
      throw new Error("EACCES");
    };
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.log).toEqual(["storeKey Lab", "writeSetting", "deleteKey Lab"]);
    expect(host.keys.has("Lab")).toBe(false);
    expect(host.setting).toEqual([INTERNAL]);
    expect(host.errors).toEqual(["Could not add the provider Lab: Error: EACCES"]);
  });

  test("a provider added while the key was stored is kept", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [INTERNAL], inputs: ["Lab", "http://lab/v1", "k"] });
    const other = { name: "Other", baseUrl: "http://other/v1" };
    const store = ports.storeKey;
    ports.storeKey = async (name, key) => {
      await store(name, key);
      host.setting = [INTERNAL, other];
    };
    expect(await addProvider(ports, english)).toBe("added");
    expect(host.setting).toEqual([INTERNAL, other, { name: "Lab", baseUrl: "http://lab/v1" }]);
  });

  test("a name taken while the key was stored is refused, the key deleted, and nothing written", async () => {
    const { host, ports } = fakeHost({ kind: "other", setting: [INTERNAL], inputs: ["Lab", "http://lab/v1", "k"] });
    const taken = [INTERNAL, { name: "Lab", baseUrl: "http://elsewhere/v1" }];
    const store = ports.storeKey;
    ports.storeKey = async (name, key) => {
      await store(name, key);
      host.setting = taken;
    };
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.log).toEqual(["storeKey Lab", "deleteKey Lab"]);
    expect(host.keys.has("Lab")).toBe(false);
    expect(host.setting).toBe(taken);
    expect(host.errors).toEqual(["Could not add the provider Lab: Another provider already uses this name."]);
  });

  test("a failed key delete after a failed settings write is shown too", async () => {
    const { host, ports } = fakeHost({ kind: "ollama", writeFails: true, deleteFails: true });
    expect(await addProvider(ports, english)).toBe("failed");
    expect(host.errors).toEqual([
      "Could not add the provider ollama: Error: EACCES",
      "Could not delete the API key for ollama: Error: keychain gone",
    ]);
  });
});
