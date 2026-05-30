// AIService.js
const Groq = require("groq-sdk");

class AIService {
    constructor() {
        // Initialize after env loading so the API key is available.
        this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }

    async analyzeEmail(subject, body, fromEmail = null) {
        const now = new Date();
        const formattedNow = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        
        try {
            const chatCompletion = await this.groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `You are a precision task extraction engine with date/time extraction and timezone awareness.
                    Current Date/Time: ${formattedNow} (IST - India Standard Time).
                    Current Year: 2026.

                    STRICT RULES:
                    1. First decide if this email requires any action (meeting, task, follow-up, etc.).
                    2. If NO action is required, return: {"action_required": false}
                    3. If action IS required, set "action_required": true and extract tasks.
                    4. EXTRACT EXACTLY 4-5 ATOMIC TASKS.
                    5. CONTEXT-RICH TITLES: NEVER use single words like "Research", "Schedule", or "Update".
                    6. Every title MUST include the OBJECT and KEY DETAIL (e.g., "Research 3 hotels for offsite").
                    7. BULLET RULE: Every bullet point in the email must be at least one task.
                    8. ATOMIC: If a bullet has two actions (e.g., "do X and Y"), create TWO tasks.
                    9. DATE/TIME EXTRACTION: If the email mentions a specific date/time or relative day for the task, extract it and include in "suggested_time" field. Understand relative day phrases like today, tomorrow, this Tuesday, next Tuesday, coming Friday, and next week by calculating the date from the Current Date/Time above.
                    10. TIME FORMAT: Convert extracted dates to ISO 8601 format (YYYY-MM-DDTHH:mm:ss) in IST (India Standard Time). If no time is specified, use 10:00 AM (10:00:00).
                    11. TIMEZONE IMPORTANT: All times mentioned in emails are assumed to be in IST unless explicitly stated otherwise. Keep times as IST - NO CONVERSION.
                    12. DESCRIPTION FIELD: For each task, provide a brief 1-2 sentence description explaining what needs to be done and why.
                    13. SENDER TIMEZONE: The sender may be in a different timezone. We will detect and store it separately, but times should always be extracted as IST.
                    14. Provide an overall_summary (1-2 sentences) of what the email is about.
                    
                    EXAMPLES:
                    Mail: "Schedule meeting for April 25 at 3pm" or "Meeting on April 25, 2026 at 15:00"
                    Extract: suggested_time: "2026-04-25T15:00:00" (as IST - no conversion)

                    Mail: "Schedule meeting next Tuesday at 2pm"
                    Extract: suggested_time: the next Tuesday after Current Date/Time at "14:00:00" IST
                    
                    Mail: "Venue: Find a hotel within 2 hours of city and check availability for June 10-12."
                    Extract: suggested_time: "2026-06-10T10:00:00" (first date at 10am IST default)

                    Return ONLY a JSON object with this structure:
                    If action required:
                    { "action_required": true, "overall_summary": "Brief summary of the email", "tasks": [
                      {"title": "...", "description": "Brief summary of what to do", "priority": "High/Medium/Low", "suggested_time": "2026-MM-DDTHH:mm:ss", "duration": 30},
                      ...
                    ]}
                    If no action required:
                    {"action_required": false}`
                    },
                    {
                        role: "user",
                        content: `From: ${fromEmail || 'unknown@email.com'}\nSubject: ${subject}\n\nBody: ${body}`
                    }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0,
                top_p: 0.9,
                response_format: { type: "json_object" }
            });

            const res = JSON.parse(chatCompletion.choices[0].message.content);

            // Normalize: if the AI returned a bare array, wrap it
            const response = {
                action_required: res.action_required === undefined ? true : res.action_required,
                overall_summary: res.overall_summary || '',
                tasks: Array.isArray(res.tasks) ? res.tasks : []
            };

            // If no action required, short-circuit
            if (!response.action_required) {
                return response;
            }

            // Validate and normalize extracted tasks
            response.tasks.forEach(task => {
                // If suggested_time was extracted, ensure it's valid ISO format
                if (task.suggested_time) {
                    const parsedDate = new Date(task.suggested_time);
                    if (Number.isNaN(parsedDate.getTime())) {
                        console.warn(`[AI] Invalid date format: ${task.suggested_time}`);
                        task.suggested_time = null;
                    }
                }
                // Add sender email for timezone detection later
                task.sender_email = fromEmail || null;
            });
            
            return response;
        } catch (err) {
            console.error("AI Parser Error:", err);
            return null;
        }
    }
}

module.exports = new AIService();
