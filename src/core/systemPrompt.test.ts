import { describe, expect, test } from "bun:test";
import { RUN_COMMAND_TOOL } from "./commands";
import { LOAD_SKILL_TOOL } from "./skills";
import type { Skill } from "./systemPrompt";
import { composeSummaryPrompt, composeSystemPrompt, offeredTools } from "./systemPrompt";
import type { ToolSpec } from "./toolCalls";
import { READ_TOOLS } from "./tools";
import { WRITE_TOOLS } from "./writeTools";

const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    args: [
      { name: "path", required: true, description: "The file to read." },
      { name: "start_line", required: false, description: "The first line to read." },
    ],
  },
  {
    name: "run_command",
    description: "Run a shell command.",
    args: [{ name: "command", required: true, description: "The command line to run." }],
  },
];

function toolNamed(name: string): ToolSpec {
  return { name, description: `${name}.`, args: [{ name: "path", required: true, description: "The file." }] };
}

describe("composeSystemPrompt", () => {
  test("lists every tool with its description, and every argument with whether it is required", () => {
    const prompt = composeSystemPrompt(TOOLS, [], []);
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Read a file from the workspace.");
    expect(prompt).toContain("- path (required): The file to read.");
    expect(prompt).toContain("- start_line (optional): The first line to read.");
    expect(prompt).toContain("run_command");
    expect(prompt).toContain("Run a shell command.");
    expect(prompt).toContain("- command (required): The command line to run.");
  });

  test("shows each tool's call shape as raw lines", () => {
    const prompt = composeSystemPrompt(TOOLS, [], []);
    expect(prompt).toContain("\n<read_file>\n<path>…</path>\n<start_line>…</start_line>\n</read_file>\n");
    expect(prompt).toContain("\n<run_command>\n<command>…</command>\n</run_command>\n");
  });

  test("states the role, the call format, and the rules before the tools", () => {
    const prompt = composeSystemPrompt(TOOLS, [], []);
    const role = prompt.indexOf("coding agent");
    const format = prompt.indexOf("<tool_name>\n<argument_name>");
    const rules = prompt.indexOf("one tool call");
    const tools = prompt.indexOf("<read_file>");
    expect(prompt.startsWith("You are a coding agent")).toBe(true);
    expect(role).toBeLessThan(format);
    expect(format).toBeLessThan(rules);
    expect(rules).toBeLessThan(tools);
    expect(prompt).toContain("wait for");
    expect(prompt).toContain("without a tool call");
    expect(prompt).toContain("relative to the workspace folder");
    expect(prompt).toContain("code fence");
  });

  test("states that edit_file needs an exact passage that appears once and that write_file replaces the whole file", () => {
    const edit =
      "- edit_file replaces an exact passage that must appear once in the file: copy it from the file, line breaks and indentation included.";
    const write = "- write_file replaces the whole file: give its complete content.";
    const rules = composeSystemPrompt([...TOOLS, toolNamed("write_file"), toolNamed("edit_file")], [], []).split(
      "# Tools",
    )[0]!;
    expect(rules).toContain(edit);
    expect(rules).toContain(write);
    const readOnly = composeSystemPrompt(TOOLS, [], []);
    expect(readOnly).not.toContain(edit);
    expect(readOnly).not.toContain(write);
  });

  test("states how to read a loaded skill's files only when load_skill is listed", () => {
    const rule =
      "- Read a loaded skill's files with read_file, list_files, or search by the absolute path the load_skill result gives. A skill folder outside the workspace is read-only.";
    const rules = composeSystemPrompt([...TOOLS, toolNamed("load_skill")], [], []).split("# Tools")[0]!;
    expect(rules).toContain(rule);
    expect(composeSystemPrompt(TOOLS, [], [])).not.toContain(rule);
  });

  test("states that a command runs in the workspace folder with the user's shell, waits for the user, and covers a whole tree in one step, only when run_command is listed", () => {
    const rule =
      "- run_command runs the command with the user's shell, in the workspace folder unless cwd names another, and only once the user approves it: wait for its result. For work over a whole folder tree, such as counting or finding files in every subfolder, one command takes one step where list_files takes one per folder.";
    expect(composeSystemPrompt(TOOLS, [], []).split("# Tools")[0]).toContain(rule);
    expect(composeSystemPrompt([TOOLS[0]!], [], [])).not.toContain(rule);
  });

  test("states when to ask the user only when ask_user is listed", () => {
    const rule =
      "- When the request names one thing and several match it, such as two functions with the same name, call ask_user before any write instead of changing them all or picking one yourself; otherwise do not ask.";
    expect(composeSystemPrompt([...TOOLS, toolNamed("ask_user")], [], []).split("# Tools")[0]).toContain(rule);
    expect(composeSystemPrompt(TOOLS, [], [])).not.toContain(rule);
  });

  test("never shows the format inside a code fence", () => {
    expect(composeSystemPrompt(TOOLS, [], [])).not.toContain("```");
  });

  test("ends after the tool list when there are no instruction files", () => {
    expect(composeSystemPrompt(TOOLS, [], []).endsWith("- command (required): The command line to run.")).toBe(true);
  });

  test("adds each instruction file after the tools, verbatim under a heading naming its label, in order", () => {
    const personal = "Prefer tabs.\n\n```sh\nmake test\n```\n  trailing spaces  ";
    const workspace = "# Project rules\nUse bun.";
    const prompt = composeSystemPrompt(
      TOOLS,
      [
        { label: "~/.agents/AGENTS.md", text: personal },
        { label: "AGENTS.md", text: workspace },
      ],
      [],
    );
    const personalHeading = prompt.indexOf("~/.agents/AGENTS.md");
    const workspaceHeading = prompt.indexOf("AGENTS.md\n", personalHeading + "~/.agents/AGENTS.md".length);
    expect(personalHeading).toBeGreaterThan(prompt.indexOf("- command (required)"));
    expect(prompt.lastIndexOf("\n", personalHeading)).toBe(prompt.lastIndexOf("\n#", personalHeading));
    expect(prompt).toContain(`~/.agents/AGENTS.md\n\n${personal}\n\n`);
    expect(workspaceHeading).toBeGreaterThan(personalHeading);
    expect(prompt.endsWith(`AGENTS.md\n\n${workspace}`)).toBe(true);
  });

  describe("skills section", () => {
    const skill = (name: string, description: string, listedToModel = true): Skill => ({
      name,
      description,
      root: `/skills/${name}`,
      listedToModel,
    });
    const SKILLS = [
      skill("pdf-forms", "Fill PDF forms.\nUse it for any PDF."),
      skill("manual-release", "Release by hand.", false),
      skill("review", "Review a diff."),
    ];

    test("lists each listed skill as one line after the tools, before the instruction files", () => {
      const prompt = composeSystemPrompt(TOOLS, [{ label: "AGENTS.md", text: "Use bun." }], SKILLS);
      const section = prompt.indexOf("# Skills\n");
      expect(section).toBeGreaterThan(prompt.indexOf("- command (required)"));
      expect(section).toBeLessThan(prompt.indexOf("# Instructions from AGENTS.md"));
      expect(prompt).toContain("\n- pdf-forms: Fill PDF forms. Use it for any PDF.\n- review: Review a diff.\n\n#");
    });

    test("tells the model to call load_skill with the name before following a skill", () => {
      const prompt = composeSystemPrompt(TOOLS, [], SKILLS);
      const intro = prompt.slice(prompt.indexOf("# Skills\n"), prompt.indexOf("- pdf-forms"));
      expect(intro).toContain("load_skill");
      expect(intro).toContain("name");
    });

    test("leaves out a skill kept from the model, and the whole section when no skill is listed", () => {
      expect(composeSystemPrompt(TOOLS, [], SKILLS)).not.toContain("manual-release");
      const prompt = composeSystemPrompt(TOOLS, [], [SKILLS[1]!]);
      expect(prompt).toBe(composeSystemPrompt(TOOLS, [], []));
      expect(prompt).not.toContain("# Skills");
    });
  });

  describe("Plan mode", () => {
    const ALL = [...READ_TOOLS, ...WRITE_TOOLS, RUN_COMMAND_TOOL, LOAD_SKILL_TOOL];
    const listed: Skill = { name: "review", description: "Review a diff.", root: "/s/review", listedToModel: true };
    const hidden: Skill = { ...listed, listedToModel: false };
    const plan = (skills: Skill[]) => composeSystemPrompt(offeredTools(ALL, skills, "plan"), [], skills, "plan");
    const PLAN_PARAGRAPH =
      "# Plan mode\n\nYou are in Plan mode. Read what you need with the tools below. Then answer with a plan of the changes: file by file, in order. Change no file and run no command.";

    test("offers the read tools only, and load_skill only while a skill is listed to the model", () => {
      const names = (skills: Skill[]) => offeredTools(ALL, skills, "plan").map((tool) => tool.name);
      expect(names([listed])).toEqual(["read_file", "list_files", "search", "load_skill"]);
      expect(names([hidden])).toEqual(["read_file", "list_files", "search"]);
    });

    test("lists no write or command tool and none of their rules, and holds the Plan paragraph before the tools", () => {
      const prompt = plan([listed]);
      for (const name of ["write_file", "edit_file", "run_command"]) expect(prompt).not.toContain(name);
      expect(prompt).toContain(PLAN_PARAGRAPH);
      expect(prompt.indexOf(PLAN_PARAGRAPH)).toBeLessThan(prompt.indexOf("# Tools"));
      expect(prompt).toContain("## load_skill");
      expect(prompt).toContain("- Read a loaded skill's files");
      expect(plan([hidden])).not.toContain("load_skill");
    });

    test("states a read-only role", () => {
      const prompt = plan([]);
      expect(prompt.startsWith("You are a coding agent working in the user's workspace. You read files")).toBe(true);
      expect(prompt).not.toContain("change files");
    });

    test("without a mode, or in Ask or Auto-edit, the tools and the prompt are today's", () => {
      for (const skills of [[listed], [hidden]]) {
        const today = composeSystemPrompt(offeredTools(ALL, skills), [], skills);
        for (const mode of ["ask", "autoEdit"] as const) {
          expect(offeredTools(ALL, skills, mode)).toEqual(offeredTools(ALL, skills));
          expect(composeSystemPrompt(offeredTools(ALL, skills, mode), [], skills, mode)).toBe(today);
        }
      }
      expect(offeredTools(ALL, [listed])).toEqual(ALL);
      expect(offeredTools(ALL, [hidden])).toEqual(ALL.slice(0, -1));
    });
  });
});

describe("composeSummaryPrompt", () => {
  test("says the model summarizes a conversation with a coding agent, then the instruction files; no tool format", () => {
    const prompt = composeSummaryPrompt([{ label: "AGENTS.md", text: "Use bun." }]);
    expect(prompt).toBe(
      "You summarize a conversation between a user and a coding agent working in the user's workspace.\n\n# Instructions from AGENTS.md\n\nUse bun.",
    );
    expect(composeSummaryPrompt([])).not.toContain("# Tools");
    expect(composeSummaryPrompt([])).not.toContain("tool call");
  });
});
