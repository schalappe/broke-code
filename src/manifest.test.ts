import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EDIT_PRESETS, EDIT_SCHEME } from "./core/editSelection";

type MenuItem = { command?: string; submenu?: string; when?: string; group?: string };
type Manifest = {
  contributes: {
    commands: { command: string; title: string; category?: string; icon?: string }[];
    submenus?: { id: string; label: string }[];
    menus: Record<string, MenuItem[]>;
    keybindings?: { command: string }[];
  };
};

const manifest: Manifest = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
const { commands, menus, submenus = [], keybindings = [] } = manifest.contributes;

describe("the editor's broke-code submenu", () => {
  const entry = menus["editor/context"]?.find((item) => item.submenu !== undefined);

  test("is in the editor's context menu when the editor has a selection", () => {
    expect(entry?.when).toBe("editorHasSelection");
    expect(submenus.find((submenu) => submenu.id === entry?.submenu)?.label).toBe("broke-code");
  });

  test("holds Add selection to chat, Edit selection, then its presets, in that order; a read-only editor hides the edits", () => {
    const items = menus[entry?.submenu ?? ""] ?? [];
    expect(items.map((item) => [item.command, item.group?.split("@")[1], item.when])).toEqual([
      ["broke-code.addSelectionToChat", "1", undefined],
      ["broke-code.editSelection", "2", "!editorReadonly"],
      ["broke-code.refactorSelection", "3", "!editorReadonly"],
      ["broke-code.documentSelection", "4", "!editorReadonly"],
      ["broke-code.typeSelection", "5", "!editorReadonly"],
    ]);
    expect(new Set(items.map((item) => item.group?.split("@")[0])).size).toBe(1);
  });

  test("Add selection to chat is no longer a direct entry of the editor's context menu", () => {
    expect(menus["editor/context"]?.some((item) => item.command === "broke-code.addSelectionToChat")).toBe(false);
  });
});

describe("Edit selection", () => {
  test("is in the Command Palette, with no default keybinding", () => {
    const command = commands.find((each) => each.command === "broke-code.editSelection");
    expect(command?.category).toBe("broke-code");
    expect(menus.commandPalette?.some((item) => item.command === "broke-code.editSelection")).toBe(false);
    expect(keybindings.some((binding) => binding.command === "broke-code.editSelection")).toBe(false);
  });

  test("its presets are in the Command Palette under the broke-code category, with one title each", () => {
    for (const id of Object.keys(EDIT_PRESETS)) {
      const command = commands.find((each) => each.command === id);
      expect(command?.category).toBe("broke-code");
      expect(command?.title).toMatch(/^%command\.\w+\.title%$/);
      expect(menus.commandPalette?.some((item) => item.command === id)).toBe(false);
    }
  });

  test("Accept and Reject are hidden from the Command Palette and sit in the title bar of an edit diff only", () => {
    for (const id of ["broke-code.acceptEdit", "broke-code.rejectEdit"]) {
      expect(commands.find((each) => each.command === id)?.icon).toBeDefined();
      expect(menus.commandPalette?.find((item) => item.command === id)?.when).toBe("false");
      const title = menus["editor/title"]?.find((item) => item.command === id);
      expect(title?.when).toBe(`resourceScheme == ${EDIT_SCHEME}`);
      expect(title?.group?.startsWith("navigation")).toBe(true);
    }
  });
});
