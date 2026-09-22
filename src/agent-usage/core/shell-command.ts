import { basename } from "node:path";

type ToolInput = Record<string, unknown>;
const maxCommandLength = 16_384;
const maxWords = 512;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Recognize only one literal simple command. This is deliberately not a shell evaluator. */
const words = (command: string): string[] | undefined => {
  if (command.length > maxCommandLength || /[\r\n\0]/.test(command)) return undefined;
  const result: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let wordStart = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (!started && !/\s/.test(char)) wordStart = i;
    if (char === quote) { quote = ""; continue; }
    if (quote === "'") { word += char; continue; }
    if (char === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
      started = true;
      continue;
    }
    if (char === "$" || char === "`") return undefined;
    if (quote === '"') { word += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/[;&|<>(){}*?\[\]~#]/.test(char)) return undefined;
    if (/\s/.test(char)) {
      if (started) {
        if (assignment.test(word) && !assignment.test(command.slice(wordStart, i))) return undefined;
        result.push(word); word = ""; started = false;
      }
      if (result.length > maxWords) return undefined;
    } else { word += char; started = true; }
  }
  if (quote) return undefined;
  if (started) {
    if (assignment.test(word) && !assignment.test(command.slice(wordStart))) return undefined;
    result.push(word);
  }
  return result.length > 0 && result.length <= maxWords ? result : undefined;
};

const argv = (value: unknown): string[] | undefined => Array.isArray(value)
  && value.length > 0 && value.length <= maxWords
  && value.every((item): item is string => typeof item === "string" && !/[\r\n\0]/.test(item))
  && value.reduce((length, item: string) => length + item.length, 0) <= maxCommandLength
  ? value : undefined;

const unwrap = (input: string[], depth = 0, shellInput = false): string[] | undefined => {
  if (depth > 8) return undefined;
  let index = 0;
  while (shellInput && assignment.test(input[index] ?? "")) index++;
  const command = input.slice(index);
  if (!command[0] || /^(?:if|then|else|fi|for|while|until|case|function|do|done|eval|source|\.)$/.test(command[0])) return undefined;
  const name = basename(command[0]);
  if (name === "env") {
    index = 1;
    while (index < command.length) {
      const arg = command[index]!;
      if (arg === "--") { index++; break; }
      if (arg === "-i" || arg === "--ignore-environment" || assignment.test(arg) || arg.startsWith("--unset=")) index++;
      else if (arg === "-u" || arg === "--unset") index += 2;
      else if (arg.startsWith("-")) return undefined;
      else break;
    }
    return unwrap(command.slice(index), depth + 1);
  }
  if (name === "rtk") {
    if (command[1]?.startsWith("-")) return undefined;
    return unwrap(command.slice(command[1] === "proxy" ? 2 : 1), depth + 1);
  }
  if (shells.has(name) && command[1]?.startsWith("-")) {
    if (/^-[lc]+$/.test(command[1]) && command[1].includes("c") && command.length === 3) {
      const nested = words(command[2]!);
      return nested ? unwrap(nested, depth + 1, true) : undefined;
    }
    // Unknown shell options may select another command string or alter expansion.
    return undefined;
  }
  return command;
};

export const literalCommand = (input: ToolInput | undefined): string[] | undefined => {
  if (!input) return undefined;
  let command: string[] | undefined;
  let shellInput = false;
  const executable = input.executable ?? input.program;
  if (typeof executable === "string") {
    command = input.args === undefined ? argv([executable])
      : Array.isArray(input.args) ? argv([executable, ...input.args]) : undefined;
  } else if (input.argv !== undefined) command = argv(input.argv);
  else {
    const value = input.command ?? input.cmd;
    shellInput = typeof value === "string";
    command = typeof value === "string" ? words(value) : argv(value);
  }
  return command ? unwrap(command, 0, shellInput) : undefined;
};

const literalPath = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= 4096 && value !== "-" && !/[\0\r\n$`*?\[\]{}~]/.test(value);

const readOperands = (name: string, args: string[]): string[] => {
  let index = 0;
  if (name === "sed") {
    if (args[index] === "-n") index++;
    if (args[index] === "-e") index++;
    // A narrow, common read form; arbitrary sed programs may execute other commands.
    if (!/^\d+(?:,\d+)?p$/.test(args[index] ?? "")) return [];
    index++;
  } else {
    while (args[index]?.startsWith("-") && args[index] !== "--" && args[index] !== "-") {
      const option = args[index++]!;
      if (name === "cat") {
        if (!/^-[AbEenstTuv]+$/.test(option)) return [];
      } else if (option === "-n" || option === "-c" || option === "--lines" || option === "--bytes") {
        if (!/^[+-]?\d+$/.test(args[index++] ?? "")) return [];
      } else if (!/^(?:-[qvf]+|-(?:[nc])?[+-]?\d+|--(?:quiet|silent|verbose)|--(?:lines|bytes)=[+-]?\d+)$/.test(option)) return [];
    }
  }
  if (args[index] === "--") index++;
  const paths = args.slice(index);
  return paths.every(path => literalPath(path) && !path.startsWith("-")) ? paths : [];
};

export type CommandFiles = { readPaths: string[]; scriptPaths: string[]; cwd?: string };

/** File operands are evidence of an attempted operation, never proof of successful execution. */
export const commandFiles = (input: ToolInput | undefined): CommandFiles => {
  const result: CommandFiles = { readPaths: [], scriptPaths: [] };
  const cwd = input?.workdir ?? input?.cwd;
  if (literalPath(cwd)) result.cwd = cwd;
  const command = literalCommand(input);
  if (!command) return result;
  const name = basename(command[0]!);
  const args = command.slice(1);
  if (["cat", "head", "tail", "sed"].includes(name)) result.readPaths = readOperands(name, args);
  else if (/^python(?:\d+(?:\.\d+)?)?$/.test(name) || name === "node" || shells.has(name)) {
    let index = 0;
    if (name.startsWith("python")) {
      while (/^-[uBIEsS]+$/.test(args[index] ?? "")) index++;
    }
    if (args[index] === "--") index++;
    const path = args[index];
    if (literalPath(path) && !path.startsWith("-")) result.scriptPaths = [path];
  } else if (literalPath(command[0]) && command[0].includes("/")) result.scriptPaths = [command[0]];
  return result;
};
