import { basename } from "node:path";

type Word = { start: number; end: number; value: string; command: boolean };
type Quote = "'" | '"' | null;

// Executable-taking prefixes supported by RTK's native rewrite contract.
type Prefix = { values: string[]; flags: string[]; operands?: number; assignments?: boolean; numeric?: boolean };
const prefixes: Record<string, Prefix> = {
  env: { values: ["-u", "--unset", "-C", "--chdir"], flags: ["-i", "--ignore-environment"], assignments: true },
  command: { values: [], flags: ["-p"] },
  exec: { values: ["-a"], flags: ["-c", "-l"] },
  noglob: { values: [], flags: [] }, nocorrect: { values: [], flags: [] },
  timeout: { values: ["-s", "-k", "--signal", "--kill-after"], flags: ["--preserve-status", "--foreground", "-v", "--verbose"], operands: 1 },
  time: { values: ["-f", "-o", "--format", "--output"], flags: ["-p", "-a", "-v", "--append", "--verbose", "--portability", "--quiet"] },
  nice: { values: ["-n", "--adjustment"], flags: [], numeric: true },
  nohup: { values: [], flags: [] }
};

const parameterEnd = (input: string, start: number): number | null => {
  const quotes: Quote[] = [null];
  for (let i = start + 2; i < input.length; i++) {
    const quote = quotes.at(-1), c = input[i]!;
    if (quote === "'") { if (c === "'") quotes[quotes.length - 1] = null; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "`" || (c === "$" && input[i + 1] === "(")) return null;
    if (c === "$" && input[i + 1] === "{") { quotes.push(null); i++; continue; }
    if (c === '"') { quotes[quotes.length - 1] = quote === '"' ? null : '"'; continue; }
    if (c === "'" && quote === null) { quotes[quotes.length - 1] = "'"; continue; }
    if (c === "}" && quote === null) { quotes.pop(); if (quotes.length === 0) return i + 1; }
  }
  return null;
};

/** Locate executable words without evaluating or reserializing the shell command. */
const commandWords = (input: string): Word[] | null => {
  const words: Word[] = [];
  let command = true;
  let redirectTarget = false;
  let prefix: Prefix | undefined;
  let prefixValue = false, prefixOptions = true, prefixOperands = 0;
  for (let i = 0; i < input.length;) {
    const character = input[i]!;
    if (character === "\\" && input[i + 1] === "\n") { i += 2; continue; }
    if (/\s/.test(character)) {
      if (character === "\n") { command = true; prefix = undefined; }
      i++; continue;
    }
    if (character === "#") { while (i < input.length && input[i] !== "\n") i++; continue; }
    if ("<>".includes(character) && input[i + 1] === "(") return null;
    const redirect = /^(?:\d+)?(?:>&|<&|>>?|<|&>>?)/.exec(input.slice(i));
    if (redirect) {
      if (input.slice(i).startsWith("<<")) return null;
      i += redirect[0].length; redirectTarget = true; continue;
    }
    if (";&|()".includes(character)) {
      if (character === "(" && (!command || input[i + 1] === "(")) return null;
      i += input[i + 1] === character && ";&|".includes(character) ? 2 : 1;
      command = character !== ")"; prefix = undefined; continue;
    }
    const start = i;
    let value = "";
    let quote: Quote = null;
    while (i < input.length) {
      const c = input[i]!;
      if (quote === "'") {
        if (c === "'") quote = null; else value += c;
        i++; continue;
      }
      if (c === "`" || (c === "$" && input[i + 1] === "(")) return null;
      if (c === "\\") {
        const next = input[i + 1];
        if (next === undefined) return null;
        if (next !== "\n") value += quote === '"' && !'$`"\\'.includes(next) ? `\\${next}` : next;
        i += 2; continue;
      }
      if (c === "$" && input[i + 1] === "{") {
        const end = parameterEnd(input, i);
        if (end === null) return null;
        value += input.slice(i, end); i = end; continue;
      }
      if (quote === '"') {
        if (c === '"') quote = null; else value += c;
        i++; continue;
      }
      if (/\s/.test(c) || ";&|()<>".includes(c)) break;
      if (c === "'" || c === '"') { quote = c; i++; continue; }
      value += c; i++;
    }
    // Attached parentheses can be functions, arrays, or glob syntax, not subshells.
    if (quote !== null || input[i] === "(") return null;
    const word: Word = { start, end: i, value, command: false };
    words.push(word);
    if (redirectTarget) { redirectTarget = false; continue; }
    if (!command) continue;
    if ((!prefix || prefix.assignments) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(input.slice(start, i))) {
      continue;
    }
    if (prefix) {
      if (prefixValue) { prefixValue = false; continue; }
      if (prefixOptions && value === "--") { prefixOptions = false; continue; }
      if (prefixOptions && value.startsWith("-")) {
        if (prefix.flags.includes(value) || (prefix.numeric && /^-\d+$/.test(value))) continue;
        if (prefix.values.includes(value)) { prefixValue = true; continue; }
        if (prefix.values.some(option => option.startsWith("--") ? value.startsWith(`${option}=`) : value.startsWith(option) && value.length > option.length)) continue;
        return null;
      }
      if (prefixOperands > 0) { prefixOperands--; continue; }
    }
    prefix = Object.hasOwn(prefixes, basename(value)) ? prefixes[basename(value)] : undefined;
    if (prefix) { prefixValue = false; prefixOptions = true; prefixOperands = prefix.operands ?? 0; continue; }
    // These constructs need a complete shell grammar; leave them to the Provider.
    if (["if", "for", "while", "until", "case", "function", "select", "coproc", "{", "}", "[["].includes(value)) return null;
    if (/^\s*\(\s*\)/.test(input.slice(i))) return null;
    word.command = true; command = false;
  }
  return redirectTarget ? null : words;
};

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const pinRtkCommand = (input: string, binary: string): string | null => {
  const targets = commandWords(input)?.filter(word => word.command && word.value === "rtk");
  if (!targets?.length) return null;
  let result = "", position = 0;
  for (const word of targets) {
    result += input.slice(position, word.start) + quote(binary);
    position = word.end;
  }
  return result + input.slice(position);
};

/** Recognize standalone native rewrite hooks; retain hooks containing other commands. */
export const isNativeRtkHook = (input: string): boolean => {
  const words = commandWords(input);
  const commands = words?.filter(word => word.command);
  if (!words || commands?.length !== 1 || basename(commands[0]!.value) !== "rtk") return false;
  const arguments_ = words.slice(words.indexOf(commands[0]!) + 1);
  return arguments_[0]?.value === "hook" && arguments_.length >= 2;
};
