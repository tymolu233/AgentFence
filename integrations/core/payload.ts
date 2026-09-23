/**
 * stdin payload 读取与守卫。hook 入口的唯一 IO 边界；
 * JSON.parse 结果一律按 unknown 收窄（不变量：调用方自报不可信）。
 */

/** payload 形状非法时抛出；上层一律按 fail-closed 转 DENY */
export class HookPayloadError extends Error {
  override readonly name = "HookPayloadError";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受非空字符串；其余一律 undefined（自报字段不可信，缺省即无） */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 读取 stdin 全部内容（hook 宿主经 stdin 传 JSON） */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 解析 stdin 文本为 JSON 对象。空输入 / 非 JSON / 非对象一律
 * HookPayloadError —— 无法识别的调用不得放行（fail-closed）。
 */
export function parseHookPayload(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) {
    throw new HookPayloadError("stdin 为空：宿主未传入 hook payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HookPayloadError(
      `payload 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new HookPayloadError("payload 必须是 JSON 对象");
  }
  return parsed;
}
