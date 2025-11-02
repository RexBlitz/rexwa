import config from '../config.js';
import logger from '../core/logger.js';
import { isJidNewsletter } from '@whiskeysockets/baileys';

class AutoReplyModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'autoreply';
        this.metadata = {
            description: 'Automatic reply system with customizable messages',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'automation'
        };

        // Configuration
        this.autoReply = config.get('features.autoReply', false);
        this.autoReplyText = config.get('messages.autoReplyText', 'Hello! This is an automated response.');
        this.replyDelay = 2000; // Fixed 2 second delay
        
        // Track replied users to avoid spam
        this.repliedUsers = new Set();
        
        // Reset replied users daily
        setInterval(() => {
            this.repliedUsers.clear();
        }, 24 * 60 * 60 * 1000);

        this.commands = [
            {
                name: 'autoreply',
                description: 'Toggle auto reply or set message',
                usage: '.autoreply on/off or .autoreply <message>',
                permissions: 'owner',
                ui: {
                    processingText: ' *Configuring Auto Reply...*',
                    errorText: '❌ *Configuration Failed*'
                },
                execute: this.handleAutoReply.bind(this)
            }
        ];

        // Message hooks for auto reply
        this.messageHooks = {
            'pre_process': this.processAutoReply.bind(this)
        };
    }

    async handleAutoReply(msg, params, context) {
        const param = params[0]?.toLowerCase();
        
        // If no parameter, show current status
        if (!param) {
            return ` *Auto Reply*\n\nStatus: ${this.autoReply ? ' ON' : ' OFF'}\nMessage: "${this.autoReplyText}"\n\nUsage:\n• .autoreply on/off\n• .autoreply <message>`;
        }

        // Toggle on/off
        if (['on', 'off'].includes(param)) {
            this.autoReply = param === 'on';
            config.set('features.autoReply', this.autoReply);
            return ` *Auto reply* ${this.autoReply ? 'enabled' : 'disabled'}`;
        }

        // Set message
        this.autoReplyText = params.join(' ');
        config.set('messages.autoReplyText', this.autoReplyText);
        return ` *Auto reply message set to*:\n"${this.autoReplyText}"`;
    }

    async processAutoReply(msg, text, bot) {
        // Skip if auto reply is disabled
        if (!this.autoReply) return;

        // Skip own messages, commands, no text, or already replied
        if (msg.key.fromMe || !text || text.startsWith(config.get('bot.prefix'))) return;

        const sender = msg.key.remoteJid;
        const participant = msg.key.participant || sender;
        const isGroup = sender.endsWith('@g.us');
        const isNewsletter = isJidNewsletter(sender);

        // Skip groups and newsletters
        if (isGroup || isNewsletter) return;

        // Skip if already replied to this user today
        if (this.repliedUsers.has(participant)) return;

        try {
            // Add delay
            if (this.replyDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, this.replyDelay));
            }

            // Send auto reply
            await bot.sendMessage(sender, { text: this.autoReplyText });

            // Mark user as replied to
            this.repliedUsers.add(participant);

            logger.debug(`🤖 Auto-replied to: ${participant}`);

        } catch (error) {
            logger.error('❌ Auto reply failed:', error);
        }
    }

}

export default AutoReplyModule;
