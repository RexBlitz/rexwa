import logger from './logger.js';
import config from '../config.js';
import rateLimiter from './rate-limiter.js';

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
        this.messageHooks = new Map();
    }

    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    unregisterCommandHandler(command) {
        this.commandHandlers.delete(command.toLowerCase());
        logger.debug(`🗑️ Unregistered command handler: ${command}`);
    }

    registerMessageHook(hookName, handler) {
        if (!this.messageHooks.has(hookName)) {
            this.messageHooks.set(hookName, []);
        }
        this.messageHooks.get(hookName).push(handler);
        logger.debug(`🪝 Registered message hook: ${hookName}`);
    }

    unregisterMessageHook(hookName) {
        this.messageHooks.delete(hookName);
        logger.debug(`🗑️ Unregistered message hook: ${hookName}`);
    }
    async handleMessages({ messages, type }) {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await this.processMessage(msg);
} catch (error) {
    console.error('[UNCAUGHT ERROR]', error); // Full dump
    logger.error('Error processing message:', error?.stack || error?.message || JSON.stringify(error));
}


        }
    }
async processMessage(msg) {
    // Handle status messages
    if (msg.key.remoteJid === 'status@broadcast') {
        return this.handleStatusMessage(msg);
    }

    const text = this.extractText(msg);
    const prefix = config.get('bot.prefix');
    const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);

    // ✅ Pre-process hooks (as original)
    await this.executeMessageHooks('pre_process', msg, text);

    if (isCommand) {
        await this.handleCommand(msg, text);
    } else {
        // ✅ ✅ NEW: Let Jarvis AI try natural language first
        await this.executeMessageHooks('nlp', msg, text);

        // ✅ Continue with normal non-command handling
        await this.handleNonCommandMessage(msg, text);
    }

    // ✅ Post hooks
    await this.executeMessageHooks('post_process', msg, text);

    // ✅ Telegram sync
    if (this.bot.telegramBridge) {
        await this.bot.telegramBridge.syncMessage(msg, text);
    }
}


    async executeMessageHooks(hookName, msg, text) {
        const hooks = this.messageHooks.get(hookName) || [];
        for (const hook of hooks) {
            try {
                await hook(msg, text, this.bot);
            } catch (error) {
                logger.error(`Error executing hook ${hookName}:`, error);
            }
        }
    }
    // New method to check if message has media
    hasMedia(msg) {
        return !!(
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.documentMessage ||
            msg.message?.stickerMessage ||
            msg.message?.locationMessage ||
            msg.message?.contactMessage
        );
    }

    async handleStatusMessage(msg) {
        // Let status viewer module handle this
        await this.executeMessageHooks('pre_process', msg, this.extractText(msg));

        // Also sync status messages to Telegram
        if (this.bot.telegramBridge) {
            const text = this.extractText(msg);
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

async handleCommand(msg, text) {
    const chatJid = msg.key.remoteJid;
    const isGroup = chatJid.endsWith('@g.us');
    const participantJid = msg.key.participant || chatJid;
    const prefix = config.get('bot.prefix');

    const sender = chatJid;

    let executorJid;
    if (msg.key.fromMe) {
        executorJid = config.get('bot.owner') || this.bot.sock.user?.id;
    } else if (isGroup) {
        executorJid = participantJid;
    } else {
        executorJid = chatJid;
    }

    const contact =
        this.bot.store?.contacts?.[executorJid] ||
        this.bot.store?.contacts?.[executorJid.split('@')[0] + '@s.whatsapp.net'];
    const displayName =
        contact?.name ||
        contact?.notify ||
        contact?.verifiedName ||
        contact?.pushName ||
        executorJid.split('@')[0];

    const args = text.slice(prefix.length).trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const params = args.slice(1);

    try {
        await this.bot.sock.readMessages([msg.key]);
        await this.bot.sock.presenceSubscribe(sender);
        await this.bot.sock.sendPresenceUpdate('composing', sender);
    } catch {}

    if (!this.checkPermissions(msg, command)) {
        if (config.get('features.sendPermissionError', false)) {
            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            return this.bot.sendMessage(sender, {
                text: '❌ You don\'t have permission to use this command.'
            });
        }
        try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
        return;
    }

    const userId = executorJid.split('@')[0];

    if (config.get('features.rateLimiting')) {
        const canExecute = await rateLimiter.checkCommandLimit(userId);
        if (!canExecute) {
            const remainingTime = await rateLimiter.getRemainingTime(userId);
            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            return this.bot.sendMessage(sender, {
                text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(remainingTime / 1000)} seconds.`
            });
        }
    }

    const handler = this.commandHandlers.get(command);
    const respondToUnknown = config.get('features.respondToUnknownCommands', false);

    if (handler) {
        try {
            await this.bot.sock.sendMessage(sender, {
                react: { key: msg.key, text: '⏳' }
            });
        } catch {}

        try {
            await handler.execute(msg, params, {
                bot: this.bot,
                sender: chatJid,
                participant: executorJid,
                isGroup
            });

            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            try {
                await this.bot.sock.sendMessage(sender, {
                    react: { key: msg.key, text: '' }
                });
            } catch {}

            logger.info(`✅ Command executed: ${command} by ${displayName} (${executorJid})`);

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '📝 Command Executed',
                    `Command: ${command}\nUser: ${displayName}\nJID: ${executorJid}\nChat: ${chatJid}`
                );
            }

        } catch (error) {
            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            try {
                await this.bot.sock.sendMessage(sender, {
                    react: { key: msg.key, text: '❌' }
                });
            } catch {}

            logger.error(`❌ Command failed: ${command} | ${error.message}`);

            if (!error._handledBySmartError) {
                await this.bot.sendMessage(sender, { text: `❌ Command failed: ${error.message}` });
            }

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram(
                    '❌ Command Error',
                    `Command: ${command}\nError: ${error.message}\nUser: ${displayName}`
                );
            }
        }

    } else {
    // ✅ Always call AI unknown command hook
    await this.executeMessageHooks(
        'unknown_command',
        msg,
        { command, args: params, text }
    );

    // ✅ If user asked anything that contains the word “help”
    // override and call actual .help command
    if (/help|menu|commands|options/i.test(text)) {
        const helpHandler = this.commandHandlers.get('help');
        if (helpHandler) {
            try {
                return await helpHandler.execute(msg, [], {
                    bot: this.bot,
                    sender: chatJid,
                    participant: executorJid,
                    isGroup
                });
            } catch (e) {
                logger.error("Help override failed:", e);
            }
        }
    }

    // ✅ Keep your original fallback behavior
    try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}

    if (respondToUnknown) {
        return this.bot.sendMessage(sender, {
            text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
        });
    }
}
    async handleNonCommandMessage(msg, text) {
        // Log media messages for debugging
        if (this.hasMedia(msg)) {
            const mediaType = this.getMediaType(msg);
            logger.debug(`📎 Media message received: ${mediaType} from ${msg.key.participant || msg.key.remoteJid}`);
        } else if (text) {
            logger.debug('💬 Text message received:', text.substring(0, 50));
        }
    }

    getMediaType(msg) {
        if (msg.message?.imageMessage) return 'image';
        if (msg.message?.videoMessage) return 'video';
        if (msg.message?.audioMessage) return 'audio';
        if (msg.message?.documentMessage) return 'document';
        if (msg.message?.stickerMessage) return 'sticker';
        if (msg.message?.locationMessage) return 'location';
        if (msg.message?.contactMessage) return 'contact';
        return 'unknown';
    }

checkPermissions(msg, commandName) {
    const participant = msg.key.participant || msg.key.remoteJid;
    const userId = participant.split('@')[0];
    const ownerId = config.get('bot.owner').split('@')[0]; // Convert full JID to userId
    const isOwner = userId === ownerId || msg.key.fromMe;

    const admins = config.get('bot.admins') || [];

    const mode = config.get('features.mode');
    if (mode === 'private' && !isOwner && !admins.includes(userId)) return false;

    const blockedUsers = config.get('security.blockedUsers') || [];
    if (blockedUsers.includes(userId)) return false;

    const handler = this.commandHandlers.get(commandName);
    if (!handler) return false;

    const permission = handler.permissions || 'public';

    switch (permission) {
        case 'owner':
            return isOwner;

        case 'admin':
            return isOwner || admins.includes(userId);

        case 'public':
            return true;

        default:
            if (Array.isArray(permission)) {
                return permission.includes(userId);
            }
            return false;
    }
}


    extractText(msg) {
        return msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || 
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption || 
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }
}

export default MessageHandler;
