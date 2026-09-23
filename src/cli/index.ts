#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`agentfence: 未处理错误（fail-closed）：${String(error)}`);
    process.exitCode = 1;
  },
);
