import pino from 'pino';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = path.join(__dirname, '../logs');
fs.ensureDirSync(logsDir);

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                level: 'info',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname'
                }
            },
            {
                target: 'pino/file',
                level: 'info',
                options: {
                    destination: path.join(logsDir, 'bot.log'),
                    mkdir: true
                }
            }
        ]
    }
});

export default logger;
