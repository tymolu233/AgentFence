/**
 * ACP 代理入口：node dist/integrations/acp/index.js -- <agent command...>
 * 在编辑器（Zed 等）的 agent_servers 配置里把它包在真实 agent 外面，
 * 配置片段见同目录 README.md。
 */
import { runProxy } from "./proxy.js";

const sep = process.argv.indexOf("--");
const cmd = sep === -1 ? undefined : process.argv[sep + 1];
if (cmd === undefined) {
  process.stderr.write(
    "用法: node dist/integrations/acp/index.js -- <agent command...>\n" +
      "例:  node dist/integrations/acp/index.js -- gemini --experimental-acp\n",
  );
  process.exitCode = 2;
} else {
  runProxy(cmd, process.argv.slice(sep + 2));
}
