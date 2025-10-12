import {  GoogleGenerativeAI, HarmBlockThreshold, HarmCategory  } from '@google/generative-ai';

class GeminiAdvancedModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'gemini';
        this.metadata = {
            description: 'Advanced Gemini AI features with conversation memory and specialized modes',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'ai'
        };

        // Add your Gemini API key here
        this.apiKey = "AIzaSyCjsufhrqepM1uYNji8hwhf_mQnDCjKL60";
        this.genAI = null;
        this.model = null;
        
        // Conversation memory
        this.conversations = new Map();
        this.maxConversationLength = 10;
        
        this.commands = [
            {
                name: 'ai',
                description: 'Chat with Gemini AI',
                usage: '.ai <message>',
                aliases: ['gemini', 'ask'],
                permissions: 'public',
                ui: {
                    processingText: '🤖 *Thinking...*\n\n⏳ Processing your request...',
                    errorText: '❌ *AI Response Failed*'
                },
                execute: this.chatWithAI.bind(this)
            },
            {
                name: 'explain',
                description: 'Get detailed explanation of a topic',
                usage: '.explain <topic>',
                permissions: 'public',
                ui: {
                    processingText: '📚 *Explaining...*\n\n⏳ Gathering information...',
                    errorText: '❌ *Explanation Failed*'
                },
                execute: this.explainTopic.bind(this)
            },
            {
                name: 'code',
                description: 'Get coding help and examples',
                usage: '.code <programming question>',
                permissions: 'public',
                ui: {
                    processingText: '💻 *Coding Assistant...*\n\n⏳ Writing code solution...',
                    errorText: '❌ *Code Generation Failed*'
                },
                execute: this.codeAssistant.bind(this)
            },
            {
                name: 'creative',
                description: 'Creative writing and storytelling',
                usage: '.creative <prompt>',
                permissions: 'public',
                ui: {
                    processingText: '✨ *Being Creative...*\n\n⏳ Crafting something special...',
                    errorText: '❌ *Creative Writing Failed*'
                },
                execute: this.creativeWriting.bind(this)
            },
            {
                name: 'analyze',
                description: 'Analyze and break down complex topics',
                usage: '.analyze <topic or question>',
                permissions: 'public',
                ui: {
                    processingText: '🔍 *Analyzing...*\n\n⏳ Breaking down the topic...',
                    errorText: '❌ *Analysis Failed*'
                },
                execute: this.analyzeTopic.bind(this)
            },
            {
                name: 'debate',
                description: 'Get multiple perspectives on a topic',
                usage: '.debate <topic>',
                permissions: 'public',
                ui: {
                    processingText: '⚖️ *Preparing Debate...*\n\n⏳ Considering all sides...',
                    errorText: '❌ *Debate Generation Failed*'
                },
                execute: this.generateDebate.bind(this)
            },
            {
                name: 'summary',
                description: 'Summarize long text or topics',
                usage: '.summary <text or topic>',
                permissions: 'public',
                ui: {
                    processingText: '📄 *Summarizing...*\n\n⏳ Extracting key points...',
                    errorText: '❌ *Summary Failed*'
                },
                execute: this.summarizeText.bind(this)
            },
            {
                name: 'brainstorm',
                description: 'Generate creative ideas and solutions',
                usage: '.brainstorm <topic or problem>',
                permissions: 'public',
                ui: {
                    processingText: '💡 *Brainstorming...*\n\n⏳ Generating ideas...',
                    errorText: '❌ *Brainstorming Failed*'
                },
                execute: this.brainstormIdeas.bind(this)
            },
            {
                name: 'clearai',
                description: 'Clear conversation memory',
                usage: '.clearai',
                permissions: 'public',
                execute: this.clearConversation.bind(this)
            }
        ];
    }

    async init() {
        if (!this.apiKey || this.apiKey === "YOUR_GEMINI_API_KEY") {
            console.error('❌ Gemini API key is missing');
            throw new Error('Gemini API key not configured');
        }
        
        this.genAI = new GoogleGenerativeAI(this.apiKey);
        this.model = this.genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash",
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ]
        });
        
    }

    getConversationHistory(userId) {
        if (!this.conversations.has(userId)) {
            this.conversations.set(userId, []);
        }
        return this.conversations.get(userId);
    }

    addToConversation(userId, userMessage, aiResponse) {
        const history = this.getConversationHistory(userId);
        history.push({ user: userMessage, ai: aiResponse, timestamp: Date.now() });
        
        // Keep only recent messages
        if (history.length > this.maxConversationLength) {
            history.shift();
        }
    }

    buildContextPrompt(userId, currentMessage, systemPrompt = '') {
        const history = this.getConversationHistory(userId);
        let prompt = systemPrompt + '\n\n';
        
        if (history.length > 0) {
            prompt += 'Previous conversation:\n';
            history.forEach(entry => {
                prompt += `User: ${entry.user}\nAI: ${entry.ai}\n\n`;
            });
        }
        
        prompt += `Current message: ${currentMessage}`;
        return prompt;
    }

    async chatWithAI(msg, params, context) {
        if (params.length === 0) {
            return '❌ *AI Chat*\n\nPlease provide a message to chat with AI.\n\n💡 Usage: `.ai <message>`\n📝 Example: `.ai What is quantum computing?`';
        }

        const userMessage = params.join(' ');
        const userId = context.participant.split('@')[0];

        try {
            const prompt = this.buildContextPrompt(userId, userMessage, 
                'You are a helpful, friendly, and knowledgeable AI assistant. Provide clear, accurate, and engaging responses.');

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const aiResponse = response.text();

            // Add to conversation history
            this.addToConversation(userId, userMessage, aiResponse);

            return `🤖 *AI Response*\n\n${aiResponse}\n\n💡 Use \`.clearai\` to reset conversation`;

        } catch (error) {
            throw new Error(`AI chat failed: ${error.message}`);
        }
    }

    async explainTopic(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Topic Explanation*\n\nPlease provide a topic to explain.\n\n💡 Usage: `.explain <topic>`\n📝 Example: `.explain blockchain technology`';
        }

        const topic = params.join(' ');

        try {
            const prompt = `Please provide a comprehensive but easy-to-understand explanation of: ${topic}

Structure your response as follows:
1. Brief definition
2. Key concepts
3. How it works
4. Real-world applications
5. Benefits and limitations

Make it educational but accessible to a general audience.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const explanation = response.text();

            return `📚 *Topic Explanation: ${topic}*\n\n${explanation}`;

        } catch (error) {
            throw new Error(`Topic explanation failed: ${error.message}`);
        }
    }

    async codeAssistant(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Code Assistant*\n\nPlease provide a programming question or request.\n\n💡 Usage: `.code <programming question>`\n📝 Example: `.code How to sort an array in Python?`';
        }

        const question = params.join(' ');

        try {
            const prompt = `You are an expert programming assistant. Help with this coding question: ${question}

Please provide:
1. A clear explanation of the solution
2. Code examples with comments
3. Best practices
4. Alternative approaches if applicable

Format code blocks clearly and explain each step.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const codeHelp = response.text();

            return `💻 *Code Assistant*\n\n${codeHelp}`;

        } catch (error) {
            throw new Error(`Code assistance failed: ${error.message}`);
        }
    }

    async creativeWriting(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Creative Writing*\n\nPlease provide a creative prompt.\n\n💡 Usage: `.creative <prompt>`\n📝 Example: `.creative Write a short story about a time traveler`';
        }

        const prompt = params.join(' ');

        try {
            const fullPrompt = `You are a creative writer. Based on this prompt: "${prompt}"

Create engaging, original content that is:
- Creative and imaginative
- Well-structured
- Engaging to read
- Appropriate for all audiences

Feel free to be creative with style, tone, and approach.`;

            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            const creative = response.text();

            return `✨ *Creative Writing*\n\n${creative}`;

        } catch (error) {
            throw new Error(`Creative writing failed: ${error.message}`);
        }
    }

    async analyzeTopic(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Topic Analysis*\n\nPlease provide a topic to analyze.\n\n💡 Usage: `.analyze <topic>`\n📝 Example: `.analyze impact of social media on society`';
        }

        const topic = params.join(' ');

        try {
            const prompt = `Provide a comprehensive analysis of: ${topic}

Structure your analysis with:
1. Overview and context
2. Key factors and components
3. Causes and effects
4. Different perspectives
5. Implications and consequences
6. Conclusion with key insights

Be objective, thorough, and analytical.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const analysis = response.text();

            return `🔍 *Analysis: ${topic}*\n\n${analysis}`;

        } catch (error) {
            throw new Error(`Topic analysis failed: ${error.message}`);
        }
    }

    async generateDebate(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Debate Generator*\n\nPlease provide a topic for debate.\n\n💡 Usage: `.debate <topic>`\n📝 Example: `.debate Should AI replace human workers?`';
        }

        const topic = params.join(' ');

        try {
            const prompt = `Generate a balanced debate on: ${topic}

Present both sides with:

**FOR (Supporting Arguments):**
- 3-4 strong points with reasoning
- Evidence and examples
- Counter-arguments to opposing views

**AGAINST (Opposing Arguments):**
- 3-4 strong points with reasoning  
- Evidence and examples
- Counter-arguments to supporting views

**NEUTRAL PERSPECTIVE:**
- Balanced summary
- Areas of compromise
- Key considerations

Be fair, objective, and present strong arguments for both sides.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const debate = response.text();

            return `⚖️ *Debate: ${topic}*\n\n${debate}`;

        } catch (error) {
            throw new Error(`Debate generation failed: ${error.message}`);
        }
    }

    async summarizeText(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Text Summary*\n\nPlease provide text or topic to summarize.\n\n💡 Usage: `.summary <text or topic>`\n📝 Example: `.summary The history of the internet`';
        }

        const content = params.join(' ');

        try {
            const prompt = `Please provide a clear, concise summary of: ${content}

Create a summary that:
1. Captures the main points
2. Is easy to understand
3. Maintains key information
4. Is well-organized
5. Includes key takeaways

If this is a topic rather than text, provide a summary of the key information about that topic.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const summary = response.text();

            return `📄 *Summary*\n\n${summary}`;

        } catch (error) {
            throw new Error(`Text summarization failed: ${error.message}`);
        }
    }

    async brainstormIdeas(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Brainstorming*\n\nPlease provide a topic or problem to brainstorm.\n\n💡 Usage: `.brainstorm <topic>`\n📝 Example: `.brainstorm ways to reduce plastic waste`';
        }

        const topic = params.join(' ');

        try {
            const prompt = `Brainstorm creative ideas for: ${topic}

Generate:
1. **Immediate Ideas** (5-7 quick solutions)
2. **Creative Approaches** (3-5 innovative ideas)
3. **Long-term Solutions** (3-4 strategic approaches)
4. **Out-of-the-box Thinking** (2-3 unconventional ideas)

For each idea, provide:
- Brief description
- Why it could work
- Potential challenges

Be creative, practical, and think from multiple angles.`;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const ideas = response.text();

            return `💡 *Brainstorming: ${topic}*\n\n${ideas}`;

        } catch (error) {
            throw new Error(`Brainstorming failed: ${error.message}`);
        }
    }

    async clearConversation(msg, params, context) {
        const userId = context.participant.split('@')[0];
        this.conversations.delete(userId);
        
        return `🧹 *Conversation Cleared*\n\nYour AI conversation history has been reset.\nStart fresh with \`.ai <message>\``;
    }


}

export default GeminiAdvancedModule;
