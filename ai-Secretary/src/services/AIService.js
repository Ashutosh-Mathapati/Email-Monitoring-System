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
                        content: `You are a precision task extraction engine with intent analysis.
                    Current Date: ${now}.

                    STRICT RULES:
                    1. EXTRACT EXACTLY 4-5 ATOMIC TASKS.
                    2. DATE TYPE CLASSIFICATION:
                       - 'deadline': If date follows "by", "due", "deadline".
                       - 'reference': If date is for "availability", "options", "range".
                       - 'scheduled': If date is for "meeting", "call", "appointment".
                       - 'none': If no specific date mentioned.
                    3. NEVER assign a 'scheduled_date' if the type is 'reference' or 'deadline'.
                    
                    OUTPUT FORMAT (JSON):
                    {
                      "overall_summary": "Context",
                      "tasks": [
                        {
                          "title": "Verb-first context-rich title",
                          "description": "Verbatim detail",
                          "date_type": "deadline | reference | scheduled | none",
                          "suggested_time": "ISO_TIMESTAMP or null",
                          "priority": "High/Medium/Low"
                        }
                      ]
                    }`
                    },
                    {
                        role: "user",
                        content: `Subject: ${subject}\n\nBody: ${body}`
                    }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0,
                response_format: { type: "json_object" }
            });

            const res = JSON.parse(chatCompletion.choices[0].message.content);
            return res;
        } catch (err) {
            console.error("AI Parser Error:", err);
            return null;
        }
    }
}

module.exports = new AIService();
