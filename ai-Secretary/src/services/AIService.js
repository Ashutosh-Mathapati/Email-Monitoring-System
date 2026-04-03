// AIService.js
const Groq = require("groq-sdk");

class AIService {
    constructor() {
        // Initialize after env loading so the API key is available.
        this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }

    async analyzeEmail(subject, body) {
        const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        try {
            const chatCompletion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are a world-class Executive Assistant. Current Date/Time: ${now}.
                        Analyze the email and extract EVERY distinct actionable request as a SEPARATE task.
                        
                        RULES:
                        1. If an email has bullet points or multiple requests, extract EACH one.
                        2. Never combine tasks like "Invite people" and "Prepare agenda" into one row.
                        3. For 'suggested_time', use the specific date/time mentioned in the text.
                        4. Return ONLY JSON.
                        
                        Format:
                        {
                          "overall_summary": "A brief title for this group of tasks",
                          "tasks": [
                            { "action_item": "Task 1 description", "priority": "High", "duration": 120, "suggested_time": "ISO_TIMESTAMP" },
                            { "action_item": "Task 2 description", "priority": "Medium", "duration": 15, "suggested_time": null }
                          ]
                        }`
                    },
                    { role: "user", content: `Subject: ${subject}\n\nBody: ${body}` }
                ],
                model: "llama-3.3-70b-versatile",
                response_format: { type: "json_object" }
            });
            return JSON.parse(chatCompletion.choices[0].message.content);
        } catch (err) { return null; }
    }
        }

module.exports = new AIService();
