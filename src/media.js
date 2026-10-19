export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const bad = (message) => { throw Object.assign(new Error(message), {status: 400}); };
export function validateParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 8) bad("Provide 1–8 content parts.");
  let bytes = 0;
  for (const p of parts) {
    if (!p || typeof p !== "object" || Array.isArray(p)) bad("Invalid content part.");
    if (p.type === "text") {
      if (Object.keys(p).some(k => !["type", "text"].includes(k)) || typeof p.text !== "string" || !p.text.trim() || p.text.length > 4000) bad("Invalid text part.");
    } else if (["attachment", "voice"].includes(p.type)) {
      if (Object.keys(p).some(k => !["type", "name", "mimeType", "data"].includes(k))) bad("Unsupported media fields.");
      if (typeof p.name !== "string" || !p.name || p.name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(p.name) || [".", ".."].includes(p.name)) bad("Provide a safe file name.");
      if (typeof p.mimeType !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(p.mimeType) || p.mimeType.length > 150) bad("Invalid MIME type.");
      if (p.type === "voice" && !p.mimeType.startsWith("audio/")) bad("Voice notes require audio.");
      if (typeof p.data !== "string" || !p.data || p.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) bad("Invalid media data; maximum 10 MiB total.");
      const data = Buffer.from(p.data, "base64");
      if (data.toString("base64") !== p.data) bad("Media must be canonical base64.");
      bytes += data.length;
      if (bytes > MAX_MEDIA_BYTES) bad("Maximum 10 MiB total media per operation.");
    } else bad("Unsupported content type. Use text, attachment, or voice.");
  }
  return parts;
}

export async function readBoundedAttachment(attachment) {
  if (!attachment || attachment.size > MAX_MEDIA_BYTES) throw Object.assign(new Error("Attachment unavailable or larger than 10 MiB."), {status: 413});
  const reader = (await attachment.stream()).getReader();
  const chunks = []; let size = 0, timer;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_MEDIA_BYTES) throw Object.assign(new Error("Attachment exceeds 10 MiB."), {status: 413});
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Attachment download timed out."), {status: 504})), 30000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}
