#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
//
// Test fixture: a stand-in ACP agent, used by acpRoundTrip.test.ts.
//
// The extension is a thin ACP client — the real agent is the `ainxt` CLI from a
// separate repository, so an end-to-end test that required it could never run in
// this repo's CI. This fixture implements the subset the extension actually
// drives (initialize, session/new, session/prompt with streaming
// session/update notifications) so the client's own protocol path is verified
// here, on every commit, with no CLI, gateway, model or credentials.
//
// It is NOT a product component and is excluded from the .vsix by .vscodeignore.
const readline = require('node:readline');
const args = process.argv.slice(2);
process.stderr.write(`[stub] argv=${JSON.stringify(args)}\n`);
process.stderr.write(`[stub] AINXT_HOME=${process.env.AINXT_HOME || '(unset)'}\n`);

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

let sessionCounter = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  process.stderr.write(`[stub] <- ${msg.method || 'response'} id=${msg.id}\n`);

  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
      _meta: { agentName: 'stub-ainxt', agentVersion: '0.0.0-audit' },
    }});
  }

  if (msg.method === 'session/new') {
    const id = `stub-session-${++sessionCounter}`;
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: id } });
  }

  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = (msg.params.prompt || []).map(b => b.text || '').join('');
    // Stream an assistant reply the way a real agent does.
    for (const chunk of ['Echo: ', text, '\n\nDone.']) {
      notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
      });
    }
    notify('session/update', {
      sessionId: sid,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `stub: no method ${msg.method}` } });
  }
});
