const axios = require("axios");
const tokenManager = require("../TokenManager");

class CalendarService {
    // 1. THE MAIN FUNCTION CALLED BY APP.JS
    async scheduleTask(aiData) {
        try {
            const token = await tokenManager.getAccessToken();
            
            // Normalize duration from AI data or database row
            const durationMinutes = aiData.duration ?? aiData.duration_minutes ?? 30;

            // Determine requested start (default to now if AI misses time)
            let requestedStart = aiData.suggested_time ? new Date(aiData.suggested_time) : new Date();
            
            // Ensure we are working with the correct year (2026)
            if (requestedStart.getFullYear() < 2026) requestedStart.setFullYear(2026);

            console.log(`[CHECKING] Looking for conflicts at ${requestedStart.toLocaleString()}...`);

            // 2. RUN CONFLICT DETECTION
            const finalStartTime = await this.findFreeSlot(requestedStart, durationMinutes);
            
            if (finalStartTime.getTime() !== requestedStart.getTime()) {
                console.log(`[RESCHEDULED] Conflict found! Moving to: ${finalStartTime.toLocaleString()}`);
            }

            const endTime = new Date(finalStartTime.getTime() + durationMinutes * 60000);

            // 3. THE ACTUAL API CALL (This is what was likely missing or failing)
            const eventPayload = {
                subject: `📅 AI AGENT: ${aiData.action_item}`,
                body: {
                    contentType: "HTML",
                    content: `<b>Summary:</b> ${aiData.summary}<br/><i>Scheduled by AI Secretary.</i>`
                },
                start: {
                    dateTime: finalStartTime.toISOString().split('.')[0],
                    timeZone: "UTC"
                },
                end: {
                    dateTime: endTime.toISOString().split('.')[0],
                    timeZone: "UTC"
                },
                location: { displayName: "AI Office" }
            };

            const response = await axios.post(
                "https://graph.microsoft.com/v1.0/me/events",
                eventPayload,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "Prefer": 'outlook.timezone="UTC"'
                    }
                }
            );

            // 4. LOG SUCCESS WITH EVENT ID
            console.log(`[SUCCESS] Event created in Outlook! ID: ${response.data.id.substring(0, 10)}...`);
            
            return {
                eventId: response.data.id,
                start: finalStartTime,
                end: endTime
            };

        } catch (err) {
            console.error("Critical Scheduling Error:", err.response?.data || err.message);
            return null;
        }
    }

    // 5. THE CONFLICT DETECTION ENGINE
    async findFreeSlot(requestedStart, durationMinutes) {
        const token = await tokenManager.getAccessToken();
        const endWindow = new Date(requestedStart);
        endWindow.setHours(23, 59, 59);

        const response = await axios.get(
            `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${requestedStart.toISOString()}&endDateTime=${endWindow.toISOString()}`,
            { 
                headers: { 
                    Authorization: `Bearer ${token}`,
                    "Prefer": 'outlook.timezone="India Standard Time"' 
                } 
            }
        );

        const events = response.data.value;
        let potentialStart = new Date(requestedStart);

        for (const calEvent of events) {
            const eventStart = new Date(calEvent.start.dateTime);
            const eventEnd = new Date(calEvent.end.dateTime);
            const taskEnd = new Date(potentialStart.getTime() + durationMinutes * 60000);

            // If overlap exists
            if (potentialStart < eventEnd && taskEnd > eventStart) {
                console.log(`[DEBUG] Conflict with "${calEvent.subject}".`);
                potentialStart = new Date(eventEnd.getTime() + 5 * 60000); // 5 min buffer
            }
        }

        // Working Hours logic (9 AM - 10 PM)
        if (potentialStart.getHours() >= 22) {
             console.log("[DAY FULL] Pushing to tomorrow...");
            potentialStart.setDate(potentialStart.getDate() + 1);
            potentialStart.setHours(9, 0, 0, 0);
            return this.findFreeSlot(potentialStart, durationMinutes);
        }

        return potentialStart;
    }
}

module.exports = new CalendarService();
