import { describe, expect, it } from "vitest";
import type { ParsedCommand, ParsedShell } from "../api/types.js";
import { parseShellCommand } from "./index.js";

function parseOk(input: string): ParsedShell {
  const r = parseShellCommand(input);
  if (!r.ok) throw new Error(`预期解析成功，实际失败：${r.reason}`);
  return r.shell;
}

function first(input: string): ParsedCommand {
  const c = parseOk(input).commands[0];
  if (c === undefined) throw new Error("预期至少一个子命令");
  return c;
}

function executables(input: string): string[] {
  return parseOk(input).commands.map((c) => c.executable);
}

describe("词法层：unquote / 解转义 / token 重组", () => {
  it("引号拼接重组出 executable：r\"m\" -rf /", () => {
    const cmd = first('r"m" -rf /');
    expect(cmd.executable).toBe("rm");
    expect(cmd.args).toEqual(["-rf", "/"]);
    expect(cmd.indirect).toBe(false);
  });

  it("双引号中段拼接：terra\"form\" destroy", () => {
    expect(first('terra"form" destroy').executable).toBe("terraform");
  });

  it("单双引号混合拼接：\"r\"'m'", () => {
    expect(first('"r"\'m\' -rf /').executable).toBe("rm");
  });

  it("反斜杠转义拼接：e\\cho \"safe\"", () => {
    const cmd = first('e\\cho "safe"');
    expect(cmd.executable).toBe("echo");
    expect(cmd.args).toEqual(["safe"]);
  });

  it("单引号保留空白与特殊字符", () => {
    expect(first("echo 'a b ; c | d'").args).toEqual(["a b ; c | d"]);
  });

  it("单双引号交替拼接：'it'\"'\"'s'", () => {
    expect(first(`echo 'it'"'"'s'`).args).toEqual(["it's"]);
  });

  it("双引号内转义", () => {
    expect(first('echo "a\\"b"').args).toEqual(['a"b']);
  });

  it("行续接（反斜杠+换行）不产生新 token", () => {
    expect(first("echo a\\\nb").args).toEqual(["ab"]);
  });

  it("DROP\\ DATABASE 类转义空格合成单 token", () => {
    expect(first("mysql -e DROP\\ DATABASE").args).toEqual(["-e", "DROP DATABASE"]);
  });
});

describe("结构层：子命令切分 / 重定向 / 环境变量", () => {
  it("&& 切分：cd x && rm -rf /", () => {
    const shell = parseOk("cd x && rm -rf /");
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[0]?.executable).toBe("cd");
    expect(shell.commands[0]?.args).toEqual(["x"]);
    expect(shell.commands[1]?.executable).toBe("rm");
    expect(shell.commands[1]?.args).toEqual(["-rf", "/"]);
  });

  it("; || | 混合切分", () => {
    expect(executables("a; b || c | d")).toEqual(["a", "b", "c", "d"]);
  });

  it("换行切分", () => {
    expect(executables("ls\npwd")).toEqual(["ls", "pwd"]);
  });

  it("后台 & 切分", () => {
    expect(executables("sleep 1 & echo hi")).toEqual(["sleep", "echo"]);
  });

  it("子 shell 展开为同级子命令", () => {
    expect(executables("(cd x && rm -rf /)")).toEqual(["cd", "rm"]);
  });

  it("子 shell 的重定向下发到内部命令", () => {
    const cmd = first("(echo hi) > out.txt");
    expect(cmd.redirects.stdout).toBe("out.txt");
  });

  it("stdout 重定向", () => {
    expect(first("echo hi > out.txt").redirects).toEqual({ stdout: "out.txt" });
  });

  it(">> 追加", () => {
    expect(first("echo hi >> out.txt").redirects).toEqual({
      stdout: "out.txt",
      append: true,
    });
  });

  it("stdin 重定向", () => {
    expect(first("cat < in.txt").redirects).toEqual({ stdin: "in.txt" });
  });

  it("stderr 重定向与 2>&1", () => {
    expect(first("cmd 2> err.log").redirects).toEqual({ stderr: "err.log" });
    expect(first("cmd > out 2>&1").redirects).toEqual({ stdout: "out", stderr: "&1" });
  });

  it("行首环境变量赋值", () => {
    const cmd = first("FOO=bar BAR=baz cmd arg1");
    expect(cmd.env).toEqual({ FOO: "bar", BAR: "baz" });
    expect(cmd.executable).toBe("cmd");
    expect(cmd.args).toEqual(["arg1"]);
  });

  it("纯赋值行不产生子命令", () => {
    expect(parseOk("FOO=bar").commands).toHaveLength(0);
  });

  it("heredoc 正文不被当作命令解析", () => {
    const shell = parseOk("cat <<EOF\nrm -rf /\nEOF");
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]?.executable).toBe("cat");
    expect(shell.commands[0]?.redirects.stdin).toBe("EOF");
  });

  it("注释被剥离", () => {
    const cmd = first("rm -rf / # cleanup");
    expect(cmd.executable).toBe("rm");
    expect(cmd.args).toEqual(["-rf", "/"]);
  });
});

describe("间接执行识别（indirect）", () => {
  it("变量展开占据可执行位置：CMD='rm -rf /'; $CMD", () => {
    const shell = parseOk("CMD='rm -rf /'; $CMD");
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]?.executable).toBe("$CMD");
    expect(shell.commands[0]?.indirect).toBe(true);
  });

  it("命令替换占据可执行位置：$(get_cmd) -rf /", () => {
    const shell = parseOk("$(get_cmd) -rf /");
    expect(shell.commands[0]?.executable).toBe("$(get_cmd)");
    expect(shell.commands[0]?.indirect).toBe(true);
    expect(shell.commands[1]?.executable).toBe("get_cmd");
  });

  it("eval：标记 indirect 且载荷递归可见", () => {
    const shell = parseOk('eval "rm -rf /"');
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[0]?.executable).toBe("eval");
    expect(shell.commands[0]?.indirect).toBe(true);
    expect(shell.commands[1]?.executable).toBe("rm");
    expect(shell.commands[1]?.args).toEqual(["-rf", "/"]);
  });

  it("bash -c：标记 indirect 且载荷递归可见", () => {
    const shell = parseOk("bash -c 'rm -rf /'");
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[0]?.indirect).toBe(true);
    expect(shell.commands[1]?.executable).toBe("rm");
  });

  it("sh -c 与合并且带参数的 -c 簇", () => {
    expect(first("sh -c 'id'").indirect).toBe(true);
    const shell = parseOk("bash -lc 'id'");
    expect(shell.commands[0]?.indirect).toBe(true);
    expect(shell.commands[1]?.executable).toBe("id");
  });

  it("base64 -d 管道进 shell：echo xxx | base64 -d | sh", () => {
    const shell = parseOk("echo xxx | base64 -d | sh");
    expect(shell.commands).toHaveLength(3);
    expect(executables("echo xxx | base64 -d | sh")).toEqual(["echo", "base64", "sh"]);
    expect(shell.commands[0]?.indirect).toBe(false);
    expect(shell.commands[1]?.indirect).toBe(false);
    expect(shell.commands[2]?.indirect).toBe(true);
  });

  it("xargs sh", () => {
    const shell = parseOk("echo x | xargs sh");
    expect(shell.commands[1]?.executable).toBe("xargs");
    expect(shell.commands[1]?.indirect).toBe(true);
  });

  it("source / . 执行脚本文件", () => {
    expect(first("source ~/.bashrc").indirect).toBe(true);
    expect(first(". /tmp/x.sh").indirect).toBe(true);
  });

  it("shell 带脚本位置参数（写文件再执行形态）", () => {
    expect(first("sh /tmp/x.sh").indirect).toBe(true);
  });

  it("参数中的命令替换递归为可见子命令", () => {
    const shell = parseOk("echo $(rm -rf /)");
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[0]?.executable).toBe("echo");
    expect(shell.commands[0]?.indirect).toBe(false);
    expect(shell.commands[1]?.executable).toBe("rm");
    expect(shell.commands[1]?.args).toEqual(["-rf", "/"]);
  });

  it("反引号命令替换同样递归", () => {
    const shell = parseOk("echo `id`");
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[1]?.executable).toBe("id");
  });

  it("${} 参数展开内的命令替换递归", () => {
    const shell = parseOk("echo ${x:-$(id)}");
    expect(shell.commands).toHaveLength(2);
    expect(shell.commands[1]?.executable).toBe("id");
  });
});

describe("易绕过模式：flag 顺序与等效写法原样产出（归一化是 matcher 职责）", () => {
  it("git push origin main --force（flag 在 ref 后）", () => {
    const cmd = first("git push origin main --force");
    expect(cmd.executable).toBe("git");
    expect(cmd.args).toEqual(["push", "origin", "main", "--force"]);
  });

  it("kubectl delete --filename=x", () => {
    const cmd = first("kubectl delete --filename=x");
    expect(cmd.executable).toBe("kubectl");
    expect(cmd.args).toEqual(["delete", "--filename=x"]);
  });

  it("git branch --delete --force（= -D）", () => {
    expect(first("git branch --delete --force").args).toEqual([
      "branch",
      "--delete",
      "--force",
    ]);
  });

  it("terraform apply --auto-approve=true", () => {
    expect(first("terraform apply --auto-approve=true").args).toEqual([
      "apply",
      "--auto-approve=true",
    ]);
  });
});

describe("fail-closed：非法输入返回 ok:false 且不抛异常", () => {
  const invalid: [string, string][] = [
    ["双引号未闭合", 'echo "unterminated'],
    ["单引号未闭合", "echo 'unterminated"],
    ["命令替换未闭合", "echo $(unterminated"],
    ["反引号未闭合", "echo `unterminated"],
    ["${ 未闭合", "echo ${x"],
    ["行尾反斜杠", "echo \\"],
    ["&& 后缺少命令", "cmd &&"],
    ["|| 后缺少命令", "cmd ||"],
    ["| 后缺少命令", "cmd |"],
    ["| 前缺少命令", "| cmd"],
    ["行首 &&", "&& cmd"],
    ["子 shell 未闭合", "(cmd"],
    ["多余的 )", "cmd)"],
    ["空子 shell", "()"],
    ["重定向缺少目标", "cmd >"],
    ["重定向缺少目标（fd 前缀）", "cmd 2>"],
    ["重定向后随操作符", "cmd > | cat"],
    ["heredoc 缺少结束行", "cat <<EOF\nbody\n"],
  ];

  it.each(invalid)("%s → ok:false", (_label, input) => {
    const r = parseShellCommand(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.reason).toBe("string");
  });

  it("深层间接执行嵌套超出上限 → ok:false", () => {
    let s = "true";
    for (let i = 0; i < 20; i += 1) s = `sh -c ${JSON.stringify(s)}`;
    expect(parseShellCommand(s).ok).toBe(false);
  });

  it("任何输入都不抛出异常", () => {
    const nasty = [
      ...invalid.map(([, i]) => i),
      "",
      "((((",
      "))))",
      "$((( ",
      "${",
      "`",
      '"',
      "'",
      "\\",
      "&&&&",
      "||||",
      ";;",
      ">",
      "<",
      "&>",
      "2>",
      "<<",
      "$()",
      "``",
      "(;)",
      "\n\n\n",
      "# only comment",
      "echo $((1+2))",
      "FOO=bar",
      "echo hi # comment",
    ];
    for (const input of nasty) {
      expect(() => parseShellCommand(input)).not.toThrow();
      const r = parseShellCommand(input);
      expect(typeof r.ok).toBe("boolean");
    }
  });
});

describe("边界", () => {
  it("空输入与纯空白输入产出空命令列表", () => {
    expect(parseOk("").commands).toEqual([]);
    expect(parseOk("  \t\n  ").commands).toEqual([]);
    expect(parseOk("# comment only").commands).toEqual([]);
  });

  it("token 值不做变量求值：$FOO 保留字面", () => {
    const cmd = first("echo $FOO");
    expect(cmd.args).toEqual(["$FOO"]);
    expect(cmd.indirect).toBe(false);
  });

  it("赋值中的命令替换仍然可见", () => {
    const shell = parseOk("X=$(rm -rf /)");
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]?.executable).toBe("rm");
  });
});

describe("包装命令解包（D3a）：包装器 × {正常 / 危险 / 无参数边界 / 多层嵌套}", () => {
  function expectParsed(input: string, executable: string, args: string[]): ParsedCommand {
    const cmd = first(input);
    expect(cmd.executable).toBe(executable);
    expect(cmd.args).toEqual(args);
    return cmd;
  }

  /** 不解包语义：executable/args 原样、wrapper 缺省 */
  function expectKept(input: string, executable: string, args: string[]): ParsedCommand {
    const cmd = expectParsed(input, executable, args);
    expect(cmd.wrapper).toBeUndefined();
    return cmd;
  }

  describe("sudo", () => {
    it("正常命令：sudo ls /tmp，wrapper 溯源", () => {
      const cmd = expectParsed("sudo ls /tmp", "ls", ["/tmp"]);
      expect(cmd.wrapper).toBe("sudo");
    });
    it("危险命令：sudo rm -rf / → executable 必须是 rm（验收锚点）", () => {
      const cmd = expectParsed("sudo rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("sudo");
      expect(cmd.indirect).toBe(false);
    });
    it("无参数边界：裸 sudo 不解包，不是错误", () => {
      expectKept("sudo", "sudo", []);
    });
    it("flag 跳过：-u root / --user[=root] / -E / -- 终止符", () => {
      expectParsed("sudo -u root -E ls", "ls", []);
      expectParsed("sudo --user=root rm -rf /", "rm", ["-rf", "/"]);
      expectParsed("sudo --user root ls", "ls", []);
      expectParsed("sudo -- ls", "ls", []);
    });
    it("VAR=x 前缀并入 env 字段", () => {
      const cmd = expectParsed("sudo FOO=bar ls", "ls", []);
      expect(cmd.env).toEqual({ FOO: "bar" });
      expect(cmd.wrapper).toBe("sudo");
    });
    it("多层嵌套：sudo env -i rm -rf /，wrapper 按剥链 join", () => {
      const cmd = expectParsed("sudo env -i rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("sudo>env");
    });
  });

  describe("env", () => {
    it("正常命令：env ls", () => {
      expectParsed("env ls", "ls", []);
    });
    it("危险命令：env rm -rf /", () => {
      const cmd = expectParsed("env rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("env");
    });
    it("无参数边界：裸 env 不解包（env | sort 语义不变）", () => {
      expectKept("env", "env", []);
      const shell = parseOk("env | sort");
      expect(shell.commands[0]?.executable).toBe("env");
      expect(shell.commands[0]?.wrapper).toBeUndefined();
    });
    it("VAR=x 前缀按现行语义进 env 字段（含 -i）", () => {
      const cmd = expectParsed("env -i FOO=bar rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.env).toEqual({ FOO: "bar" });
    });
    it("flag 跳过：-u NAME / -- 终止符", () => {
      expectParsed("env -u FOO ls", "ls", []);
      expectParsed("env -- ls", "ls", []);
    });
    it("多层嵌套：env sudo -E rm -rf /", () => {
      const cmd = expectParsed("env sudo -E rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("env>sudo");
    });
  });

  describe("timeout", () => {
    it("正常命令：timeout 5 ls", () => {
      expectParsed("timeout 5 ls", "ls", []);
    });
    it("危险命令：timeout 5 rm -rf /", () => {
      const cmd = expectParsed("timeout 5 rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("timeout");
    });
    it("无参数边界：裸 timeout / 只有 DURATION 不解包", () => {
      expectKept("timeout", "timeout", []);
      expectKept("timeout 5", "timeout", ["5"]);
    });
    it("flag 跳过：-s KILL / --signal=KILL / 连写 -sKILL 与 -k", () => {
      expectParsed("timeout -s KILL 5 rm -rf /", "rm", ["-rf", "/"]);
      expectParsed("timeout --signal=KILL 5 ls", "ls", []);
      expectParsed("timeout -sKILL -k 1 5 ls", "ls", []);
    });
    it("多层嵌套：timeout 5 sudo rm -rf /", () => {
      const cmd = expectParsed("timeout 5 sudo rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("timeout>sudo");
    });
  });

  describe("nice", () => {
    it("正常命令：nice ls", () => {
      expectParsed("nice ls", "ls", []);
    });
    it("危险命令：nice rm -rf /", () => {
      const cmd = expectParsed("nice rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("nice");
    });
    it("无参数边界：裸 nice 不解包", () => {
      expectKept("nice", "nice", []);
    });
    it("flag 跳过：-n 5 / 连写 -n5 / 老式 -5 / --adjustment=5", () => {
      expectParsed("nice -n 5 rm -rf /", "rm", ["-rf", "/"]);
      expectParsed("nice -n5 ls", "ls", []);
      expectParsed("nice -5 ls", "ls", []);
      expectParsed("nice --adjustment=5 ls", "ls", []);
    });
    it("多层嵌套：nice -n 5 env rm -rf /", () => {
      const cmd = expectParsed("nice -n 5 env rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("nice>env");
    });
  });

  describe("nohup", () => {
    it("正常命令：nohup ls", () => {
      expectParsed("nohup ls", "ls", []);
    });
    it("危险命令：nohup rm -rf /", () => {
      const cmd = expectParsed("nohup rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("nohup");
    });
    it("无参数边界：裸 nohup / --help（无执行语义）不解包", () => {
      expectKept("nohup", "nohup", []);
      expectKept("nohup --help", "nohup", ["--help"]);
    });
    it("多层嵌套：nohup sudo rm -rf /", () => {
      const cmd = expectParsed("nohup sudo rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("nohup>sudo");
    });
  });

  describe("stdbuf", () => {
    it("正常命令：stdbuf -o0 ls", () => {
      expectParsed("stdbuf -o0 ls", "ls", []);
    });
    it("危险命令：stdbuf -o0 rm -rf /", () => {
      const cmd = expectParsed("stdbuf -o0 rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("stdbuf");
    });
    it("无参数边界：裸 stdbuf 不解包", () => {
      expectKept("stdbuf", "stdbuf", []);
    });
    it("flag 跳过：值分离 -o 0 / -e L / --output=0", () => {
      expectParsed("stdbuf -o 0 -e L rm -rf /", "rm", ["-rf", "/"]);
      expectParsed("stdbuf --output=0 ls", "ls", []);
    });
    it("多层嵌套：stdbuf -o0 timeout 5 rm -rf /", () => {
      const cmd = expectParsed("stdbuf -o0 timeout 5 rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("stdbuf>timeout");
    });
  });

  describe("command / builtin（shell 内建前缀）", () => {
    it("正常命令：command ls / builtin echo hi", () => {
      expectParsed("command ls", "ls", []);
      expectParsed("builtin echo hi", "echo", ["hi"]);
    });
    it("危险命令：command rm -rf / / builtin rm -rf /", () => {
      expectParsed("command rm -rf /", "rm", ["-rf", "/"]);
      const cmd = expectParsed("builtin rm -rf /", "rm", ["-rf", "/"]);
      expect(cmd.wrapper).toBe("builtin");
    });
    it("无参数边界：裸 command / 裸 builtin 不解包", () => {
      expectKept("command", "command", []);
      expectKept("builtin", "builtin", []);
    });
    it("command -p 跳过；-v/-V 只查路径不执行 → 保持不解包", () => {
      expectParsed("command -p rm -rf /", "rm", ["-rf", "/"]);
      expectKept("command -v rm", "command", ["-v", "rm"]);
    });
    it("多层嵌套：builtin command echo hi", () => {
      const cmd = expectParsed("builtin command echo hi", "echo", ["hi"]);
      expect(cmd.wrapper).toBe("builtin>command");
    });
  });

  describe("解包不吞间接执行信号与其它不变量", () => {
    it("sudo bash -c 解包后内层是 bash -c，indirect 必须仍为 true", () => {
      const shell = parseOk("sudo bash -c 'rm -rf /'");
      expect(shell.commands).toHaveLength(2);
      expect(shell.commands[0]?.executable).toBe("bash");
      expect(shell.commands[0]?.indirect).toBe(true);
      expect(shell.commands[0]?.wrapper).toBe("sudo");
      expect(shell.commands[1]?.executable).toBe("rm");
      expect(shell.commands[1]?.args).toEqual(["-rf", "/"]);
    });
    it("sudo -E sh -c 同样保持 indirect 与载荷递归", () => {
      const shell = parseOk("sudo -E sh -c 'id'");
      expect(shell.commands[0]?.executable).toBe("sh");
      expect(shell.commands[0]?.indirect).toBe(true);
      expect(shell.commands[1]?.executable).toBe("id");
    });
    it("sudo $CMD：内层是展开词，indirect 与 wrapper 共存", () => {
      const cmd = first("sudo $CMD");
      expect(cmd.executable).toBe("$CMD");
      expect(cmd.indirect).toBe(true);
      expect(cmd.wrapper).toBe("sudo");
    });
    it("包装器被剥掉的参数仍可递归看见：sudo -u $(id) rm -rf /", () => {
      const shell = parseOk("sudo -u $(id) rm -rf /");
      expect(shell.commands[0]?.executable).toBe("rm");
      expect(shell.commands[0]?.wrapper).toBe("sudo");
      expect(shell.commands[1]?.executable).toBe("id");
    });
    it("行首赋值 × 包装器赋值 × env 赋值三段共存", () => {
      const cmd = first("A=1 sudo B=2 env C=3 rm -rf /");
      expect(cmd.executable).toBe("rm");
      expect(cmd.args).toEqual(["-rf", "/"]);
      expect(cmd.env).toEqual({ A: "1", B: "2", C: "3" });
      expect(cmd.wrapper).toBe("sudo>env");
    });
    it("&& 切分后各子命令各自解包", () => {
      const shell = parseOk("cd /tmp && sudo rm -rf /");
      expect(shell.commands[0]?.executable).toBe("cd");
      expect(shell.commands[1]?.executable).toBe("rm");
      expect(shell.commands[1]?.wrapper).toBe("sudo");
    });
    it("放弃语义保持原样：sudo -s/-i/-e、未知长 flag、env -S", () => {
      expectKept("sudo -i id", "sudo", ["-i", "id"]);
      expectKept("sudo -e /etc/fstab", "sudo", ["-e", "/etc/fstab"]);
      expectKept("sudo --frobnicate ls", "sudo", ["--frobnicate", "ls"]);
      expectKept("env -S 'rm -rf /'", "env", ["-S", "rm -rf /"]);
    });
  });
});
