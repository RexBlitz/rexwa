import config from '../config.js';
import log from '../core/logger.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

// --- Helpers ---
async function geminiJson(prompt, systemInstruction, model, apiKey) {
  const finalModel = model || DEFAULT_MODEL;
  const key = apiKey || process.env.GEMINI_API_KEY || config.get?.('ai.gemini.apiKey');
  if (!key) throw new Error('Gemini API key missing.');

  const body = {
    contents: [
      ...(systemInstruction ? [{ role: 'user', parts: [{ text: systemInstruction }] }] : []),
      { role: 'user', parts: [{ text: prompt }] }
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json'
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${finalModel}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

function buildManifest(bot) {
  const cmds = [];
  for (const [moduleName, moduleInfo] of bot.moduleLoader.modules) {
    const instance = moduleInfo.instance;
    if (!Array.isArray(instance?.commands)) continue;
    for (const c of instance.commands) {
      cmds.push({
        name: c.name,
        module: moduleName,
        description: c.description || '',
        usage: c.usage || '',
        permissions: c.permissions || 'public',
        aliases: c.aliases || []
      });
    }
  }
  return {
    bot: {
      name: config.get?.('bot.name') || 'HyperWa',
      version: config.get?.('bot.version') || '1.0.0',
      prefix: config.get?.('bot.prefix') || '.',
      owner: config.get?.('bot.owner') || ''
    },
    commands: cmds
  };
}

function stringifyManifestShort(m) {
  return m.commands.map(c => `${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''} – ${c.description}`).join('\n');
}

function findCommandHandler(bot, name) {
  if (!name) return null;
  const h = bot.messageHandler.commandHandlers.get(name);
  if (h) return { name, handler: h };
  for (const [cmdName, h] of bot.messageHandler.commandHandlers.entries()) {
    if (cmdName === name) return { name: cmdName, handler: h };
  }
  return null;
}

// --- Module ---
export default class JarvisModule {
  constructor(bot) {
    this.bot = bot;
    this.name = 'jarvis';
    this.metadata = {
      description: 'Natural-language AI control layer (Gemini)',
      version: '1.0.0',
      author: 'Jarvis Layer',
      category: 'AI'
    };

    this.state = {
      enabled: true,
      persona: config.get?.('ai.persona') || 'friendly_jarvis'
    };

    this.commands = [
      {
        name: 'xi',
        description: 'Enable/disable AI NL or run a prompt.',
        usage: '.xi on | .xi off | .xi status | .xi <msg>',
        permissions: 'owner',
        execute: async (msg, params, { bot, sender }) => {
          const sub = (params[0] || '').toLowerCase();

          if (sub === 'on') {
            this.state.enabled = true;
            return bot.sendMessage(sender, { text: '✅ AI enabled.' });
          }
          if (sub === 'off') {
            this.state.enabled = false;
            return bot.sendMessage(sender, { text: '⏸ AI disabled.' });
          }
          if (sub === 'status') {
            return bot.sendMessage(sender, { text: `🤖 AI status: *${this.state.enabled ? 'enabled' : 'disabled'}*` });
          }

          const text = params.join(' ').trim();
          if (!text) return bot.sendMessage(sender, { text: 'Usage: .xi <message>' });

          const answer = await this.freeChat(text).catch(e => `❌ ${e.message}`);
          return bot.sendMessage(sender, { text: answer });
        }
      },
      {
        name: 'skills',
        description: 'Show AI-visible commands.',
        usage: '.skills',
        permissions: 'public',
        execute: async (msg, _params, { bot, sender }) => {
          const manifest = buildManifest(bot);
          const list = stringifyManifestShort(manifest);
          return bot.sendMessage(sender, { text: `🧠 *AI Skills*\n${list || 'None.'}` });
        }
      }
    ];

    this.messageHooks = {};
  }

  async init() {
    this.messageHooks = {
      nlp: this.onNlp.bind(this)
    };
  }

  async destroy() {}

  // --- AI Core ---
async routeIntent(userText, manifest) {
  const system = `
You are an AI command router for a WhatsApp bot. You know these commands:

${stringifyManifestShort(manifest)}

If the user asks for something that matches a command, choose it and fill arguments from the message.
If not, set "action":"chat" and produce a helpful natural-language reply.

Return strict JSON:
{
  "action": "command" | "chat",
  "command": "<commandName or empty>",
  "args": ["..."],
  "reply": "<assistant reply if action=chat>"
}

Rules:
- If user intent is close to a command (even with typos), still map to it.
- If multiple commands could fit, pick the best single one.
- Be concise in "reply".
`;
  const prompt = JSON.stringify({ user: userText, prefix: manifest.bot.prefix });
  return await geminiJson(prompt, system, config.get?.('ai.gemini.model'), config.get?.('ai.gemini.apiKey'));
}


  async freeChat(userText) {
    const system = (config.get?.('ai.personaSystem') || `
You are Jarvis: concise, helpful, slightly witty, never rude. Avoid long paragraphs unless asked.
`).trim();

    const out = await geminiJson(JSON.stringify({ user: userText }),
      system,
      config.get?.('ai.gemini.model'),
      config.get?.('ai.gemini.apiKey')
    );

    return out?.reply || out?.text || JSON.stringify(out);
  }

  // --- Hooks ---
// --- Hooks ---
async onNlp(msg, text, bot) {
  try {
    if (!this.state.enabled) return;
    if (!text?.trim()) return;

    const jid = msg.key.remoteJid;

    // ✅ DO NOT mark read here (removed)
    try {
      await this.bot.sock.presenceSubscribe(jid);
      await this.bot.sock.sendPresenceUpdate('composing', jid);
    } catch {}

    const manifest = buildManifest(this.bot);
    const routed = await this.routeIntent(text, manifest);

    // ✅ Command mode
    if (routed?.action === 'command' && routed?.command) {
      const found = findCommandHandler(this.bot, routed.command);
      const params = Array.isArray(routed.args) ? routed.args : [];

      try {
        if (found?.handler) {
          await found.handler.execute(msg, params, {
            bot: this.bot,
            sender: jid,
            participant: msg.key.participant || jid,
            isGroup: jid.endsWith('@g.us')
          });
        } else {
          await bot.sendMessage(jid, { text: routed.reply || `Could not execute ${routed.command}.` });
        }
      } catch (err) {
        await bot.sendMessage(jid, { text: `❌ Error running ${routed.command}: ${err.message}` });
      }

      try { await this.bot.sock.sendPresenceUpdate('paused', jid); } catch {}

      // ✅ NOW mark read (after reply)
      try { await this.bot.sock.readMessages([msg.key]); } catch {}

      return;
    }

    // ✅ Chat mode
    const reply = routed?.reply || await this.freeChat(text);

    try { await this.bot.sock.sendPresenceUpdate('paused', jid); } catch {}
    await bot.sendMessage(jid, { text: reply });

    // ✅ Mark message as read AFTER reply
    try { await this.bot.sock.readMessages([msg.key]); } catch {}

  } catch (e) {
    log.error('onNlp error:', e);
  }
}

}
