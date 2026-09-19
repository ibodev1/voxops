import type { StreamTextTransform, ToolSet } from "ai";

// Keep a possible partial delimiter until the next model text delta arrives.
export function thinkingFilter<TOOLS extends ToolSet>(
  requireTool = false,
): StreamTextTransform<TOOLS> {
  return () => {
    const open = "<thinking>";
    const close = "</thinking>";
    let pending = "";
    let depth = 0;
    let grounded = !requireTool;
    const suffixLength = (value: string, token: string) => {
      for (let length = Math.min(value.length, token.length - 1); length > 0; length--)
        if (value.endsWith(token.slice(0, length))) return length;
      return 0;
    };
    return new TransformStream({
      transform(part, controller) {
        if (part.type === "tool-result") grounded = true;
        if (part.type !== "text-delta") {
          controller.enqueue(part);
          return;
        }
        if (!grounded) return;
        pending += part.text;
        let visible = "";
        while (pending) {
          const openAt = pending.indexOf(open);
          const closeAt = pending.indexOf(close);
          const opening = openAt >= 0 && (closeAt < 0 || openAt < closeAt);
          const index = opening ? openAt : closeAt;
          if (index >= 0) {
            if (!depth) visible += pending.slice(0, index);
            pending = pending.slice(index + (opening ? open.length : close.length));
            if (opening) depth++;
            else if (depth) depth--;
            continue;
          }
          const kept = Math.max(suffixLength(pending, open), suffixLength(pending, close));
          if (!depth) visible += pending.slice(0, pending.length - kept);
          pending = pending.slice(pending.length - kept);
          break;
        }
        if (visible) controller.enqueue({ ...part, text: visible });
      },
      flush() {
        // Discard an unfinished delimiter or thinking block instead of failing the response stream.
        pending = "";
        depth = 0;
      },
    });
  };
}
