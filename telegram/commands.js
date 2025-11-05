import logger from '../core/logger.js';

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.trim().split(/\s+/);

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/addfilter':
                    await this.handleAddFilter(msg.chat.id, args);
                    break;
                case '/filters':
                    await this.handleListFilters(msg.chat.id);
                    break;
                case '/clearfilters':
                    await this.handleClearFilters(msg.chat.id);
                    break;
                case '/updatetopics': // 🆕 New Command Case
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                    case '/getinfo': 
                    await this.handleGetInfo(msg.chat.id, args);
                    break;
                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
    }
async handleGetInfo(chatId, args) {
        if (args.length < 1) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /getinfo <number>\nExample: /getinfo 1234567890',
                { parse_mode: 'Markdown' });
        }

        const number = args[0].replace(/\D/g, '');

        if (!/^\d{6,15}$/.test(number)) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid phone number format.',
                { parse_mode: 'Markdown' });
        }

        // Format as a JID (Jaber ID)
        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        try {
            await this.bridge.telegramBot.sendMessage(chatId, `🔍 Fetching info for ${number}...`, { parse_mode: 'Markdown' });
            
            // This function will be created in bridge.js
            const info = await this.bridge.getUserInfo(jid); 

            // Convert the info object to a formatted JSON string
            const infoString = JSON.stringify(info, null, 2);
            const response = `\`\`\`json\n${infoString}\n\`\`\``;

            await this.bridge.telegramBot.sendMessage(chatId, `📊 *Raw Info for ${number}*\n\n${response}`, { parse_mode: 'Markdown' });

        } catch (error) {
            logger.error(`❌ Error fetching info for ${jid}:`, error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }
    async handleStart(chatId) {
        const statusText = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${this.bridge.telegramBot ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `Contacts: ${this.bridge.contactMappings?.size || 0}\n` +
            `Users: ${this.bridge.userMappings?.size || 0}`;
        await this.bridge.telegramBot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const whatsapp = this.bridge.whatsappBot?.sock;
        const userName = whatsapp?.user?.name || 'Unknown';

        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${whatsapp ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${userName}\n` +
            `💬 Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `👥 Users: ${this.bridge.userMappings?.size || 0}\n` +
            `📞 Contacts: ${this.bridge.contactMappings?.size || 0}`;
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!',
                { parse_mode: 'Markdown' });
        }

        const number = args[0].replace(/\D/g, '');
        const message = args.slice(1).join(' ');

        if (!/^\d{6,15}$/.test(number)) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid phone number format.',
                { parse_mode: 'Markdown' });
        }

        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        try {
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            const response = result?.key?.id ? `✅ Message sent to ${number}` : `⚠️ Message sent, but no confirmation`;
            await this.bridge.telegramBot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`❌ Error sending message to ${number}:`, error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...', { parse_mode: 'Markdown' });
        try {
            await this.bridge.syncContacts();
            await this.bridge.saveMappingsToDb?.();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${this.bridge.contactMappings.size} contacts from WhatsApp`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSearchContact(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John',
                { parse_mode: 'Markdown' });
        }

        const query = args.join(' ').toLowerCase();
        const contacts = [...this.bridge.contactMappings.entries()];
        const matches = contacts.filter(([phone, name]) =>
            phone.includes(query) || name?.toLowerCase().includes(query)
        );

        if (matches.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                `❌ No contacts found for "${query}"`,
                { parse_mode: 'Markdown' });
        }

        const result = matches.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    async handleAddFilter(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId, '❌ Usage: /addfilter <word>', { parse_mode: 'Markdown' });
        }

        const word = args.join(' ').toLowerCase();
        await this.bridge.addFilter(word);
        await this.bridge.telegramBot.sendMessage(chatId, `✅ Added filter: \`${word}\``, { parse_mode: 'Markdown' });
    }

    async handleListFilters(chatId) {
        if (!this.bridge.filters?.size) {
            return this.bridge.telegramBot.sendMessage(chatId, '⚠️ No filters set.', { parse_mode: 'Markdown' });
        }

        const list = [...this.bridge.filters].map(w => `- \`${w}\``).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, `🛑 *Current Filters:*\n\n${list}`, { parse_mode: 'Markdown' });
    }

    async handleClearFilters(chatId) {
        await this.bridge.clearFilters();
        await this.bridge.telegramBot.sendMessage(chatId, '🧹 All filters cleared.', { parse_mode: 'Markdown' });
    }
    
    // 🆕 New Command Handler
    async handleUpdateTopics(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 **Updating Telegram topic names...** This may take a moment.', { parse_mode: 'Markdown' });
        try {
            await this.bridge.updateTopicNames(); 

            await this.bridge.telegramBot.sendMessage(chatId,
                '✅ **Telegram topic names update complete.**',
                { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`❌ Error updating topic names:`, error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to update topic names: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n` +
            `/addfilter <word> - Block WA messages starting with it\n` +
            `/filters - Show current filters\n` +
            `/clearfilters - Remove all filters\n` +
            `/updatetopics - Update Telegram topic names (Contacts/PNs)`; 
            `/getinfo <number> - Fetch raw metadata for a user`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'addfilter', description: 'Add blocked word' },
                { command: 'filters', description: 'Show blocked words' },
                { command: 'clearfilters', description: 'Clear all filters' },
                { command: 'updatetopics', description: 'Update Telegram topic names (Contacts/PNs)' },
                { command: 'getinfo', description: 'Fetch raw metadata for a user' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

export default TelegramCommands;
