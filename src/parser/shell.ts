/**
 * Shell 词法/结构解析器（手写，无外部依赖）。
 * 及格线契约：.agents/notes/implemented/architecture/2026-09-23-rule-format-v1.md
 * - unquote/解转义/token 重组后才进匹配；
 * - 按 && || ; | & 换行切分子命令，子 shell 与命令替换递归展开为同级 ParsedCommand；
 * - 间接执行（eval / sh -c / 管道进 shell / xargs / source / $CMD / $(...)）打 indirect；
 * - fail-closed：解析失败返回 { ok: false }，绝不向调用方抛异常；
 * - 不做变量求值：$VAR / $(...) 在 token 值中保留字面，不确定性由 indirect 体现。
 */

import type { ParsedCommand, ParsedShell } from "../api/types.js";

export type ParseResult =
  | { ok: true; shell: ParsedShell }
  | { ok: false; reason: string };

const MAX_INPUT_LEN = 100_000;
const MAX_DEPTH = 16;
const MAX_COMMANDS = 512;

class ParseError extends Error {}

interface Word {
  value: string;
  hasExpansion: boolean;
  hasSubstitution: boolean;
  /** 词内命令替换的原始内文，解析阶段递归展开 */
  subs: string[];
}

interface RedirectToken {
  fd: number;
  op: string;
  target: Word;
}

type Operator = "&&" | "||" | ";" | "|" | "&" | "(" | ")";

type Token =
  | { kind: "word"; word: Word }
  | { kind: "op"; op: Operator }
  | ({ kind: "redirect" } & RedirectToken);

const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
]);

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VAR_START_RE = /[A-Za-z_]/;
const VAR_CHAR_RE = /[A-Za-z0-9_]/;
const SPECIAL_DOLLAR_RE = /[0-9@*?$!#-]/;
const C_FLAG_RE = /^-[A-Za-z]*c/;

function isBlank(c: string): boolean {
  return c === " " || c === "\t" || c === "\r";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isWordBreaker(c: string): boolean {
  return (
    isBlank(c) ||
    c === "\n" ||
    c === "&" ||
    c === "|" ||
    c === ";" ||
    c === "(" ||
    c === ")" ||
    c === "<" ||
    c === ">"
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

class Lexer {
  private pos = 0;
  private pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];

  constructor(private readonly input: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) {
        const h = this.pendingHeredocs[0];
        if (h !== undefined) {
          throw new ParseError(`heredoc '<<${h.delimiter}' 缺少结束行`);
        }
        return tokens;
      }
      if (c === "\n") {
        this.pos += 1;
        tokens.push({ kind: "op", op: ";" });
        this.consumeHeredocBodies();
        continue;
      }
      if (isBlank(c)) {
        this.pos += 1;
        continue;
      }
      if (c === "#") {
        this.skipToNewline();
        continue;
      }
      const op = this.readOperator();
      if (op !== null) {
        tokens.push(op);
        continue;
      }
      const redirect = this.readRedirect();
      if (redirect !== null) {
        tokens.push(redirect);
        continue;
      }
      const word = this.readWord();
      if (word === null) {
        throw new ParseError(`无法识别的字符 '${c}'（位置 ${this.pos}）`);
      }
      tokens.push({ kind: "word", word });
    }
  }

  private skipToNewline(): void {
    const nl = this.input.indexOf("\n", this.pos);
    this.pos = nl === -1 ? this.input.length : nl;
  }

  private consumeHeredocBodies(): void {
    while (this.pendingHeredocs.length > 0) {
      const h = this.pendingHeredocs.shift();
      if (h === undefined) return;
      for (;;) {
        const nl = this.input.indexOf("\n", this.pos);
        const end = nl === -1 ? this.input.length : nl;
        let line = this.input.slice(this.pos, end);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (h.stripTabs) line = line.replace(/^\t+/, "");
        if (line === h.delimiter) {
          this.pos = nl === -1 ? this.input.length : nl + 1;
          break;
        }
        if (nl === -1) {
          throw new ParseError(`heredoc '<<${h.delimiter}' 缺少结束行`);
        }
        this.pos = nl + 1;
      }
    }
  }

  private readOperator(): Token | null {
    const c = this.input[this.pos];
    const n1 = this.input[this.pos + 1];
    if (c === "&") {
      if (n1 === "&") {
        this.pos += 2;
        return { kind: "op", op: "&&" };
      }
      if (n1 === ">") {
        const append = this.input[this.pos + 2] === ">";
        this.pos += append ? 3 : 2;
        return this.finishRedirect(1, append ? "&>>" : "&>");
      }
      this.pos += 1;
      return { kind: "op", op: "&" };
    }
    if (c === "|") {
      if (n1 === "|") {
        this.pos += 2;
        return { kind: "op", op: "||" };
      }
      this.pos += n1 === "&" ? 2 : 1;
      return { kind: "op", op: "|" };
    }
    if (c === ";") {
      this.pos += 1;
      return { kind: "op", op: ";" };
    }
    if (c === "(") {
      this.pos += 1;
      return { kind: "op", op: "(" };
    }
    if (c === ")") {
      this.pos += 1;
      return { kind: "op", op: ")" };
    }
    return null;
  }

  private readRedirect(): Token | null {
    const start = this.pos;
    let fd = -1;
    let j = this.pos;
    for (;;) {
      const d = this.input[j];
      if (d === undefined || !isDigit(d)) break;
      j += 1;
    }
    const afterDigits = this.input[j];
    if (j > this.pos && (afterDigits === "<" || afterDigits === ">")) {
      fd = Number.parseInt(this.input.slice(this.pos, j), 10);
      this.pos = j;
    }
    const c = this.input[this.pos];
    if (c === ">") {
      this.pos += 1;
      const n = this.input[this.pos];
      const base = fd === -1 ? 1 : fd;
      if (n === ">") {
        this.pos += 1;
        return this.finishRedirect(base, ">>");
      }
      if (n === "&") {
        this.pos += 1;
        return this.finishRedirect(base, ">&");
      }
      if (n === "|") {
        this.pos += 1;
        return this.finishRedirect(base, ">");
      }
      return this.finishRedirect(base, ">");
    }
    if (c === "<") {
      this.pos += 1;
      const n = this.input[this.pos];
      const base = fd === -1 ? 0 : fd;
      if (n === "<") {
        this.pos += 1;
        const n2 = this.input[this.pos];
        if (n2 === "<") {
          this.pos += 1;
          return this.finishRedirect(base, "<<<");
        }
        if (n2 === "-") {
          this.pos += 1;
          return this.finishRedirect(base, "<<", true);
        }
        return this.finishRedirect(base, "<<");
      }
      if (n === "&") {
        this.pos += 1;
        return this.finishRedirect(base, "<&");
      }
      if (n === ">") {
        this.pos += 1;
        return this.finishRedirect(base, "<>");
      }
      return this.finishRedirect(base, "<");
    }
    this.pos = start;
    return null;
  }

  private finishRedirect(fd: number, op: string, heredocStripTabs = false): Token {
    let p = this.pos;
    for (;;) {
      const d = this.input[p];
      if (d === undefined || !isBlank(d)) break;
      p += 1;
    }
    const c = this.input[p];
    if (c === undefined || c === "#" || isWordBreaker(c)) {
      throw new ParseError(`重定向 '${op}' 缺少目标`);
    }
    this.pos = p;
    const target = this.readWord();
    if (target === null) {
      throw new ParseError(`重定向 '${op}' 缺少目标`);
    }
    if (op === "<<") {
      this.pendingHeredocs.push({ delimiter: target.value, stripTabs: heredocStripTabs });
    }
    return { kind: "redirect", fd, op, target };
  }

  /** 扫描一个词；词首是空白/操作元字符/注释时返回 null（由调用方处理）。 */
  private readWord(): Word | null {
    const start = this.pos;
    const first = this.input[this.pos];
    if (first === undefined || first === "#" || isWordBreaker(first)) return null;
    let value = "";
    let hasExpansion = false;
    let hasSubstitution = false;
    const subs: string[] = [];
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined || isWordBreaker(c)) break;
      if (c === "\\") {
        const n = this.input[this.pos + 1];
        if (n === undefined) throw new ParseError("行尾反斜杠后无内容");
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        value += n;
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        const end = this.input.indexOf("'", this.pos + 1);
        if (end === -1) throw new ParseError("单引号未闭合");
        value += this.input.slice(this.pos + 1, end);
        this.pos = end + 1;
        continue;
      }
      if (c === '"') {
        const r = this.readDoubleQuoted();
        value += r.value;
        hasExpansion ||= r.hasExpansion;
        hasSubstitution ||= r.hasSubstitution;
        subs.push(...r.subs);
        continue;
      }
      if (c === "`") {
        const inner = this.extractBacktick();
        value += "`" + inner + "`";
        hasSubstitution = true;
        subs.push(inner);
        continue;
      }
      if (c === "$") {
        const r = this.readDollar();
        value += r.value;
        hasExpansion ||= r.hasExpansion;
        hasSubstitution ||= r.hasSubstitution;
        subs.push(...r.subs);
        continue;
      }
      value += c;
      this.pos += 1;
    }
    if (this.pos === start) return null;
    return { value, hasExpansion, hasSubstitution, subs };
  }

  private readDoubleQuoted(): Word {
    this.pos += 1;
    let value = "";
    let hasExpansion = false;
    let hasSubstitution = false;
    const subs: string[] = [];
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) throw new ParseError("双引号未闭合");
      if (c === '"') {
        this.pos += 1;
        return { value, hasExpansion, hasSubstitution, subs };
      }
      if (c === "\\") {
        const n = this.input[this.pos + 1];
        if (n === undefined) throw new ParseError("双引号内反斜杠后无内容");
        if (n === '"' || n === "\\" || n === "$" || n === "`") {
          value += n;
          this.pos += 2;
          continue;
        }
        if (n === "\n") {
          this.pos += 2;
          continue;
        }
        value += "\\";
        this.pos += 1;
        continue;
      }
      if (c === "`") {
        const inner = this.extractBacktick();
        value += "`" + inner + "`";
        hasSubstitution = true;
        subs.push(inner);
        continue;
      }
      if (c === "$") {
        const r = this.readDollar();
        value += r.value;
        hasExpansion ||= r.hasExpansion;
        hasSubstitution ||= r.hasSubstitution;
        subs.push(...r.subs);
        continue;
      }
      value += c;
      this.pos += 1;
    }
  }

  /** 处理 `$...`；展开与替换保留字面原文进 value。 */
  private readDollar(): Word {
    const start = this.pos;
    const c1 = this.input[this.pos + 1];
    if (c1 === "(") {
      const inner = this.readDollarParen();
      const raw = this.input.slice(start, this.pos);
      if (inner === null) {
        return { value: raw, hasExpansion: true, hasSubstitution: false, subs: [] };
      }
      return { value: raw, hasExpansion: true, hasSubstitution: true, subs: [inner] };
    }
    if (c1 === "{") {
      this.pos += 2;
      const r = this.scanBraces();
      return {
        value: this.input.slice(start, this.pos),
        hasExpansion: true,
        hasSubstitution: r.subs.length > 0,
        subs: r.subs,
      };
    }
    if (c1 !== undefined && VAR_START_RE.test(c1)) {
      let j = this.pos + 1;
      for (;;) {
        const d = this.input[j];
        if (d === undefined || !VAR_CHAR_RE.test(d)) break;
        j += 1;
      }
      const raw = this.input.slice(this.pos, j);
      this.pos = j;
      return { value: raw, hasExpansion: true, hasSubstitution: false, subs: [] };
    }
    if (c1 !== undefined && SPECIAL_DOLLAR_RE.test(c1)) {
      this.pos += 2;
      return {
        value: this.input.slice(start, this.pos),
        hasExpansion: true,
        hasSubstitution: false,
        subs: [],
      };
    }
    this.pos += 1;
    return { value: "$", hasExpansion: false, hasSubstitution: false, subs: [] };
  }

  /** pos 在 '$' 上且下一字符是 '('；跳过整个 $(...) 或 $((...))，返回命令替换内文（算术展开返回 null）。 */
  private readDollarParen(): string | null {
    this.pos += 2;
    if (this.input[this.pos] === "(") {
      this.pos += 1;
      this.scanParens(2);
      return null;
    }
    return this.scanParens(1);
  }

  /** 从当前位置（开括号之后）扫描到括号配对完成；返回内文，pos 停在闭括号之后。 */
  private scanParens(initialDepth: number): string {
    const start = this.pos;
    let depth = initialDepth;
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) throw new ParseError("命令替换/算术展开未闭合");
      if (c === "\\") {
        if (this.input[this.pos + 1] === undefined) {
          throw new ParseError("替换内反斜杠后无内容");
        }
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        this.skipSingleQuoted();
        continue;
      }
      if (c === '"') {
        this.skipDoubleQuoted();
        continue;
      }
      if (c === "`") {
        this.extractBacktick();
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "(") {
        this.readDollarParen();
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "{") {
        this.pos += 2;
        this.scanBraces();
        continue;
      }
      if (c === "(") {
        depth += 1;
        this.pos += 1;
        continue;
      }
      if (c === ")") {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) return this.input.slice(start, this.pos - 1);
        continue;
      }
      this.pos += 1;
    }
  }

  /** 从当前位置（'${' 之后）扫描到配对 '}'；收集内文中的命令替换。 */
  private scanBraces(): { subs: string[] } {
    const subs: string[] = [];
    let depth = 1;
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) throw new ParseError("'${' 未闭合");
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        this.skipSingleQuoted();
        continue;
      }
      if (c === '"') {
        this.skipDoubleQuoted();
        continue;
      }
      if (c === "`") {
        subs.push(this.extractBacktick());
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "(") {
        const inner = this.readDollarParen();
        if (inner !== null) subs.push(inner);
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "{") {
        this.pos += 2;
        subs.push(...this.scanBraces().subs);
        continue;
      }
      if (c === "{") {
        depth += 1;
        this.pos += 1;
        continue;
      }
      if (c === "}") {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) return { subs };
        continue;
      }
      this.pos += 1;
    }
  }

  private skipSingleQuoted(): void {
    const end = this.input.indexOf("'", this.pos + 1);
    if (end === -1) throw new ParseError("单引号未闭合");
    this.pos = end + 1;
  }

  private skipDoubleQuoted(): void {
    this.pos += 1;
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) throw new ParseError("双引号未闭合");
      if (c === '"') {
        this.pos += 1;
        return;
      }
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "`") {
        this.extractBacktick();
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "(") {
        this.readDollarParen();
        continue;
      }
      if (c === "$" && this.input[this.pos + 1] === "{") {
        this.pos += 2;
        this.scanBraces();
        continue;
      }
      this.pos += 1;
    }
  }

  private extractBacktick(): string {
    this.pos += 1;
    const start = this.pos;
    for (;;) {
      const c = this.input[this.pos];
      if (c === undefined) throw new ParseError("反引号未闭合");
      if (c === "`") {
        const inner = this.input.slice(start, this.pos);
        this.pos += 1;
        return inner;
      }
      this.pos += c === "\\" ? 2 : 1;
    }
  }
}

type LastOp = "start" | "cmd" | Operator;

function isConnector(op: LastOp): boolean {
  return op === "&&" || op === "||" || op === "|";
}

function redirectTargetValue(op: string, target: Word): string {
  return (op === ">&" || op === "<&" ? "&" : "") + target.value;
}

function applyRedirect(
  rc: ParsedCommand["redirects"],
  fd: number,
  op: string,
  targetValue: string,
): void {
  if (op === "&>" || op === "&>>") {
    if (rc.stdout === undefined) rc.stdout = targetValue;
    if (rc.stderr === undefined) rc.stderr = targetValue;
    if (op === "&>>") rc.append = true;
    return;
  }
  if (op.startsWith("<")) {
    if (rc.stdin === undefined) rc.stdin = targetValue;
    return;
  }
  if (fd === 2) {
    if (rc.stderr === undefined) rc.stderr = targetValue;
    if (op === ">>") rc.append = true;
    return;
  }
  if (rc.stdout === undefined) rc.stdout = targetValue;
  if (op === ">>") rc.append = true;
}

function buildRedirects(redirects: RedirectToken[]): ParsedCommand["redirects"] {
  const out: ParsedCommand["redirects"] = {};
  for (const r of redirects) {
    applyRedirect(out, r.fd, r.op, redirectTargetValue(r.op, r.target));
  }
  return out;
}

/** 扫描 shell 解释器的选项区（到第一个位置参数或 -- 为止），提取 -c 载荷与位置参数迹象。 */
function shellProbe(args: string[]): { payload: string | undefined; hasPositional: boolean } {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--") return { payload: undefined, hasPositional: i + 1 < args.length };
    if (!a.startsWith("-") || a === "-") {
      return { payload: undefined, hasPositional: true };
    }
    if (C_FLAG_RE.test(a)) {
      const inline = a.slice(a.indexOf("c") + 1);
      return { payload: inline.length > 0 ? inline : args[i + 1], hasPositional: false };
    }
  }
  return { payload: undefined, hasPositional: false };
}

class ShellParser {
  readonly commands: ParsedCommand[] = [];

  constructor(private readonly depth: number) {}

  parseSequence(tokens: Token[]): void {
    let words: Word[] = [];
    let redirects: RedirectToken[] = [];
    let pipedStdin = false;
    let expectCommand = true;
    let lastOp: LastOp = "start";

    const flush = (): void => {
      this.buildCommand(words, redirects, pipedStdin);
      words = [];
      redirects = [];
      pipedStdin = false;
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === undefined) continue;
      if (t.kind === "word") {
        words.push(t.word);
        expectCommand = false;
        lastOp = "cmd";
        continue;
      }
      if (t.kind === "redirect") {
        if (expectCommand && isConnector(lastOp)) {
          throw new ParseError(`'${lastOp}' 后缺少命令`);
        }
        redirects.push({ fd: t.fd, op: t.op, target: t.target });
        continue;
      }
      if (t.op === "(") {
        if (!expectCommand) throw new ParseError("'(' 前缺少操作符");
        let d = 1;
        let j = i + 1;
        while (j < tokens.length && d > 0) {
          const tk = tokens[j];
          if (tk !== undefined && tk.kind === "op") {
            if (tk.op === "(") d += 1;
            else if (tk.op === ")") d -= 1;
          }
          j += 1;
        }
        if (d > 0) throw new ParseError("子 shell 括号未闭合");
        const inner = tokens.slice(i + 1, j - 1);
        const groupRedirects: RedirectToken[] = [];
        let k = j;
        for (;;) {
          const tk = tokens[k];
          if (tk === undefined || tk.kind !== "redirect") break;
          groupRedirects.push({ fd: tk.fd, op: tk.op, target: tk.target });
          k += 1;
        }
        this.parseGroup(inner, groupRedirects);
        i = k - 1;
        expectCommand = false;
        lastOp = "cmd";
        continue;
      }
      if (t.op === ")") throw new ParseError("多余的 ')'");
      if (t.op === "&&" || t.op === "||" || t.op === "|") {
        if (expectCommand) throw new ParseError(`'${t.op}' 前缺少命令`);
        flush();
        pipedStdin = t.op === "|";
        expectCommand = true;
        lastOp = t.op;
        continue;
      }
      // ";" | "&"
      if (expectCommand && isConnector(lastOp)) {
        throw new ParseError(`'${lastOp}' 后缺少命令`);
      }
      if (!expectCommand) flush();
      expectCommand = true;
      lastOp = t.op;
    }

    if (expectCommand && isConnector(lastOp)) {
      throw new ParseError(`'${lastOp}' 后缺少命令`);
    }
    if (!expectCommand) flush();
  }

  private parseGroup(inner: Token[], groupRedirects: RedirectToken[]): void {
    if (this.depth + 1 > MAX_DEPTH) {
      throw new ParseError(`嵌套层级超过上限 ${MAX_DEPTH}`);
    }
    if (!inner.some((t) => t.kind === "word")) {
      throw new ParseError("空的子 shell");
    }
    const sub = new ShellParser(this.depth + 1);
    sub.parseSequence(inner);
    for (const c of sub.commands) {
      for (const gr of groupRedirects) {
        applyRedirect(c.redirects, gr.fd, gr.op, redirectTargetValue(gr.op, gr.target));
      }
      this.pushCommand(c);
    }
    for (const gr of groupRedirects) {
      for (const s of gr.target.subs) this.parseNested(s);
    }
  }

  private buildCommand(words: Word[], redirects: RedirectToken[], pipedStdin: boolean): void {
    if (words.length === 0) {
      for (const r of redirects) {
        for (const s of r.target.subs) this.parseNested(s);
      }
      return;
    }
    const env: Record<string, string> = {};
    const envWords: Word[] = [];
    let idx = 0;
    for (;;) {
      const w = words[idx];
      if (w === undefined || !ASSIGN_RE.test(w.value)) break;
      const eq = w.value.indexOf("=");
      env[w.value.slice(0, eq)] = w.value.slice(eq + 1);
      envWords.push(w);
      idx += 1;
    }
    const execWord = words[idx];
    const argWords = words.slice(idx + 1);
    if (execWord === undefined) {
      for (const w of envWords) {
        for (const s of w.subs) this.parseNested(s);
      }
      for (const r of redirects) {
        for (const s of r.target.subs) this.parseNested(s);
      }
      return;
    }

    const executable = execWord.value;
    const args = argWords.map((w) => w.value);
    let indirect = execWord.hasExpansion || execWord.hasSubstitution;
    let recursePayload: string | null = null;
    const base = basename(executable);

    if (base === "eval") {
      indirect = true;
      if (args.length > 0) recursePayload = args.join(" ");
    } else if (SHELL_EXECUTABLES.has(base)) {
      const probe = shellProbe(args);
      if (probe.payload !== undefined) {
        indirect = true;
        recursePayload = probe.payload;
      } else if (pipedStdin || probe.hasPositional) {
        indirect = true;
      }
    } else if (base === "xargs" || base === "source" || base === ".") {
      indirect = true;
    }

    this.pushCommand({
      executable,
      args,
      redirects: buildRedirects(redirects),
      env,
      indirect,
    });

    for (const w of [...envWords, execWord, ...argWords]) {
      for (const s of w.subs) this.parseNested(s);
    }
    for (const r of redirects) {
      for (const s of r.target.subs) this.parseNested(s);
    }
    if (recursePayload !== null) this.parseNested(recursePayload);
  }

  private pushCommand(c: ParsedCommand): void {
    if (this.commands.length >= MAX_COMMANDS) {
      throw new ParseError(`子命令数量超过上限 ${MAX_COMMANDS}`);
    }
    this.commands.push(c);
  }

  private parseNested(source: string): void {
    if (this.depth + 1 > MAX_DEPTH) {
      throw new ParseError(`嵌套层级超过上限 ${MAX_DEPTH}`);
    }
    const result = parseShell(source, this.depth + 1);
    if (!result.ok) {
      throw new ParseError(`嵌套命令解析失败：${result.reason}`);
    }
    for (const c of result.shell.commands) this.pushCommand(c);
  }
}

function parseShell(input: string, depth: number): ParseResult {
  try {
    if (typeof input !== "string") {
      return { ok: false, reason: "输入不是字符串" };
    }
    if (input.length > MAX_INPUT_LEN) {
      return { ok: false, reason: `输入长度超过上限 ${MAX_INPUT_LEN}` };
    }
    if (depth > MAX_DEPTH) {
      return { ok: false, reason: `嵌套层级超过上限 ${MAX_DEPTH}` };
    }
    const tokens = new Lexer(input).tokenize();
    const parser = new ShellParser(depth);
    parser.parseSequence(tokens);
    return { ok: true, shell: { commands: parser.commands } };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, reason: e.message };
    return { ok: false, reason: e instanceof Error ? e.message : "未知解析错误" };
  }
}

export function parseShellCommand(input: string): ParseResult {
  return parseShell(input, 0);
}
