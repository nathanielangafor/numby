import { Spectrum, reply, reaction, text, attachment, voice, typing } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { readBoundedAttachment } from "./media.js";
import { ErrorCode } from "@photon-ai/advanced-imessage/grpc";
// Whitelisted diagnostics only: provider messages may contain phone numbers or tokens.
export function deliveryFailure(error) {
  const reasons = new Map([
    ["Send outcome unknown", "timeout"],
    ["Provider unavailable", "provider_unavailable"],
    ["Provider did not confirm the operation", "missing_confirmation"],
    ["Provider did not confirm the content part", "missing_part_confirmation"],
  ]);
  return {
    reason: reasons.get(error?.message) || "provider_error",
    ...(["Error", "TypeError", "ZodError", "IMessageError", "AuthenticationError", "NotFoundError", "RateLimitError", "ValidationError", "ConnectionError", "UnsupportedError"].includes(error?.name) ? {errorType: error.name} : {}),
    ...(Object.values(ErrorCode).includes(error?.code) ? {code: error.code} : {}),
    ...(Number.isInteger(error?.grpcCode) && error.grpcCode >= 0 && error.grpcCode <= 16 ? { grpcCode: error.grpcCode } : {}),
    ...(typeof error?.retryable === "boolean" ? {retryable: error.retryable} : {}),
    ...(["upstream", "spectrum-imessage", "middleware", "intermediary"].includes(error?.source) ? {source: error.source} : {}),
    ...(typeof error?.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(error.requestId) ? {requestId: error.requestId} : {}),
  };
}
export class Photon {
  constructor(projectId, secret) {
    this.projectId = projectId;
    this.secret = secret;
    this.ready = false;
  }
  async api(path, body) {
    const r = await fetch(
      `https://spectrum.photon.codes/projects/${this.projectId}/${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(`${this.projectId}:${this.secret}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw new Error(`Photon returned ${r.status}`);
    const result = await r.json();
    if (!result.succeed) throw new Error("Photon rejected request");
    return result.data;
  }
  async allocate(phone) {
    return this.api("users/", { type: "shared", phoneNumber: phone });
  }
  async connect(ingest) {
    this.app = await Spectrum({
      projectId: this.projectId,
      projectSecret: this.secret,
      providers: [imessage.config()],
      telemetry: false,
      options: { logLevel: "error", flattenGroups: true },
    });
    this.ready = true;
    try {
      for await (const [space, message] of this.app.messages) {
        console.log(
          JSON.stringify({
            event: "provider_inbound",
            platform: message.platform,
            type: space.type,
            direction: message.direction,
            contentType: message.content.type,
            senderIsPhone: /^\+[1-9]\d{6,14}$/.test(message.sender?.id || ""),
          }),
        );
        const inbound = normalizeInbound(space, message);
        if (inbound) ingest(inbound.space, inbound.message);
      }
    } finally {
      this.ready = false;
    }
  }
  async download(payload) {
    if (!this.ready) throw new Error("Provider unavailable");
    const file = await imessage(this.app).getAttachment(payload.message.content.id, payload.space.phone);
    return readBoundedAttachment(file);
  }
  async signal(payload, active) {
    if (!this.ready) throw new Error("Provider unavailable");
    const space = await imessage(this.app).space.get(payload.space.id);
    await space.send(typing(active ? "start" : "stop"));
  }
  async send(payload, value, operation) {
    if (!this.ready) throw new Error("Provider unavailable");
    const im = imessage(this.app);
    const space = await im.space.get(payload.space.id);
    let timer;
    try {
      return await Promise.race([
        deliver(space, payload.message, value, operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Send outcome unknown")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Explicit normalized event contract: never persist SDK objects, methods or target bodies.
export function normalizeInbound(space, message) {
  let content;
  if (message.content?.type === "text")
    content = { type: "text", text: message.content.text };
  else if (
    message.content?.type === "reply" &&
    message.content.content?.type === "text"
  )
    content = {
      type: "reply",
      text: message.content.content.text,
      targetId: message.content.target?.id,
    };
  else if (message.content?.type === "reaction")
    content = {
      type: "reaction",
      emoji: message.content.emoji,
      targetId: message.content.target?.id,
    };
  else if (["attachment", "voice"].includes(message.content?.type)) {
    const c = message.content;
    if (typeof c.id !== "string") return null;
    content = { type: c.type, id: c.id, name: c.name || "attachment", mimeType: c.mimeType || "application/octet-stream",
      ...(Number.isFinite(c.size) ? {size: c.size} : {}) };
  } else if (message.content?.type === "reply" && ["attachment", "voice"].includes(message.content.content?.type)) {
    const inner = normalizeInbound(space, {...message, content: message.content.content});
    if (!inner) return null;
    content = {...inner.message.content, targetId: message.content.target?.id};
  } else return null;
  return {
    space: {
      id: space.id,
      platform: message.platform,
      type: space.type,
      phone: space.phone,
    },
    message: {
      id: message.id,
      direction: message.direction,
      platform: message.platform,
      sender: { id: message.sender?.id },
      content,
      ...(Number.isInteger(message.partIndex)
        ? { partIndex: message.partIndex }
        : {}),
      ...(typeof message.parentId === "string"
        ? { parentId: message.parentId }
        : {}),
    },
  };
}
export async function deliver(space, message, value, operation) {
  const target = {
    ...message,
    space,
    content:
      message.content.type === "reply"
        ? { type: "text", text: message.content.text }
        : message.content,
  };
  if (["send-content", "reply-content"].includes(operation)) {
    let last;
    for (const part of value) {
      let item = part.type === "text" ? text(part.text) :
        (part.type === "voice" ? voice : attachment)(Buffer.from(part.data, "base64"), {name: part.name, mimeType: part.mimeType});
      if (operation === "reply-content") item = reply(item, target);
      last = await space.send(item);
      if (!last) throw new Error("Provider did not confirm the content part");
    }
    return last;
  }
  let content;
  if (operation === "send") content = value;
  else if (operation === "reply") content = reply(text(value), target);
  else if (operation === "react") content = reaction(value, target);
  else throw new Error("Unsupported outbound operation");
  const result = await space.send(content);
  if (!result) throw new Error("Provider did not confirm the operation");
  return result;
}
