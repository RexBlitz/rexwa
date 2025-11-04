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
                case '/deepsync':
                    await this.handleDeepSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/checkcontact':
                    await this.handleCheckContact(msg.chat.id, args);
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
                case '/updatetopics':
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                case '/stats':
                    await this.handleStats(msg.chat.id);
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

    async handleStart(chatId) {
        const statusText = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${this.bridge.telegramBot ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `Contacts: ${this.bridge.contactMappings?.size || 0}\n` +
            `Users: ${this.bridge.userMappings?.size || 0}\n\n` +
            `Type /help for available commands.`;
        await this.bridge.telegramBot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const whatsapp = this.bridge.whatsappBot?.sock;
        const userName = whatsapp?.user?.name || 'Unknown';
        const userPhone = whatsapp?.user?.id?.split(':')[0] || 'Unknown';

        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${whatsapp ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${userName}\n` +
            `📱 Phone: +${userPhone}\n` +
            `💬 Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `👥 Users: ${this.bridge.userMappings?.size || 0}\n` +
            `📞 Contacts: ${this.bridge.contactMappings?.size || 0}\n` +
            `🔍 Filters: ${this.bridge.filters?.size || 0}`;
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 923001234567 Hello!',
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
            const response = result?.key?.id ? `✅ Message sent to +${number}` : `⚠️ Message sent, but no confirmation`;
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
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${this.bridge.contactMappings.size} contacts from WhatsApp`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleDeepSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, 
            '🔄 *Deep syncing all contacts...*\nThis may take 1-2 minutes.', 
            { parse_mode: 'Markdown' });
        
        try {
            // Clear cache to force fresh resolution
            logger.info('🧹 Starting deep sync...');
            const oldSize = this.bridge.contactMappings.size;
            
            // Re-sync from WhatsApp
            await this.bridge.syncContacts();
            
            const newSize = this.bridge.contactMappings.size;
            const diff = newSize - oldSize;
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ *Deep sync complete!*\n\n` +
                `📊 Old contacts: ${oldSize}\n` +
                `📊 New contacts: ${newSize}\n` +
                `📈 Change: ${diff >= 0 ? '+' : ''}${diff}\n\n` +
                `💡 Now run /updatetopics to update topic names.`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Deep sync failed:', error);
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Deep sync failed: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId) {
        const contacts = [...this.bridge.contactMappings.entries()];
        
        if (contacts.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '⚠️ No contacts found. Run /sync first.',
                { parse_mode: 'Markdown' });
        }

        const pageSize = 50;
        const totalPages = Math.ceil(contacts.length / pageSize);
        const firstPage = contacts.slice(0, pageSize);
        
        let contactList = `📇 *Contacts (Page 1/${totalPages})*\n\n`;
        contactList += firstPage.map(([phone, name]) => `📱 ${name} (+${phone})`).join('\n');
        
        if (totalPages > 1) {
            contactList += `\n\n_Showing ${pageSize} of ${contacts.length} contacts_`;
        }

        await this.bridge.telegramBot.sendMessage(chatId, contactList, { parse_mode: 'Markdown' });
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

        const result = matches.slice(0, 20).map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
        const moreText = matches.length > 20 ? `\n\n_Showing 20 of ${matches.length} results_` : '';
        
        await this.bridge.telegramBot.sendMessage(chatId, 
            `🔍 *Search Results for "${query}"*\n\n${result}${moreText}`, 
            { parse_mode: 'Markdown' });
    }

    async handleCheckContact(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /checkcontact <phone>\nExample: /checkcontact 923086133772',
                { parse_mode: 'Markdown' });
        }

        const phone = args[0].replace(/\D/g, '');
        const jid = `${phone}@s.whatsapp.net`;
        
        try {
            const contact = this.bridge.whatsappBot.store?.contacts?.[jid];
            const contactName = this.bridge.contactMappings.get(phone);
            const topicId = this.bridge.chatMappings.get(jid);
            
            let info = `🔍 *Contact Debug Info*\n\n` +
                `📱 Phone: \`${phone}\`\n` +
                `🆔 JID: \`${jid}\`\n` +
                `📌 Topic ID: ${topicId || 'Not Created'}\n\n`;
            
            info += `*WhatsApp Store Contact:*\n`;
            if (contact) {
                info += `✅ Found in store\n`;
                info += `- Name: ${contact.name || 'N/A'}\n`;
                info += `- Notify: ${contact.notify || 'N/A'}\n`;
                info += `- Phone: ${contact.phoneNumber || 'N/A'}\n`;
                info += `- Verified: ${contact.verifiedName || 'N/A'}\n`;
            } else {
                info += `❌ Not found in store\n`;
            }
            
            info += `\n*Contact Mapping (Database):*\n`;
            if (contactName) {
                info += `✅ ${contactName}`;
            } else {
                info += `❌ Not Found\n\n`;
                info += `💡 This number is not saved in WhatsApp contacts.\n`;
                info += `Save it in WhatsApp and run /deepsync`;
            }
            
            await this.bridge.telegramBot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error checking contact:', error);
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleAddFilter(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId, 
                '❌ Usage: /addfilter <word>\nExample: /addfilter /command', 
                { parse_mode: 'Markdown' });
        }

        const word = args.join(' ').toLowerCase();
        await this.bridge.addFilter(word);
        await this.bridge.telegramBot.sendMessage(chatId, 
            `✅ Added filter: \`${word}\`\n\nMessages starting with this will be blocked from Telegram → WhatsApp`, 
            { parse_mode: 'Markdown' });
    }

    async handleListFilters(chatId) {
        if (!this.bridge.filters?.size) {
            return this.bridge.telegramBot.sendMessage(chatId, 
                '⚠️ No filters set.', 
                { parse_mode: 'Markdown' });
        }

        const list = [...this.bridge.filters].map(w => `- \`${w}\``).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, 
            `🛡️ *Current Filters:*\n\n${list}\n\n_Messages starting with these will be blocked_`, 
            { parse_mode: 'Markdown' });
    }

    async handleClearFilters(chatId) {
        await this.bridge.clearFilters();
        await this.bridge.telegramBot.sendMessage(chatId, 
            '🧹 All filters cleared.', 
            { parse_mode: 'Markdown' });
    }
    
    async handleUpdateTopics(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, 
            '🔄 *Updating Telegram topic names...*\nThis may take a moment.', 
            { parse_mode: 'Markdown' });
        
        try {
            await this.bridge.updateTopicNames(); 

            await this.bridge.telegramBot.sendMessage(chatId,
                '✅ *Telegram topic names update complete.*\n\n' +
                'Check the logs for detailed results.',
                { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`❌ Error updating topic names:`, error);
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Failed to update topic names: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleStats(chatId) {
        try {
            const totalChats = this.bridge.chatMappings?.size || 0;
            const totalContacts = this.bridge.contactMappings?.size || 0;
            const totalUsers = this.bridge.userMappings?.size || 0;
            const totalFilters = this.bridge.filters?.size || 0;
            
            // Count chats by type
            let groupChats = 0;
            let individualChats = 0;
            let specialChats = 0;
            
            for (const [jid] of this.bridge.chatMappings.entries()) {
                if (jid.endsWith('@g.us')) groupChats++;
                else if (jid.includes('broadcast') || jid.includes('newsletter')) specialChats++;
                else individualChats++;
            }
            
            // Count unnamed contacts
            let unnamedContacts = 0;
            for (const [jid] of this.bridge.chatMappings.entries()) {
                if (!jid.endsWith('@g.us') && !jid.includes('broadcast') && !jid.includes('newsletter')) {
                    const phone = jid.split('@')[0];
                    if (/^\d{10,15}$/.test(phone) && !this.bridge.contactMappings.get(phone)) {
                        unnamedContacts++;
                    }
                }
            }
            
            const stats = `📊 *Bridge Statistics*\n\n` +
                `*Chats:*\n` +
                `- Total: ${totalChats}\n` +
                `- Individual: ${individualChats}\n` +
                `- Groups: ${groupChats}\n` +
                `- Special: ${specialChats}\n\n` +
                `*Contacts:*\n` +
                `- Saved: ${totalContacts}\n` +
                `- Unnamed: ${unnamedContacts}\n\n` +
                `*Other:*\n` +
                `- Users: ${totalUsers}\n` +
                `- Filters: ${totalFilters}\n\n` +
                `${unnamedContacts > 0 ? '💡 _Run /deepsync to sync unnamed contacts_' : '✅ _All contacts synced_'}`;
            
            await this.bridge.telegramBot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('Error generating stats:', error);
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `*Basic:*\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/stats - Show detailed statistics\n` +
            `/send <number> <msg> - Send WhatsApp message\n\n` +
            `*Contacts:*\n` +
            `/sync - Quick contact sync\n` +
            `/deepsync - Deep sync with enhanced resolution\n` +
            `/contacts - List all contacts\n` +
            `/searchcontact <query> - Search contacts\n` +
            `/checkcontact <phone> - Debug contact info\n` +
            `/updatetopics - Update Telegram topic names\n\n` +
            `*Filters:*\n` +
            `/addfilter <word> - Block messages starting with word\n` +
            `/filters - Show current filters\n` +
            `/clearfilters - Remove all filters\n\n` +
            `*Help:*\n` +
            `/help - Show this menu`;
        
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'stats', description: 'Show detailed statistics' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Quick contact sync' },
                { command: 'deepsync', description: 'Deep sync (enhanced)' },
                { command: 'contacts', description: 'List all contacts' },
                { command: 'searchcontact', description: 'Search contacts' },
                { command: 'checkcontact', description: 'Debug contact info' },
                { command: 'updatetopics', description: 'Update topic names' },
                { command: 'addfilter', description: 'Add blocked word' },
                { command: 'filters', description: 'Show blocked words' },
                { command: 'clearfilters', description: 'Clear all filters' },
                { command: 'help', description: 'Show help menu' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

export default TelegramCommands;
