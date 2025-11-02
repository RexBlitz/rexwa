import config from '../config.js';
import logger from '../core/logger.js';

class StatusViewerModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'autostatus';
        this.metadata = {
            description: 'Automatically view and react to WhatsApp status updates',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'automation'
        };

        // Configuration
        this.autoViewStatus = config.get('features.autoViewStatus', false);
        this.autoReactStatus = config.get('features.autoReactStatus', false);
        this.statusReaction = config.get('features.statusReaction', '❤️');
        this.viewDelay = config.get('features.statusViewDelay', 1000);
        
        // Statistics
        this.totalViewed = 0;
        this.totalReacted = 0;

        this.commands = [
            {
                name: 'autostatus',
                description: 'Toggle auto status viewing',
                usage: '.autostatus on/off',
                permissions: 'owner',
                ui: {
                    processingText: ' *Configuring Auto Status...*',
                    errorText: '❌ *Configuration Failed*'
                },
                execute: this.toggleAutoStatus.bind(this)
            },
            {
                name: 'statusreact',
                description: 'Toggle auto status reactions and set emoji',
                usage: '.statusreact on/off or .statusreact <emoji>',
                permissions: 'owner',
                ui: {
                    processingText: ' *Configuring Status Reactions...*',
                    errorText: '❌ *Configuration Failed*'
                },
                execute: this.handleStatusReact.bind(this)
            }
        ];

        // Message hooks for status handling
        this.messageHooks = {
            'pre_process': this.handleStatusMessage.bind(this)
        };
    }

    async toggleAutoStatus(msg, params, context) {
        const action = params[0]?.toLowerCase();
        
        if (!action || !['on', 'off'].includes(action)) {
            return ` *Auto Status Viewing*\n\nStatus: ${this.autoViewStatus ? ' ON' : ' OFF'}\nViewed: ${this.totalViewed}\n\nUsage: .autostatus on/off`;
        }

        this.autoViewStatus = action === 'on';
        config.set('features.autoViewStatus', this.autoViewStatus);
        
        return ` *Auto status viewing* ${this.autoViewStatus ? 'enabled' : 'disabled'}`;
    }

    async handleStatusReact(msg, params, context) {
        const param = params[0]?.toLowerCase();
        
        // If no parameter, show current status
        if (!param) {
            return ` *Auto Status Reactions*\n\nStatus: ${this.autoReactStatus ? ' ON' : ' OFF'}\nEmoji: ${this.statusReaction}\nReacted: ${this.totalReacted}\n\nUsage:\n• .statusreact on/off\n• .statusreact <emoji>`;
        }

        // Toggle on/off
        if (['on', 'off'].includes(param)) {
            this.autoReactStatus = param === 'on';
            config.set('features.autoReactStatus', this.autoReactStatus);
            return ` *Auto status reactions* ${this.autoReactStatus ? 'enabled' : 'disabled'}`;
        }

        // Set emoji
        this.statusReaction = params[0];
        config.set('features.statusReaction', this.statusReaction);
        return ` *Status reaction set to*: ${this.statusReaction}`;
    }

    async handleStatusMessage(msg, text, bot) {
        // Check if it's a status message
        if (msg.key.remoteJid !== 'status@broadcast') return;

        // Skip if auto view is disabled
        if (!this.autoViewStatus) return;

        const participant = msg.key.participant;
        if (!participant) return;

        try {
            // Add delay before viewing
            if (this.viewDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, this.viewDelay));
            }

            // Mark status as read
            await bot.sock.readMessages([msg.key]);
            this.totalViewed++;
            
            // React to status if enabled
            if (this.autoReactStatus) {
                await bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: this.statusReaction }
                });
                this.totalReacted++;
            }

            // Get contact info for logging
            const contact = bot.getContactInfo?.(participant) || {};
            const name = contact.name || participant.split('@')[0];
            
            logger.debug(`👁️ Viewed status from ${name}${this.autoReactStatus ? ` (${this.statusReaction})` : ''}`);

        } catch (error) {
            logger.error('❌ Status viewing failed:', error);
        }
    }


}

export default StatusViewerModule;
