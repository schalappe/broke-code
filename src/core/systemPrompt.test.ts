import { describe, expect, test } from "bun:test";
import type { Skill } from "./systemPrompt";
import { composeSystemPrompt } from "./systemPrompt";
import type { ToolSpec } from "./toolCalls";

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
});
