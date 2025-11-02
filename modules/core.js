import config from '../config.js';
import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import helpers from '../utils/helpers.js';
import logger from '../core/logger.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CoreModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'core';
        this.metadata = {
            description: 'Core commands for bot control and monitoring',
            version: '2.1.0',
            author: 'HyperWA',
            category: 'system'
        };
        this.commands = [
            {
                name: 'ping',
                description: 'Check bot response time',
                usage: '.ping',
                permissions: 'public',
                aliases: ['p'],
                ui: {
                    processingText: '🏓 *Pinging...*',
                    errorText: '❌ Failed to ping'
                },
                execute: this.ping.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status and statistics',
                usage: '.status',
                permissions: 'public',
                aliases: ['stats', 'info'],
                ui: {
                    processingText: '📊 Gathering status...',
                    errorText: '❌ Failed to retrieve status'
                },
                execute: this.status.bind(this)
            },
            {
                name: 'activity',
                description: 'View user activity logs',
                usage: '.activity [user] [days]',
                permissions: 'admin',
                execute: this.viewActivity.bind(this)
            },
            {
                name: 'restart',
                description: 'Restart the bot (owner only)',
                usage: '.restart',
                permissions: 'owner',
                ui: {
                    processingText: '🔄 Restarting bot...',
                    errorText: '❌ Restart failed'
                },
                execute: this.restart.bind(this)
            },
            {
                name: 'logs',
                description: 'Send or display bot logs (owner only)',
                usage: '.logs [display]',
                permissions: 'owner',
                execute: this.logs.bind(this)
            },
            {
                name: 'mode',
                description: 'Toggle bot mode',
                usage: '.mode [public|private]',
                permissions: 'owner',
                ui: {
                    processingText: '⚙️ Toggling mode...',
                    errorText: '❌ Mode change failed'
                },
                execute: this.toggleMode.bind(this)
            },
            {
                name: 'ban',
                description: 'Ban a user',
                usage: '.ban <number>',
                permissions: 'owner',
                ui: {
                    processingText: '🚫 Banning user...',
                    errorText: '❌ Failed to ban user'
                },
                execute: this.banUser.bind(this)
            },
            {
                name: 'unban',
                description: 'Unban a user',
                usage: '.unban <number>',
                permissions: 'owner',
                ui: {
                    processingText: '✅ Unbanning user...',
                    errorText: '❌ Failed to unban user'
                },
                execute: this.unbanUser.bind(this)
            },
            {
                name: 'broadcast',
                description: 'Broadcast message to all chats',
                usage: '.broadcast <message>',
                permissions: 'owner',
                ui: {
                    processingText: '📢 Sending broadcast...',
                    errorText: '❌ Broadcast failed'
                },
                execute: this.broadcast.bind(this)
            },
            {
                name: 'update',
                description: 'Pull latest updates from Git',
                usage: '.update',
                permissions: 'owner',
                ui: {
                    processingText: '📥 Updating code...',
                    errorText: '❌ Update failed'
                },
                execute: this.updateCode.bind(this)
            },
            {
                name: 'sh',
                description: 'Execute a shell command',
                usage: '.sh <command>',
                permissions: 'owner',
                ui: {
                    processingText: '🖥️ Running shell command...',
                    errorText: '❌ Shell command failed'
                },
                execute: this.runShell.bind(this)
            }
        ];

        this.commandCounts = new Map();
        this.startTime = Date.now();
    }

async ping(msg, params, context) {
    const start = Date.now();
    this.incrementCommandCount('ping');
    await new Promise(resolve => setTimeout(resolve, 0)); 
    const latency = Date.now() - start;
    return ` *Pong!* • ${latency}ms`;
}

    async status(msg, params, context) {
        const uptime = this.getUptime();
        const totalCommands = [...this.commandCounts.values()].reduce((a, b) => a + b, 0);
        const text = `🤖 *${config.get('bot.name')} Status*\n\n` +
                     `🆚 Version: ${config.get('bot.version')}\n` +
                     `👤 Owner: ${config.get('bot.owner').split('@')[0]}\n` +
                     `⏰ Uptime: ${uptime}\n` +
                     `📊 Commands Executed: ${totalCommands}\n` +
                     `🌐 Mode: ${config.get('features.mode')}\n` +
                     `🔗 Telegram Bridge: ${config.get('telegram.enabled') ? 'Enabled' : 'Disabled'}\n` +
                     `📞 Contacts Synced: ${this.bot.telegramBridge?.contactMappings.size || 0}`;
        this.incrementCommandCount('status');
        return text;
    }

async restart(msg, params, context) {
    this.incrementCommandCount('restart');

    // Optional log to Telegram before restart
    if (this.bot.telegramBridge) {
        await this.bot.telegramBridge.logToTelegram('🔄 Bot Restart', 'Restart requested by owner.');
    }

    // Notify user
    await context.bot.sendMessage(context.sender, { text: '🔁 Restarting ' });

    // Get current node and script info
    const execPath = process.argv[0];
    const scriptPath = process.argv[1];
    const args = process.argv.slice(2);

    // Spawn new instance (detached so it survives this process)
    const child = spawn(execPath, [scriptPath, ...args], {
        detached: true,
        stdio: 'inherit',
    });

    // Give it a moment to start, then exit the current process
    setTimeout(() => {
        process.exit(0);
    }, 1000);

    return '🔄 Restarting process...';
}


    async toggleMode(msg, params, context) {
        const mode = params[0]?.toLowerCase();
        if (!['public', 'private'].includes(mode)) {
            return `🌐 Current Mode: ${config.get('features.mode')}\n\nUsage: \`.mode public|private\``;
        }

        config.set('features.mode', mode);
        this.incrementCommandCount('mode');
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🌐 Mode Changed', `New mode: ${mode}`);
        }
        return `✅ *Mode Changed*\n\nNew Mode: ${mode}`;
    }

    async banUser(msg, params, context) {
        const phone = (params[0] || '').replace('+', '');
        if (!phone) return '❌ Usage: `.ban <number>`';
        const list = config.get('security.blockedUsers') || [];
        if (list.includes(phone)) return `❌ User ${phone} is already banned.`;

        list.push(phone);
        config.set('security.blockedUsers', list);
        this.incrementCommandCount('ban');

        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🚫 User Banned', phone);
        }
        return `🚫 *User Banned*\n\n📱 ${phone}`;
    }

    async unbanUser(msg, params, context) {
        const phone = (params[0] || '').replace('+', '');
        if (!phone) return '❌ Usage: `.unban <number>`';
        const list = config.get('security.blockedUsers') || [];
        if (!list.includes(phone)) return `❌ User ${phone} is not banned.`;

        config.set('security.blockedUsers', list.filter(p => p !== phone));
        this.incrementCommandCount('unban');

        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('✅ User Unbanned', phone);
        }
        return `✅ *User Unbanned*\n\n📱 ${phone}`;
    }

    async broadcast(msg, params, context) {
        const text = params.join(' ');
        if (!text) return '❌ Usage: `.broadcast <message>`';

        const chats = this.bot.telegramBridge?.chatMappings.keys() || [];
        let sent = 0;
        for (const jid of chats) {
            try {
                await this.bot.sendMessage(jid, { text: `📢 *Broadcast*\n\n${text}` });
                sent++;
            } catch (e) {
                this.bot.logger?.error?.(`Broadcast failed to ${jid}`, e);
            }
        }

        this.incrementCommandCount('broadcast');
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('📢 Broadcast Sent', `${text} (${sent} chats)`);
        }
        return `📢 *Broadcast Sent*\n\nSent to ${sent} chats.`;
    }

async updateCode(msg, params, context) {
    return new Promise((resolve) => {
        exec('git pull', async (err, stdout, stderr) => {
            const output = stdout?.trim() || '';
            const errorOutput = stderr?.trim() || '';
            this.incrementCommandCount('update');

            let message;

            if (err) {
                message = `❌ *Git Pull Failed*\n\n\`\`\`\n${errorOutput || err.message || 'Unknown error'}\n\`\`\``;
            } else {
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📥 Update Pulled', output);
                }
                message = `📥 *Update Complete*\n\n\`\`\`\n${output || 'No changes'}\n\`\`\``;
            }

            resolve(message);
        });
    });
}


    async viewActivity(msg, params, context) {
        const targetUser = params[0];
        const days = parseInt(params[1]) || 7;
        
        try {
            const activity = await this.getUserActivity(targetUser, days);
            
            let activityText = `📊 *User Activity Report*\n\n`;
            
            if (targetUser) {
                activityText += `👤 *User:* ${targetUser}\n`;
            } else {
                activityText += `👥 *All Users*\n`;
            }
            
            activityText += `📅 *Period:* Last ${days} days\n\n`;
            activityText += `💬 *Messages:* ${activity.messages}\n`;
            activityText += `⚡ *Commands:* ${activity.commands}\n`;
            activityText += `📊 *Success Rate:* ${activity.successRate}%\n`;
            
            if (activity.topCommands.length > 0) {
                activityText += `\n🔥 *Top Commands:*\n`;
                activity.topCommands.forEach((cmd, index) => {
                    activityText += `  ${index + 1}. ${cmd.name} (${cmd.count}x)\n`;
                });
            }
            
            await context.bot.sendMessage(context.sender, { text: activityText });
            
        } catch (error) {
            await context.bot.sendMessage(context.sender, {
                text: `❌ Failed to get activity report: ${error.message}`
            });
        }
    } 

async logs(msg, params, context) {
    const jid = msg.key.remoteJid;
    const displayMode = params[0]?.toLowerCase() === 'display';
    const logFilePath = path.join(__dirname, '../logs', 'bot.log');

    // Check if log file exists
    if (!await fs.pathExists(logFilePath)) {
        logger.error('Log file does not exist:', logFilePath);
        await this.bot.sock.sendMessage(jid, { text: '❌ No log file found at the specified path.' });
        return;
    }

    logger.debug('Processing log file:', logFilePath);

    if (displayMode) {
        try {
            const content = await fs.readFile(logFilePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            const recent = lines.slice(-10).join('\n') || 'No recent logs.';
            const logText = `📜 *Recent Logs* (Last 10 lines)\n\n\`\`\`\n${recent}\n\`\`\`\n🕒 ${new Date().toLocaleTimeString()}`;
            await this.bot.sock.sendMessage(jid, { text: logText });

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('📜 Logs Displayed', 'Recent logs viewed by owner');
            }
        } catch (err) {
            logger.error('Failed to read/display log file:', err);
            await this.bot.sock.sendMessage(jid, {
                text: `❌ Failed to display logs: ${err.message || 'Unknown error'}`
            });
        }
    } else {
        try {
            const fileBuffer = await fs.readFile(logFilePath);
            if (fileBuffer.length === 0) {
                logger.warn('Log file is empty:', logFilePath);
                await this.bot.sock.sendMessage(jid, { text: '❌ Log file is empty.' });
                return;
            }

            await this.bot.sock.sendMessage(jid, {
                document: {
                    stream: fileBuffer,
                    filename: 'bot.log',
                    mimetype: 'text/plain'
                },
                caption: `📜 *Latest Log File*\n\n📄 File: bot.log\n🕒 ${new Date().toLocaleTimeString()}`
            });

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('📜 Log File Sent', 'File: bot.log');
            }
        } catch (err) {
            logger.error('Failed to send log file:', err);
            await this.bot.sock.sendMessage(jid, {
                text: `❌ Failed to send log file: ${err.message || 'Unknown error'}`
            });
        }
    }

    this.incrementCommandCount('logs');
}


async runShell(msg, params, context) {
    const command = params.join(' ');
    if (!command) return '❌ Usage: `.sh <command>`';

    return new Promise((resolve) => {
        exec(command, { timeout: 10000 }, (err, stdout, stderr) => {
            this.incrementCommandCount('sh');

            const output = stdout?.trim() || '';
            const errorOutput = stderr?.trim() || '';
            const message = err
                ? `❌ *Shell Command Error*\n\n\`\`\`\n${errorOutput || err.message || 'Unknown error'}\n\`\`\``
                : `🖥️ *Command Output*\n\n\`\`\`\n${output || errorOutput || '✅ Command executed with no output'}\n\`\`\``;

            resolve(message);
        });
    });
}




    getUptime() {
        const sec = Math.floor((Date.now() - this.startTime) / 1000);
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${d}d ${h}h ${m}m ${s}s`;
    }

    incrementCommandCount(name) {
        this.commandCounts.set(name, (this.commandCounts.get(name) || 0) + 1);
    }
}

export default CoreModule;
