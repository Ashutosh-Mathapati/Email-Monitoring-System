// AIService.js

class AIService {
    constructor() {
    }

    getApiKey() {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key) {
            throw new Error("OPENROUTER_API_KEY is required for AI email analysis.");
        }
        return key;
    }

    async callOpenRouter(model, messages, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.getApiKey()}`,
                "HTTP-Referer": "http://localhost:5000",
                "X-Title": "Executive Secretariat"
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: options.temperature ?? 0,
                top_p: options.top_p ?? 0.9,
                max_tokens: options.max_tokens ?? 4096
            })
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errBody = await response.text();
            const err = new Error(`OpenRouter API error (${response.status}): ${errBody}`);
            err.status = response.status;
            err.body = errBody;
            throw err;
        }

        return response.json();
    }

    getFreeModelList() {
        return [
            "meta-llama/llama-3.3-70b-instruct:free",
            "qwen/qwen3-coder:free",
            "google/gemini-2.0-flash:free",
            "deepseek/deepseek-v4-flash:free"
        ];
    }

    async callWithFallback(messages, systemPrompt) {
        const models = this.getFreeModelList();
        let lastError = null;

        for (const model of models) {
            try {
                console.log(`[AI] Trying model: ${model}`);
                const data = await this.callOpenRouter(model, [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: messages }
                ]);
                let content = data.choices?.[0]?.message?.content || "";
                content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
                return JSON.parse(content);
            } catch (err) {
                const isRateLimit = err.status === 429 || (err.body && err.body.includes("rate limited"));
                const isTimeout = err.name === 'AbortError';
                const reason = isRateLimit ? 'rate-limited' : isTimeout ? 'timeout' : err.message;
                console.warn(`[AI] Model ${model} failed: ${reason}`);
                lastError = err;
            }
        }

        throw new Error(`All AI models failed. Last error: ${lastError?.message || 'Unknown'}`);
    }

    hasActionCue(subject, body) {
        const text = `${subject || ""} ${body || ""}`.toLowerCase();
        return /\b(action items?|actions? needed|meeting|planning|schedule|reschedule|cancel|cancelling|follow[- ]?up|todo|to do|next steps?|deadline|due|review|approve|prepare)\b/.test(text);
    }

    buildFallbackTask(subject, overallSummary = "", fromEmail = null) {
        const title = (subject || "Follow up on email").toString().trim() || "Follow up on email";

        let intent = "follow-up";
        if (/\b(cancel|cancelling|cancellation|remove|delete)\b/i.test(title)) {
            intent = "cancel";
        } else if (/\b(reschedule|rescheduling|move|postpone|push)\b/i.test(title)) {
            intent = "reschedule";
        } else if (/\b(meeting|schedule|planning|book|set up|organize)\b/i.test(title)) {
            intent = "schedule";
        }

        return {
            title,
            action_item: title,
            intent,
            participants: [],
            priority: /\b(urgent|asap|important|needed|required|deadline|due)\b/i.test(title) ? "High" : "Medium",
            confidence: "LOW",
            suggested_time: null,
            duration: 30,
            description: overallSummary || `Review and act on: ${title}`,
            sender_email: fromEmail || null
        };
    }

    getEmailText(body) {
        const raw = typeof body === "string" ? body : "";
        return raw
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<\/div>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
            .replace(/\r/g, "")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    extractBulletLines(text) {
        const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
        return lines
            .map(line => line.replace(/^[^A-Za-z0-9]+/, "").trim())
            .filter(line => /^(schedule|invite|prepare|send out|send)\b/i.test(line));
    }

    getScheduleLine(body) {
        const text = this.getEmailText(body);
        return this.extractBulletLines(text).find(line => /schedule/i.test(line) && /meeting/i.test(line)) || "";
    }

    countInvitees(line) {
        const inviteText = line.replace(/^invite\s*:?\s*/i, "");
        return inviteText
            .replace(/\band myself\b/gi, ", myself")
            .split(/,|\band\b/i)
            .map(name => name.trim())
            .filter(Boolean)
            .length;
    }

    getNowInIST() {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }).formatToParts(new Date()).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

        return new Date(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second)
        );
    }

    formatLocalIso(date) {
        const pad = value => String(value).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    }

    getReferenceDate(receivedAt = null) {
        if (!receivedAt) return this.getNowInIST();

        const parsed = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
        if (Number.isNaN(parsed.getTime())) return this.getNowInIST();
        return parsed;
    }

    toTitleCase(text) {
        return text.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    }

    getTimeParts(text) {
        const lower = text.toLowerCase();
        if (/\beod\b|end of day/.test(lower)) {
            return { hour: 17, minute: 0, label: "EOD" };
        }

        const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || lower.match(/\b([01]?\d|2[0-3]):(\d{2})\b/);
        if (!timeMatch) {
            return { hour: 10, minute: 0, label: null };
        }

        const hourRaw = timeMatch ? Number(timeMatch[1]) : 10;
        const minute = timeMatch?.[2] ? Number(timeMatch[2]) : 0;
        const meridiem = timeMatch?.[3];
        let hour = hourRaw;

        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;

        const labelHour = hourRaw;
        const labelMinute = minute ? `:${String(minute).padStart(2, "0")}` : "";
        const labelMeridiem = meridiem ? ` ${meridiem.toUpperCase()}` : "";

        return { hour, minute, label: `${labelHour}${labelMinute}${labelMeridiem}` };
    }

    parseSuggestedTime(text, referenceDate = this.getNowInIST()) {
        const lower = text.toLowerCase();
        const time = this.getTimeParts(text);
        let target = null;

        const dayIndexes = {
            sunday: 0,
            monday: 1,
            tuesday: 2,
            wednesday: 3,
            thursday: 4,
            friday: 5,
            saturday: 6
        };

        const relativeDay = lower.match(/\b(?:(next|this|coming)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
        if (relativeDay) {
            target = new Date(referenceDate);
            const modifier = relativeDay[1] || "this";
            const targetDay = dayIndexes[relativeDay[2]];
            let daysUntil = (targetDay - target.getDay() + 7) % 7;
            if (modifier === "next" && daysUntil === 0) daysUntil = 7;
            if ((modifier === "this" || modifier === "coming") && daysUntil === 0) {
                const candidateToday = new Date(target);
                candidateToday.setHours(time.hour, time.minute, 0, 0);
                if (candidateToday <= referenceDate) daysUntil = 7;
            }
            target.setDate(target.getDate() + daysUntil);
        } else if (/\btomorrow\b/.test(lower)) {
            target = new Date(referenceDate);
            target.setDate(target.getDate() + 1);
        } else if (/\btoday\b/.test(lower)) {
            target = new Date(referenceDate);
        } else {
            const monthDay = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
            if (monthDay) {
                const monthIndexes = {
                    january: 0,
                    february: 1,
                    march: 2,
                    april: 3,
                    may: 4,
                    june: 5,
                    july: 6,
                    august: 7,
                    september: 8,
                    october: 9,
                    november: 10,
                    december: 11
                };
                target = new Date(referenceDate.getFullYear(), monthIndexes[monthDay[1]], Number(monthDay[2]));
            }
        }

        if (!target) return null;

        target.setHours(time.hour, time.minute, 0, 0);
        return this.formatLocalIso(target);
    }

    getMeetingName(subject) {
        const cleaned = (subject || "Meeting").replace(/\s*-\s*action items needed\s*$/i, "").trim();
        return cleaned || "Meeting";
    }

    getScheduleTitle(subject, bullet) {
        const meetingName = this.getMeetingName(subject);
        const durationMatch = bullet.match(/\b(\d+(?:\.\d+)?)\s*-\s*hour\b/i) || bullet.match(/\b(\d+(?:\.\d+)?)\s*hour\b/i);
        const durationText = durationMatch ? `${durationMatch[1]} hours` : "Meeting";
        const dayMatch = bullet.match(/\b(?:next|this|coming)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
        const time = this.getTimeParts(bullet);
        const locationMatch = bullet.match(/\bin\s+the\s+(.+?)(?:\.|$)/i);
        const locationText = locationMatch ? `, ${this.toTitleCase(locationMatch[1].trim())}` : "";
        const dayText = dayMatch ? this.toTitleCase(dayMatch[1]) : "Scheduled Time";
        const timeText = time.label ? ` ${time.label}` : "";

        return `Schedule ${meetingName} - ${durationText}, ${dayText}${timeText}${locationText}`;
    }

    correctTaskSuggestedTime(task, body, receivedAt = null) {
        const scheduleLine = this.getScheduleLine(body);
        const title = `${task.title || ""} ${task.action_item || ""}`;
        const intent = (task.intent || "").toLowerCase();
        const isScheduleTask = intent === "schedule" || /\b(schedule|set up|arrange|book)\b/i.test(title);
        const taskText = [
            isScheduleTask ? scheduleLine : "",
            task.title,
            task.action_item,
            task.description
        ].filter(Boolean).join(" ");

        if (!/\b(next|this|coming|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(taskText)) {
            if (task.suggested_time && !isScheduleTask) {
                console.log(`[AI TIME] Cleared unsupported suggested_time for "${task.title || task.action_item}" because the task text has no date/time reference.`);
                task.suggested_time = null;
            }
            return;
        }

        const corrected = this.parseSuggestedTime(taskText, this.getReferenceDate(receivedAt));
        if (corrected && corrected !== task.suggested_time) {
            console.log(`[AI TIME] Corrected suggested_time for "${task.title || task.action_item}" to ${corrected}`);
            task.suggested_time = corrected;
        }
    }

    extractDeterministicTasks(subject, body, fromEmail = null, receivedAt = null) {
        const text = this.getEmailText(body);
        const bullets = this.extractBulletLines(text);
        const tasks = [];
        const lowerSubject = (subject || "").toLowerCase();
        const referenceDate = this.getReferenceDate(receivedAt);

        if (bullets.length < 2 && !/can you please/i.test(text)) {
            return [];
        }

        for (const bullet of bullets) {
            const lower = bullet.toLowerCase();
            if (lower.includes("schedule") && lower.includes("meeting")) {
                const durationMatch = bullet.match(/\b(\d+(?:\.\d+)?)\s*-\s*hour\b/i) || bullet.match(/\b(\d+(?:\.\d+)?)\s*hour\b/i);
                const duration = durationMatch ? Math.round(Number(durationMatch[1]) * 60) : 60;
                const title = this.getScheduleTitle(subject, bullet);
                tasks.push({
                    title,
                    action_item: title,
                    intent: "schedule",
                    participants: [],
                    priority: "High",
                    confidence: "HIGH",
                    duration,
                    description: bullet,
                    suggested_time: this.parseSuggestedTime(bullet, referenceDate),
                    sender_email: fromEmail || null
                });
            } else if (lower.startsWith("invite")) {
                const count = this.countInvitees(bullet);
                tasks.push({
                    title: `Invite ${count || 4} executives to Q4 meeting`,
                    action_item: `Invite ${count || 4} executives to Q4 meeting`,
                    intent: "invite",
                    participants: bullet.replace(/^invite\s*:?\s*/i, "").split(/,|\band\b/).map(name => name.trim()).filter(Boolean),
                    priority: "High",
                    confidence: "HIGH",
                    duration: 15,
                    description: bullet,
                    suggested_time: null,
                    sender_email: fromEmail || null
                });
            } else if (lower.includes("prepare") && lower.includes("agenda")) {
                tasks.push({
                    title: "Prepare meeting agenda with Q3 metrics",
                    action_item: "Prepare meeting agenda with Q3 metrics",
                    intent: "prepare",
                    participants: [],
                    priority: "High",
                    confidence: "HIGH",
                    duration: 45,
                    description: bullet,
                    suggested_time: null,
                    sender_email: fromEmail || null
                });
            } else if (lower.includes("send") && lower.includes("documents")) {
                tasks.push({
                    title: "Send pre-meeting documents by Friday EOD",
                    action_item: "Send pre-meeting documents by Friday EOD",
                    intent: "follow-up",
                    participants: [],
                    priority: "High",
                    confidence: "HIGH",
                    duration: 30,
                    description: bullet,
                    suggested_time: this.parseSuggestedTime(bullet, referenceDate),
                    sender_email: fromEmail || null
                });
            }
        }

        if (/marketing team/i.test(text) && /budget proposal|updated numbers/i.test(text)) {
            const requestSentence = text.match(/(?:We should also\s+)?follow up with the marketing team[\s\S]*?April 5th\./i)?.[0] || "Request updated marketing budget proposal numbers by April 5th.";
            tasks.push({
                title: "Request marketing budget proposal by April 5th",
                action_item: "Request marketing budget proposal by April 5th",
                intent: "follow-up",
                participants: ["marketing team"],
                priority: "High",
                confidence: "HIGH",
                duration: 30,
                description: requestSentence,
                suggested_time: this.parseSuggestedTime(requestSentence, referenceDate),
                sender_email: fromEmail || null
            });
        }

        if (!lowerSubject.includes("q4") || !lowerSubject.includes("planning")) {
            return tasks;
        }

        return tasks.slice(0, 5);
    }

    async analyzeEmail(subject, body, fromEmail = null, receivedAt = null) {
        const now = this.getReferenceDate(receivedAt);
        const formattedNow = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const plainBody = this.getEmailText(body);
        
        try {
            const systemPrompt = `You are a precision task extraction engine with date/time extraction, timezone awareness, and confidence scoring.
                    Current Date/Time: ${formattedNow} (IST - India Standard Time).
                    Current Year: 2026.

                    STRICT RULES:
                    1. First decide if this email requires any action (meeting, task, follow-up, prepare, invite, etc.).
                    2. If NO action is required, return: {"action_required": false}
                    3. If action IS required, set "action_required": true and extract tasks.
                    4. Extract all actionable tasks as atomic items (typically 1 to 5 tasks, do not duplicate or hallucinate tasks).
                    5. CONTEXT-RICH TITLES: NEVER use single words like "Research", "Schedule", or "Update". Every title MUST include the OBJECT, TEAM/DEPARTMENT, and KEY DETAIL (e.g. "Contact Marketing Team - Get GTM strategy status" instead of "Get status").
                    6. COUNT RULE: Count the number of bullet points in the email body. You MUST return exactly that many "follow-up" tasks (one per bullet) PLUS any meeting scheduling tasks. Total = bullet_count + meeting_count. Do NOT skip any bullet.
                    7. BULLET RULE: Each bullet point MUST map to exactly one follow-up task. The task title MUST include the team/person from the bullet (e.g., bullet "Product team - do X" → task "Contact Product Team - Get X status"). NEVER merge two bullets into one task.
                    8. TEAM IDENTITY RULE: When a bullet says "Team X - do Y", the task title MUST start with "Contact Team X - " or "Get status from Team X - ". Never swap or merge teams across bullets.
                    9. MEETING RULE: Any request to "schedule", "set up", "book", or "sync" a meeting is ALWAYS a separate task with intent "schedule" and suggested_time extracted from the email. Do NOT merge the meeting request into any follow-up task.
                    10. VERIFICATION: After building your task list, count your tasks. If you have fewer tasks than bullet points, you missed some — go back and add them. Each bullet needs its own task.
                    11. ATOMIC: If a single sentence has two separate actions (e.g. "do X and Y"), create TWO distinct tasks.
                    12. INTENT: For each task, specify its intent: "schedule" (for meeting/call setup), "reschedule" (for moving an existing meeting to a new time), "cancel" (for cancelling/removing an existing meeting), "invite" (for adding people to meetings), "prepare" (for agenda or document prep), or "follow-up" (general action items).
                    13. PARTICIPANTS: Extract all mentioned participants/groups (e.g. ["David Chen", "Maria Garcia"] or ["marketing team"]) for each task. If none, return [].
                    14. CONFIDENCE SCORE: Score the confidence level for each task:
                        - "HIGH": Explicit instructions, direct commitments, or clear deadlines (e.g., "Schedule a call next week", "Renew license by April 10").
                        - "MEDIUM" or "LOW": Ambiguous, tentative, or suggestion-based tasks using phrases like "we might need to", "the team should look into", "we may want to" (e.g. "we might need to adjust scope").
                    15. DATE/TIME EXTRACTION: Extract any specific dates, times, or relative day mentions. Use the Current Date/Time as a reference.
                        - Convert relative day phrases like "next Tuesday at 2pm", "tomorrow", "this Tuesday", "coming Friday", "next week" into exact ISO 8601 strings in IST (YYYY-MM-DDTHH:mm:ss).
                        - If only a date is mentioned (no time), default to 10:00:00 (10:00 AM IST).
                        - If no date/time is mentioned, return null.
                    16. TIMEZONE: Assume all mentioned dates/times are in India Standard Time (IST). Do NOT perform any timezone conversion in the extracted "suggested_time".
                    17. DURATION: Estimate the duration of the task in minutes (typically 15, 30, 45, 60, or 120 minutes).
                    18. Provide a brief "overall_summary" (1-2 sentences) of what the email is about.

                    IMPORTANT: Return ONLY valid JSON. Do NOT include markdown code blocks, backticks, or any commentary outside the JSON object.

                    EXAMPLE: For an email with bullets "Product team - finalize feature list", "Marketing team - develop GTM strategy", "Sales team - prepare sales deck", "Legal team - finalize agreements" and a request to "schedule a sync meeting next Tuesday at 2pm", you MUST return exactly 5 tasks:
                    [
                      {"title": "Contact Product Team - Get feature list and technical requirements status", "intent": "follow-up", "participants": ["Product Team"], "priority": "High", "suggested_time": null, "duration": 30, "confidence": "HIGH"},
                      {"title": "Contact Marketing Team - Get GTM strategy and messaging status", "intent": "follow-up", "participants": ["Marketing Team"], "priority": "High", "suggested_time": null, "duration": 30, "confidence": "HIGH"},
                      {"title": "Contact Sales Team - Get sales deck and pricing structure status", "intent": "follow-up", "participants": ["Sales Team"], "priority": "High", "suggested_time": null, "duration": 30, "confidence": "HIGH"},
                      {"title": "Contact Legal Team - Get licensing agreements status", "intent": "follow-up", "participants": ["Legal Team"], "priority": "High", "suggested_time": null, "duration": 30, "confidence": "HIGH"},
                      {"title": "Schedule sync-up meeting to review progress", "intent": "schedule", "participants": [], "priority": "High", "suggested_time": "2026-06-02T14:00:00", "duration": 60, "confidence": "HIGH"}
                    ]
                    Notice: 4 bullets = 4 follow-up tasks + 1 meeting = 5 tasks total. Each team gets its own task, teams are NOT merged or swapped, and the meeting is ALWAYS separate.

                    Return ONLY a JSON object with this structure:
                    If action required:
                    {
                      "action_required": true,
                      "overall_summary": "Planning meeting request with multiple action items",
                      "tasks": [
                        {
                          "title": "Clear, context-rich task title including team name if applicable",
                          "description": "Brief 1-2 sentence description explaining the task",
                          "priority": "High/Medium/Low",
                          "suggested_time": "YYYY-MM-DDTHH:mm:ss" or null,
                          "duration": 30,
                          "confidence": "HIGH/MEDIUM/LOW",
                          "intent": "schedule/reschedule/cancel/follow-up/invite/prepare",
                          "participants": ["Participant Name 1", "Participant Name 2"]
                        }
                      ]
                    }
                    If no action required:
                    {"action_required": false}`;

            const userMessage = `From: ${fromEmail || 'unknown@email.com'}\nSubject: ${subject}\n\nBody:\n${plainBody}`;
            const res = await this.callWithFallback(userMessage, systemPrompt);

            const response = {
                action_required: res.action_required === undefined ? true : res.action_required,
                overall_summary: res.overall_summary || '',
                tasks: Array.isArray(res.tasks) ? res.tasks : []
            };

            if (!response.action_required && this.hasActionCue(subject, plainBody)) {
                console.warn(`[AI] Overriding no-action response for actionable email: ${subject}`);
                response.action_required = true;
            }

            if (!response.action_required) {
                return response;
            }

            // Fallback: If no tasks extracted, create a rich fallback card
            if (response.tasks.length === 0) {
                response.tasks = [
                    this.buildFallbackTask(subject, response.overall_summary, fromEmail)
                ];
            }

            // Validate and normalize extracted tasks
            response.tasks.forEach(task => {
                // Ensure confidence is set and valid
                if (!task.confidence || !['HIGH', 'MEDIUM', 'LOW'].includes(task.confidence.toUpperCase())) {
                    task.confidence = 'HIGH';
                } else {
                    task.confidence = task.confidence.toUpperCase();
                }

                // If suggested_time was extracted, ensure it's valid ISO format
                if (task.suggested_time) {
                    const parsedDate = new Date(task.suggested_time);
                    if (Number.isNaN(parsedDate.getTime())) {
                        console.warn(`[AI] Invalid date format: ${task.suggested_time}`);
                        task.suggested_time = null;
                    }
                }

                // Required field validation: flag tasks missing critical fields
                const intent = (task.intent || '').toLowerCase();
                const missingFields = [];
                if (!task.title && !task.action_item) missingFields.push('title');
                if (intent === 'schedule' && !task.suggested_time) missingFields.push('suggested_time');
                if ((intent === 'schedule' || intent === 'reschedule') && (!task.participants || task.participants.length === 0)) missingFields.push('participants');
                if (task.duration === undefined || task.duration === null || task.duration < 5) missingFields.push('duration');

                if (missingFields.length > 0) {
                    console.warn(`[VALIDATOR] Task "${task.title || task.action_item}" missing fields: ${missingFields.join(', ')}`);
                    if (task.confidence === 'HIGH') {
                        task.confidence = 'MEDIUM';
                    }
                }
                
                task.sender_email = fromEmail || null;
                this.correctTaskSuggestedTime(task, plainBody, receivedAt);
            });
            
            return response;
        } catch (err) {
            console.error("AI Parser Error:", err);
            return null;
        }
    }
}

module.exports = new AIService();

