class RateLimiter {
    constructor() {
        this.userLimits = new Map();
        this.commandLimits = new Map();
        
        // Clean up old entries periodically
        setInterval(() => {
            this.cleanup();
        }, 300000); // Every 5 minutes
    }

    async checkCommandLimit(userId, maxCommands = 15, windowMs = 60000) {
        const now = Date.now();
        const userKey = `cmd_${userId}`;
        
        if (!this.commandLimits.has(userKey)) {
            this.commandLimits.set(userKey, []);
        }
        
        const userCommands = this.commandLimits.get(userKey);
        
        // Remove old entries
        const validCommands = userCommands.filter(time => now - time < windowMs);
        this.commandLimits.set(userKey, validCommands);
        
        if (validCommands.length >= maxCommands) {
            return false;
        }
        
        validCommands.push(now);
        return true;
    }

    async getRemainingTime(userId, windowMs = 60000) {
        const userKey = `cmd_${userId}`;
        const userCommands = this.commandLimits.get(userKey) || [];
        
        if (userCommands.length === 0) return 0;
        
        const oldestCommand = Math.min(...userCommands);
        const remaining = windowMs - (Date.now() - oldestCommand);
        
        return Math.max(0, remaining);
    }
    
    cleanup() {
        const now = Date.now();
        const windowMs = 300000; // 5 minutes
        
        for (const [key, commands] of this.commandLimits.entries()) {
            const validCommands = commands.filter(time => now - time < windowMs);
            if (validCommands.length === 0) {
                this.commandLimits.delete(key);
            } else {
                this.commandLimits.set(key, validCommands);
            }
        }
    }
}

export default new RateLimiter();
