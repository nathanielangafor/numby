import test from "node:test";
import assert from "node:assert/strict";
import { deliver, normalizeInbound } from "../src/provider.js";
const space = { id: "dm-owner", phone: "shared", type: "dm" };
const message = {
  id: "message-owner",
  platform: "imessage",
  direction: "inbound",
  sender: { id: "+12405550101" },
  content: { type: "text", text: "hello" },
};
test("real SDK builders produce text, inline replies and tapbacks with trusted message targets", async () => {
  let observed;
  const channel = {
    ...space,
    async send(content) {
      observed = typeof content === "string" ? content : await content.build();
      return { id: "sent" };
    },
  };
  await deliver(channel, message, "normal", "send");
  assert.equal(observed, "normal");
  await deliver(channel, message, "threaded", "reply");
  assert.equal(observed.type, "reply");
  assert.equal(observed.target.id, message.id);
  assert.equal(observed.content.text, "threaded");
  await deliver(channel, message, "👍", "react");
  assert.equal(observed.type, "reaction");
  assert.equal(observed.target.id, message.id);
  assert.equal(observed.emoji, "👍");
  await assert.rejects(() => deliver(channel, message, "no", "group"));
  await assert.rejects(
    () =>
      deliver(
        {
          ...channel,
          async send() {
            return undefined;
          },
        },
        message,
        "no",
        "reply",
      ),
    /did not confirm/,
  );
});
test("SDK normalization forwards text, nested reply and added reaction without target bodies", () => {
  assert.equal(normalizeInbound(space, message).message.content.text, "hello");
  const reply = normalizeInbound(space, {
    ...message,
    content: {
      type: "reply",
      content: { type: "text", text: "nested" },
      target: { id: "prior", content: { text: "private-target" } },
    },
  });
  assert.deepEqual(reply.message.content, {
    type: "reply",
    text: "nested",
    targetId: "prior",
  });
  const reaction = normalizeInbound(space, {
    ...message,
    content: {
      type: "reaction",
      emoji: "❤️",
      target: { id: "prior", content: { text: "private-target" } },
    },
  });
  assert.deepEqual(reaction.message.content, {
    type: "reaction",
    emoji: "❤️",
    targetId: "prior",
  });
  assert.equal(
    normalizeInbound(space, {
      ...message,
      content: { type: "attachment", url: "private" },
    }),
    null,
  );
});

test("delivery diagnostics classify failures without leaking provider strings", async () => {
  const { deliveryFailure } = await import('../src/provider.js');
  assert.deepEqual(deliveryFailure({message:'token=secret phone=+12405550101',code:'recipientCoolingDown',grpcCode:8,retryable:true,source:'spectrum-imessage'}), {reason:'provider_error',code:'recipientCoolingDown',grpcCode:8,retryable:true,source:'spectrum-imessage'});
  assert.deepEqual(deliveryFailure({message:'Send outcome unknown'}),{reason:'timeout'});
  assert.deepEqual(deliveryFailure({message:'secret',code:'secret'}),{reason:'provider_error'});
});
