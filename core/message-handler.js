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
                console.error('[UNCAUGHT ERROR]', error);
                logger.error('Error processing message:', error?.stack || error?.message || JSON.stringify(error));
            }
        }
    }

    async processMessage(msg) {
        //  RAW MESSAGE LOGGING
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info('📨 RAW MESSAGE RECEIVED:');
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        

        // Log message type and content

        logger.info('💬 Full Message Object:', JSON.stringify(msg, null, 2));
        
        // Handle status messages
        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        const text = this.extractText(msg);
        const prefix = config.get('bot.prefix');
        const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);

        // Pre-process hooks
        await this.executeMessageHooks('pre_process', msg, text);

        if (isCommand) {
            await this.handleCommand(msg, text);
        } else {
            // Let Jarvis AI try natural language first
            await this.executeMessageHooks('nlp', msg, text);

            // Continue with normal non-command handling
            await this.handleNonCommandMessage(msg, text);
        }

        // Post hooks
        await this.executeMessageHooks('post_process', msg, text);

        // Telegram sync
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

    /**
     * ✅ UPDATED: Enhanced LID support for v7
     * Resolves user identity with LID/PN fallbacks
     */
    async resolveUserJid(msg) {
        const chatJid = msg.key.remoteJid;
        const isGroup = chatJid.endsWith('@g.us');

        let executorJid;

        if (msg.key.fromMe) {
            executorJid = config.get('bot.owner') || this.bot.sock.user?.id;
        } else if (isGroup) {
            // In groups: prefer participant, fallback to participantAlt
            executorJid = msg.key.participant || msg.key.participantAlt || chatJid;
        } else {
            // In DMs: prefer remoteJid, fallback to remoteJidAlt
            executorJid = msg.key.remoteJid || msg.key.remoteJidAlt;
        }

        return { executorJid, chatJid, isGroup };
    }

    /**
     * ✅ UPDATED: Smart contact lookup with LID→PN resolution
     */
    async getContactInfo(executorJid) {
        let contact = this.bot.store?.contacts?.[executorJid];

        // If not found and executorJid might be a LID, try to get PN version
        if (!contact && !executorJid.endsWith('@s.whatsapp.net')) {
            try {
                const pn = await this.bot.sock.signalRepository?.lidMapping?.getPNForLID(executorJid);
                if (pn) {
                    contact = this.bot.store?.contacts?.[pn];
                    logger.debug(`📞 Resolved LID to PN: ${executorJid} → ${pn}`);
                }
            } catch (err) {
                logger.debug('Could not resolve LID to PN for contact lookup');
            }
        }

        // Fallback: try with @s.whatsapp.net suffix
        if (!contact) {
            const baseJid = executorJid.split('@')[0] + '@s.whatsapp.net';
            contact = this.bot.store?.contacts?.[baseJid];
        }

        const displayName =
            contact?.name ||
            contact?.notify ||
            contact?.verifiedName ||
            contact?.pushName ||
            executorJid.split('@')[0];

        return { contact, displayName };
    }

    async handleCommand(msg, text) {
        const prefix = config.get('bot.prefix');
        const args = text.slice(prefix.length).trim().split(/\s+/);
        const command = args[0].toLowerCase();
        const params = args.slice(1);

        // ✅ Use new resolver
        const { executorJid, chatJid, isGroup } = await this.resolveUserJid(msg);
        const { contact, displayName } = await this.getContactInfo(executorJid);

        const sender = chatJid;

        try {
            await this.bot.sock.readMessages([msg.key]);
            await this.bot.sock.presenceSubscribe(sender);
            await this.bot.sock.sendPresenceUpdate('composing', sender);
        } catch {}

        // ✅ UPDATED: Permission check with LID awareness
        const hasPermission = await this.checkPermissions(msg, command, executorJid);

        const handler = this.commandHandlers.get(command);
        const respondToUnknown = config.get('features.respondToUnknownCommands', false);

        // If command exists but user has no permission
        if (!hasPermission && handler) {
            const userId = executorJid.split('@')[0];
            const ownerId = config.get('bot.owner').split('@')[0];
            const isPrivate = config.get('features.mode') === 'private';

            if (isPrivate && userId !== ownerId) {
                try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
                return;
            }

            if (config.get('features.sendPermissionError', false)) {
                try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
                // This is the problematic block, re-typed carefully
                return this.bot.sendMessage(sender, {
                    text: '❌ You don\'t have permission to use this command.'
                });
            }

            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            return;
        }

        // Valid command execution
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

            return;
        }

        // Unknown command handling
        if (respondToUnknown) {
            const userId = executorJid.split('@')[0];
            const ownerId = config.get('bot.owner').split('@')[0];
            const isPrivate = config.get('features.mode') === 'private';

            if (isPrivate && userId !== ownerId) {
                try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
                return;
            }

            const allCommands = Array.from(this.commandHandlers.keys());
            const { best, bestScore } = this.findClosestCommand(command, allCommands);

            let suggestText = `🚩 Unknown command: *${command}*`;
            if (bestScore <= 3) {
                suggestText += `\n Did you mean *${prefix}${best}* ?`;
            }

            try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
            return this.bot.sendMessage(sender, { text: suggestText });
        }

        try { await this.bot.sock.sendPresenceUpdate('paused', sender); } catch {}
    }

    findClosestCommand(input, allCommands) {
        let best = null;
        let bestScore = Infinity;

        for (const cmd of allCommands) {
            const dist = levenshteinDistance(input, cmd);
            if (dist < bestScore) {
                bestScore = dist;
                best = cmd;
            }
        }
        return { best, bestScore };
    }

    async handleNonCommandMessage(msg, text) {
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

    /**
     * ✅ UPDATED: Enhanced permission check with LID→PN normalization
     * This ensures owner/admin checks work regardless of LID vs PN format
     */
    async checkPermissions(msg, commandName, executorJid = null) {
        if (!executorJid) {
            const resolved = await this.resolveUserJid(msg);
            executorJid = resolved.executorJid;
        }

        let userId = executorJid.split('@')[0];

        // For reliable owner/admin comparison, try to normalize to PN
        if (!executorJid.endsWith('@s.whatsapp.net')) {
            try {
                const pn = await this.bot.sock.signalRepository?.lidMapping?.getPNForLID(executorJid);
                if (pn) {
                    userId = pn.split('@')[0];
                    logger.debug(`🔐 Normalized LID to PN for permission check: ${userId}`);
                }
            } catch (err) {
                // Fallback to LID-based comparison
                logger.debug('Using LID for permission check (no PN mapping available)');
            }
        }

        const ownerId = config.get('bot.owner')?.split('@')[0];
        const isOwner = userId === ownerId;

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

function levenshteinDistance(a, b) {
    const matrix = Array(a.length + 1)
        .fill(null)
        .map(() => Array(b.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[a.length][b.length];
}

export default MessageHandler;
