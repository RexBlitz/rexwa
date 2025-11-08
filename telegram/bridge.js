import TelegramBot from 'node-telegram-bot-api';
import TelegramCommands from './commands.js'; 
import config from '../config.js';       
import logger from '../core/logger.js';   
import { connectDb } from '../utils/db.js';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import mime from 'mime-types';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import ffmpeg from 'fluent-ffmpeg';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { exec } from 'child_process';
import qrcode from 'qrcode';

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.contactMappings = new Map();
        this.profilePicCache = new Map();
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map();
        this.statusMessageMapping = new Map();
        this.presenceTimeout = null;
        this.botChatId = null;
        this.db = null;
        this.collection = null;
        this.messageQueue = new Map();
        this.lastPresenceUpdate = new Map();
        this.topicVerificationCache = new Map();
        this.creatingTopics = new Map(); // jid => Promise
        this.userChatIds = new Set(); // Runtime memory

    }

// --- LID & JID Normalization helpers (FIXED) ---
async handleLIDConversion(jid) {
    try {
        if (jid && jid.endsWith('@lid') && this.whatsappBot?.sock?.store?.lids?.getPNForLID) {
            const pn = await this.whatsappBot.sock.store.lids.getPNForLID(jid);
            if (pn) {
                const pnJid = `${pn}@s.whatsapp.net`;
                logger.info(`📞 Converted LID ${jid} → ${pnJid}`);
                return pnJid;
            }
        }
    } catch (e) {
        logger.error('❌ LID conversion failed:', e);
    }
    return jid;
}

normalizeJID(jid) {
    if (!jid) return jid;
    // Remove device/session suffix like :23
    if (jid.includes(':')) {
        const base = jid.split(':')[0];
        const domain = jid.substring(jid.lastIndexOf('@'));
        return base + domain;
    }
    return jid;
}
// --- end helpers ---


    async initialize() {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured');
            return;
        }

        try {
            await this.initializeDatabase();
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { 
                polling: true,
                onlyFirstMatch: true
            });
            
            this.commands = new TelegramCommands(this);
            await this.commands.registerBotCommands();
            await this.setupTelegramHandlers();
            await this.loadMappingsFromDb();
            await this.loadUserChatIds();
            await this.loadFiltersFromDb();

            
            // Wait for WhatsApp to be ready before syncing
            if (this.whatsappBot?.sock?.user) {
                await this.syncContacts();
                await this.updateTopicNames();
            }
            
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            await this.db.command({ ping: 1 });
            logger.info('✅ MongoDB connection successful');
            this.collection = this.db.collection('bridge');
            await this.collection.createIndex({ type: 1, 'data.whatsappJid': 1 }, { unique: true, partialFilterExpression: { type: 'chat' } });
            await this.collection.createIndex({ type: 1, 'data.whatsappId': 1 }, { unique: true, partialFilterExpression: { type: 'user' } });
            await this.collection.createIndex({ type: 1, 'data.phone': 1 }, { unique: true, partialFilterExpression: { type: 'contact' } });
            logger.info('📊 Database initialized for Telegram bridge (single collection: bridge)');
        } catch (error) {
            logger.error('❌ Failed to initialize database:', error);
        }
    }

    async loadMappingsFromDb() {
        try {
            const mappings = await this.collection.find({}).toArray();
            
            for (const mapping of mappings) {
                switch (mapping.type) {
                    case 'chat':
                        this.chatMappings.set(mapping.data.whatsappJid, mapping.data.telegramTopicId);
                        // Load profile picture URL into cache
                        if (mapping.data.profilePicUrl) {
                            this.profilePicCache.set(mapping.data.whatsappJid, mapping.data.profilePicUrl);
                        }
                        break;
                    case 'user':
                        this.userMappings.set(mapping.data.whatsappId, {
                            name: mapping.data.name,
                            phone: mapping.data.phone,
                            firstSeen: mapping.data.firstSeen,
                            messageCount: mapping.data.messageCount || 0
                        });
                        break;
                    case 'contact':
                        this.contactMappings.set(mapping.data.phone, mapping.data.name);
                        break;
                }
            }
            
            logger.info(`📊 Loaded mappings: ${this.chatMappings.size} chats, ${this.userMappings.size} users, ${this.contactMappings.size} contacts`);
        } catch (error) {
            logger.error('❌ Failed to load mappings:', error);
        }
    }

    async saveChatMapping(whatsappJid, telegramTopicId, profilePicUrl = null) {
        try {
            // Ensure the saved JID is the normalized PN JID
            whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));

            const updateData = { 
                type: 'chat',
                data: { 
                    whatsappJid, 
                    telegramTopicId, 
                    createdAt: new Date(),
                    lastActivity: new Date()
                } 
            };

            if (profilePicUrl) {
                updateData.data.profilePicUrl = profilePicUrl;
            }

            await this.collection.updateOne(
                { type: 'chat', 'data.whatsappJid': whatsappJid },
                { $set: updateData },
                { upsert: true }
            );
            
            this.chatMappings.set(whatsappJid, telegramTopicId);
            if (profilePicUrl) {
                this.profilePicCache.set(whatsappJid, profilePicUrl);
            }
            this.topicVerificationCache.delete(whatsappJid);
            
            logger.debug(`✅ Saved chat mapping: ${whatsappJid} -> ${telegramTopicId}${profilePicUrl ? ' (with profile pic)' : ''}`);
        } catch (error) {
            logger.error('❌ Failed to save chat mapping:', error);
        }
    }
    
   async loadUserChatIds() {
    try {
        const users = await this.collection.find({ type: 'userChat' }).toArray();
        this.userChatIds = new Set(users.map(u => u.chatId));
        logger.info(`✅ Loaded ${this.userChatIds.size} Telegram bot users`);
    } catch (err) {
        logger.error('❌ Failed to load user chat IDs:', err);
    }
}

   async loadFiltersFromDb() {
    this.filters = new Set();

    const filterDocs = await this.collection.find({ type: 'filter' }).toArray();
    for (const doc of filterDocs) {
        this.filters.add(doc.word);
    }

    logger.info(`✅ Loaded ${this.filters.size} filters from DB`);
}
   
   async addFilter(word) {
    this.filters.add(word);
    await this.collection.updateOne(
        { type: 'filter', word },
        { $set: { type: 'filter', word } },
        { upsert: true }
    );
}

async clearFilters() {
    this.filters.clear();
    await this.collection.deleteMany({ type: 'filter' });
}


    async updateProfilePicUrl(whatsappJid, profilePicUrl) {
        try {
            // Ensure the JID is the PN JID before querying/updating
            whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));

            await this.collection.updateOne(
                { type: 'chat', 'data.whatsappJid': whatsappJid },
                { $set: { 'data.profilePicUrl': profilePicUrl, 'data.lastProfilePicUpdate': new Date() } }
            );
            
            this.profilePicCache.set(whatsappJid, profilePicUrl);
            logger.debug(`✅ Updated profile pic URL for ${whatsappJid}: ${profilePicUrl}`);
        } catch (error) {
            logger.error('❌ Failed to update profile pic URL:', error);
        }
    }

    async saveUserMapping(whatsappId, userData) {
        try {
            // Ensure the saved ID is the PN JID
            whatsappId = await this.handleLIDConversion(this.normalizeJID(whatsappId));
            
            await this.collection.updateOne(
                { type: 'user', 'data.whatsappId': whatsappId },
                { 
                    $set: { 
                        type: 'user',
                        data: { 
                            whatsappId,
                            name: userData.name,
                            phone: userData.phone,
                            firstSeen: userData.firstSeen,
                            messageCount: userData.messageCount || 0,
                            lastSeen: new Date()
                        } 
                    } 
                },
                { upsert: true }
            );
            this.userMappings.set(whatsappId, userData);
            logger.debug(`✅ Saved user mapping: ${whatsappId} (${userData.name || userData.phone})`);
        } catch (error) {
            logger.error('❌ Failed to save user mapping:', error);
        }
    }

    async saveContactMapping(phone, name) {
        try {
            await this.collection.updateOne(
                { type: 'contact', 'data.phone': phone },
                { 
                    $set: { 
                        type: 'contact',
                        data: { 
                            phone, 
                            name, 
                            updatedAt: new Date() 
                        } 
                    } 
                },
                { upsert: true }
            );
            this.contactMappings.set(phone, name);
            logger.debug(`✅ Saved contact mapping: ${phone} -> ${name}`);
        } catch (error) {
            logger.error('❌ Failed to save contact mapping:', error);
        }
    }

    async syncContacts() {
        try {
            if (!this.whatsappBot?.sock?.user) {
                logger.warn('⚠️ WhatsApp not connected, skipping contact sync');
                return;
            }
            
            logger.info('📞 Syncing contacts from WhatsApp...');
            
            const contacts = this.whatsappBot.sock.store?.contacts || {};
            const contactEntries = Object.entries(contacts);
            
            logger.debug(`🔍 Found ${contactEntries.length} contacts in WhatsApp store`);
            
            let syncedCount = 0;
            
            for (const [jid, contact] of contactEntries) {
                if (!jid || jid === 'status@broadcast' || !contact) continue;
                
                // Ensure we are dealing with the phone number, not LID or session IDs
                const normalizedJid = this.normalizeJID(jid);
                const phone = normalizedJid.split('@')[0];
                let contactName = null;
                
                // Extract name from contact - prioritize saved contact name
                if (contact.name && contact.name !== phone && !contact.name.startsWith('+') && contact.name.length > 2) {
                    contactName = contact.name;
                } else if (contact.notify && contact.notify !== phone && !contact.notify.startsWith('+') && contact.notify.length > 2) {
                    contactName = contact.notify;
                } else if (contact.verifiedName && contact.verifiedName !== phone && contact.verifiedName.length > 2) {
                    contactName = contact.verifiedName;
                }
                
                if (contactName) {
                    const existingName = this.contactMappings.get(phone);
                    if (existingName !== contactName) {
                        await this.saveContactMapping(phone, contactName);
                        syncedCount++;
                        logger.debug(`📞 Synced contact: ${phone} -> ${contactName}`);
                    }
                }
            }
            
            logger.info(`✅ Synced ${syncedCount} new/updated contacts (Total: ${this.contactMappings.size})`);
            
            if (syncedCount > 0) {
                await this.updateTopicNames();
            }
            
        } catch (error) {
            logger.error('❌ Failed to sync contacts:', error);
        }
    }

    async updateTopicNames() {
        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId || chatId.includes('YOUR_CHAT_ID')) {
                logger.error('❌ Invalid telegram.chatId for updating topic names');
                return;
            }
            
            logger.info('📝 Updating Telegram topic names...');
            let updatedCount = 0;
            
            for (const [jid, topicId] of this.chatMappings.entries()) {
                if (!jid.endsWith('@g.us') && jid !== 'status@broadcast' && jid !== 'call@broadcast') {
                    const phone = jid.split('@')[0];
                    const contactName = this.contactMappings.get(phone);
                    
                    if (contactName) {
                        try {
                            // Get current topic info first
                            // const currentTopic = await this.telegramBot.getChat(chatId); // Removed as it causes errors if not a group
                            logger.debug(`📝 Attempting to update topic ${topicId} for ${phone} to "${contactName}"`);
                            
                            await this.telegramBot.editForumTopic(chatId, topicId, {
                                name: contactName
                            });
                            
                            logger.info(`📝 ✅ Updated topic name for ${phone}: "${contactName}"`);
                            updatedCount++;
                        } catch (error) {
                            logger.error(`❌ Failed to update topic ${topicId} for ${phone} to "${contactName}":`, error.message);
                        }
                        
                        // Add delay to avoid rate limits
                        await new Promise(resolve => setTimeout(resolve, 200));
                    } else {
                        logger.debug(`📝 ⚠️ No contact name found for ${phone}, keeping current topic name`);
                    }
                }
            }
            
            logger.info(`✅ Updated ${updatedCount} topic names`);
        } catch (error) {
            logger.error('❌ Failed to update topic names:', error);
        }
    }

    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.get('telegram.botToken');
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
        }
    }

    async setupTelegramHandlers() {
    this.awaitingPassword = new Set(); // 🆕 Track users awaiting password

    this.telegramBot.on('message', this.wrapHandler(async (msg) => {
        const chatType = msg.chat.type;

        // ✅ 1. Private chat (user DMs the bot)
        if (chatType === 'private') {
            const chatId = msg.chat.id;
            const BOT_PASSWORD = config.get('telegram.botPassword');

            const isVerified = await this.collection.findOne({ type: 'userChat', chatId });

            if (!isVerified) {
                // 🔒 If waiting for password
                if (this.awaitingPassword.has(chatId)) {
                    if (msg.text?.trim() === BOT_PASSWORD) {
                        // ✅ Store verified user
                        await this.collection.insertOne({
                            type: 'userChat',
                            chatId,
                            firstSeen: new Date()
                        });

                        this.userChatIds.add(chatId);
                        this.botChatId = chatId;
                        this.awaitingPassword.delete(chatId);

                        await this.telegramBot.sendMessage(chatId, '✅ Access granted! You can now use the bot.');
                        logger.info(`🔓 Telegram bot access granted: ${chatId}`);
                    } else {
                        await this.telegramBot.sendMessage(chatId, '❌ Incorrect password. Try again:');
                    }
                    return;
                }

                // 🛑 Not verified and not prompted yet
                this.awaitingPassword.add(chatId);
                await this.telegramBot.sendMessage(chatId, '🔐 This bot is password-protected.\nPlease enter the password to continue:');
                return;
            }

            // ✅ Already verified user
            this.userChatIds.add(chatId);
            this.botChatId = chatId;

            await this.commands.handleCommand(msg);
        }

        // ✅ 2. Group messages from forum topics
        else if (
            (chatType === 'supergroup' || chatType === 'group') &&
            msg.is_topic_message &&
            msg.message_thread_id
        ) {
            await this.handleTelegramMessage(msg);
        }

        // ❗ 3. Unexpected thread messages
        else if (msg.message_thread_id) {
            logger.warn(`⚠️ Received thread message in unexpected context (chatType=${chatType}), attempting to handle`);
            await this.handleTelegramMessage(msg);
        }
    }));

    this.telegramBot.on('polling_error', (error) => {
        logger.error('Telegram polling error:', error);
    });

    this.telegramBot.on('error', (error) => {
        logger.error('Telegram bot error:', error);
    });

    logger.info('📱 Telegram message handlers set up');
}



    wrapHandler(handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (error) {
                logger.error('❌ Unhandled error in Telegram handler:', error);
            }
        };
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('YOUR_LOG_CHANNEL')) {
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

async sendQRCode(qrData) {
    if (!this.telegramBot) return;

    const qrImagePath = path.join(this.tempDir, `qr_${Date.now()}.png`);
    await qrcode.toFile(qrImagePath, qrData, {
        width: 512,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' }
    });

    const caption = '📱 *WhatsApp QR Code*\n\n' +
                    '🔄 Scan this QR code with WhatsApp to connect\n' +
                    '⏰ QR code expires in 30 seconds\n\n' +
                    '💡 Open WhatsApp → Settings → Linked Devices → Link a Device';

    const opts = { caption, parse_mode: 'Markdown' };

    for (const chatId of this.userChatIds) {
        try {
            await this.telegramBot.sendPhoto(chatId, qrImagePath, opts);
        } catch (err) {
            logger.warn(`⚠️ Failed to send QR to ${chatId}:`, err.message);
        }
    }

    const logChannel = config.get('telegram.logChannel');
    if (logChannel && !logChannel.includes('YOUR_LOG_CHANNEL')) {
        try {
            await this.telegramBot.sendPhoto(logChannel, qrImagePath, opts);
        } catch (err) {
            logger.warn(`⚠️ Failed to send QR to log channel: ${err.message}`);
        }
    }

    setTimeout(() => fs.remove(qrImagePath).catch(() => {}), 60000);
    logger.info(`✅ Sent QR code to ${this.userChatIds.size} users`);
}


async sendToAllUsers(text, extra = {}) {
    for (const chatId of this.userChatIds) {
        try {
            await this.telegramBot.sendMessage(chatId, text, extra);
        } catch (err) {
            logger.warn(`⚠️ Failed to send message to user ${chatId}: ${err.message}`);
        }
    }
}


async sendStartMessage() {
    const startMessage = `🚀 *HyperWa Bridge Started Successfully!*\n\n` +
                         `✅ WhatsApp: Connected\n` +
                         `✅ Telegram Bridge: Active\n` +
                         `📞 Contacts: ${this.contactMappings.size} synced\n` +
                         `💬 Chats: ${this.chatMappings.size} mapped\n` +
                         `🔗 Ready to bridge messages!\n\n` +
                         `⏰ Started at: ${new Date().toLocaleString()}`;

    // Send to all users
    try {
        await this.sendToAllUsers(startMessage, { parse_mode: 'Markdown' });
        logger.info('✅ Start message sent to all users');
    } catch (error) {
        logger.error('❌ Failed to send start message to users:', error);
    }

    // Send to log channel
    const logChannel = config.get('telegram.logChannel');
    if (logChannel && !logChannel.includes('YOUR_LOG_CHANNEL')) {
        try {
            await this.telegramBot.sendMessage(logChannel, startMessage, { parse_mode: 'Markdown' });
            logger.info('✅ Start message sent to Telegram log channel');
        } catch (error) {
            logger.error('❌ Failed to send start message to Telegram log channel:', error);
        }
    } else {
        logger.warn('⚠️ Log channel not configured or left as default placeholder');
    }
}

    async sendPresence(jid, presenceType = 'available') {
        try {
            if (!this.whatsappBot?.sock || !config.get('telegram.features.presenceUpdates')) return;
            
            // Ensure JID is normalized before sending presence
            jid = await this.handleLIDConversion(this.normalizeJID(jid));

            const now = Date.now();
            const lastUpdate = this.lastPresenceUpdate.get(jid) || 0;
            
            if (now - lastUpdate < 1000) return;
            
            this.lastPresenceUpdate.set(jid, now);
            
            await this.whatsappBot.sock.sendPresenceUpdate(presenceType, jid);
            logger.debug(`👁️ Sent presence update: ${presenceType} to ${jid}`);
            
        } catch (error) {
            logger.debug('Failed to send presence:', error);
        }
    }

    async sendTypingPresence(jid) {
        try {
            if (!this.whatsappBot?.sock || !config.get('telegram.features.presenceUpdates')) return;
            
            // Ensure JID is normalized before sending presence
            jid = await this.handleLIDConversion(this.normalizeJID(jid));

            await this.sendPresence(jid, 'composing');
            
            if (this.presenceTimeout) {
                clearTimeout(this.presenceTimeout);
            }
            
            this.presenceTimeout = setTimeout(async () => {
                try {
                    await this.sendPresence(jid, 'paused');
                } catch (error) {
                    logger.debug('Failed to send paused presence:', error);
                }
            }, 3000);
            
        } catch (error) {
            logger.debug('Failed to send typing presence:', error);
        }
    }

    
     async recreateMissingTopics() {
        try {
            logger.info('🔄 Checking for missing topics...');
            const toRecreate = [];
            
            for (const [jid, topicId] of this.chatMappings.entries()) {
                const exists = await this.verifyTopicExists(topicId);
                if (!exists) {
                    logger.warn(`🗑️ Topic ${topicId} for ${jid} was deleted, will recreate...`);
                    toRecreate.push(jid);
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            for (const jid of toRecreate) {
                this.chatMappings.delete(jid);
                this.profilePicCache.delete(jid); // Clear profile pic cache
                await this.collection.deleteOne({ 
                    type: 'chat', 
                    'data.whatsappJid': jid 
                });
                
                const dummyMsg = {
                    key: { 
                        remoteJid: jid, 
                        participant: jid.endsWith('@g.us') ? jid : jid 
                    }
                };
                await this.getOrCreateTopic(jid, dummyMsg);
                
                logger.info(`✅ Recreated topic for ${jid}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            if (toRecreate.length > 0) {
                logger.info(`✅ Recreated ${toRecreate.length} missing topics`);
            }
            
        } catch (error) {
            logger.error('❌ Error recreating missing topics:', error);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        // 1. Normalize and resolve LIDs to PN JIDs
        const originalRemoteJid = this.normalizeJID(whatsappMsg.key.remoteJid);
        const originalParticipant = whatsappMsg.key.participant 
            ? this.normalizeJID(whatsappMsg.key.participant) 
            : originalRemoteJid;

        let sender = await this.handleLIDConversion(originalRemoteJid);
        let participant = await this.handleLIDConversion(originalParticipant);
        
        // 2. Overwrite the JIDs in the message key if they were LIDs
        // This ensures all downstream logic (like queueMessageForReadReceipt) uses the PN JID.
        whatsappMsg.key.remoteJid = sender;
        if (whatsappMsg.key.participant) {
            whatsappMsg.key.participant = participant;
        }
        
        const isFromMe = whatsappMsg.key.fromMe;
        
        if (sender === 'status@broadcast') {
            await this.handleStatusMessage(whatsappMsg, text);
            return;
        }
        
        if (isFromMe) {
            const existingTopicId = this.chatMappings.get(sender);
            if (existingTopicId) {
                await this.syncOutgoingMessage(whatsappMsg, text, existingTopicId, sender);
            }
            return;
        }
        
        await this.createUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId);
        } else if (whatsappMsg.message?.imageMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) { 
            await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage) { 
            await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (text) {
            let messageText = text;
            if (sender.endsWith('@g.us') && participant !== sender) {
                const senderPhone = participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                messageText = `👤 ${senderName}:\n${text}`;
            }
            
            await this.sendSimpleMessage(topicId, messageText, sender);
        }

        if (whatsappMsg.key?.id && config.get('telegram.features.readReceipts') !== false) {
            this.queueMessageForReadReceipt(sender, whatsappMsg.key);
        }
    }

async handleStatusMessage(whatsappMsg, text) {
    try {
        if (!config.get('telegram.features.statusSync')) return;
        
        const participant = whatsappMsg.key.participant;
        const phone = participant.split('@')[0];
        const contactName = this.contactMappings.get(phone) || `+${phone}`;
        
        const topicId = await this.getOrCreateTopic('status@broadcast', whatsappMsg);
        if (!topicId) return;
        
        const chatId = config.get('telegram.chatId');
        const mediaType = this.getMediaType(whatsappMsg);
        
        let sentMsg;
        
        // Handle media status
        if (mediaType && mediaType !== 'text') {
            // For media, create caption with text first (if available), then contact info
            let caption = '';
            if (text) {
                caption = `💭 "_${text}_"\n\n📱 *${contactName}* (+${phone})`;
            } else {
                caption = `📱 *${contactName}* (+${phone})`;
            }
            
            sentMsg = await this.forwardStatusMedia(whatsappMsg, topicId, caption, mediaType);
        } else {
            // Handle text-only status
            let statusMessage = '';
            if (text) {
                statusMessage = `💭 "_${text}_"\n\n📱 *${contactName}* (+${phone})`;
            } else {
                statusMessage = `📱 *${contactName}* (+${phone})`;
            }
            
            sentMsg = await this.telegramBot.sendMessage(chatId, statusMessage, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
        
        if (sentMsg) {
            this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key);
        }
        
        // Only mark as read if connection is still active
        if (config.get('features.autoViewStatus') && this.whatsappBot.sock?.ws?.readyState === 1) {
            try {
                await this.whatsappBot.sock.readMessages([whatsappMsg.key]);
            } catch (readError) {
                logger.warn('⚠️ Could not mark status as read (connection issue):', readError.message);
            }
        }
        
    } catch (error) {
        logger.error('❌ Error handling status message:', error);
        
        // If it's a connection error, don't try to send more messages
        if (error.message?.includes('Connection Closed') || error.output?.statusCode === 428) {
            logger.warn('⚠️ WhatsApp connection lost, skipping status sync');
            return;
        }
    }
}

async forwardStatusMedia(whatsappMsg, topicId, caption, mediaType) {
    try {
        const stream = await downloadContentFromMessage(
            whatsappMsg.message[`${mediaType}Message`], 
            mediaType
        );
        
        const buffer = await this.streamToBuffer(stream);
        const chatId = config.get('telegram.chatId');
        
        let sentMsg;
        
        switch (mediaType) {
            case 'image':
                sentMsg = await this.telegramBot.sendPhoto(chatId, buffer, {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'video':
                sentMsg = await this.telegramBot.sendVideo(chatId, buffer, {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'audio':
                sentMsg = await this.telegramBot.sendAudio(chatId, buffer, {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'document':
                sentMsg = await this.telegramBot.sendDocument(chatId, buffer, {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                break;
                
            case 'sticker':
                sentMsg = await this.telegramBot.sendSticker(chatId, buffer, {
                    message_thread_id: topicId
                });
                // Send caption separately for stickers since they don't support captions
                if (caption) {
                    await this.telegramBot.sendMessage(chatId, caption, {
                        message_thread_id: topicId,
                        parse_mode: 'Markdown'
                    });
                }
                break;
                
            default:
                // Fallback to document for unsupported media types
                sentMsg = await this.telegramBot.sendDocument(chatId, buffer, {
                    message_thread_id: topicId,
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                break;
        }
        
        return sentMsg;
        
    } catch (error) {
        logger.error('❌ Error forwarding status media:', error);
        
        // If media forwarding fails, send text message as fallback
        try {
            const sentMsg = await this.telegramBot.sendMessage(config.get('telegram.chatId'), 
                `${caption}\n\n⚠️ _Media could not be forwarded_`, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            
            return sentMsg;
        } catch (fallbackError) {
            logger.error('❌ Error sending fallback message:', fallbackError);
            return null;
        }
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
    return 'text';
}
       async syncOutgoingMessage(whatsappMsg, text, topicId, sender) {
            if (!config.get('telegram.features.sendOutgoingMessages')) return;
        try {
            if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
                await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId, true);
            } else if (whatsappMsg.message?.imageMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId, true);
            } else if (whatsappMsg.message?.videoMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId, true);
            } else if (whatsappMsg.message?.audioMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId, true);
            } else if (whatsappMsg.message?.documentMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId, true);
            } else if (whatsappMsg.message?.stickerMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId, true);
            } else if (whatsappMsg.message?.locationMessage) { 
                await this.handleWhatsAppLocation(whatsappMsg, topicId, true);
            } else if (whatsappMsg.message?.contactMessage) { 
                await this.handleWhatsAppContact(whatsappMsg, topicId, true);
            } else if (text) {
                const messageText = `📤 You: ${text}`;
                await this.sendSimpleMessage(topicId, messageText, sender);
            }
        } catch (error) {
            logger.error('❌ Failed to sync outgoing message:', error);
        }
    }

    queueMessageForReadReceipt(chatJid, messageKey) {
        if (!config.get('telegram.features.readReceipts')) return;
        
        if (!this.messageQueue.has(chatJid)) {
            this.messageQueue.set(chatJid, []);
        }
        
        this.messageQueue.get(chatJid).push(messageKey);
        
        setTimeout(() => {
            this.processReadReceipts(chatJid);
        }, 2000);
    }

    async processReadReceipts(chatJid) {
        try {
            const messages = this.messageQueue.get(chatJid);
            if (!messages || messages.length === 0) return;
            
            if (this.whatsappBot?.sock) {
                await this.whatsappBot.sock.readMessages(messages);
                logger.debug(`📖 Marked ${messages.length} messages as read in ${chatJid}`);
            }
            
            this.messageQueue.set(chatJid, []);
        } catch (error) {
            logger.debug('Failed to send read receipts:', error);
        }
    }


    async createUserMapping(participant, whatsappMsg) {
        // participant is already the PN JID from syncMessage
        participant = this.normalizeJID(participant);

        if (this.userMappings.has(participant)) {
            const userData = this.userMappings.get(participant);
            userData.messageCount = (userData.messageCount || 0) + 1;
            await this.saveUserMapping(participant, userData);
            return;
        }

        let userName = null;
        // The phone number is extracted from the PN JID
        let userPhone = participant.split('@')[0]; 
        
        try {
            // Lookup using the phone number
            if (this.contactMappings.has(userPhone)) {
                userName = this.contactMappings.get(userPhone);
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        const userData = {
            name: userName,
            phone: userPhone,
            firstSeen: new Date(),
            messageCount: 1
        };

        await this.saveUserMapping(participant, userData);
        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
    }

   async getOrCreateTopic(chatJid, whatsappMsg) {
        // 1. Ensure PN JID is used for caching/lookup
        chatJid = await this.handleLIDConversion(this.normalizeJID(chatJid));
        // ✅ If topic already cached, return
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        // ✅ If another creation is in progress, wait for it
        if (this.creatingTopics.has(chatJid)) {
            return await this.creatingTopics.get(chatJid);
        }

        const creationPromise = (async () => {
            const chatId = config.get('telegram.chatId');
            if (!chatId || chatId.includes('YOUR_CHAT_ID')) {
              logger.error('❌ Telegram chat ID not configured');
              return null;
            }

            try {
              const isGroup = chatJid.endsWith('@g.us');
              const isStatus = chatJid === 'status@broadcast';
              const isCall = chatJid === 'call@broadcast';
            
              let topicName, iconColor = 0x7ABA3C;

              if (isStatus) {
                topicName = `📊 Status Updates`;
                iconColor = 0xFF6B35;
              } else if (isCall) {
                topicName = `📞 Call Logs`;
                iconColor = 0xFF4757;
              } else if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = groupMeta.subject;
                } catch {
                    topicName = `Group Chat`;
                }
                iconColor = 0x6FB9F0;
              } else {
                  // 2. Lookup contact name using the PN JID
                  const phone = chatJid.split('@')[0];
                  const contactName = this.contactMappings.get(phone);
                  topicName = contactName || `+${phone}`;
              }

              const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
              });

              let profilePicUrl = null;
              if (!isStatus && !isCall) {
                  try {
                      profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(chatJid, 'image');
                  } catch {}
              }

              await this.saveChatMapping(chatJid, topic.message_thread_id, profilePicUrl);
              logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for ${chatJid}`);

              if (!isStatus && !isCall && config.get('telegram.features.welcomeMessage')) {
                  await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, whatsappMsg, profilePicUrl);
              }

              return topic.message_thread_id;

              } catch (error) {
                  logger.error('❌ Failed to create Telegram topic:', error);
                  return null;
              } finally {
                  this.creatingTopics.delete(chatJid); // ✅ Cleanup after done
              }
        })();

        this.creatingTopics.set(chatJid, creationPromise);
        return await creationPromise;
    }
    async sendWelcomeMessage(topicId, jid, isGroup, whatsappMsg, initialProfilePicUrl = null) {
        try {
            const chatId = config.get('telegram.chatId');
            const phone = jid.split('@')[0];
            const contactName = this.contactMappings.get(phone) || `+${phone}`;
            const participant = whatsappMsg.key.participant || jid;
            const userInfo = this.userMappings.get(participant);
            const handleName = whatsappMsg.pushName || userInfo?.name || 'Unknown';
            
            let welcomeText = '';
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                    welcomeText = `🏷️ **Group Information**\n\n` +
                                 `📝 **Name:** ${groupMeta.subject}\n` +
                                 `👥 **Participants:** ${groupMeta.participants.length}\n` +
                                 `🆔 **Group ID:** \`${jid}\`\n` +
                                 `📅 **Created:** ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\n` +
                                 `💬 Messages from this group will appear here`;
                } catch (error) {
                    welcomeText = `🏷️ **Group Chat**\n\n💬 Messages from this group will appear here`;
                    logger.debug(`Could not fetch group metadata for ${jid}:`, error);
                }
            } else {
                let userStatus = '';
                try {
                    const status = await this.whatsappBot.sock.fetchStatus(jid);
                    if (status?.status) {
                        userStatus = `📝 **Status:** ${status.status}\n`;
                    }
                } catch (error) {
                    logger.debug(`Could not fetch status for ${jid}:`, error);
                }

                welcomeText = `👤 **Contact Information**\n\n` +
                             `📝 **Name:** ${contactName}\n` +
                             `📱 **Phone:** +${phone}\n` +
                             `🖐️ **Handle:** ${handleName}\n` +
                             userStatus +
                             `🆔 **WhatsApp ID:** \`${jid}\`\n` +
                             `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n` +
                             `💬 Messages with this contact will appear here`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);
            
            // Send initial profile picture if available
            if (initialProfilePicUrl) {
                await this.sendProfilePictureWithUrl(topicId, jid, initialProfilePicUrl, false);
            }

        } catch (error) {
            logger.error('❌ Failed to send welcome message:', error);
        }
    }

    async sendProfilePicture(topicId, jid, isUpdate = false) {
    try {
        if (!config.get('telegram.features.profilePicSync')) {
            logger.debug(`📸 Profile pic sync disabled for ${jid}`);
            return;
        }

        // Ensure JID is normalized before use
        jid = await this.handleLIDConversion(this.normalizeJID(jid));

        logger.debug(`📸 Checking profile picture for ${jid} (update: ${isUpdate})`);

        // 1. Fetch latest URL from WhatsApp
        let currentProfilePicUrl = null;
        try {
            currentProfilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            logger.debug(`📸 Current profile pic URL from WhatsApp: ${currentProfilePicUrl || 'none'}`);
        } catch (error) {
            logger.debug(`📸 No profile picture found for ${jid}: ${error.message}`);
        }

        if (!currentProfilePicUrl) {
            logger.debug(`📸 No profile picture to send for ${jid}`);
            return;
        }

        // 2. Get stored URL from DB
        const dbEntry = await this.collection.findOne({ type: 'chat', 'data.whatsappJid': jid });
        const storedProfilePicUrl = dbEntry?.data?.profilePicUrl || null;

        // 3. Compare with DB value
        if (currentProfilePicUrl === storedProfilePicUrl) {
            logger.debug(`📸 ⏭️ Profile picture unchanged for ${jid}, skipping send`);
            this.profilePicCache.set(jid, currentProfilePicUrl); // Refresh cache anyway
            return;
        }

        // 4. Send the image
        const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';

        await this.telegramBot.sendPhoto(config.get('telegram.chatId'), currentProfilePicUrl, {
            message_thread_id: topicId,
            caption: caption
        });

        // 5. Update DB + cache
        await this.updateProfilePicUrl(jid, currentProfilePicUrl);
        this.profilePicCache.set(jid, currentProfilePicUrl);

        logger.info(`📸 ✅ Sent ${isUpdate ? 'updated' : 'initial'} profile picture for ${jid}`);
    } catch (error) {
        logger.error(`📸 ❌ Could not send profile picture for ${jid}:`, error);
    }
}


    async sendProfilePictureWithUrl(topicId, jid, profilePicUrl, isUpdate = false) {
    try {
        if (!config.get('telegram.features.profilePicSync')) {
            logger.debug(`📸 Profile pic sync disabled for ${jid}`);
            return;
        }

        if (!profilePicUrl) {
            logger.debug(`📸 No profile picture URL provided for ${jid}`);
            return;
        }

        // Ensure JID is normalized before use
        jid = await this.handleLIDConversion(this.normalizeJID(jid));

        const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';

        await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
            message_thread_id: topicId,
            caption: caption
        });

        // Always update DB and cache to ensure consistency
        await this.updateProfilePicUrl(jid, profilePicUrl);
        this.profilePicCache.set(jid, profilePicUrl);

        logger.info(`📸 ✅ Sent ${isUpdate ? 'updated' : 'initial'} profile picture for ${jid}`);
    } catch (error) {
        logger.error(`📸 ❌ Could not send profile picture with URL for ${jid}:`, error);
    }
}


     async handleCallNotification(callEvent) {
        if (!this.telegramBot || !config.get('telegram.features.callLogs')) return;

        const callerId = callEvent.from;
        const callKey = `${callerId}_${callEvent.id}`;

        if (this.activeCallNotifications.has(callKey)) return;
        
        this.activeCallNotifications.set(callKey, true);
        setTimeout(() => {
            this.activeCallNotifications.delete(callKey);
        }, 30000);

        try {
            // Must convert to PN JID to lookup contact name
            const normalizedCallerId = await this.handleLIDConversion(this.normalizeJID(callerId));
            const phone = normalizedCallerId.split('@')[0];
            const callerName = this.contactMappings.get(phone) || `+${phone}`;
            
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: normalizedCallerId }
            });

            if (!topicId) {
                logger.error('❌ Could not create call topic');
                return;
            }

            const callMessage = `📞 **Incoming Call**\n\n` +
                               `👤 **From:** ${callerName}\n` +
                               `📱 **Number:** +${phone}\n` +
                               `⏰ **Time:** ${new Date().toLocaleString()}\n` +
                               `📋 **Status:** ${callEvent.status || 'Incoming'}`;

            await this.telegramBot.sendMessage(config.get('telegram.chatId'), callMessage, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            logger.info(`📞 Sent call notification from ${callerName}`);
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId, isOutgoing = false) {
    const sendMedia = async (finalTopicId) => {
        try {
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg);
            const sender = whatsappMsg.key.remoteJid; // Already PN JID

            switch (mediaType) {
                case 'image': mediaMessage = whatsappMsg.message.imageMessage; fileName += '.jpg'; break;
                case 'video': mediaMessage = whatsappMsg.message.videoMessage; fileName += '.mp4'; break;
                case 'video_note': mediaMessage = whatsappMsg.message.ptvMessage || whatsappMsg.message.videoMessage; fileName += '.mp4'; break;
                case 'audio': mediaMessage = whatsappMsg.message.audioMessage; fileName += '.ogg'; break;
                case 'document': mediaMessage = whatsappMsg.message.documentMessage; fileName = mediaMessage.fileName || `document_${Date.now()}`; break;
                case 'sticker': mediaMessage = whatsappMsg.message.stickerMessage; fileName += '.webp'; break;
            }

            if (!mediaMessage) return logger.error(`❌ No media content for ${mediaType}`);

            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'video_note' ? 'video' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            if (!buffer?.length) return logger.error(`❌ Empty buffer for ${mediaType}`);

            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            const chatId = config.get('telegram.chatId');

            if (isOutgoing) caption = caption ? `📤 You: ${caption}` : '📤 You sent media';
            else if (sender.endsWith('@g.us') && whatsappMsg.key.participant !== sender) {
                const senderPhone = whatsappMsg.key.participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                caption = `👤 ${senderName}:\n${caption || ''}`;
            }

            const opts = { caption, message_thread_id: finalTopicId };

            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(chatId, filePath, opts);
                    break;
                case 'video':
                    mediaMessage.gifPlayback
                        ? await this.telegramBot.sendAnimation(chatId, filePath, opts)
                        : await this.telegramBot.sendVideo(chatId, filePath, opts);
                    break;
                case 'video_note':
                    const notePath = await this.convertToVideoNote(filePath);
                    await this.telegramBot.sendVideoNote(chatId, notePath, { message_thread_id: finalTopicId });
                    if (notePath !== filePath) await fs.unlink(notePath).catch(() => {});
                    break;
                case 'audio':
                    if (mediaMessage.ptt) {
                        await this.telegramBot.sendVoice(chatId, filePath, opts);
                    } else {
                        await this.telegramBot.sendAudio(chatId, filePath, {
                            ...opts,
                            title: mediaMessage.title || 'Audio'
                        });
                    }
                    break;
                case 'document':
                    await this.telegramBot.sendDocument(chatId, filePath, opts);
                    break;
                case 'sticker':
                    try {
                        await this.telegramBot.sendSticker(chatId, filePath, { message_thread_id: finalTopicId });
                    } catch {
                        const pngPath = filePath.replace('.webp', '.png');
                        await sharp(filePath).png().toFile(pngPath);
                        await this.telegramBot.sendPhoto(chatId, pngPath, { caption: caption || 'Sticker', message_thread_id: finalTopicId });
                        await fs.unlink(pngPath).catch(() => {});
                    }
                    break;
            }

            await fs.unlink(filePath).catch(() => {});
            logger.info(`✅ ${mediaType} sent to topic ${finalTopicId}`);
        } catch (error) {
            const desc = error.response?.data?.description || error.message;
            if (desc.includes('message thread not found')) {
                logger.warn(`🗑️ Topic ${topicId} was deleted. Recreating and retrying...`);

                const sender = whatsappMsg.key.remoteJid;
                this.chatMappings.delete(sender);
                this.profilePicCache.delete(sender);
                await this.collection.deleteOne({ type: 'chat', 'data.whatsappJid': sender });

                const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg);
                if (newTopicId) {
                    await sendMedia(newTopicId);
                }
            } else {
                logger.error(`❌ Failed to send ${mediaType}:`, desc);
            }
        }
    };

    await sendMedia(topicId);
}


    async convertToVideoNote(inputPath) {
        return new Promise((resolve, reject) => {
            const outputPath = inputPath.replace('.mp4', '_note.mp4');
            
            ffmpeg(inputPath)
                .videoFilter('scale=240:240:force_original_aspect_ratio=increase,crop=240:240')
                .duration(60)
                .format('mp4')
                .on('end', () => {
                    logger.debug('Video note conversion completed');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    logger.debug('Video note conversion failed:', err);
                    resolve(inputPath);
                })
                .save(outputPath);
        });
    }

async handleWhatsAppLocation(whatsappMsg, topicId, isOutgoing = false) {
    try {
        const locationMessage = whatsappMsg.message.locationMessage;
        const sender = whatsappMsg.key.remoteJid;
        const chatId = config.get('telegram.chatId');
        const caption = isOutgoing ? '📤 You shared location' : '';

        try {
            await this.telegramBot.sendLocation(
                chatId,
                locationMessage.degreesLatitude,
                locationMessage.degreesLongitude,
                { message_thread_id: topicId }
            );

            if (caption) {
                await this.telegramBot.sendMessage(chatId, caption, {
                    message_thread_id: topicId
                });
            }
        } catch (error) {
            const desc = error.response?.data?.description || error.message;
            if (desc.includes("message thread not found")) {
                logger.warn(`🗑️ Location topic deleted. Recreating...`);
                this.chatMappings.delete(sender);
                this.profilePicCache.delete(sender);
                await this.collection.deleteOne({ type: 'chat', 'data.whatsappJid': sender });
                const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg);
                await this.telegramBot.sendLocation(
                    chatId,
                    locationMessage.degreesLatitude,
                    locationMessage.degreesLongitude,
                    { message_thread_id: newTopicId }
                );
                if (caption) {
                    await this.telegramBot.sendMessage(chatId, caption, {
                        message_thread_id: newTopicId
                    });
                }
            } else {
                logger.error('❌ Failed to send location:', desc);
            }
        }
    } catch (err) {
        logger.error('❌ Error in handleWhatsAppLocation:', err);
    }
}

async handleWhatsAppContact(whatsappMsg, topicId, isOutgoing = false) {
    try {
        const contactMessage = whatsappMsg.message.contactMessage;
        const displayName = contactMessage.displayName || 'Unknown Contact';
        const phoneNumber = contactMessage.vcard.match(/TEL.*:(.*)/)?.[1] || '';
        const sender = whatsappMsg.key.remoteJid;
        const caption = isOutgoing
            ? `📤 You shared contact: ${displayName}`
            : `📇 Contact: ${displayName}`;

        try {
            await this.telegramBot.sendContact(
                config.get('telegram.chatId'),
                phoneNumber,
                displayName,
                { message_thread_id: topicId }
            );
        } catch (error) {
            const desc = error.response?.data?.description || error.message;
            if (desc.includes("message thread not found")) {
                logger.warn(`🗑️ Contact topic deleted. Recreating...`);
                this.chatMappings.delete(sender);
                this.profilePicCache.delete(sender);
                await this.collection.deleteOne({ type: 'chat', 'data.whatsappJid': sender });
                const newTopicId = await this.getOrCreateTopic(sender, whatsappMsg);
                if (newTopicId) {
                    await this.telegramBot.sendContact(
                        config.get('telegram.chatId'),
                        phoneNumber,
                        displayName,
                        { message_thread_id: newTopicId }
                    );
                }
            } else {
                logger.error('❌ Failed to send contact:', desc);
            }
        }
    } catch (err) {
        logger.error('❌ Error in handleWhatsAppContact:', err);
    }
}



    async markAsRead(jid, messageKeys) {
        try {
            if (!this.whatsappBot?.sock || !messageKeys.length || !config.get('telegram.features.readReceipts')) return;
            
            await this.whatsappBot.sock.readMessages(messageKeys);
            logger.debug(`📖 Marked ${messageKeys.length} messages as read in ${jid}`);
        } catch (error) {
            logger.debug('Failed to mark messages as read:', error);
        }
    }

    async handleTelegramMessage(msg) {
    try {
        const topicId = msg.message_thread_id;
        let whatsappJid = this.findWhatsAppJidByTopic(topicId);
        // Normalize and convert LID to PN JID if necessary (lookup result might be old LID)
        whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));
        
        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
            return;
        }

        await this.sendTypingPresence(whatsappJid);

        if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
            await this.handleStatusReply(msg);
            return;
        }

        if (msg.photo) {
            await this.handleTelegramMedia(msg, 'photo');
        } else if (msg.video) {
            await this.handleTelegramMedia(msg, 'video');
        } else if (msg.animation) {
            await this.handleTelegramMedia(msg, 'animation');
        } else if (msg.video_note) {
            await this.handleTelegramMedia(msg, 'video_note');
        } else if (msg.voice) {
            await this.handleTelegramMedia(msg, 'voice');
        } else if (msg.audio) {
            await this.handleTelegramMedia(msg, 'audio');
        } else if (msg.document) {
            await this.handleTelegramMedia(msg, 'document');
        } else if (msg.sticker) {
            await this.handleTelegramMedia(msg, 'sticker');
        } else if (msg.location) {
            await this.handleTelegramLocation(msg);
        } else if (msg.contact) {
            await this.handleTelegramContact(msg);
        } else if (msg.text) {
            const originalText = msg.text.trim();
            const textLower = originalText.toLowerCase();

            // ✅ Filter enforcement
            for (const word of this.filters || []) {
                if (textLower.startsWith(word)) {
                    logger.info(`🛑 Blocked Telegram ➝ WhatsApp message due to filter "${word}": ${originalText}`);
                    await this.setReaction(msg.chat.id, msg.message_id, '🚫');
                    return;
                }
            }

            // ✅ If allowed, send message
            const messageOptions = { text: originalText };
            if (msg.entities && msg.entities.some(entity => entity.type === 'spoiler')) {
                messageOptions.text = `🫥 ${originalText}`;
            }

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');

                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        }

        setTimeout(async () => {
            await this.sendPresence(whatsappJid, 'available');
        }, 2000);

    } catch (error) {
        logger.error('❌ Failed to handle Telegram message:', error);
        await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
}


    async handleStatusReply(msg) {
        try {
            const originalStatusKey = this.statusMessageMapping.get(msg.reply_to_message.message_id);
            if (!originalStatusKey) {
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Cannot find original status to reply to', {
                    message_thread_id: msg.message_thread_id
                });
                return;
            }

            const statusJid = originalStatusKey.participant;
            const phone = statusJid.split('@')[0];
            const contactName = this.contactMappings.get(phone) || `+${phone}`;

            const messageOptions = {
                text: msg.text,
                contextInfo: {
                    quotedMessage: originalStatusKey.message,
                    stanzaId: originalStatusKey.id,
                    participant: originalStatusKey.participant,
                    remoteJid: 'status@broadcast'
                }
            };

            const sendResult = await this.whatsappBot.sendMessage(statusJid, messageOptions);

            if (sendResult?.key?.id) {
                await this.telegramBot.sendMessage(msg.chat.id, `✅ Status reply sent to ${contactName}`, {
                    message_thread_id: msg.message_thread_id
                });
                await this.setReaction(msg.chat.id, msg.message_id, '✅');
                logger.info(`✅ Sent status reply to ${statusJid} for ${contactName}`);
            } else {
                throw new Error('Failed to send status reply');
            }
            
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send reply to ${contactName}`, {
                message_thread_id: msg.message_thread_id
            });
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            let whatsappJid = this.findWhatsAppJidByTopic(topicId);
            whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
                return;
            }

            await this.sendPresence(whatsappJid, false);

            let fileId, fileName, caption = msg.caption || '';
            
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                    fileName = `photo_${Date.now()}.jpg`;
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
                    break;
                case 'animation':
                    fileId = msg.animation.file_id;
                    fileName = `animation_${Date.now()}.mp4`;
                    break;
                case 'video_note':
                    fileId = msg.video_note.file_id;
                    fileName = `video_note_${Date.now()}.mp4`;
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    break;
                case 'audio':
                    fileId = msg.audio.file_id;
                    fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    break;
                case 'sticker':
                    fileId = msg.sticker.file_id;
                    fileName = `sticker_${Date.now()}.webp`;
                    break;
            }

            logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);

            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            logger.info(`💾 Saved ${mediaType} to: ${filePath} (${buffer.length} bytes)`);

            let sendResult;
            let messageOptions = {};

            const hasMediaSpoiler = msg.has_media_spoiler || 
                (msg.caption_entities && msg.caption_entities.some(entity => entity.type === 'spoiler'));

            switch (mediaType) {
                case 'photo':
                    messageOptions = {
                        image: fs.readFileSync(filePath),
                        caption: caption,
                        viewOnce: hasMediaSpoiler
                    };
                    break;
                    
                case 'video':
                    messageOptions = {
                        video: fs.readFileSync(filePath),
                        caption: caption,
                        viewOnce: hasMediaSpoiler
                    };
                    break;

                case 'video_note':
                    messageOptions = {
                        video: fs.readFileSync(filePath),
                        caption: caption,
                        ptv: true,
                        viewOnce: hasMediaSpoiler
                    };
                    break;

                case 'animation':
                    messageOptions = {
                        video: fs.readFileSync(filePath),
                        caption: caption,
                        gifPlayback: true,
                        viewOnce: hasMediaSpoiler
                    };
                    break;
                    
                case 'voice':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        ptt: true,
                        mimetype: 'audio/ogg; codecs=opus'
                    };
                    break;
                    
                case 'audio':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        mimetype: mime.lookup(fileName) || 'audio/mp3',
                        fileName: fileName,
                        caption: caption
                    };
                    break;
                    
                case 'document':
                    messageOptions = {
                        document: fs.readFileSync(filePath),
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        caption: caption
                    };
                    break;
                    
                case 'sticker':
                    await this.handleTelegramSticker(msg);
                    return;
            }

            sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);

            await fs.unlink(filePath).catch(() => {});
            
            if (sendResult?.key?.id) {
                logger.info(`✅ Successfully sent ${mediaType} to WhatsApp`);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            } else {
                logger.warn(`⚠️ Failed to send ${mediaType} to WhatsApp - no message ID`);
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramSticker(msg) {
        const topicId = msg.message_thread_id;
        let whatsappJid = this.findWhatsAppJidByTopic(topicId);
        whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));
        const chatId = msg.chat.id;

        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram sticker');
            return;
        }

        try {
            await this.sendPresence(whatsappJid, 'composing');

            const fileId = msg.sticker.file_id;
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const stickerBuffer = (await axios.get(fileLink, { responseType: 'arraybuffer' })).data;
            const fileName = `sticker_${Date.now()}`;
            const inputPath = path.join(this.tempDir, `${fileName}.webp`);
            await fs.writeFile(inputPath, stickerBuffer);

            let outputBuffer;

            const isAnimated = msg.sticker.is_animated || msg.sticker.is_video;

            if (isAnimated) {
                const animatedPath = await this.convertAnimatedSticker(inputPath);
                if (animatedPath) {
                    outputBuffer = await fs.readFile(animatedPath);
                    await fs.unlink(animatedPath).catch(() => {});
                } else {
                    throw new Error('Animated sticker conversion failed');
                }
            } else {
                const sticker = new Sticker(stickerBuffer, {
                    type: StickerTypes.FULL,
                    pack: 'Telegram Stickers',
                    author: 'BridgeBot',
                    quality: 100
                });
                outputBuffer = await sticker.toBuffer();
            }

            const result = await this.whatsappBot.sendMessage(whatsappJid, {
                sticker: outputBuffer
            });

            await fs.unlink(inputPath).catch(() => {});

            if (result?.key?.id) {
                logger.info('✅ Sticker sent to WhatsApp');
                await this.setReaction(chatId, msg.message_id, '👍');
            } else {
                throw new Error('Sticker sent but no confirmation');
            }
        } catch (err) {
            logger.error('❌ Failed to send sticker to WhatsApp:', err);
            await this.setReaction(chatId, msg.message_id, '❌');

            const fallbackPath = path.join(this.tempDir, `fallback_${Date.now()}.png`);
            await sharp(stickerBuffer).resize(512, 512).png().toFile(fallbackPath);
            await this.telegramBot.sendPhoto(chatId, fallbackPath, {
                message_thread_id: topicId,
                caption: 'Sticker (fallback)'
            });
            await fs.unlink(fallbackPath).catch(() => {});
        }
    }

    async convertAnimatedSticker(inputPath) {
        const outputPath = inputPath.replace('.webp', '-converted.webp');

        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-loop', '0',
                    '-an',
                    '-vsync', '0'
                ])
                .outputFormat('webp')
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    logger.debug('Animated sticker conversion failed:', err.message);
                    resolve(null);
                })
                .save(outputPath);
        });
    } 

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            let whatsappJid = this.findWhatsAppJidByTopic(topicId);
            whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                return;
            }

            await this.sendPresence(whatsappJid, 'available');

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = msg.message_thread_id;
            let whatsappJid = this.findWhatsAppJidByTopic(topicId);
            whatsappJid = await this.handleLIDConversion(this.normalizeJID(whatsappJid));

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram contact');
                return;
            }

            await this.sendPresence(whatsappJid, 'available');

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async sendSimpleMessage(topicId, text, sender) {
    const chatId = config.get('telegram.chatId');

    try {
        const sentMessage = await this.telegramBot.sendMessage(chatId, text, {
            message_thread_id: topicId
        });
        return sentMessage.message_id;

    } catch (error) {
        const desc = error.response?.data?.description || error.message;

        if (desc.includes('message thread not found')) {
            logger.warn(`🗑️ Topic ID ${topicId} for sender ${sender} is missing. Recreating...`);

            // Find JID from topic ID
            const jidEntry = [...this.chatMappings.entries()].find(([jid, tId]) => tId === topicId);
            const jid = jidEntry?.[0];

            if (jid) {
                // Clean mapping
                this.chatMappings.delete(jid);
                this.profilePicCache.delete(jid);
                await this.collection.deleteOne({ type: 'chat', 'data.whatsappJid': jid });

                // Recreate topic
                const dummyMsg = {
                    key: {
                        remoteJid: jid,
                        participant: jid.endsWith('@g.us') ? jid : jid
                    }
                };
                const newTopicId = await this.getOrCreateTopic(jid, dummyMsg);

                if (newTopicId) {
                    // 🔁 RETRY original message
                    try {
                        const retryMessage = await this.telegramBot.sendMessage(chatId, text, {
                            message_thread_id: newTopicId
                        });
                        return retryMessage.message_id;
                    } catch (retryErr) {
                        logger.error('❌ Retry failed after topic recreation:', retryErr);
                        return null;
                    }
                }
            } else {
                logger.warn(`⚠️ Could not find WhatsApp JID for topic ID ${topicId}`);
            }
        }

        logger.error('❌ Failed to send message to Telegram:', desc);
        return null;
    }
}




    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
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

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 HyperWa Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `📞 Contacts: ${this.contactMappings.size} synced\n` +
            `🚀 Ready to bridge messages!`);

        await this.syncContacts();
    }

    async setupWhatsAppHandlers() {
        if (!this.whatsappBot?.sock) {
            logger.warn('⚠️ WhatsApp socket not available for setting up handlers');
            return;
        }

        // FIXED: Enhanced contact sync and topic name update handlers
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            try {
                let updatedCount = 0;
                for (const contact of contacts) {
                    // Ensure we are dealing with the phone number, not LID or session IDs
                    const normalizedJid = this.normalizeJID(contact.id);
                    if (normalizedJid && contact.name) {
                        const phone = normalizedJid.split('@')[0];
                        const oldName = this.contactMappings.get(phone);
                        
                        // Only update if it's a real contact name (not handle name)
                        if (contact.name !== phone && 
                            !contact.name.startsWith('+') && 
                            contact.name.length > 2 &&
                            oldName !== contact.name) {
                            
                            await this.saveContactMapping(phone, contact.name);
                            logger.info(`📞 Updated contact: ${phone} -> ${contact.name}`);
                            updatedCount++;
                            
                            // Update topic name immediately - MUST USE CONVERTED JID
                            const pnJid = await this.handleLIDConversion(normalizedJid);
                            if (this.chatMappings.has(pnJid)) {
                                const topicId = this.chatMappings.get(pnJid);
                                try {
                                    logger.debug(`📝 Updating topic ${topicId} name from "${oldName || 'unknown'}" to "${contact.name}"`);
                                    
                                    await this.telegramBot.editForumTopic(config.get('telegram.chatId'), topicId, {
                                        name: contact.name
                                    });
                                    
                                    logger.info(`📝 ✅ Updated topic name for ${phone}: "${contact.name}"`);
                                } catch (error) {
                                    logger.error(`📝 ❌ Could not update topic name for ${phone}:`, error.message);
                                }
                            }
                        }
                    }
                }
                if (updatedCount > 0) {
                    logger.info(`✅ Processed ${updatedCount} contact updates`);
                }
            } catch (error) {
                logger.error('❌ Failed to process contact updates:', error);
            }
        });

        this.whatsappBot.sock.ev.on('contacts.upsert', async (contacts) => {
            try {
                let newCount = 0;
                for (const contact of contacts) {
                    const normalizedJid = this.normalizeJID(contact.id);
                    if (normalizedJid && contact.name) {
                        const phone = normalizedJid.split('@')[0];
                        // Only save real contact names
                        if (contact.name !== phone && 
                            !contact.name.startsWith('+') && 
                            contact.name.length > 2 &&
                            !this.contactMappings.has(phone)) {
                            
                            await this.saveContactMapping(phone, contact.name);
                            logger.info(`📞 New contact: ${phone} -> ${contact.name}`);
                            newCount++;
                            
                            // Update topic name if topic exists - MUST USE CONVERTED JID
                            const pnJid = await this.handleLIDConversion(normalizedJid);
                            if (this.chatMappings.has(pnJid)) {
                                const topicId = this.chatMappings.get(pnJid);
                                try {
                                    logger.debug(`📝 Updating new contact topic ${topicId} to "${contact.name}"`);
                                    
                                    await this.telegramBot.editForumTopic(config.get('telegram.chatId'), topicId, {
                                        name: contact.name
                                    });
                                    
                                    logger.info(`📝 ✅ Updated new contact topic name for ${phone}: "${contact.name}"`);
                                } catch (error) {
                                    logger.error(`📝 ❌ Could not update new contact topic name for ${phone}:`, error.message);
                                }
                            }
                        }
                    }
                }
                if (newCount > 0) {
                    logger.info(`✅ Added ${newCount} new contacts`);
                }
            } catch (error) {
                logger.error('❌ Failed to process new contacts:', error);
            }
        });

        // FIXED: Profile picture update handler with proper URL checking
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            for (const contact of contacts) {
                const pnJid = await this.handleLIDConversion(this.normalizeJID(contact.id));
                if (pnJid && this.chatMappings.has(pnJid)) {
                    const topicId = this.chatMappings.get(pnJid);
                    
                    // Check for profile picture updates
                    logger.debug(`📸 Checking profile picture update for ${pnJid}`);
                    await this.sendProfilePicture(topicId, pnJid, true);
                }
            }
        });

        this.whatsappBot.sock.ev.on('call', async (callEvents) => {
            for (const callEvent of callEvents) {
                await this.handleCallNotification(callEvent);
            }
        });

        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }
    
    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

export default TelegramBridge;
