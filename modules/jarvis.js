import config from '../config.js';
import log from '../core/logger.js' 

const DEFAULT_MODEL = 'gemini-2.5-flash';

// --- Helpers ---
async function geminiJson(prompt, systemInstruction, model, apiKey) {
  const finalModel = model || DEFAULT_MODEL;
  const key = apiKey || process.env.GEMINI_API_KEY || config.get?.('ai.gemini.apiKey');

  if (!key) throw new Error('Gemini API key missing. Set GEMINI_API_KEY env or ai.gemini.apiKey in config.');

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
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error ${res.status}: ${t}`);
  }
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
  // Compact list of callable commands for prompting
  return m.commands.map(c => `${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''} – ${c.description}`).join('\n');
}

function findCommandHandler(bot, name) {
  if (!name) return null;
  const h = bot.messageHandler.commandHandlers.get(name);
  if (h) return { name, handler: h };
  // try alias
  for (const [cmdName, h] of bot.messageHandler.commandHandlers.entries()) {
    if (cmdName === name) return { name: cmdName, handler: h };
  }
  return null;
}

async function replySameLang(bot, jid, text, lang, apiKey, model) {
  const safe = String(text ?? '');
  if (!lang || lang.toLowerCase() === 'en') {
    return bot.sendMessage(jid, { text: safe });
  }
  const prompt = JSON.stringify({ target_lang: lang, text: safe });
  const out = await geminiJson(prompt,
`Translate "text" to language code "target_lang". Keep meaning, tone, and emojis. Return {"translated": "..."} only.`,
  model, apiKey);
  const t = out?.translated || safe;
  return bot.sendMessage(jid, { text: t });
}

// --- Module ---
export default class JarvisModule {
  constructor(bot) {
    this.bot = bot;
    this.name = 'jarvis';
    this.metadata = {
      description: 'Natural-language AI control layer (Gemini): intent → command/function, self-aware help, multilingual replies.',
      version: '1.0.0',
      author: 'Jarvis Layer',
      category: 'AI'
    };
    this.state = {
      enabled: true,
      persona: (config.get?.('ai.persona') || 'friendly_jarvis')
    };

    this.commands = [
      {
        name: 'xi',
        description: 'Enable/disable AI NL control or run a prompt. Usage: .ai on|off|status|<ask anything>',
        usage: '.xi on | .ai off | .ai status | .ai <message>',
        permissions: 'owner',
        execute: async (msg, params, { bot, sender }) => {
          const sub = (params[0] || '').toLowerCase();
          if (sub === 'on') {
            this.state.enabled = true;
            return bot.sendMessage(sender, { text: '✅ AI is now *enabled*. Natural language control is active.' });
          }
          if (sub === 'off') {
            this.state.enabled = false;
            return bot.sendMessage(sender, { text: '⏸️ AI is now *disabled*. Only commands will work.' });
          }
          if (sub === 'status') {
            return bot.sendMessage(sender, { text: `🤖 AI status: *${this.state.enabled ? 'enabled' : 'disabled'}*` });
          }
          // treat rest as a one-shot chat with same-language reply
          const text = params.join(' ').trim();
          if (!text) return bot.sendMessage(sender, { text: 'ℹ️ Usage: .ai on|off|status|<message>' });

          const lang = await this.detectLanguage(text).catch(() => 'en');
          const answer = await this.freeChat(text, lang).catch(e => `❌ ${e.message}`);
          return replySameLang(bot, sender, answer, lang, config.get?.('ai.gemini.apiKey'), config.get?.('ai.gemini.model'));
        }
      },
      {
        name: 'skills',
        description: 'Show AI-visible skills/commands (self manifest).',
        usage: '.skills',
        permissions: 'public',
        execute: async (msg, _params, { bot, sender }) => {
          const manifest = buildManifest(bot);
          const list = stringifyManifestShort(manifest);
          return bot.sendMessage(sender, { text: `🧠 *AI Skills I Know*\n${list || 'No commands found.'}` });
        }
      }
    ];

    // Hooks registered below in init()
    this.messageHooks = {};
  }

  async init() {
    // Attach hooks only once
    this.messageHooks = {
      // natural-language messages (non-command)
      nlp: this.onNlp.bind(this),

    };

  }

  async destroy() {

  }

  // --- AI Core ---
  async detectLanguage(text) {
    const out = await geminiJson(
      JSON.stringify({ text }),
      `Detect language of "text". Respond with {"language": "<ISO-639-1 code>"} only.`,
      config.get?.('ai.gemini.model'),
      config.get?.('ai.gemini.apiKey')
    );
    return (out?.language || 'en').toLowerCase();
  }

  async routeIntent(userText, manifest, userLang) {
    const system = `
You are an AI command router for a WhatsApp bot. You know these commands:

${stringifyManifestShort(manifest)}

If the user asks for something that matches a command, choose it and fill arguments from the message.
If not, set "action":"chat" and produce a helpful natural-language reply.

Return strict JSON:
{
  "language": "<iso-639-1>",
  "action": "command" | "chat",
  "command": "<commandName or empty>",
  "args": ["..."],
  "reply": "<assistant reply if action=chat>"
}

Rules:
- Keep "language" = user's language.
- If user intent is close to a command (even with typos), still map to it.
- If multiple commands could fit, pick the best single one.
- Be concise in "reply".
`;
    const prompt = JSON.stringify({ user: userText, user_lang: userLang, prefix: manifest.bot.prefix });
    return await geminiJson(prompt, system, config.get?.('ai.gemini.model'), config.get?.('ai.gemini.apiKey'));
  }

  async freeChat(userText, userLang) {
    const system = (config.get?.('ai.personaSystem') || `
You are Jarvis: concise, helpful, slightly witty, never rude. Avoid long paragraphs unless asked.`).trim();

    const out = await geminiJson(JSON.stringify({ user: userText, lang: userLang }),
      system, config.get?.('ai.gemini.model'), config.get?.('ai.gemini.apiKey'));
    return out?.reply || out?.text || JSON.stringify(out);
  }

  // --- Hooks ---
async onNlp(msg, text, bot) {
  try {
    if (!this.state.enabled) return;
    if (!text || !text.trim()) return;

    const jid = msg.key.remoteJid;

    // ✅ Read message + start typing indicator
    try {
      await this.bot.sock.readMessages([msg.key]);
      await this.bot.sock.presenceSubscribe(jid);
      await this.bot.sock.sendPresenceUpdate('composing', jid);
    } catch (e) {
      log.error("Presence error (nlp):", e);
    }

    const lang = await this.detectLanguage(text).catch(() => 'en');
    const manifest = buildManifest(this.bot);

    const routed = await this.routeIntent(text, manifest, lang);
    const action = routed?.action;

    if (action === 'command' && routed?.command) {
      const found = findCommandHandler(this.bot, routed.command);
      if (!found?.handler) {
        const reply = routed?.reply || `I couldn't execute "${routed.command}".`;

        // ✅ stop typing
        try {
          await this.bot.sock.sendPresenceUpdate('paused', jid);
        } catch {}

        return replySameLang(this.bot, jid, reply, lang,
          config.get?.('ai.gemini.apiKey'),
          config.get?.('ai.gemini.model')
        );
      }

      const params = Array.isArray(routed.args) ? routed.args : [];

      try {
        await found.handler.execute(msg, params, {
          bot: this.bot,
          sender: jid,
          participant: msg.key.participant || jid,
          isGroup: jid.endsWith('@g.us')
        });
      } catch (err) {
        log.error('AI command execution error:', err);

        // ✅ stop typing
        try {
          await this.bot.sock.sendPresenceUpdate('paused', jid);
        } catch {}

        await replySameLang(
          this.bot,
          jid,
          `❌ Failed to run ${routed.command}: ${err.message}`,
          lang,
          config.get?.('ai.gemini.apiKey'),
          config.get?.('ai.gemini.model')
        );
      }

      // ✅ Stop typing after success
      try {
        await this.bot.sock.sendPresenceUpdate('paused', jid);
      } catch {}

      return;
    }

    // ✅ Chat / fallback
    const reply = routed?.reply || await this.freeChat(text, lang);

    // ✅ stop typing before sending
    try {
      await this.bot.sock.sendPresenceUpdate('paused', jid);
    } catch {}

    await replySameLang(
      this.bot,
      jid,
      reply,
      lang,
      config.get?.('ai.gemini.apiKey'),
      config.get?.('ai.gemini.model')
    );

  } catch (e) {
    log.error('onNlp error:', e);
  }
  }

